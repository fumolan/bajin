import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  toolSchemaToParameters,
  type ChatMessage,
  type ModelProvider,
  type PermissionMode,
  type ProviderTool,
  type ToolCall,
  type ToolContext,
  type ToolDefinition,
  type UsageInfo,
} from '@bajin/shared';
import { PermissionPolicy } from './permissions.js';
import { buildSystemPrompt, estimateTokens, type SkillSummary, type TodoSnapshot } from './prompt.js';
import { builtinTools } from './tools/index.js';
import { createEnterPlanModeTool, createExitPlanModeTool, type PlanModeHost } from './tools/plan.js';
import { createSkillTool } from './tools/skill.js';
import { createSubagentTool } from './tools/subagent.js';
import { clipSkillBody, discoverSkills, type DiscoveredSkill } from './skills.js';
import { appendMessage, loadTranscript, listSessions, type SessionMeta } from './session.js';
import { HookRunner, type HooksConfig } from './hooks.js';
import { loadMcpServerConfigs, connectMcpServers, type McpRuntime } from './mcp.js';
import { discoverSubagents, type SubagentDef } from './subagents.js';
import { createMemoryTool, memoryPromptBlock, readMemories, type MemoryEntry } from './memory.js';

export interface AgentCallbacks {
  onText?(delta: string): void;
  onReasoning?(delta: string): void;
  onToolCall?(name: string, args: unknown): void;
  onToolResult?(name: string, result: { ok: boolean; output: string; denied?: boolean }): void;
  /** 工具/计划需要用户批准；返回 true 放行。未提供时视为拒绝（headless 安全默认） */
  onApproval?(name: string, args: unknown): Promise<boolean>;
  onUsage?(usage: UsageInfo): void;
}

export interface AgentOptions {
  provider: ModelProvider;
  /** 子代理用的 provider 工厂（默认复用 provider 实例；测试时注入独立 mock） */
  providerFactory?: () => ModelProvider;
  model: string;
  cwd: string;
  mode: PermissionMode;
  tools?: ToolDefinition[];
  policy?: PermissionPolicy;
  callbacks?: AgentCallbacks;
  maxIterations?: number;
  /** 每个工具结果的输出上限（字符） */
  maxToolOutputChars?: number;
  /** 覆盖默认的 askUser（无人交互环境返回 null） */
  askUser?: ToolContext['askUser'];
  /** 是否启用 Agent 子代理工具（默认 true；子代理内部为 false 防递归） */
  enableSubagent?: boolean;
  /** 开启后把每次模型请求/响应落到 <dir>/model-io-<sessionId>.jsonl（对标 ZCode rollout 日志） */
  rolloutDir?: string;
  /** 开启后把会话消息落到 <dir>/<sessionId>/transcript.jsonl，支撑 --continue/--resume */
  persistDir?: string;
  /** SQLite 双写通道（过渡期）：每条持久化消息同时入 store；JSONL 仍为读路径。异常只吞不阻断 */
  storeSink?: (msg: ChatMessage) => void;
  /** 禁用的技能名（config.json skillsDisabled）：不出现在系统提示清单，Skill 执行直接拒绝 */
  disabledSkills?: string[];
  /** 恢复既有会话时传入 */
  sessionId?: string;
  /** 附加到 system prompt 末尾的说明（子代理人格等） */
  promptSuffix?: string;
  /** @internal 子代理继承父代理已发现的 skills，避免重复扫描 */
  inheritSkillsFrom?: Agent;
  /** hooks 配置（默认关闭；enabled:true 才执行，见 hooks.ts） */
  hooks?: HooksConfig;
}

export interface AgentResult {
  text: string;
  usage: UsageInfo;
  iterations: number;
  toolCalls: number;
  denied: number;
  tokens: number;
  /** 用户主动中断 */
  cancelled?: boolean;
}

const DEFAULT_MAX_ITERATIONS = 40;
/** 历史超过该字符量（约 9 万 token）时自动压缩 */
const AUTO_COMPACT_CHARS = 220_000;

