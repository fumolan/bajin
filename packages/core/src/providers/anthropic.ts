import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ModelProvider,
  ProviderTool,
  StreamEvent,
  ToolCall,
} from '@bajin/shared';
import { ApiError, SseBuffer } from './glm.js';

/**
 * Anthropic Messages 协议 provider（POST {baseUrl}/messages，SSE 流式）。
 * 适用于 Anthropic 原生端点及其兼容网关（如 open.bigmodel.cn/api/anthropic）。
 * 与 OpenAI 格式的差异：
 *   - 鉴权头 x-api-key + anthropic-version，而非 Authorization Bearer
 *   - system 是顶层字段，不进 messages
 *   - 工具调用是 content blocks：assistant 侧 tool_use{id,name,input}，
 *     结果以 user 侧 tool_result{tool_use_id,content} 回传
 *   - 流式事件：message_start / content_block_start / content_block_delta /
 *     message_delta(usage+stop_reason) / message_stop
 */

export interface AnthropicProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
}

interface ToolUseAcc {
  id: string;
  name: string;
  json: string;
}

interface AnthropicAccumulator {
  content: string;
  reasoning: string;
  toolUses: Map<number, ToolUseAcc>;
  startedToolCalls: Set<string>;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  finishReason?: string;
}

/** ChatMessage[] → Anthropic messages（system 提取到顶层；tool_use/tool_result 转内容块；相邻同角色合并） */
export function toAnthropicMessages(messages: ChatMessage[]): {
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
} {
  let system = '';
  const out: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
  const push = (role: 'user' | 'assistant', block: unknown) => {
    const last = out[out.length - 1];
    if (last && last.role === role && Array.isArray(last.content) && Array.isArray(block)) {
      last.content = [...(last.content as unknown[]), ...(block as unknown[])];
    } else if (last && last.role === role && typeof last.content === 'string' && typeof block === 'string') {
      last.content = `${last.content}\n${block}`;
    } else {
      out.push({ role, content: block });
    }
  };
  for (const m of messages) {
    if (m.role === 'system') {
      system = system ? `${system}\n${m.content}` : m.content;
    } else if (m.role === 'user') {
      push('user', m.content);
    } else if (m.role === 'assistant') {
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(c.arguments || '{}');
        } catch {
          input = {};
        }
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input });
      }
      push('assistant', blocks.length === 1 && blocks[0] && (blocks[0] as { type: string }).type === 'text'
        ? (blocks[0] as { text: string }).text
        : blocks);
    } else {
      // tool 结果 → user 侧 tool_result 块
      push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }]);
    }
  }
  // 首条必须是 user（Anthropic 要求）；空消息兜底
  if (!out.length) out.push({ role: 'user', content: '(空)' });
  return { system: system || undefined, messages: out };
}

function toAnthropicTools(tools?: ProviderTool[]): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

const STOP_REASON_MAP: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  tool_use: 'tool_calls',
  max_tokens: 'length',
};

