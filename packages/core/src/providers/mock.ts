import type { ChatRequest, ChatResponse, ModelProvider, StreamEvent } from '@bajin/shared';

export interface MockStep {
  text?: string;
  reasoning?: string;
  toolCalls?: Array<{ name: string; args: unknown }>;
}

export interface MockProvider extends ModelProvider {
  /** 记录每次 chat 的请求，供测试断言 */
  calls: ChatRequest[];
}

/**
 * 脚本化 provider：按顺序吐出预设的回复步（文本/推理/工具调用），
 * 用于无 API key 的开发与端到端测试。
 */
export function createMockProvider(steps: MockStep[], model = 'mock-1'): MockProvider {
  const calls: ChatRequest[] = [];
  let cursor = 0;
  let callSeq = 0;

  async function chat(req: ChatRequest, onEvent?: (e: StreamEvent) => void): Promise<ChatResponse> {
    calls.push(structuredClone(req));
    const step = steps[Math.min(cursor, steps.length - 1)] ?? {};
    cursor++;

    if (step.reasoning && onEvent) {
      for (const piece of step.reasoning.match(/.{1,8}/gs) ?? []) {
        onEvent({ type: 'reasoning-delta', delta: piece });
      }
    }
    const toolCalls = (step.toolCalls ?? []).map((c) => {
      callSeq++;
      return { id: `call_mock_${callSeq}`, name: c.name, arguments: JSON.stringify(c.args) };
    });
    for (const c of toolCalls) {
      onEvent?.({ type: 'tool-call-start', id: c.id, name: c.name });
      onEvent?.({ type: 'tool-call-end', id: c.id, name: c.name, arguments: c.arguments });
    }
    if (step.text && onEvent) {
      for (const piece of step.text.match(/.{1,6}/gs) ?? []) {
        onEvent({ type: 'text-delta', delta: piece });
      }
    }
    const usage = { inputTokens: 10 + calls.length, outputTokens: 20 + cursor, totalTokens: 30 + calls.length + cursor };
    onEvent?.({ type: 'usage', usage });

    return {
      message: {
        role: 'assistant',
        content: step.text ?? '',
        ...(toolCalls.length ? { toolCalls } : {}),
      },
      usage,
      finishReason: toolCalls.length ? 'tool_calls' : 'stop',
    };
  }

  return { id: 'mock', defaultModel: model, chat, calls };
}