/** 把一次回复里的工具调用切成分组：连续的 concurrentSafe 调用并入同组（组内并发），其余独占一组 */
export function groupToolCalls(calls: ToolCall[], lookup: (name: string) => ToolDefinition | undefined): ToolCall[][] {
  const groups: ToolCall[][] = [];
  let batch: ToolCall[] = [];
  for (const call of calls) {
    const safe = lookup(call.name)?.metadata.concurrentSafe === true;
    if (safe) {
      batch.push(call);
    } else {
      if (batch.length) {
        groups.push(batch);
        batch = [];
      }
      groups.push([call]);
    }
  }
  if (batch.length) groups.push(batch);
  return groups;
}

interface Gate {
  tool?: ToolDefinition;
  args?: unknown;
  status: 'allow' | 'ask' | 'deny';
  msg?: string;
}

export class Agent implements PlanModeHost {
  readonly sessionId: string;
  readonly messages: ChatMessage[] = [];
  private readonly policy: PermissionPolicy;
  private readonly toolsMap: Map<string, ToolDefinition>;
  private callbacks: AgentCallbacks;
  private readonly maxIterations: number;
  private readonly maxToolOutputChars: number;
  private readonly state = new Map<string, unknown>();
  private _planMode = false;
  private skills: DiscoveredSkill[] = [];
  private subagents: SubagentDef[] = [];
  private memories: MemoryEntry[] = [];
  private agentsMd: { user?: string; project?: string } = {};
  private rolloutPath?: string;
  private transcriptPath?: string;
  private mode: PermissionMode;
  private compacting = false;
  private readonly opts: AgentOptions;
  private readonly initPromise: Promise<void>;
  private cancelRequested = false;
  private activeAbort: AbortController | null = null;
  private readonly hookRunner: HookRunner;
  /** 本次 run 里 Stop 钩子已续跑的次数（上限 3） */
  private stopContinues = 0;
  /** SessionStart 钩子注入的附加上下文（随下一条用户消息生效后清空） */
  private hookExtraContext = '';

