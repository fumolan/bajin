import { describe, expect, it } from 'vitest';
import { createAnthropicProvider, toAnthropicMessages, processAnthropicChunk } from '../src/providers/anthropic.js';
import type { ChatRequest, ChatMessage } from '@bajin/shared';

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('toAnthropicMessages 消息转换', () => {
  it('system 提取到顶层；tool_use/tool_result 转内容块', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '读 a.txt' },
      { role: 'assistant', content: '这就读', toolCalls: [{ id: 'toolu_1', name: 'Read', arguments: '{"file_path":"a.txt"}' }] },
      { role: 'tool', toolCallId: 'toolu_1', name: 'Read', content: 'AAA' },
      { role: 'assistant', content: '内容是 AAA' },
    ];
    const { system, messages } = toAnthropicMessages(msgs);
    expect(system).toBe('你是助手');
    expect(messages[0]).toEqual({ role: 'user', content: '读 a.txt' });
    const assistant = messages[1] as { role: string; content: Array<{ type: string }> };
    expect(assistant.role).toBe('assistant');
    expect(assistant.content[0]!.type).toBe('text');
    expect(assistant.content[1]!.type).toBe('tool_use');
    const toolResult = messages[2] as { role: string; content: Array<{ type: string; tool_use_id: string }> };
    expect(toolResult.role).toBe('user');
    expect(toolResult.content[0]!.type).toBe('tool_result');
    expect(toolResult.content[0]!.tool_use_id).toBe('toolu_1');
  });

  it('相邻同角色消息合并', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: '第一句' },
      { role: 'user', content: '第二句' },
    ];
    const { messages } = toAnthropicMessages(msgs);
    expect(messages).toHaveLength(1);
    expect((messages[0] as { content: string }).content).toBe('第一句\n第二句');
  });
});

describe('processAnthropicChunk 流式事件', () => {
  it('message_start 记 usage；message_delta 映射 stop_reason 并更新输出 token', () => {
    const acc = { content: '', reasoning: '', toolUses: new Map(), startedToolCalls: new Set() };
    processAnthropicChunk({ type: 'message_start', message: { usage: { input_tokens: 7, output_tokens: 1 } } }, acc);
    expect(acc.usage?.inputTokens).toBe(7);
    processAnthropicChunk({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }, acc as never);
    expect(acc.finishReason).toBe('tool_calls');
    expect(acc.usage?.totalTokens).toBe(16);
  });

  it('tool_use 块：start 建条目 + input_json_delta 拼参数 + 事件回调', () => {
    const acc = { content: '', reasoning: '', toolUses: new Map(), startedToolCalls: new Set() };
    const events: string[] = [];
    processAnthropicChunk({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_9', name: 'Bash' } }, acc, (e) => {
      if (e.type === 'tool-call-start') events.push(`${e.id}:${e.name}`);
    });
    processAnthropicChunk({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"comm' } }, acc);
    processAnthropicChunk({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'and":"ls"}' } }, acc);
    expect(acc.toolUses.get(1)).toEqual({ id: 'toolu_9', name: 'Bash', json: '{"command":"ls"}' });
    expect(events).toEqual(['toolu_9:Bash']);
  });

  it('thinking_delta 走 reasoning；text_delta 走 content', () => {
    const acc = { content: '', reasoning: '', toolUses: new Map(), startedToolCalls: new Set() };
    const reasons: string[] = [];
    processAnthropicChunk({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想想' } }, acc, (e) => {
      if (e.type === 'reasoning-delta') reasons.push(e.delta);
    });
    processAnthropicChunk({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '答' } }, acc);
    expect(acc.reasoning).toBe('想想');
    expect(acc.content).toBe('答');
    expect(reasons).toEqual(['想想']);
  });
});

describe('createAnthropicProvider.chat（端到端流式）', () => {
  const REQ: ChatRequest = {
    model: 'glm-4.7',
    messages: [
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '帮我执行 ls' },
    ],
    tools: [{ name: 'Bash', description: '执行命令', parameters: { type: 'object', properties: { command: { type: 'string' } } } }],
  };

  it('文本 + 工具调用 + usage 完整组装；请求头/路径/请求体为 Anthropic 协议', async () => {
    let captured!: Request;
    const provider = createAnthropicProvider({
      apiKey: 'sk-ant-test',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      fetchImpl: async (input, init) => {
        captured = new Request(input as string, init);
        return sseResponse([
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好的"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls\\"}"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]);
      },
    });
    const toolEnds: string[] = [];
    const res = await provider.chat(REQ, (e) => {
      if (e.type === 'tool-call-end') toolEnds.push(`${e.id}:${e.name}:${e.arguments}`);
    });

    // 请求侧：Anthropic 协议（x-api-key + /messages + system 顶层 + input_schema）
    expect(captured.url).toBe('https://open.bigmodel.cn/api/anthropic/messages');
    expect(captured.headers.get('x-api-key')).toBe('sk-ant-test');
    expect(captured.headers.get('anthropic-version')).toBe('2023-06-01');
    const body = JSON.parse(await captured.clone().text()) as Record<string, unknown>;
    expect(body['system']).toBe('系统提示');
    expect((body['tools'] as Array<{ input_schema: unknown }>)[0]!.input_schema).toBeDefined();
    expect(body['max_tokens']).toBeGreaterThan(0);

    // 响应侧：文本 + 工具调用 + usage + finishReason
    expect(res.message.content).toBe('好的');
    expect(res.message.toolCalls?.[0]).toEqual({ id: 'toolu_1', name: 'Bash', arguments: '{"command":"ls"}' });
    expect(res.usage?.totalTokens).toBe(32); // input 12 + output 20
    expect(res.finishReason).toBe('tool_calls');
    expect(toolEnds).toEqual(['toolu_1:Bash:{"command":"ls"}']);
  });

  it('429 重试后成功', async () => {
    let calls = 0;
    const provider = createAnthropicProvider({
      apiKey: 'k',
      maxRetries: 1,
      fetchImpl: async () => {
        calls++;
        if (calls === 1) return new Response('rate limited', { status: 429 });
        return sseResponse(['data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n', 'data: {"type":"message_stop"}\n\n']);
      },
    });
    const res = await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(calls).toBe(2);
    expect(res.message.role).toBe('assistant');
  });
});
