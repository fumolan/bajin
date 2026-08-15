import { z } from 'zod';

// ---------- 权限 ----------

export type PermissionMode = 'plan' | 'build' | 'edit' | 'yolo';

export const PERMISSION_MODES: readonly PermissionMode[] = ['plan', 'build', 'edit', 'yolo'];

export type PermissionDecision = 'allow' | 'ask' | 'deny';

export type RiskLevel = 'low' | 'medium' | 'high';

// ---------- 工具 ----------

export interface ToolMetadata {
  /** 只读工具（不产生副作用）在任何模式下都免审批 */
  readOnly: boolean;
  riskLevel: RiskLevel;
  /** 执行超时（毫秒），超时则终止并报错 */
  timeoutMs?: number;
  /** 连续多次调用时可并发执行（如批量 Read/Glob）；有副作用的工具必须为 false */
  concurrentSafe?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  /** 原始 JSON 字符串参数 */
  arguments: string;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface UserQuestionOption {
  label: string;
  description?: string;
}

export interface UserQuestion {
  question: string;
  header?: string;
  options?: UserQuestionOption[];
  multiSelect?: boolean;
}

export interface UserAnswer {
  answer: string;
  notes?: string;
}

export interface ToolContext {
  cwd: string;
  env?: Record<string, string>;
  /** 工具间共享的会话级状态（如 TodoWrite 的清单） */
  state: Map<string, unknown>;
  /** 向用户提问；无人交互时返回 null */
  askUser(question: UserQuestion): Promise<UserAnswer | null>;
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  inputSchema: S;
  metadata: ToolMetadata;
  execute(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

// ---------- 消息 ----------

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

// ---------- 模型 Provider ----------

export type StreamEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'tool-call-start'; id: string; name: string }
  | { type: 'tool-call-end'; id: string; name: string; arguments: string }
  | { type: 'usage'; usage: UsageInfo };

export interface ProviderTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ProviderTool[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ChatResponse {
  message: ChatMessage;
  usage?: UsageInfo;
  finishReason?: string;
}

export interface ModelProvider {
  id: string;
  defaultModel: string;
  chat(req: ChatRequest, onEvent?: (event: StreamEvent) => void): Promise<ChatResponse>;
}

/** 把 zod schema 转成 provider 需要的 JSON Schema */
export function toolSchemaToParameters(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}