/** 处理一条 SSE data 载荷，累积文本/思考/工具调用 */
export function processAnthropicChunk(data: Record<string, unknown>, acc: AnthropicAccumulator, onEvent?: (e: StreamEvent) => void): void {
  const type = String(data['type'] ?? '');
  if (type === 'message_start') {
    const usage = (data['message'] as { usage?: Record<string, unknown> } | undefined)?.usage;
    if (usage) {
      acc.usage = {
        inputTokens: Number(usage['input_tokens'] ?? 0),
        outputTokens: Number(usage['output_tokens'] ?? 0),
        totalTokens: Number(usage['input_tokens'] ?? 0) + Number(usage['output_tokens'] ?? 0),
      };
    }
  } else if (type === 'content_block_start') {
    const index = Number(data['index'] ?? 0);
    const block = data['content_block'] as { type?: string; id?: string; name?: string } | undefined;
    if (block?.type === 'tool_use') {
      acc.toolUses.set(index, { id: block.id ?? `call_${index}`, name: block.name ?? '', json: '' });
      const id = block.id ?? `call_${index}`;
      if (!acc.startedToolCalls.has(id)) {
        acc.startedToolCalls.add(id);
        onEvent?.({ type: 'tool-call-start', id, name: block.name ?? '' });
      }
    }
  } else if (type === 'content_block_delta') {
    const index = Number(data['index'] ?? 0);
    const delta = data['delta'] as { type?: string; text?: string; partial_json?: string; thinking?: string } | undefined;
    if (!delta) return;
    if (delta.type === 'text_delta' && delta.text) {
      acc.content += delta.text;
      onEvent?.({ type: 'text-delta', delta: delta.text });
    } else if (delta.type === 'input_json_delta' && delta.partial_json) {
      const entry = acc.toolUses.get(index);
      if (entry) entry.json += delta.partial_json;
    } else if (delta.type === 'thinking_delta' && delta.thinking) {
      acc.reasoning += delta.thinking;
      onEvent?.({ type: 'reasoning-delta', delta: delta.thinking });
    }
  } else if (type === 'message_delta') {
    const delta = data['delta'] as { stop_reason?: string } | undefined;
    if (delta?.stop_reason) acc.finishReason = STOP_REASON_MAP[delta.stop_reason] ?? delta.stop_reason;
    const usage = data['usage'] as { output_tokens?: number } | undefined;
    if (usage?.output_tokens != null) {
      const input = acc.usage?.inputTokens ?? 0;
      acc.usage = { inputTokens: input, outputTokens: Number(usage.output_tokens), totalTokens: input + Number(usage.output_tokens) };
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createAnthropicProvider(opts: AnthropicProviderOptions = {}): ModelProvider {
  const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
  const baseUrlRaw = (opts.baseUrl ?? process.env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com').replace(/\/$/, '');
  // anthropic SDK 惯例：baseUrl 不带版本段时补 /v1（如 https://api.anthropic.com → /v1/messages）
  const baseUrl = /\/v\d+$/.test(baseUrlRaw) ? baseUrlRaw : `${baseUrlRaw}/v1`;
  const model = opts.model ?? 'claude-sonnet-4-5';
  const doFetch = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxRetries ?? 3;

  async function chat(req: ChatRequest, onEvent?: (e: StreamEvent) => void): Promise<ChatResponse> {
    if (!apiKey) throw new ApiError(401, '缺少 API key：请为该供应商配置 API Key');

    const { system, messages } = toAnthropicMessages(req.messages);
    const body = {
      model: req.model,
      max_tokens: req.maxTokens ?? opts.maxTokens ?? 8192,
      ...(system ? { system } : {}),
      messages,
      tools: toAnthropicTools(req.tools),
      stream: true,
      ...(req.temperature != null ? { temperature: req.temperature } : {}),
    };

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await doFetch(`${baseUrl}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
          signal: req.signal,
        });
        if (!res.ok) {
          let msg: string;
          try {
            const text = await res.text();
            try {
              const json = JSON.parse(text) as { error?: { message?: string } };
              msg = json.error?.message ?? text.slice(0, 500);
            } catch {
              msg = text.slice(0, 500);
            }
          } catch {
            msg = res.statusText;
          }
          if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
            lastError = new ApiError(res.status, msg);
            await sleep(500 * 2 ** attempt);
            continue;
          }
          throw new ApiError(res.status, msg);
        }
        if (!res.body) throw new ApiError(500, '响应缺少 body');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const sse = new SseBuffer();
        const acc: AnthropicAccumulator = { content: '', reasoning: '', toolUses: new Map(), startedToolCalls: new Set() };
        while (true) {
          const { value, done: streamDone } = await reader.read();
          if (streamDone) break;
          for (const data of sse.feed(decoder.decode(value, { stream: true }))) {
            if (data === null) break;
            processAnthropicChunk(data, acc, onEvent);
          }
        }

        const toolCalls: ToolCall[] = [...acc.toolUses.entries()]
          .sort(([a], [b]) => a - b)
          .map(([index, { id, name, json }], i) => {
            const final = { id: id || `call_${index}_${i}`, name, arguments: json || '{}' };
            onEvent?.({ type: 'tool-call-end', id: final.id, name: final.name, arguments: final.arguments });
            return final;
          });

        return {
          message: {
            role: 'assistant',
            content: acc.content,
            ...(toolCalls.length ? { toolCalls } : {}),
          },
          ...(acc.usage ? { usage: acc.usage } : {}),
          ...(acc.finishReason ? { finishReason: acc.finishReason } : {}),
        };
      } catch (err) {
        lastError = err;
        if (err instanceof TypeError && attempt < maxRetries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  return { id: 'anthropic', defaultModel: model, chat };
}