  constructor(opts: AgentOptions) {
    this.opts = opts;
    this.mode = opts.mode;
    this.policy =
      opts.policy ?? new PermissionPolicy({ mode: opts.mode, allowedTools: [], disallowedTools: [] });
    this.sessionId = opts.sessionId ?? `sess_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    this.callbacks = opts.callbacks ?? {};
    this.maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.maxToolOutputChars = opts.maxToolOutputChars ?? 30_000;
    this.hookRunner = new HookRunner(opts.hooks, { cwd: opts.cwd, sessionId: this.sessionId });

    // 工具集 = 内置 + 计划模式 + Skill + Memory + （可选）子代理
    const toolList: ToolDefinition[] = [...(opts.tools ?? builtinTools)];
    if (!opts.tools) {
      // opts.tools 由子代理场景显式传入过滤后的集合，不追加动态工具
      toolList.push(createEnterPlanModeTool(() => this), createExitPlanModeTool(() => this));
      toolList.push(createSkillTool(() => this, clipSkillBody));
      toolList.push(createMemoryTool(() => this.opts.cwd, () => void this.refreshMemory()));
      if (opts.enableSubagent !== false) toolList.push(createSubagentTool(() => this));
    }
    this.toolsMap = new Map(toolList.map((t) => [t.name, t]));

    this.initPromise = this.initContext();
  }

  /** 等 skills/AGENTS.md/持久化目录就绪（测试与恢复会话前 await） */
  get ready(): Promise<void> {
    return this.initPromise;
  }

  private async initContext(): Promise<void> {
    // skills：子代理继承父代理的发现结果，否则现场扫描
    if (this.opts.inheritSkillsFrom) {
      this.skills = this.opts.inheritSkillsFrom.skillsSnapshot();
    } else {
      this.skills = await discoverSkills(this.opts.cwd).catch(() => []);
    }
    // 自定义子代理定义（.bajin/agents/*.md）：发现后重建 Agent 工具描述（列出可用类型）
    if (!this.opts.inheritSkillsFrom) {
      this.subagents = await discoverSubagents(this.opts.cwd).catch(() => []);
      if (this.subagents.length && this.toolsMap.has('Agent')) {
        this.toolsMap.set('Agent', createSubagentTool(() => this, this.subagents));
      }
    }
    const read = async (p: string) => fs.readFile(p, 'utf8').catch(() => undefined);
    this.agentsMd.project = await read(path.join(this.opts.cwd, 'AGENTS.md'));
    if (!this.agentsMd.project) this.agentsMd.project = await read(path.join(this.opts.cwd, '.bajin', 'AGENTS.md'));
    // 长期记忆（用户级 + 项目级），随 systemPrompt 注入
    this.memories = await readMemories(this.opts.cwd).catch(() => []);

    if (this.opts.rolloutDir) {
      await fs.mkdir(this.opts.rolloutDir, { recursive: true }).catch(() => undefined);
      this.rolloutPath = path.join(this.opts.rolloutDir, `model-io-${this.sessionId}.jsonl`);
    }
    if (this.opts.persistDir) {
      const dir = path.join(this.opts.persistDir, this.sessionId);
      await fs.mkdir(dir, { recursive: true }).catch(() => undefined);
      this.transcriptPath = path.join(dir, 'transcript.jsonl');
      await fs.writeFile(
        path.join(dir, 'meta.json'),
        JSON.stringify({ sessionId: this.sessionId, model: this.opts.model, cwd: this.opts.cwd, createdAt: new Date().toISOString() }, null, 2),
      ).catch(() => undefined);
    }
    // SessionStart(startup)：附加上下文记入 hookExtraContext，随下一条用户消息注入
    const startHook = await this.hookRunner.fire('SessionStart', { source: 'startup' }).catch(() => undefined);
    if (startHook?.additionalContext) this.hookExtraContext = startHook.additionalContext;

    // MCP：主会话（非子代理）按 ~/.bajin/config.json mcpServers 连接 stdio server，
    // 工具以 mcp__<server>__<tool> 注入；连接失败仅告警不阻断
    if (!this.opts.inheritSkillsFrom) {
      try {
        const configs = await loadMcpServerConfigs();
        if (Object.keys(configs).some((k) => configs[k]?.type === 'stdio')) {
          this.mcp = await connectMcpServers(configs);
          for (const t of this.mcp.tools) this.toolsMap.set(t.name, t);
        }
      } catch {
        /* MCP 不可用不阻断会话 */
      }
    }
  }

  /** MCP 子进程集合（会话结束时由宿主调 dispose 释放；Agent 无显式析构钩子，留给调用方） */
  private mcp: McpRuntime | null = null;

  disposeMcp(): void {
    this.mcp?.dispose();
    this.mcp = null;
  }

  // —— 对外状态 ——

  get planMode(): boolean {
    return this._planMode;
  }

  get currentMode(): PermissionMode {
    return this.mode;
  }

  get model(): string {
    return this.opts.model;
  }

  toolset(): ToolDefinition[] {
    return [...this.toolsMap.values()];
  }

  skillsSnapshot(): DiscoveredSkill[] {
    return [...this.skills];
  }

  subagentsSnapshot(): SubagentDef[] {
    return [...this.subagents];
  }

  memoriesSnapshot(): MemoryEntry[] {
    return [...this.memories];
  }

  /** Memory 工具保存后：重读文件并刷新 system prompt（下一轮生效） */
  private async refreshMemory(): Promise<void> {
    this.memories = await readMemories(this.opts.cwd).catch(() => this.memories);
    this.refreshSystem();
  }

  skillSummaries(): SkillSummary[] {
    const off = new Set(this.opts.disabledSkills ?? []);
    return this.skills.filter((s) => !off.has(s.name)).map(({ name, description }) => ({ name, description }));
  }

  /** @internal 供子代理工具转发事件 */
  subagentForward(): AgentCallbacks {
    return this.callbacks;
  }

  /** @internal 供子代理创建独立 provider */
  newSubagentProvider(): ModelProvider {
    return this.opts.providerFactory ? this.opts.providerFactory() : this.opts.provider;
  }

  getSkill(name: string): { file: string } | undefined {
    const s = this.skills.find((x) => x.name === name);
    return s ? { file: s.file } : undefined;
  }

  disabledSkills(): string[] {
    return this.opts.disabledSkills ?? [];
  }

  enterPlan(): void {
    this._planMode = true;
  }

  /** 计划审批：走 callbacks.onApproval（REPL/桌面已有审批 UI，计划在 args.plan 里） */
  async submitPlan(plan: string): Promise<boolean> {
    const approved = (await this.callbacks.onApproval?.('ExitPlanMode', { plan })) ?? false;
    if (approved) {
      this._planMode = false;
      if (this.mode === 'plan') this.mode = 'build';
      this.policy.setMode(this.mode);
    }
    return approved;
  }

  providerTools(): ProviderTool[] {
    return [...this.toolsMap.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: toolSchemaToParameters(t.inputSchema),
    }));
  }

  toolContext(): ToolContext {
    return {
      cwd: this.opts.cwd,
      state: this.state,
      askUser: this.opts.askUser ?? (async () => null),
    };
  }

  /** 动态 system prompt：todo 状态/skills 清单每轮回注 */
  private systemPrompt(): string {
    const todos = this.state.get('todoList') as TodoSnapshot[] | undefined;
    let prompt = buildSystemPrompt({
      cwd: this.opts.cwd,
      platform: `${process.platform}/${process.arch}`,
      date: new Date().toISOString().slice(0, 10),
      mode: this.mode,
      planMode: this._planMode,
      todos,
      skills: this.skillSummaries(),
      userAgentsMd: this.agentsMd.user,
      projectAgentsMd: this.agentsMd.project,
    });
    const memBlock = memoryPromptBlock(this.memories);
    if (memBlock) prompt += `\n${memBlock}`;
    if (this.opts.promptSuffix) prompt += this.opts.promptSuffix;
    return prompt;
  }

  private refreshSystem(): void {
    const sys: ChatMessage = { role: 'system', content: this.systemPrompt() };
    if (this.messages.length === 0) this.messages.push(sys);
    else this.messages[0] = sys;
  }

  reset(): void {
    this.messages.length = 0;
    this.state.clear();
    this._planMode = false;
    // SessionStart(clear)：异步触发，注入的上下文随下一条用户消息生效
    void this.hookRunner
      .fire('SessionStart', { source: 'clear' })
      .then((r) => {
        if (r.additionalContext) this.hookExtraContext = r.additionalContext;
      })
      .catch(() => undefined);
  }

  // —— 主循环 ——

  async run(userInput: string): Promise<AgentResult> {
    this.cancelRequested = false;
    this.activeAbort = new AbortController();
    this.refreshSystem();
    // UserPromptSubmit 钩子：可注入附加上下文或阻止本次提交
    let input = userInput;
    if (this.hookExtraContext) {
      input = `${userInput}\n\n附加上下文（hook 注入）:\n${this.hookExtraContext}`;
      this.hookExtraContext = '';
    }
    const promptHook = await this.hookRunner.fire('UserPromptSubmit', { prompt: userInput });
    if (promptHook.blocked) {
      return {
        text: `(被 UserPromptSubmit 钩子阻止${promptHook.reason ? `：${promptHook.reason}` : ''})`,
        usage: {}, iterations: 0, toolCalls: 0, denied: 0, tokens: 0,
      };
    }
    if (promptHook.additionalContext) input = `${input}\n\n附加上下文（hook 注入）:\n${promptHook.additionalContext}`;
    this.messages.push({ role: 'user', content: input });
    await this.persist({ role: 'user', content: input });
    const usage: UsageInfo = {};
    let iterations = 0;
    let toolCallCount = 0;
    let denied = 0;
    this.stopContinues = 0;

    while (iterations < this.maxIterations) {
      iterations++;
      this.maybeAutoCompact();
      this.refreshSystem(); // todo 状态可能在上一轮被 TodoWrite 更新

      let response: Awaited<ReturnType<ModelProvider['chat']>>;
      try {
        response = await this.chat({
          model: this.opts.model,
          messages: [...this.messages],
          tools: this.providerTools(),
          signal: this.activeAbort.signal,
        });
      } catch (err) {
        if (this.cancelRequested || (err instanceof Error && err.name === 'AbortError')) {
          return {
            text: '(已被用户中断)',
            usage,
            iterations,
            toolCalls: toolCallCount,
            denied,
            tokens: 0,
            cancelled: true,
          };
        }
        throw err;
      }
      if (this.cancelRequested) {
        return { text: '(已被用户中断)', usage, iterations, toolCalls: toolCallCount, denied, tokens: 0, cancelled: true };
      }
      if (response.usage) {
        usage.inputTokens = (usage.inputTokens ?? 0) + (response.usage.inputTokens ?? 0);
        usage.outputTokens = (usage.outputTokens ?? 0) + (response.usage.outputTokens ?? 0);
        usage.totalTokens = (usage.totalTokens ?? 0) + (response.usage.totalTokens ?? 0);
        this.callbacks.onUsage?.(response.usage);
      }

      const assistantMsg = response.message;
      if (assistantMsg.role !== 'assistant') throw new Error(`provider 返回了意外的消息角色: ${assistantMsg.role}`);
      this.messages.push(assistantMsg);
      await this.persist(assistantMsg);

      const calls = assistantMsg.toolCalls ?? [];
      if (!calls.length) {
        // Stop 钩子：可阻止停止并请求续跑（单次 run 最多 3 次）
        const stopHook = await this.hookRunner.fire('Stop', { response: assistantMsg.content.slice(0, 200) });
        if (stopHook.continueRun && this.stopContinues < 3) {
          this.stopContinues++;
          const why = stopHook.reason ?? '钩子请求继续';
          this.messages.push({ role: 'user', content: `(继续任务：${why})` });
          await this.persist({ role: 'user', content: `(继续任务：${why})` });
          continue;
        }
        return {
          text: assistantMsg.content,
          usage,
          iterations,
          toolCalls: toolCallCount,
          denied,
          tokens: estimateTokens(JSON.stringify(this.messages)),
        };
      }

      toolCallCount += calls.length;
      if (this.cancelRequested) {
        return { text: '(已被用户中断)', usage, iterations, toolCalls: toolCallCount, denied, tokens: 0, cancelled: true };
      }
      // 并发分组执行：连续只读调用并发，副作用调用串行
      for (const group of groupToolCalls(calls, (n) => this.toolsMap.get(n))) {
        if (group.length === 1) {
          const r = await this.executeToolCall(group[0]!);
          if (r.denied) denied++;
          this.pushToolMessage(group[0]!, r);
        } else {
          const results = await this.executeGroupParallel(group);
          results.forEach((r, i) => {
            if (r.denied) denied++;
            this.pushToolMessage(group[i]!, r);
          });
        }
      }
    }

    return {
      text: `已达最大迭代次数（${this.maxIterations}），强制停止。这可能意味着任务过大或模型陷入循环。`,
      usage,
      iterations,
      toolCalls: toolCallCount,
      denied,
      tokens: 0,
    };
  }

  private pushToolMessage(call: ToolCall, r: { ok: boolean; output: string; denied?: boolean }): void {
    this.messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: r.output });
    void this.persist({ role: 'tool', toolCallId: call.id, name: call.name, content: r.output });
  }

  /** 组内并发：先串行完成钩子/权限/审批，再并发执行，结果按原顺序返回 */
  private async executeGroupParallel(group: ToolCall[]): Promise<Array<{ ok: boolean; output: string; denied?: boolean }>> {
    let gates = group.map((c) => this.gate(c));
    for (let i = 0; i < group.length; i++) {
      gates[i] = await this.applyHooksToGate(group[i]!, gates[i]!);
      if (gates[i]!.status === 'ask') {
        const approved = (await this.callbacks.onApproval?.(group[i]!.name, gates[i]!.args)) ?? false;
        gates[i] = approved ? { ...gates[i]!, status: 'allow' } : { status: 'deny', msg: `用户未批准执行 ${group[i]!.name}，已跳过。` };
      }
    }
    return Promise.all(
      group.map(async (c, i) => {
        const g = gates[i]!;
        if (g.status === 'deny' || !g.tool || g.args === undefined) {
          const output = g.msg ?? '无法执行';
          this.callbacks.onToolResult?.(c.name, { ok: false, output, denied: true });
          await this.hookRunner.fire('PostToolUseFailure', { toolName: c.name, toolInput: g.args, toolOutput: output });
          return { ok: false, output, denied: true };
        }
        return this.runTool(c, g.tool, g.args);
      }),
    );
  }

  /** 单个工具调用全流程（含钩子与审批） */
  private async executeToolCall(call: ToolCall): Promise<{ ok: boolean; output: string; denied?: boolean }> {
    let gate = this.gate(call);
    gate = await this.applyHooksToGate(call, gate);
    if (gate.status === 'deny') {
      const output = gate.msg ?? '权限不足';
      this.callbacks.onToolResult?.(call.name, { ok: false, output, denied: true });
      await this.hookRunner.fire('PostToolUseFailure', { toolName: call.name, toolInput: gate.args, toolOutput: output });
      return { ok: false, output, denied: true };
    }
    if (gate.status === 'ask') {
      const approved = (await this.callbacks.onApproval?.(call.name, gate.args)) ?? false;
      if (!approved) {
        const output = `用户未批准执行 ${call.name}，已跳过。请改用其他方式或询问用户意图。`;
        this.callbacks.onToolResult?.(call.name, { ok: false, output, denied: true });
        await this.hookRunner.fire('PostToolUseFailure', { toolName: call.name, toolInput: gate.args, toolOutput: output });
        return { ok: false, output, denied: true };
      }
    }
    return this.runTool(call, gate.tool!, gate.args!);
  }

  /**
   * 钩子对权限门的作用（顺序与 ZCode 对齐）：
   *   PreToolUse（matcher 命中工具名）→ deny 阻止 / allow 直接放行（跳过审批）；
   *   仍为 ask 时再触发 PermissionRequest → deny 阻止 / allow 免审批；否则交给用户。
   */
  private async applyHooksToGate(call: ToolCall, gate: Gate): Promise<Gate> {
    if (gate.status === 'deny') return gate; // 未知工具/参数错误等已在 gate 拒绝，无需钩子
    const pre = await this.hookRunner.fire('PreToolUse', { toolName: call.name, toolInput: gate.args });
    if (pre.blocked || pre.decision === 'deny') {
      return { ...gate, status: 'deny', msg: `PreToolUse 钩子拒绝了 ${call.name}${pre.reason ? `：${pre.reason}` : ''}` };
    }
    if (pre.decision === 'allow') return { ...gate, status: 'allow' };
    if (gate.status === 'ask') {
      const perm = await this.hookRunner.fire('PermissionRequest', { toolName: call.name, toolInput: gate.args });
      if (perm.blocked || perm.decision === 'deny') {
        return { ...gate, status: 'deny', msg: `PermissionRequest 钩子拒绝了 ${call.name}${perm.reason ? `：${perm.reason}` : ''}` };
      }
      if (perm.decision === 'allow') return { ...gate, status: 'allow' };
    }
    return gate;
  }

  /** 权限/解析门控：未知工具、参数错误、planMode、policy 全在这判定 */
  private gate(call: ToolCall): Gate {
    const tool = this.toolsMap.get(call.name);
    if (!tool) {
      return { status: 'deny', msg: `未知工具: ${call.name}。可用工具: ${[...this.toolsMap.keys()].join(', ')}` };
    }
    let args: unknown;
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      return { status: 'deny', msg: `参数不是合法 JSON: ${call.arguments.slice(0, 200)}` };
    }
    const parsed = tool.inputSchema.safeParse(args);
    if (!parsed.success) {
      return {
        status: 'deny',
        msg: `参数校验失败: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      };
    }
    const isPlanTool = call.name === 'EnterPlanMode' || call.name === 'ExitPlanMode';
    if (this._planMode && !tool.metadata.readOnly && !isPlanTool) {
      return { status: 'deny', msg: `计划模式生效中：只允许只读工具调研，${call.name} 被拒绝。完成调研后用 ExitPlanMode 提交计划。`, tool, args: parsed.data };
    }
    const decision = this.policy.decide(tool);
    if (decision === 'deny') {
      return { status: 'deny', msg: `权限不足：${this.policy.denyReason(tool)}`, tool, args: parsed.data };
    }
    return { tool, args: parsed.data, status: decision };
  }

  /** 真正执行（权限已通过）：超时保护 + 输出截断 + 事件回调 */
  private async runTool(call: ToolCall, tool: ToolDefinition, args: unknown): Promise<{ ok: boolean; output: string }> {
    this.callbacks.onToolCall?.(call.name, args);
    const timeoutMs = tool.metadata.timeoutMs ?? 120_000;
    try {
      const result = await Promise.race([
        tool.execute(args, this.toolContext()),
        new Promise<{ ok: false; output: string }>((resolve) =>
          setTimeout(() => resolve({ ok: false, output: `工具 ${call.name} 执行超时（${timeoutMs}ms）` }), timeoutMs),
        ),
      ]);
      const output =
        result.output.length > this.maxToolOutputChars
          ? `${result.output.slice(0, this.maxToolOutputChars)}\n...(工具输出已截断)`
          : result.output;
      const extra = await this.hookRunner.fire('PostToolUse', { toolName: call.name, toolInput: args, toolOutput: output });
      const finalOutput = extra.additionalContext ? `${output}\n(hook 注入: ${extra.additionalContext})` : output;
      const final = { ...result, output: finalOutput };
      this.callbacks.onToolResult?.(call.name, final);
      return final;
    } catch (err) {
      const output = `工具执行异常: ${err instanceof Error ? err.message : String(err)}`;
      this.callbacks.onToolResult?.(call.name, { ok: false, output });
      await this.hookRunner.fire('PostToolUseFailure', { toolName: call.name, toolInput: args, toolOutput: output });
      return { ok: false, output };
    }
  }

  // —— 模型调用（带 rollout 日志） ——

  private async chat(req: Parameters<ModelProvider['chat']>[0]): Promise<ReturnType<ModelProvider['chat']> extends Promise<infer T> ? T : never> {
    const started = Date.now();
    if (this.rolloutPath) {
      void fs.appendFile(this.rolloutPath, `${JSON.stringify({ ts: new Date().toISOString(), dir: 'request', model: req.model, messages: req.messages })}\n`).catch(() => undefined);
    }
    const res = await this.opts.provider.chat(req, (event) => {
      if (event.type === 'text-delta') this.callbacks.onText?.(event.delta);
      else if (event.type === 'reasoning-delta') this.callbacks.onReasoning?.(event.delta);
    });
    if (this.rolloutPath) {
      void fs.appendFile(this.rolloutPath, `${JSON.stringify({ ts: new Date().toISOString(), dir: 'response', ms: Date.now() - started, message: res.message, usage: res.usage, finishReason: res.finishReason })}\n`).catch(() => undefined);
    }
    return res;
  }

  // —— 持久化 ——

  private async persist(msg: ChatMessage): Promise<void> {
    if (this.transcriptPath) await appendMessage(this.transcriptPath, msg);
    if (this.opts.storeSink) {
      try {
        this.opts.storeSink(msg);
      } catch {
        /* SQLite 双写失败不影响会话（JSONL 为主） */
      }
    }
  }

  /** 历史上下文用量（粗估 token） */
  contextTokens(): number {
    return estimateTokens(JSON.stringify(this.messages));
  }

  /** 当前 todo 清单快照（供 UI 实时渲染） */
  todoSnapshot(): Array<{ content: string; status: string; priority: string }> {
    return ((this.state.get('todoList') as Array<{ content: string; status: string; priority: string }> | undefined) ?? []).map((t) => ({ ...t }));
  }

  /** 用户中断：中止当前模型调用，并在最近的检查点退出循环 */
  abort(): void {
    this.cancelRequested = true;
    this.activeAbort?.abort();
  }

  // —— 宿主注入点（app-server 等宿主在会话建立后绑定事件回调与交互） ——

  setCallbacks(cb: AgentCallbacks): void {
    this.callbacks = cb;
  }

  setAskUser(fn: ToolContext['askUser']): void {
    this.opts.askUser = fn;
  }

  /** 切权限模式（不重建实例，todo 等状态保留） */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
    this.policy.setMode(mode);
  }

  /** 「始终允许」某工具：原地生效，进行中的循环同样感知 */
  allowTool(name: string): void {
    this.policy.allowTool(name);
  }

  disallowTool(name: string): void {
    this.policy.disallowTool(name);
  }

  private maybeAutoCompact(): void {
    if (this.compacting) return;
    if (JSON.stringify(this.messages).length < AUTO_COMPACT_CHARS) return;
    void this.compact().catch(() => undefined);
  }

  /** 压缩历史：摘要 + 保留最近两轮（/compact 与自动触发共用） */
  async compact(): Promise<{ before: number; after: number }> {
    if (this.compacting) return { before: 0, after: 0 };
    this.compacting = true;
    try {
      const before = this.contextTokens();
      const history = this.messages.filter((m) => m.role !== 'system');
      if (history.length <= 4) return { before, after: before };
      const flat = history
        .map((m) => {
          if (m.role === 'assistant') return `assistant: ${m.content}${m.toolCalls ? ` [调用 ${m.toolCalls.map((c) => c.name).join(',')}]` : ''}`;
          if (m.role === 'tool') return `tool(${m.name}): ${m.content.slice(0, 400)}`;
          return `${m.role}: ${m.content}`;
        })
        .join('\n')
        .slice(0, 120_000);
      const res = await this.opts.provider.chat({
        model: this.opts.model,
        messages: [
          { role: 'system', content: '你是会话压缩器。把对话历史压缩成要点摘要，必须保留：任务目标、关键决策及理由、已完成的改动（含文件路径）、当前进行到哪一步、待办事项、用户明确的偏好约束。直接输出摘要正文。' },
          { role: 'user', content: flat },
        ],
      });
      const summary = res.message.role === 'assistant' ? res.message.content : '';
      // 保留最近 2 轮（最多 6 条），并丢弃开头孤立的 tool 消息
      let tail = history.slice(-6);
      while (tail.length && tail[0]!.role === 'tool') tail = tail.slice(1);
      this.messages.length = 0;
      this.refreshSystem();
      this.messages.push({ role: 'user', content: `[会话已压缩] 之前的对话摘要：\n${summary}` });
      this.messages.push(...tail);
      const after = this.contextTokens();
      const compactMark: ChatMessage = { role: 'system', content: `<<<compacted ${new Date().toISOString()} tokens ${before}->${after}>>>` };
      if (this.transcriptPath) {
        await appendMessage(this.transcriptPath, compactMark).catch(() => undefined);
      }
      if (this.opts.storeSink) {
        try {
          this.opts.storeSink(compactMark);
        } catch {
          /* 双写失败不影响压缩 */
        }
      }
      const hookCtx = await this.hookRunner.fire('SessionStart', { source: 'compact' }).catch(() => undefined);
      if (hookCtx?.additionalContext) this.hookExtraContext = hookCtx.additionalContext;
      return { before, after };
    } finally {
      this.compacting = false;
    }
  }

  /** 恢复会话：把历史消息（不含 system）装回本实例 */
  async resumeFrom(transcriptPath: string): Promise<number> {
    const { messages } = await loadTranscript(transcriptPath);
    const usable = messages.filter((m) => m.role !== 'system');
    this.refreshSystem(); // 先保证 messages[0] 是 system，避免覆盖历史首条
    this.messages.push(...usable);
    const hookCtx = await this.hookRunner.fire('SessionStart', { source: 'resume' }).catch(() => undefined);
    if (hookCtx?.additionalContext) this.hookExtraContext = hookCtx.additionalContext;
    return usable.length;
  }
}

export { listSessions, loadTranscript };
export type { SessionMeta };
