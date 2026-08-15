import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Hooks 系统（对标 ZCode/Claude Code 的 7 事件钩子，净室实现）：
 *   配置：~/.bajin/config.json 与工作区 .bajin/config.json（cwd 向上到 .git 根）的
 *         `hooks` 键：{ enabled?, timeoutMs?, maxOutputBytes?, events: { <Event>: [{ matcher?, hooks: [...] }] } }
 *   默认关闭：必须 hooks.enabled: true 才执行（安全默认，与 ZCode 一致）。
 *   事件（恰好七种）：SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest /
 *                     PostToolUse / PostToolUseFailure / Stop
 *   matcher：大小写敏感正则，对事件的匹配值测试；省略 = 全匹配；非法正则永不匹配。
 *     - SessionStart → startup|resume|clear|compact
 *     - 工具事件 → 工具名（别名 Task↔Agent、ApplyPatch→Write/Edit）
 *     - UserPromptSubmit → prompt 文本；Stop → 回复预览
 *   钩子两种类型：command（shell 字符串，timeout 单位秒）与 process（argv 免 shell，timeoutMs 毫秒）；
 *   超时解析：hook.timeoutMs → hook.timeout×1000 → 配置 timeoutMs → 60000。
 *   输出协议：stdin 收 JSON 事件载荷；stdout 可为空（靠退出码）或严格 JSON——
 *     识别键：decision(allow|ask|deny)/reason/additionalContext/continue/stopReason，多余键视为校验失败；
 *     退出码 0=通过，2=阻止（PreToolUse/PermissionRequest 即 deny），其他非零=错误（仅记录）。
 *   Stop 钩子返回 continue:true 可请求续跑，单次 run 最多 3 次。
 */

export type HookEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PermissionRequest'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Stop';

const EVENTS: readonly HookEvent[] = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Stop',
];

export interface HookCommandSpec {
  type?: 'command';
  command: string;
  shell?: string;
  /** 秒（command 型专用） */
  timeout?: number;
  timeoutMs?: number;
  statusMessage?: string;
}

export interface HookProcessSpec {
  type: 'process';
  command: string;
  args?: string[];
  timeoutMs?: number;
  statusMessage?: string;
}

export type HookSpec = HookCommandSpec | HookProcessSpec;

export interface HookMatcherGroup {
  matcher?: string;
  hooks: HookSpec[];
}

export interface HooksConfig {
  enabled?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  events?: Partial<Record<HookEvent, HookMatcherGroup[]>>;
}

export interface HookPayload {
  /** SessionStart 匹配值 */
  source?: 'startup' | 'resume' | 'clear' | 'compact';
  /** UserPromptSubmit 匹配值 */
  prompt?: string;
  /** 工具事件的工具名与入参 */
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: string;
  /** Stop 匹配值（回复预览） */
  response?: string;
}

export interface HookOutcome {
  /** 有钩子阻止（退出码 2 或 deny） */
  blocked: boolean;
  decision?: 'allow' | 'ask' | 'deny';
  /** 注入会话的附加上下文（多钩子拼接） */
  additionalContext: string;
  /** Stop 事件：请求继续运行 */
  continueRun: boolean;
  reason?: string;
  /** 执行错误（超时/非零退出/JSON 校验失败），仅记录不中断主流程 */
  errors: string[];
}

/** 工具名别名（matcher 对每个候选名都测试） */
export function toolNameCandidates(toolName: string): string[] {
  switch (toolName) {
    case 'Agent': return ['Agent', 'Task'];
    case 'Task': return ['Task', 'Agent'];
    case 'Write': return ['Write', 'ApplyPatch'];
    case 'Edit': return ['Edit', 'ApplyPatch'];
    default: return [toolName];
  }
}

/** matcher 是否命中（大小写敏感正则；非法正则永不匹配；省略全匹配） */
export function matcherHits(matcher: string | undefined, candidates: string[]): boolean {
  if (matcher === undefined || matcher === '') return true;
  let re: RegExp;
  try {
    re = new RegExp(matcher);
  } catch {
    return false;
  }
  return candidates.some((c) => re.test(c));
}

export interface HookRunContext {
  cwd: string;
  sessionId: string;
}

export class HookRunner {
  private readonly cfg: HooksConfig;
  private readonly ctx: HookRunContext;

  constructor(cfg: HooksConfig | undefined, ctx: HookRunContext) {
    this.cfg = cfg ?? {};
    this.ctx = ctx;
  }

