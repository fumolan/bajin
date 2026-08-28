import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ModelProvider,
  ProviderTool,
  StreamEvent,
  ToolCall,
  UsageInfo,
} from '@bajin/shared';

const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
export const DEFAULT_GLM_MODEL = 'glm-5.3';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(`[bigmodel ${status}] ${message}`);
    this.name = 'ApiError';
  }
}

export interface GlmProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
}

/** SSE 增量缓冲器：feed() 接收任意切块，产出完整的 data 载荷（JSON 已解析，[DONE] 与注释返回 null） */
export class SseBuffer {
  private rest = '';

  feed(chunk: string): Array<Record<string, unknown> | null> {
    this.rest += chunk;
    const out: Array<Record<string, unknown> | null> = [];
    let idx: number;
    while ((idx = this.rest.indexOf('\n')) >= 0) {
      const raw = this.rest.slice(0, idx).replace(/\r$/, '');
      this.rest = this.rest.slice(idx + 1);
      const line = raw.trim();
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        out.push(null);
        continue;
      }
      try {
        out.push(JSON.parse(payload) as Record<string, unknown>);
      } catch {
        // 半截 JSON 等异常载荷直接丢弃，避免中断整个流
      }
    }
    return out;
  }
}

interface OpenAiToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface StreamingAccumulator {
  content: string;
  reasoning: string;
  toolCalls: Map<number, { id: string; name: string; args: string }>;
  startedToolCalls: Set<number>;
  finishReason?: string;
  usage?: UsageInfo;
}

function processChunk(data: Record<string, unknown>, acc: StreamingAccumulator, onEvent?: (e: StreamEvent) => void): void {
  const usage = data['usage'] as Record<string, number> | undefined;
  if (usage && (usage['prompt_tokens'] != null || usage['completion_tokens'] != null)) {
    acc.usage = {
      inputTokens: usage['prompt_tokens'],
      outputTokens: usage['completion_tokens'],
      totalTokens: usage['total_tokens'],
    };
    onEvent?.({ type: 'usage', usage: acc.usage });
  }
  const choices = data['choices'] as Array<Record<string, unknown>> | undefined;
  const choice = choices?.[0];
  if (!choice) return;
  if (typeof choice['finish_reason'] === 'string') {
    acc.finishReason = choice['finish_reason'];
  }
  const delta = choice['delta'] as Record<string, unknown> | undefined;
  if (!delta) return;
  if (typeof delta['content'] === 'string' && delta['content']) {
    acc.content += delta['content'];
    onEvent?.({ type: 'text-delta', delta: delta['content'] });
  }
  const reasoning = (delta as Record<string, unknown>)['reasoning_content'];
  if (typeof reasoning === 'string' && reasoning) {
    acc.reasoning += reasoning;
    onEvent?.({ type: 'reasoning-delta', delta: reasoning });
  }
  const calls = delta['tool_calls'] as OpenAiToolCallDelta[] | undefined;
  if (Array.isArray(calls)) {
    for (const c of calls) {
      const key = c.index ?? 0;
      let entry = acc.toolCalls.get(key);
      if (!entry) {
        entry = { id: '', name: '', args: '' };
        acc.toolCalls.set(key, entry);
      }
      if (c.id) entry.id = c.id;
      if (c.function?.name) entry.name += c.function.name;
      if (c.function?.arguments) entry.args += c.function.arguments;
      // 首个增量到达时广播 start（id/name 可能尚不完整，end 事件会带全量）
      if (!acc.startedToolCalls.has(key) && entry.name) {
        acc.startedToolCalls.add(key);
        onEvent?.({ type: 'tool-call-start', id: entry.id, name: entry.name });
      }
    }
  }
}

function toOpenAiMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    switch (m.role) {
      case 'system':
      case 'user':
        return { role: m.role, content: m.content };
      case 'assistant': {
        const out: Record<string, unknown> = { role: 'assistant', content: m.content };
        if (m.toolCalls?.length) {
          out['tool_calls'] = m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.arguments },
          }));
        }
        return out;
      }
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId, name: m.name, content: m.content };
    }
  });
}

function toOpenAiTools(tools?: ProviderTool[]): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text) as { error?: { message?: string } };
      return json.error?.message ?? text.slice(0, 500);
    } catch {
      return text.slice(0, 500);
    }
  } catch {
    return res.statusText;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createGlmProvider(opts: GlmProviderOptions = {}): ModelProvider {
  const apiKey = opts.apiKey ?? process.env['BIGMODEL_API_KEY'] ?? '';
  const baseUrl = (opts.baseUrl ?? process.env['BIGMODEL_BASE_URL'] ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const model = opts.model ?? DEFAULT_GLM_MODEL;
  const doFetch = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxRetries ?? 3;

  async function chat(req: ChatRequest, onEvent?: (e: StreamEvent) => void): Promise<ChatResponse> {
    if (!apiKey) throw new ApiError(401, '缺少 API key：请设置 BIGMODEL_API_KEY 或在配置中填写 bigmodel.apiKey');

    const body = {
      model: req.model,
      messages: toOpenAiMessages(req.messages),
      tools: toOpenAiTools(req.tools),
      stream: true,
      stream_options: { include_usage: true },
      ...(req.maxTokens != null ? { max_tokens: req.maxTokens } : {}),
      ...(req.temperature != null ? { temperature: req.temperature } : {}),
      ...(req.topP != null ? { top_p: req.topP } : {}),
    };

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await doFetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: req.signal,
        });
        if (!res.ok) {
          const msg = await readErrorBody(res);
          // 429/5xx 可重试；4xx（除 429）是请求本身的问题，重试无意义
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
        const acc: StreamingAccumulator = { content: '', reasoning: '', toolCalls: new Map(), startedToolCalls: new Set() };
        let done = false;
        while (!done) {
          const { value, done: streamDone } = await reader.read();
          if (streamDone) break;
          for (const data of sse.feed(decoder.decode(value, { stream: true }))) {
            if (data === null) {
              done = true;
              break;
            }
            processChunk(data, acc, onEvent);
          }
        }

        const toolCalls: ToolCall[] = [...acc.toolCalls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([id, { id: callId, name, args }], i) => {
            const final = { id: callId || `call_${id}_${i}`, name, arguments: args || '{}' };
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
        // 网络类错误（TypeError）也重试；ApiError 已在上面处理过重试逻辑
        if (err instanceof TypeError && attempt < maxRetries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  return { id: 'glm', defaultModel: model, chat };
}
