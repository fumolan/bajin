import { describe, expect, it } from 'vitest';
import { SseBuffer, createGlmProvider } from '../src/providers/glm.js';
import type { ChatRequest } from '@bajin/shared';

describe('SseBuffer', () => {
  it('跨 chunk 的行重组与 [DONE] 识别', () => {
    const sse = new SseBuffer();
    const a = sse.feed('data: {"choices":[{"delta":{"content":"he');
    const b = sse.feed('llo"}}]}\n\ndata: [DONE]\n');
    expect(a).toEqual([]);
    const parsed = b.filter((x) => x !== null);
    expect((parsed[0] as Record<string, unknown>)['choices']).toBeDefined();
    expect(b.some((x) => x === null)).toBe(true);
  });

  it('忽略注释行与非 data 行', () => {
    const sse = new SseBuffer();
    const out = sse.feed(': keepalive\nevent: x\ndata: {"ok":1}\n');
    expect(out).toEqual([{ ok: 1 }]);
  });
});

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

const REQ: ChatRequest = { model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] };

describe('createGlmProvider.chat（流式解析）', () => {
  it('文本增量 + usage 聚合', async () => {
    const provider = createGlmProvider({
      apiKey: 'test-key',
      fetchImpl: async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"你"},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
          'data: [DONE]\n\n',
        ]),
    });
    const deltas: string[] = [];
    const res = await provider.chat(REQ, (e) => {
      if (e.type === 'text-delta') deltas.push(e.delta);
    });
    expect(deltas).toEqual(['你', '好']);
    expect(res.message.content).toBe('你好');
    expect(res.message.role).toBe('assistant');
    expect(res.usage?.totalTokens).toBe(15);
    expect(res.finishReason).toBe('stop');
  });

  it('工具调用跨 chunk 参数拼接', async () => {
    const provider = createGlmProvider({
      apiKey: 'test-key',
      fetchImpl: async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"Read","arguments":"{\\"file"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"_path\\": \\"a.ts\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
    });
    const events: string[] = [];
    const res = await provider.chat(REQ, (e) => events.push(e.type));
    const msg = res.message;
    if (msg.role !== 'assistant') throw new Error('unexpected role');
    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.toolCalls![0]).toMatchObject({ id: 'call_1', name: 'Read' });
    expect(JSON.parse(msg.toolCalls![0]!.arguments)).toEqual({ file_path: 'a.ts' });
    expect(events).toContain('tool-call-start');
    expect(res.finishReason).toBe('tool_calls');
  });

  it('4xx 错误直接抛 ApiError（不重试）', async () => {
    let calls = 0;
    const provider = createGlmProvider({
      apiKey: 'bad',
      fetchImpl: async () => {
        calls++;
        return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 });
      },
    });
    await expect(provider.chat(REQ)).rejects.toThrow('401');
    expect(calls).toBe(1);
  });

  it('缺少 api key 时给出可操作的错误', async () => {
    const provider = createGlmProvider({ apiKey: '', fetchImpl: async () => { throw new Error('unreachable'); } });
    await expect(provider.chat(REQ)).rejects.toThrow('BIGMODEL_API_KEY');
  });
});