  get enabled(): boolean {
    return this.cfg.enabled === true;
  }

  /** 触发事件：依次执行所有命中的钩子，聚合结果；未启用或无命中 → 全通过 */
  async fire(event: HookEvent, payload: HookPayload): Promise<HookOutcome> {
    const out: HookOutcome = { blocked: false, additionalContext: '', continueRun: false, errors: [] };
    if (!this.enabled) return out;
    const groups = this.cfg.events?.[event] ?? [];
    for (const group of groups) {
      if (!matcherHits(group.matcher, matchValue(event, payload))) continue;
      for (const hook of group.hooks ?? []) {
        const r = await this.execOne(event, payload, hook);
        if (r.error) out.errors.push(r.error);
        if (r.blocked) {
          out.blocked = true;
          if (!out.decision) out.decision = 'deny';
          out.reason = r.reason ?? out.reason;
        } else if (r.decision && !out.decision) {
          out.decision = r.decision;
          if (r.reason) out.reason = r.reason;
        }
        if (r.additionalContext) {
          out.additionalContext = out.additionalContext ? `${out.additionalContext}\n${r.additionalContext}` : r.additionalContext;
        }
        if (r.reason && !out.reason) out.reason = r.reason;
        if (r.continueRun) out.continueRun = true;
      }
    }
    return out;
  }

  private async execOne(
    event: HookEvent,
    payload: HookPayload,
    hook: HookSpec,
  ): Promise<{ blocked?: boolean; decision?: 'allow' | 'ask' | 'deny'; additionalContext?: string; continueRun?: boolean; reason?: string; error?: string }> {
    const timeoutMs = hook.timeoutMs ?? (isProcess(hook) ? undefined : (hook.timeout !== undefined ? hook.timeout * 1000 : undefined)) ?? this.cfg.timeoutMs ?? 60_000;
    const maxBytes = this.cfg.maxOutputBytes ?? 1_048_576;
    const stdinJson = JSON.stringify({
      event,
      sessionId: this.ctx.sessionId,
      cwd: this.ctx.cwd,
      ...payload,
    });
    const isCmd = !isProcess(hook);
    // command 型：spawn(shell, ['-c', 展开后的命令])；process 型：spawn(executable, 展开后的 argv)
    const file = isCmd ? (hook.shell ?? process.env['BAJIN_SHELL'] ?? '/bin/bash') : hook.command;
    const argv = isCmd
      ? ['-c', expandTemplates([hook.command], this.ctx)[0]!]
      : expandTemplates((hook as HookProcessSpec).args ?? [], this.ctx);
    const cmdForLog = isCmd ? hook.command : [file, ...argv].join(' ');

    return await new Promise((resolve) => {
      const child = spawn(file, argv, {
        cwd: this.ctx.cwd,
        env: { ...process.env, ...templateEnv(this.ctx) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        resolve({ error: `钩子超时（${timeoutMs}ms）: ${cmdForLog}` });
      }, timeoutMs);
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (d: string) => {
        if (stdout.length < maxBytes) stdout += d;
      });
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (d: string) => {
        if (stderr.length < 4096) stderr += d;
      });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ error: `钩子无法启动: ${err.message}` });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 2) return resolve({ blocked: true, reason: stderr.trim() || undefined });
        if (code !== 0) return resolve({ error: `钩子退出码 ${code}: ${stderr.trim().slice(0, 300) || cmdForLog}` });
        const trimmed = stdout.trim();
        if (!trimmed) return resolve({});
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return resolve({ error: `钩子 stdout 不是合法 JSON: ${trimmed.slice(0, 200)}` });
        }
        const validated = validateHookJson(parsed, event);
        if (validated.error) return resolve({ error: validated.error });
        return resolve(validated);
      });
      // 钩子进程可能先于 stdin 写入退出（echo/exit 2 类快速命令）——吞掉 EPIPE，避免未处理流错误
      child.stdin!.on('error', () => undefined);
      child.stdin!.write(stdinJson);
      child.stdin!.end();
    });
  }
}

function isProcess(hook: HookSpec): hook is HookProcessSpec {
  return hook.type === 'process';
}

function matchValue(event: HookEvent, p: HookPayload): string[] {
  switch (event) {
    case 'SessionStart':
      return [p.source ?? 'startup'];
    case 'UserPromptSubmit':
      return [p.prompt ?? ''];
    case 'Stop':
      return [p.response ?? ''];
    default:
      return toolNameCandidates(p.toolName ?? '');
  }
}

/** stdout 严格 JSON 校验：只认识别键，事件语义外的键报错 */
function validateHookJson(
  parsed: unknown,
  event: HookEvent,
): { blocked?: boolean; decision?: 'allow' | 'ask' | 'deny'; additionalContext?: string; continueRun?: boolean; reason?: string; error?: string } {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: '钩子 stdout JSON 必须是对象' };
  }
  const KNOWN = ['decision', 'reason', 'additionalContext', 'continue', 'stopReason'];
  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!KNOWN.includes(key)) return { error: `钩子 stdout JSON 含未识别键: ${key}` };
  }
  const out: { blocked?: boolean; decision?: 'allow' | 'ask' | 'deny'; additionalContext?: string; continueRun?: boolean; reason?: string; } = {};
  if (obj['decision'] !== undefined) {
    const d = String(obj['decision']);
    if (!['allow', 'ask', 'deny'].includes(d)) return { error: `decision 必须是 allow|ask|deny，收到: ${d}` };
    out.decision = d as 'allow' | 'ask' | 'deny';
    if (d === 'deny') out.blocked = true;
  }
  if (obj['reason'] !== undefined) out.reason = String(obj['reason']);
  if (obj['additionalContext'] !== undefined) out.additionalContext = String(obj['additionalContext']);
  if (obj['continue'] !== undefined) out.continueRun = obj['continue'] === true;
  if (obj['stopReason'] !== undefined && !out.reason) out.reason = String(obj['stopReason']);
  if (out.continueRun && event !== 'Stop') {
    return { error: 'continue 键只允许在 Stop 事件输出中使用' };
  }
  return out;
}

/** 命令/参数里的 ${VAR} 模板展开（项目目录与会话 id 三套前缀等价） */
function expandTemplates(values: string[], ctx: HookRunContext): string[] {
  const map = templateMap(ctx);
  return values.map((v) =>
    v.replace(/\$\{(?:BAJIN|ZCODE|CLAUDE)_(PROJECT_DIR|SESSION_ID)\}/g, (whole, name: string) => map[name] ?? whole),
  );
}

function templateMap(ctx: HookRunContext): Record<string, string> {
  return { PROJECT_DIR: ctx.cwd, SESSION_ID: ctx.sessionId };
}

/** 模板变量同时注入子进程环境（BAJIN_/ZCODE_/CLAUDE_ 三前缀） */
function templateEnv(ctx: HookRunContext): Record<string, string> {
  const env: Record<string, string> = {};
  for (const ns of ['BAJIN', 'ZCODE', 'CLAUDE']) {
    env[`${ns}_PROJECT_DIR`] = ctx.cwd;
    env[`${ns}_SESSION_ID`] = ctx.sessionId;
  }
  return env;
}

// —— 配置发现与合并：用户 ~/.bajin/config.json + 工作区 .bajin/config.json（.git 根为止，近的在后覆盖 enabled）——

export async function loadHooksConfig(cwd: string, home = os.homedir()): Promise<HooksConfig> {
  const userCfg = await readHooksBlock(path.join(home, '.bajin', 'config.json'));
  const wsCfgs: HooksConfig[] = [];
  let dir = path.resolve(cwd);
  for (;;) {
    const cfg = await readHooksBlock(path.join(dir, '.bajin', 'config.json'));
    if (cfg) wsCfgs.unshift(cfg); // 远 → 近，近的排在后（事件组合并时靠后）
    if (await exists(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const merged: HooksConfig = {
    enabled: userCfg?.enabled === true || wsCfgs.some((c) => c.enabled === true),
    ...(userCfg?.timeoutMs !== undefined ? { timeoutMs: userCfg.timeoutMs } : {}),
    ...(userCfg?.maxOutputBytes !== undefined ? { maxOutputBytes: userCfg.maxOutputBytes } : {}),
    events: {},
  };
  // 事件组合并：用户级在前，工作区（远→近）追加在后
  const all = [userCfg, ...wsCfgs].filter((c): c is HooksConfig => Boolean(c));
  for (const ev of EVENTS) {
    const groups = all.flatMap((c) => c.events?.[ev] ?? []);
    if (groups.length) merged.events![ev] = groups;
  }
  return merged;
}

async function readHooksBlock(file: string): Promise<HooksConfig | undefined> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { hooks?: HooksConfig };
    return raw.hooks;
  } catch {
    return undefined;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
