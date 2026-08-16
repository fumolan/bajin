import * as readline from 'node:readline';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import {
  Agent, createGlmProvider, createAnthropicProvider, createMockProvider, listSessions, PermissionPolicy, discoverSkills,
  discoverCommands, findCommand, expandCommand, loadHooksConfig, discoverSubagents, readMemories, clearMemories, seedBuiltinSkills,
  openSessionStore, storeUpsertSession, storeAppendMessage, storeUpdateSessionMeta, storeDeleteSession, storeReplaceTodos, storeListSessions,
  rewindTranscript, discoverProjectConfigFiles, envSettingsOverlay, type SessionStore,
  mergeModelOptions, readCustomModels, writeCustomModels, resolveModelEndpoint,
  readProviders, writeProviders, nextCronRun,
  type SlashCommand, type HooksConfig, type CustomModel, type ProviderEntry, type AgentCallbacks, type MockStep,
} from '@bajin/core';
import type { ChatMessage, ModelProvider, PermissionMode, UserAnswer, UserQuestion } from '@bajin/shared';
import { automationsPath, loadAutomations, saveAutomations, createAutomation, type Automation } from './automations.js';

/**
 * bajin app-server：桌面端后端进程（多会话版，一个标签页 = 一个会话）。
 *
 * 协议（按行分隔的 JSON-RPC，stdin/stdout；日志走 stderr）：
 *   请求    → {"id":1,"method":"send","params":{"sessionId":"sess_x","text":"..."}}
 *   响应    → {"id":1,"result":{...}} 或 {"id":1,"error":{"code":-32000,"message":"..."}}
 *   事件    → {"event":"text-delta","params":{"sessionId":"sess_x",...}}
 *
 * 方法：initialize · session/new · session/open · session/close · send · reset ·
 *        set-mode · set-model · set-allowed-tools · compact · status · interrupt ·
 *        approval:respond · ask-user:respond · list-sessions · shutdown
 * 事件：text-delta · reasoning-delta · tool-call · tool-result · todo-updated · usage ·
 *        approval-request · ask-user · done · agent-error · session-resumed
 */

interface SessionState {
  agent: Agent;
  model: string;
  mode: PermissionMode;
  allowedTools: string[];
  disallowedTools: string[];
  busy: boolean;
  title: string;
}

interface RpcRequest {
  id?: number | string;
  method: string;
  params?: unknown;
}

interface RpcError {
  code: number;
  message: string;
}

export interface InitializeParams {
  cwd?: string;
  model?: string;
  mode?: PermissionMode;
  mock?: boolean;
  steps?: MockStep[];
  apiKey?: string;
  baseUrl?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  persist?: boolean;
}

export interface SessionNewParams {
  cwd?: string;
  model?: string;
  mode?: PermissionMode;
  /** 从既有会话分叉（复制历史到新会话） */
  forkFrom?: string;
}

interface WithSession {
  sessionId: string;
}

class BusyError extends Error {}

export class AppServer {
  private readonly sessions = new Map<string, SessionState>();
  private mock = false;
  private scriptedSteps: MockStep[] | undefined;
  private apiKey?: string;
  private baseUrl?: string;
  private cwd = process.cwd();
  private persist = false;
  private model = 'glm-5.3';
  private mode: PermissionMode = 'build';
  private allowedTools: string[] = [];
  private disallowedTools: string[] = [];
  private readonly pendingApprovals = new Map<string, (approved: boolean) => void>();
  private readonly pendingAskUser = new Map<string, (answer: UserAnswer | null) => void>();
  private seq = 0;
  private customModels: CustomModel[] = [];
  private providers: ProviderEntry[] = [];
  private hooks: HooksConfig = {};
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  /** SQLite 会话库（双写过渡）：惰性开库，失败降级为 null 只走 JSONL */
  private store: SessionStore | null | undefined = undefined;

  private sessionStore(): SessionStore | null {
    if (this.store !== undefined) return this.store;
    try {
      this.store = openSessionStore(path.join(AppServer.stateHome(), 'sessions.db'));
    } catch (err) {
      console.error(`[bajin] SQLite 会话库不可用，仅 JSONL：${err instanceof Error ? err.message : err}`);
      this.store = null;
    }
    return this.store;
  }

  constructor(
    private readonly write: (line: string) => void,
    private readonly exit: () => void,
  ) {}

  async handleRequest(req: RpcRequest): Promise<void> {
    const respond = (result?: unknown, error?: RpcError) => {
      const payload: Record<string, unknown> = {};
      if (req.id !== undefined) payload['id'] = req.id;
      if (error) payload['error'] = error;
      else payload['result'] = result ?? {};
      this.write(JSON.stringify(payload));
    };
    try {
      const p = (req.params ?? {}) as Record<string, unknown>;
      switch (req.method) {
        case 'initialize':
          return respond(await this.initialize(p as unknown as InitializeParams));
        case 'session/new':
          return respond(await this.sessionNew(p as unknown as SessionNewParams));
        case 'session/open':
          return respond(await this.sessionOpen(p as unknown as { sessionId: string }));
        case 'session/close':
          return respond(this.sessionClose(p as unknown as WithSession));
        case 'send':
          return respond(await this.send(p as unknown as WithSession & { text: string }));
        case 'reset':
          return respond(this.withSession(p, (s) => void s.agent.reset()));
        case 'set-mode':
          return respond(await this.setMode(p as unknown as WithSession & { mode: PermissionMode }));
        case 'set-model':
          return respond(await this.setModel(p as unknown as WithSession & { model: string }));
        case 'set-allowed-tools':
          return respond(this.setAllowedTools(p as unknown as WithSession & { add?: string; remove?: string }));
        case 'compact':
          return respond(await this.withSessionAsync(p, (s) => s.agent.compact()));
        case 'status':
          return respond(this.withSession(p, (s) => this.statusOf(s)));
        case 'interrupt':
          return respond(this.withSession(p, (s) => (s.agent.abort(), { interrupted: true })));
        case 'approval:respond':
          return respond(this.approvalRespond(p as unknown as { requestId: string; approved: boolean }));
        case 'ask-user:respond':
          return respond(this.askUserRespond(p as unknown as { requestId: string; answer?: UserAnswer }));
        case 'list-sessions':
          return respond({ sessions: await this.listSessionsEnriched() });
        case 'models/list':
          return respond({ models: mergeModelOptions(this.customModels, this.providers) });
        case 'models/add':
          return respond(await this.modelsAdd(p as unknown as CustomModel));
        case 'models/remove':
          return respond(await this.modelsRemove(p as unknown as { id: string }));
        case 'providers/list':
          return respond({ providers: this.providers });
        case 'providers/add':
          return respond(await this.providersAdd(p as unknown as ProviderEntry));
        case 'providers/remove':
          return respond(await this.providersRemove(p as unknown as { name: string }));
        case 'automations/list':
          return respond({ automations: await loadAutomations() });
        case 'automations/create':
          return respond(await this.automationsCreate(p as unknown as { title: string; cron: string; prompt: string; model?: string; mode?: string }));
        case 'automations/remove':
          return respond(await this.automationsRemove(p as unknown as { id: string }));
        case 'automations/toggle':
          return respond(await this.automationsToggle(p as unknown as { id: string; enabled: boolean }));
        case 'search/sessions':
          return respond(await this.searchSessions(p as unknown as { query: string }));
        case 'skills/list':
          return respond({ skills: await discoverSkills(this.cwd) });
        case 'commands/list':
          return respond({ commands: (await discoverCommands(this.cwd)).map(this.commandSummary) });
        case 'subagents/list':
          return respond({ subagents: await discoverSubagents(this.cwd).catch(() => []) });
        case 'memory/list':
          return respond({ memories: await readMemories(this.cwd).catch(() => []) });
        case 'memory/clear':
          return respond({ cleared: await clearMemories(this.cwd, (p as { scope?: 'user' | 'project' })?.scope === 'project' ? 'project' : 'user') });
        case 'skills/create':
          return respond(await this.skillCreate(p as unknown as { name: string; description?: string }));
        case 'skills/read':
          return respond(await this.skillRead(p as unknown as { name: string }));
        case 'projects/list':
          return respond(await this.projectsList());
        case 'session/set-group':
          return respond(await this.sessionSetGroup(p as unknown as { sessionId: string; group?: string }));
        case 'session/rename':
          return respond(await this.sessionMutateMeta(p as unknown as { sessionId: string }, { title: (v) => String(v ?? '').trim().slice(0, 120) }));
        case 'session/pin':
          return respond(await this.sessionMutateMeta(p as unknown as { sessionId: string }, { pinned: (v) => v === true }));
        case 'session/archive':
          return respond(await this.sessionMutateMeta(p as unknown as { sessionId: string }, { archived: (v) => v === true }));
        case 'session/unread':
          return respond(await this.sessionMutateMeta(p as unknown as { sessionId: string }, { unread: (v) => v === true }));
        case 'session/delete':
          return respond(await this.sessionDelete(p as unknown as { sessionId: string }));
        case 'session/rewind':
          return respond(await this.sessionRewind(p as unknown as { sessionId: string; n?: number }));
        case 'config/chain':
          return respond(await this.configChain());
        case 'logs/list':
          return respond(await this.logsList());
        case 'logs/read':
          return respond(await this.logsRead(p as unknown as { name: string }));
        case 'settings/set':
          return respond(await this.settingsSet(p as unknown as { model?: string; mode?: PermissionMode }));
        case 'usage/stats':
          return respond(await this.usageStats(p as unknown as { range?: 'all' | '7d' | '30d' }));
        case 'shutdown':
          respond();
          this.exit();
          return;
        default:
          return respond(undefined, { code: -32601, message: `未知方法: ${req.method}` });
      }
    } catch (err) {
      if (err instanceof BusyError) respond(undefined, { code: -32000, message: err.message });
      else respond(undefined, { code: -32000, message: err instanceof Error ? err.message : String(err) });
    }
  }

  private emit(event: string, params: unknown): void {
    this.write(JSON.stringify({ event, params }));
  }

  /** commands/list 输出：不带正文，只给补全与展示所需字段 */
  private commandSummary(c: SlashCommand): Record<string, unknown> {
    return {
      name: c.name,
      description: c.description,
      ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
      ...(c.allowedTools ? { allowedTools: c.allowedTools } : {}),
      source: c.source,
    };
  }

  // —— 会话管理 ——

  private async initialize(params: InitializeParams): Promise<Record<string, unknown>> {
    this.cwd = params.cwd ?? this.cwd;
    this.model = params.model ?? this.model;
    this.mode = params.mode ?? this.mode;
    this.mock = params.mock ?? false;
    this.scriptedSteps = params.steps;
    this.allowedTools = params.allowedTools ?? [];
    this.disallowedTools = params.disallowedTools ?? [];
    this.apiKey = params.apiKey ?? this.apiKey;
    // 首启种入内置默认技能（缺失才写，用户编辑过不覆盖；幂等）
    await seedBuiltinSkills().catch(() => undefined);
    this.baseUrl = params.baseUrl ?? this.baseUrl;
    this.persist = params.persist ?? false;
    this.customModels = await readCustomModels();
    this.providers = await readProviders();
    this.hooks = await loadHooksConfig(this.cwd).catch(() => ({}));
    this.startScheduler();
    const s = this.createSession(params.cwd ?? this.cwd, this.model, this.mode);
    await s.agent.ready;
    return this.describe(s);
  }

  // —— 供应商管理（一个端点 + 一把钥匙 + 名下模型） ——

  private async providersAdd(v: ProviderEntry): Promise<Record<string, unknown>> {
    if (!v?.name || typeof v.name !== 'string') throw new Error('供应商名称必填');
    const entry: ProviderEntry = {
      name: v.name.trim(),
      ...(v.baseUrl ? { baseUrl: v.baseUrl.trim() } : {}),
      ...(v.apiKey ? { apiKey: v.apiKey.trim() } : {}),
      ...(v.apiFormat === 'anthropic' || v.apiFormat === 'openai' ? { apiFormat: v.apiFormat } : {}),
      ...(Array.isArray(v.models) ? { models: v.models.map(String) } : {}),
      ...(v.note ? { note: v.note.trim() } : {}),
    };
    this.providers = [...this.providers.filter((x) => x.name !== entry.name), entry];
    await writeProviders(this.providers);
    return { providers: this.providers };
  }

  private async providersRemove(p: { name: string }): Promise<Record<string, unknown>> {
    this.providers = this.providers.filter((x) => x.name !== p.name);
    await writeProviders(this.providers);
    return { providers: this.providers };
  }

  // —— 自动化（存储 + 调度） ——

  private async automationsCreate(input: { title: string; cron: string; prompt: string; model?: string; mode?: string }): Promise<Record<string, unknown>> {
    if (!input?.title || !input?.cron || !input?.prompt) throw new Error('title/cron/prompt 均必填');
    const a = await createAutomation(input);
    const list = await loadAutomations();
    await saveAutomations([...list, a]);
    return { automation: a };
  }

  private async automationsRemove(p: { id: string }): Promise<Record<string, unknown>> {
    const list = (await loadAutomations()).filter((x) => x.id !== p.id);
    await saveAutomations(list);
    return { automations: list };
  }

  private async automationsToggle(p: { id: string; enabled: boolean }): Promise<Record<string, unknown>> {
    const list = await loadAutomations();
    const hit = list.find((x) => x.id === p.id);
    if (!hit) throw new Error(`自动化不存在: ${p.id}`);
    hit.enabled = p.enabled === true;
    hit.nextRunAt = hit.enabled ? (nextCronRun(hit.cron)?.getTime() ?? 0) : undefined;
    await saveAutomations(list);
    return { automation: hit };
  }

  /** 每分钟 tick：到点的自动化在自己专属会话里发 prompt */
  private startScheduler(): void {
    if (this.schedulerTimer) return;
    this.schedulerTimer = setInterval(() => void this.tickAutomations(), 60_000);
  }

  private async tickAutomations(): Promise<void> {
    let list: Automation[];
    try {
      list = await loadAutomations();
    } catch {
      return;
    }
    let changed = false;
    for (const a of list) {
      if (!a.enabled) continue;
      if (!a.nextRunAt) {
        a.nextRunAt = nextCronRun(a.cron)?.getTime() ?? 0;
        changed = true;
        continue;
      }
      if (Date.now() >= a.nextRunAt) {
        a.lastRunAt = Date.now();
        // 一次性任务（delayMinutes 创建）：触发后自动停用；周期任务重算下次
        if (a.oneShot) {
          a.enabled = false;
          a.nextRunAt = 0;
        } else {
          a.nextRunAt = nextCronRun(a.cron, new Date())?.getTime() ?? 0;
        }
        changed = true;
        void this.fireAutomation(a);
      }
    }
    if (changed) await saveAutomations(list).catch(() => undefined);
  }

  private async fireAutomation(a: Automation): Promise<void> {
    try {
      let state = a.sessionId ? this.sessions.get(a.sessionId) : undefined;
      if (!state) {
        state = this.createSession(this.cwd, a.model ?? this.model, (a.mode as PermissionMode) ?? 'yolo');
        state.title = `自动化·${a.title}`;
        a.sessionId = state.agent.sessionId;
        await saveAutomations(await loadAutomations());
      }
      this.emit('automation-ran', { id: a.id, title: a.title, sessionId: state.agent.sessionId });
      await this.send({ sessionId: state.agent.sessionId, text: a.prompt });
    } catch (err) {
      this.emit('agent-error', { sessionId: a.sessionId ?? '', message: `自动化 ${a.title} 执行失败: ${err instanceof Error ? err.message : err}` });
    }
  }

  // —— 跨会话搜索 ——

  private async searchSessions(p: { query: string }): Promise<Record<string, unknown>> {
    const q = (p?.query ?? '').trim().toLowerCase();
    if (!q) return { results: [] };
    const sessions = await listSessions(this.persistDir(), 50);
    const results: Array<Record<string, unknown>> = [];
    for (const s of sessions) {
      let raw: string;
      try {
        raw = await fs.readFile(s.transcriptPath, 'utf8');
      } catch {
        continue;
      }
      if (s.title.toLowerCase().includes(q)) {
        results.push({ sessionId: s.sessionId, title: s.title, snippet: '', matches: 1 });
        continue;
      }
      let count = 0;
      let snippet = '';
      for (const line of raw.split('\n')) {
        const idx = line.toLowerCase().indexOf(q);
        if (idx >= 0) {
          count++;
          if (!snippet) snippet = line.slice(Math.max(0, idx - 40), idx + 80);
          if (count >= 3) break;
        }
      }
      if (count) results.push({ sessionId: s.sessionId, title: s.title, snippet, matches: count });
      if (results.length >= 30) break;
    }
    return { results };
  }

  // —— 技能管理 ——

  private async skillCreate(p: { name: string; description?: string }): Promise<Record<string, unknown>> {
    const name = (p?.name ?? '').trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) {
      throw new Error('技能名需匹配 ^[a-z0-9][a-z0-9._-]{0,63}$');
    }
    const dir = path.join(AppServer.stateHome(), 'skills', name);
    await fs.mkdir(dir, { recursive: true });
    const skillMd = `---\nname: ${name}\ndescription: ${p?.description?.trim() || `${name} 技能`}\n---\n\n# ${name}\n\n(在此编写操作指南：何时用、怎么做、注意事项)\n`;
    await fs.writeFile(path.join(dir, 'SKILL.md'), skillMd, 'utf8');
    return { created: name, file: path.join(dir, 'SKILL.md') };
  }

  private async skillRead(p: { name: string }): Promise<Record<string, unknown>> {
    const skills = await discoverSkills(this.cwd);
    const hit = skills.find((s) => s.name === p.name);
    if (!hit) throw new Error(`未安装技能: ${p.name}`);
    const content = await fs.readFile(hit.file, 'utf8');
    return { name: hit.name, source: hit.source, content: content.slice(0, 8000) };
  }

  // —— 项目（按会话 cwd 聚合）与分组 ——

  private async projectsList(): Promise<Record<string, unknown>> {
    const sessions = await listSessions(this.persistDir(), 200);
    const byCwd = new Map<string, { cwd: string; count: number; lastModifiedAt: number; title: string }>();
    for (const s of sessions) {
      const cwd = s.meta?.cwd ?? '未知目录';
      const cur = byCwd.get(cwd);
      if (cur) {
        cur.count += 1;
        cur.lastModifiedAt = Math.max(cur.lastModifiedAt, s.modifiedAt);
      } else {
        byCwd.set(cwd, { cwd, count: 1, lastModifiedAt: s.modifiedAt, title: s.title });
      }
    }
    return { projects: [...byCwd.values()].sort((a, b) => b.lastModifiedAt - a.lastModifiedAt) };
  }

  private async sessionSetGroup(p: { sessionId: string; group?: string }): Promise<Record<string, unknown>> {
    const dir = path.join(this.persistDir(), p.sessionId);
    const metaFile = path.join(dir, 'meta.json');
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(await fs.readFile(metaFile, 'utf8')) as Record<string, unknown>;
    } catch {
      throw new Error(`会话不存在: ${p.sessionId}`);
    }
    if (p.group?.trim()) meta['group'] = p.group.trim();
    else delete meta['group'];
    await fs.writeFile(metaFile, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    const store = this.sessionStore();
    if (store) storeUpdateSessionMeta(store, p.sessionId, { group: p.group?.trim() || null });
    return { sessionId: p.sessionId, group: meta['group'] ?? null };
  }

  /** 任务项操作：重命名（meta.title）/ 置顶（meta.pinned），对标 taskList.rename/pin */
  private async sessionMutateMeta(
    p: { sessionId: string },
    fields: Record<string, (v: unknown) => unknown>,
  ): Promise<Record<string, unknown>> {
    const dir = path.join(this.persistDir(), p.sessionId);
    const metaFile = path.join(dir, 'meta.json');
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(await fs.readFile(metaFile, 'utf8')) as Record<string, unknown>;
    } catch {
      throw new Error(`会话不存在: ${p.sessionId}`);
    }
    const params = p as unknown as Record<string, unknown>;
    for (const [key, transform] of Object.entries(fields)) {
      const val = transform(params[key]);
      if (key === 'title' && !val) continue; // 空标题不改
      if (key === 'pinned' && !val) delete meta[key];
      else meta[key] = val;
    }
    await fs.writeFile(metaFile, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    const store = this.sessionStore();
    if (store) {
      storeUpdateSessionMeta(store, p.sessionId, {
        ...(fields['title'] ? { title: (meta['title'] as string) ?? undefined } : {}),
        ...(fields['pinned'] ? { pinned: Boolean(meta['pinned']) } : {}),
      });
    }
    return { sessionId: p.sessionId, ...Object.fromEntries(Object.keys(fields).map((k) => [k, meta[k] ?? null])) };
  }

  /** 回退最近 N 轮（默认 1）：裁 JSONL 后把 SQLite 里该会话整体重同步，保持双写一致 */
  private async sessionRewind(p: { sessionId: string; n?: number }): Promise<Record<string, unknown>> {
    const n = Math.max(1, Math.floor(p?.n ?? 1));
    const transcriptPath = path.join(this.persistDir(), p.sessionId, 'transcript.jsonl');
    const r = await rewindTranscript(transcriptPath, n);
    const store = this.sessionStore();
    if (store && (r.removedTurns > 0 || r.remainingTurns >= 0)) {
      storeDeleteSession(store, p.sessionId);
      // 重导入裁剪后的 JSONL（meta 保留 group/pinned/title）
      const metaRaw = await fs.readFile(path.join(this.persistDir(), p.sessionId, 'meta.json'), 'utf8').catch(() => null);
      const meta = metaRaw ? (JSON.parse(metaRaw) as Record<string, unknown>) : {};
      storeUpsertSession(store, {
        sessionId: p.sessionId,
        model: String(meta['model'] ?? ''),
        cwd: String(meta['cwd'] ?? ''),
        createdAt: String(meta['createdAt'] ?? new Date().toISOString()),
        title: typeof meta['title'] === 'string' ? meta['title'] : undefined,
        group: typeof meta['group'] === 'string' ? meta['group'] : undefined,
        pinned: meta['pinned'] === true,
        modifiedAt: new Date().toISOString(),
      });
      const raw = await fs.readFile(transcriptPath, 'utf8').catch(() => '');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const rec = JSON.parse(t) as { ts?: string; msg?: ChatMessage };
          if (rec.msg?.role) storeAppendMessage(store, p.sessionId, rec.msg, rec.ts ?? '');
        } catch { /* 损坏行跳过 */ }
      }
    }
    return { sessionId: p.sessionId, ...r };
  }

  /** 配置作用域链诊断（设置页展示：用户级/项目级各文件与环境覆盖层） */
  private async configChain(): Promise<Record<string, unknown>> {
    const userFile = path.join(AppServer.stateHome(), 'config.json');
    const userExists = await fs.access(userFile).then(() => true, () => false);
    const projectFiles = await discoverProjectConfigFiles(this.cwd);
    const env = envSettingsOverlay();
    return {
      userFile,
      userExists,
      projectFiles, // 远 → 近
      envKeys: Object.keys(env),
      hint: '优先级：内置默认 < 用户级 < 项目级(远→近) < 环境变量 < 命令行旗标',
    };
  }

  /** 删除任务：移除持久化目录；若该会话正开着，先关掉 */
  private async sessionDelete(p: { sessionId: string }): Promise<Record<string, unknown>> {
    const dir = path.join(this.persistDir(), p.sessionId);
    const st = await fs.stat(dir).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`会话不存在: ${p.sessionId}`);
    const open = this.sessions.get(p.sessionId);
    if (open) this.sessionClose({ sessionId: p.sessionId });
    await fs.rm(dir, { recursive: true, force: true });
    const store = this.sessionStore();
    if (store) storeDeleteSession(store, p.sessionId);
    return { sessionId: p.sessionId, deleted: true };
  }

  // —— 模型目录管理（自定义模型 = 任意 openai 兼容端点） ——

  private async modelsAdd(m: CustomModel): Promise<Record<string, unknown>> {
    if (!m?.id || typeof m.id !== 'string') throw new Error('模型 id 不能为空');
    if (m.provider && !this.providers.some((x) => x.name === m.provider)) {
      throw new Error(`供应商不存在: ${m.provider}（先 providers/add）`);
    }
    const entry: CustomModel = {
      id: m.id.trim(),
      ...(m.label ? { label: m.label.trim() } : {}),
      ...(m.baseUrl ? { baseUrl: m.baseUrl.trim() } : {}),
      ...(m.apiKey ? { apiKey: m.apiKey.trim() } : {}),
      ...(m.provider ? { provider: m.provider.trim() } : {}),
    };
    this.customModels = [...this.customModels.filter((x) => x.id !== entry.id), entry];
    await writeCustomModels(this.customModels);
    return { models: mergeModelOptions(this.customModels, this.providers) };
  }

  private async modelsRemove(p: { id: string }): Promise<Record<string, unknown>> {
    this.customModels = this.customModels.filter((x) => x.id !== p.id);
    await writeCustomModels(this.customModels);
    return { models: mergeModelOptions(this.customModels, this.providers) };
  }

  // —— 日志（rollout / 会话 transcript，只允许读 ~/.bajin 下白名单目录的尾部） ——

  private async logsList(): Promise<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    const rolloutDir = this.rolloutDir();
    for (const name of await fs.readdir(rolloutDir).catch(() => [] as string[])) {
      if (!name.endsWith('.jsonl')) continue;
      const st = await fs.stat(path.join(rolloutDir, name)).catch(() => null);
      if (st) out.push({ name, size: st.size, modifiedAt: st.mtimeMs, kind: 'rollout' });
    }
    return { files: out.sort((a, b) => Number(b['modifiedAt']) - Number(a['modifiedAt'])) };
  }

  private async logsRead(p: { name: string }): Promise<Record<string, unknown>> {
    const safe = path.basename(p?.name ?? '');
    if (!safe.endsWith('.jsonl')) throw new Error('只支持读取 .jsonl 日志');
    const file = path.join(this.rolloutDir(), safe);
    const raw = await fs.readFile(file, 'utf8').catch(() => null);
    if (raw === null) throw new Error(`日志不存在: ${safe}`);
    const lines = raw.trim().split('\n');
    return { name: safe, tail: lines.slice(-120).join('\n'), totalLines: lines.length };
  }

  // —— 默认设置（写入 ~/.bajin/config.json，重启/新会话生效） ——

  private async settingsSet(p: { model?: string; mode?: PermissionMode }): Promise<Record<string, unknown>> {
    const file = path.join(os.homedir(), '.bajin', 'config.json');
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    } catch {
      // 首次创建
    }
    if (p?.model) config['model'] = p.model;
    if (p?.mode) {
      const modes = ['plan', 'build', 'edit', 'yolo'];
      if (!modes.includes(p.mode)) throw new Error(`mode 必须是 ${modes.join('|')}`);
      config['mode'] = p.mode;
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    return { saved: true, config };
  }

  private async sessionNew(params: SessionNewParams): Promise<Record<string, unknown>> {
    this.requireInit();
    const s = this.createSession(params.cwd ?? this.cwd, params.model ?? this.model, params.mode ?? this.mode);
    if (params.forkFrom) {
      const src = this.sessions.get(params.forkFrom);
      if (src) {
        const history = src.agent.messages.filter((m) => m.role !== 'system');
        s.agent.messages.push(...history);
        s.title = `分叉自 ${params.forkFrom.slice(0, 12)}`;
      }
    }
    await s.agent.ready;
    return this.describe(s);
  }

  /** 打开历史会话（从 transcript 恢复到新标签） */
  private async sessionOpen(params: { sessionId: string }): Promise<Record<string, unknown>> {
    this.requireInit();
    const sessions = await listSessions(this.persistDir());
    const hit = sessions.find((x) => x.sessionId.startsWith(params.sessionId));
    if (!hit) throw new Error(`未找到会话: ${params.sessionId}`);
    const s = this.createSession(this.cwd, this.model, this.mode, hit.sessionId);
    await s.agent.ready;
    const n = await s.agent.resumeFrom(hit.transcriptPath);
    s.title = hit.title;
    // 历史消息一并返回，供渲染层还原完整对话流（对标 ZCode 打开任务即见全文）
    return { ...this.describe(s), messages: s.agent.messages.filter((m) => m.role !== 'system') };
  }

  private sessionClose(params: WithSession): Record<string, unknown> {
    const s = this.sessions.get(params.sessionId);
    if (!s) return { closed: false };
    s.agent.abort();
    s.agent.disposeMcp();
    this.sessions.delete(params.sessionId);
    return { closed: true };
  }

  private createSession(cwd: string, model: string, mode: PermissionMode, reuseId?: string): SessionState {
    const providerFactory = this.buildProviderFactory();
    const store = this.persist ? this.sessionStore() : null;
    // storeSink 在 persist() 内触发，晚于构造——用 holder 承载构造后才有的 sessionId
    const sidHolder: { sid: string } = { sid: '' };
    const agent = new Agent({
      provider: providerFactory(),
      providerFactory,
      model,
      cwd,
      mode,
      policy: new PermissionPolicy({ mode, allowedTools: this.allowedTools, disallowedTools: this.disallowedTools }),
      ...(this.persist ? { persistDir: this.persistDir(), rolloutDir: this.rolloutDir() } : {}),
      ...(this.hooks.enabled ? { hooks: this.hooks } : {}),
      ...(reuseId ? { sessionId: reuseId } : {}),
      ...(store
        ? {
            storeSink: (msg: ChatMessage) => {
              storeAppendMessage(store, sidHolder.sid, msg);
              store.db.prepare('UPDATE session SET modified_at = ? WHERE id = ?').run(new Date().toISOString(), sidHolder.sid);
            },
          }
        : {}),
    });
    if (store) {
      sidHolder.sid = agent.sessionId;
      storeUpsertSession(store, {
        sessionId: agent.sessionId,
        model,
        cwd,
        createdAt: new Date().toISOString(),
        title: '新会话',
      });
    }
    const state: SessionState = { agent, model, mode, allowedTools: [...this.allowedTools], disallowedTools: [...this.disallowedTools], busy: false, title: '新会话' };
    this.bindCallbacks(state);
    this.sessions.set(agent.sessionId, state);
    return state;
  }

  /** 每个 agent 的回调：事件全部带 sessionId；审批与提问走往返协议 */
  private bindCallbacks(state: SessionState): void {
    const sessionId = state.agent.sessionId;
    state.agent.setCallbacks({
      onText: (delta) => this.emit('text-delta', { sessionId, delta }),
      onReasoning: (delta) => this.emit('reasoning-delta', { sessionId, delta }),
      onToolCall: (name, args) => this.emit('tool-call', { sessionId, name, args }),
      onToolResult: (name, result) => {
        this.emit('tool-result', { sessionId, name, ...result });
        const todos = state.agent.todoSnapshot();
        if (todos.length) {
          this.emit('todo-updated', { sessionId, todos });
          const store = this.persist ? this.sessionStore() : null;
          if (store) storeReplaceTodos(store, sessionId, todos);
        }
      },
      onUsage: (usage) => this.emit('usage', { sessionId, ...usage }),
      onApproval: async (name, args) => {
        const requestId = `approval_${++this.seq}`;
        this.emit('approval-request', { sessionId, requestId, name, args });
        return await this.awaitDecision((resolve) => {
          this.pendingApprovals.set(requestId, resolve);
        }, 300_000, false);
      },
    });
    state.agent.setAskUser(async (q) => {
      const requestId = `ask_${++this.seq}`;
      this.emit('ask-user', { sessionId, requestId, question: q });
      return await this.awaitDecision<UserAnswer | null>((resolve) => {
        this.pendingAskUser.set(requestId, resolve);
      }, 600_000, null);
    });
  }

  private awaitDecision<T>(register: (resolve: (v: T) => void) => void, timeoutMs: number, timeoutValue: T): Promise<T> {
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => resolve(timeoutValue), timeoutMs);
      register((v) => {
        clearTimeout(timer);
        resolve(v);
      });
    });
  }

  // —— 会话内操作 ——

  private requireInit(): void {
    if (!this.sessions.size) throw new Error('请先调用 initialize');
  }

  private withSession(p: Record<string, unknown>, fn: (s: SessionState) => unknown): Record<string, unknown> {
    this.requireInit();
    const s = this.sessions.get(String(p['sessionId'] ?? ''));
    if (!s) throw new Error(`会话不存在: ${p['sessionId']}`);
    const r = fn(s);
    return (r ?? {}) as Record<string, unknown>;
  }

  private async withSessionAsync(p: Record<string, unknown>, fn: (s: SessionState) => unknown): Promise<Record<string, unknown>> {
    this.requireInit();
    const s = this.sessions.get(String(p['sessionId'] ?? ''));
    if (!s) throw new Error(`会话不存在: ${p['sessionId']}`);
    if (s.busy) throw new BusyError('该会话有任务执行中');
    return ((await fn(s)) ?? {}) as Record<string, unknown>;
  }

  private describe(s: SessionState): Record<string, unknown> {
    return {
      sessionId: s.agent.sessionId,
      model: s.model,
      mode: s.mode,
      mock: this.mock,
      cwd: this.cwd,
      title: s.title,
      allowedTools: s.allowedTools,
      tools: s.agent.providerTools().map((t) => t.name),
    };
  }

  private statusOf(s: SessionState): Record<string, unknown> {
    return {
      tokens: s.agent.contextTokens(),
      model: s.model,
      mode: s.mode,
      planMode: s.agent.planMode,
      busy: s.busy,
      todos: s.agent.todoSnapshot(),
    };
  }

  private buildProviderFactory(): () => ModelProvider {
    return this.mock
      ? () => (this.scriptedSteps?.length ? createMockProvider(this.scriptedSteps, this.model) : createEchoProvider(this.model))
      : () => {
          // 端点解析链：模型自带 baseUrl/apiKey > 挂靠的供应商 > 全局 key + 默认端点
          const ep = resolveModelEndpoint(this.model, this.customModels, this.providers);
          const apiKey = ep.apiKey ?? this.apiKey ?? process.env['BIGMODEL_API_KEY'] ?? '';
          if (!apiKey) throw new Error('缺少 API key（initialize 传 apiKey、为模型/供应商配置 key，或传 mock: true）');
          // 两种接入端点：anthropic 走 Messages 协议（x-api-key），openai 走 chat/completions（Bearer）
          if (ep.apiFormat === 'anthropic') {
            return createAnthropicProvider({ apiKey, baseUrl: ep.baseUrl ?? this.baseUrl, model: this.model });
          }
          return createGlmProvider({ apiKey, baseUrl: ep.baseUrl ?? this.baseUrl, model: this.model });
        };
  }

  private async send(p: WithSession & { text: string }): Promise<Record<string, unknown>> {
    this.requireInit();
    const s = this.sessions.get(p.sessionId);
    if (!s) throw new Error(`会话不存在: ${p.sessionId}`);
    if (s.busy) throw new BusyError('该会话有任务执行中');
    const text = p.text?.trim();
    if (!text) throw new Error('text 不能为空');
    if (!s.title || s.title === '新会话') s.title = text.slice(0, 40);
    // 自定义 slash 命令：/name args → 展开成完整 prompt 再跑（桌面端斜杠补全联动 commands/list）
    let prompt = text;
    if (text.startsWith('/')) {
      const custom = findCommand(await discoverCommands(this.cwd), text.split(/\s+/)[0] ?? '');
      if (custom) prompt = expandCommand(custom, text.slice(1 + custom.name.length).trim());
    }
    s.busy = true;
    try {
      const result = await s.agent.run(prompt);
      const done = {
        text: result.text,
        iterations: result.iterations,
        toolCalls: result.toolCalls,
        denied: result.denied,
        tokens: s.agent.contextTokens(),
        ...(result.cancelled ? { cancelled: true } : {}),
      };
      this.emit('done', { sessionId: p.sessionId, ...done });
      return done;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit('agent-error', { sessionId: p.sessionId, message });
      throw new Error(message);
    } finally {
      s.busy = false;
    }
  }

  private async setMode(p: WithSession & { mode: PermissionMode }): Promise<Record<string, unknown>> {
    return this.withSessionAsync(p as unknown as Record<string, unknown>, (s) => {
      const modes = ['plan', 'build', 'edit', 'yolo'];
      if (!modes.includes(p.mode)) throw new Error(`mode 必须是 ${modes.join('|')}`);
      s.mode = p.mode;
      s.agent.setMode(p.mode);
      return { mode: s.mode };
    });
  }

  private async setModel(p: WithSession & { model: string }): Promise<Record<string, unknown>> {
    return this.withSessionAsync(p as unknown as Record<string, unknown>, (s) => {
      if (!p?.model) throw new Error('model 不能为空');
      s.model = p.model;
      this.rebuild(s);
      return { model: s.model };
    });
  }

  private setAllowedTools(p: WithSession & { add?: string; remove?: string }): Record<string, unknown> {
    return this.withSession(p as unknown as Record<string, unknown>, (s) => {
      // 原地改 policy（不重建 agent）：审批进行中的循环立刻感知白名单变化
      if (p.add) {
        if (!s.allowedTools.includes(p.add)) s.allowedTools.push(p.add);
        s.agent.allowTool(p.add);
      }
      if (p.remove) {
        s.allowedTools = s.allowedTools.filter((t) => t !== p.remove);
        s.agent.disallowTool(p.remove);
      }
      return { allowedTools: s.allowedTools };
    });
  }

  /** 重建 agent（切模型/改权限名单），保留对话历史 */
  private rebuild(s: SessionState): void {
    const history: ChatMessage[] = s.agent.messages.filter((m) => m.role !== 'system');
    const prevId = s.agent.sessionId;
    const providerFactory = this.buildProviderFactory();
    const next = new Agent({
      provider: providerFactory(),
      providerFactory,
      model: s.model,
      cwd: this.cwd,
      mode: s.mode,
      policy: new PermissionPolicy({ mode: s.mode, allowedTools: s.allowedTools, disallowedTools: s.disallowedTools }),
      ...(this.persist ? { persistDir: this.persistDir(), rolloutDir: this.rolloutDir() } : {}),
      ...(this.hooks.enabled ? { hooks: this.hooks } : {}),
      sessionId: prevId,
      callbacks: {},
    });
    this.sessions.delete(prevId);
    s.agent = next;
    this.bindCallbacks(s);
    this.sessions.set(next.sessionId, s);
    next.messages.push(...history);
  }

  private approvalRespond(p: { requestId: string; approved: boolean }): Record<string, unknown> {
    const resolve = this.pendingApprovals.get(p?.requestId);
    if (!resolve) return { resolved: false };
    this.pendingApprovals.delete(p.requestId);
    resolve(p.approved === true);
    return { resolved: true };
  }

  private askUserRespond(p: { requestId: string; answer?: UserAnswer }): Record<string, unknown> {
    const resolve = this.pendingAskUser.get(p?.requestId);
    if (!resolve) return { resolved: false };
    this.pendingAskUser.delete(p.requestId);
    resolve(p.answer && typeof p.answer === 'object' ? p.answer : null);
    return { resolved: true };
  }

  // —— 使用统计（来自本地会话历史，与 ZCode 的「使用统计」对齐） ——

  private async usageStats(p: { range?: 'all' | '7d' | '30d' }): Promise<Record<string, unknown>> {
    const sessions = await listSessions(this.persistDir(), 500);
    const now = Date.now();
    const rangeMs = p?.range === '7d' ? 7 * 86400000 : p?.range === '30d' ? 30 * 86400000 : 0;

    // 逐会话解析 transcript，聚合统计
    let totalMessages = 0;
    let totalTokens = 0;
    let totalToolCalls = 0;
    let longestSession = 0;
    let favoriteModel = '';
    let peakHour = 0;
    const modelTokens = new Map<string, number>();
    const dayTokens = new Map<string, number>();      // YYYY-MM-DD → tokens
    const dayActive = new Set<string>();
    const hourTokens: number[] = new Array(24).fill(0); // 24 小时分桶

    for (const s of sessions) {
      let raw: string;
      try {
        raw = await fs.readFile(s.transcriptPath, 'utf8');
      } catch {
        continue;
      }
      const model = s.meta?.model ?? '未知模型';
      let sessTokens = 0;
      let sessMessages = 0;
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let rec: { ts?: string; msg?: { role?: string; content?: string; name?: string } };
        try {
          rec = JSON.parse(trimmed) as typeof rec;
        } catch {
          continue;
        }
        if (!rec.msg || !rec.msg.role) continue;
        if (rec.msg.role === 'system' && typeof rec.msg.content === 'string' && rec.msg.content.startsWith('<<<compacted')) {
          sessTokens = 0; sessMessages = 0; // 压缩后只计后半段
          continue;
        }
        const ts = rec.ts ? new Date(rec.ts) : new Date(s.modifiedAt);
        if (rangeMs && now - ts.getTime() > rangeMs) continue;

        // token 粗估：content 字符数 / 3（中英混用近似）
        const contentLen = (rec.msg.content ?? '').length;
        const est = Math.max(1, Math.round(contentLen / 3));
        sessTokens += est;
        sessMessages++;
        totalMessages++;

        if (rec.msg.role === 'tool') totalToolCalls++;

        // 按天
        const dayKey = ts.toISOString().slice(0, 10);
        dayActive.add(dayKey);
        dayTokens.set(dayKey, (dayTokens.get(dayKey) ?? 0) + est);
        // 按时段
        hourTokens[ts.getHours()] = (hourTokens[ts.getHours()] ?? 0) + est;
      }
      totalTokens += sessTokens;
      longestSession = Math.max(longestSession, sessTokens);
      modelTokens.set(model, (modelTokens.get(model) ?? 0) + sessTokens);
    }

    // 最常用模型
    let maxModelTokens = 0;
    for (const [m, t] of modelTokens) {
      if (t > maxModelTokens) { maxModelTokens = t; favoriteModel = m; }
    }

    // 峰值时段
    let maxHourTokens = 0;
    for (let h = 0; h < 24; h++) {
      if ((hourTokens[h] ?? 0) > maxHourTokens) { maxHourTokens = hourTokens[h] ?? 0; peakHour = h; }
    }

    // 活跃天数 / 连续天数
    const activeDays = [...dayActive].sort();
    const { currentStreak, longestStreak } = this.computeStreaks(dayActive);

    // 按天 token 序列（用于趋势图）
    const days = [...dayTokens.entries()]
      .map(([date, tokens]) => ({ date, tokens }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // 模型分布（用于饼图）
    const modelBreakdown = [...modelTokens.entries()]
      .map(([model, tokens]) => ({ model, tokens, share: totalTokens > 0 ? Math.round((tokens / totalTokens) * 100) : 0 }))
      .sort((a, b) => b.tokens - a.tokens);

    return {
      range: p?.range ?? 'all',
      totalTokens,
      sessions: sessions.length,
      messages: totalMessages,
      activeDays: activeDays.length,
      favoriteModel: favoriteModel || '—',
      favoriteModelShare: totalTokens > 0 && maxModelTokens > 0 ? Math.round((maxModelTokens / totalTokens) * 100) : 0,
      longestSession,
      currentStreak,
      longestStreak,
      peakHour,
      peakHourTokens: maxHourTokens,
      estimationHint: '根据本地会话历史估算（字符数 / 3）',
      days,
      models: modelBreakdown,
    };
  }

  /** 计算当前连续天数与历史最长连续天数 */
  private computeStreaks(daySet: Set<string>): { currentStreak: number; longestStreak: number } {
    if (!daySet.size) return { currentStreak: 0, longestStreak: 0 };
    const days = [...daySet].sort();
    let longest = 1;
    let run = 1;
    for (let i = 1; i < days.length; i++) {
      const prev = new Date(days[i - 1]!);
      const cur = new Date(days[i]!);
      const diff = Math.round((cur.getTime() - prev.getTime()) / 86400000);
      if (diff === 1) {
        run++;
        longest = Math.max(longest, run);
      } else {
        run = 1;
      }
    }
    // 当前连续：从今天/昨天往前数
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    let current = daySet.has(today) ? 1 : daySet.has(yesterday) ? 1 : 0;
    if (current) {
      let cursor = daySet.has(today) ? today : yesterday;
      while (true) {
        const d = new Date(cursor);
        d.setDate(d.getDate() - 1);
        const key = d.toISOString().slice(0, 10);
        if (daySet.has(key)) { current++; cursor = key; }
        else break;
      }
    }
    return { currentStreak: current, longestStreak: longest };
  }

  /** 状态目录：BAJIN_HOME 可覆盖（桌面端数据目录迁移），缺省 ~/.bajin */
  private static stateHome(): string {
    return process.env.BAJIN_HOME && process.env.BAJIN_HOME.startsWith('/')
      ? process.env.BAJIN_HOME
      : path.join(os.homedir(), '.bajin');
  }

  private persistDir(): string {
    return path.join(AppServer.stateHome(), 'sessions');
  }

  /** 列会话并带上 meta.json 里的 group/cwd（供侧边栏分组与项目页） */
  private async listSessionsEnriched(): Promise<Array<Record<string, unknown>>> {
    const sessions = await listSessions(this.persistDir());
    // SQLite 行覆盖层（双写过渡期 store 为元数据优先源；不可用时纯 JSONL 行为不变）
    const store = this.persist ? this.sessionStore() : null;
    const storeRows = new Map<string, { title: string | null; group: string | null; pinned: number | null; modifiedAt: string }>();
    if (store) {
      for (const row of storeListSessions(store)) {
        storeRows.set(row.sessionId, { title: row.title, group: row.group, pinned: row.pinned, modifiedAt: row.modifiedAt });
      }
    }
    const out: Array<Record<string, unknown>> = [];
    for (const s of sessions) {
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(await fs.readFile(path.join(s.dir, 'meta.json'), 'utf8')) as Record<string, unknown>;
      } catch {
        // 无 meta
      }
      const row = storeRows.get(s.sessionId);
      const storeTitle = row?.title?.trim() || null;
      out.push({
        sessionId: s.sessionId,
        // 标题优先级：store.title > meta.title > 首条用户消息（双写期 store 最新）
        title: storeTitle ?? (((meta['title'] as string | undefined)?.trim()) || s.title),
        modifiedAt: s.modifiedAt,
        createdAt: Date.parse(String(meta['createdAt'] ?? '')) || s.modifiedAt,
        group: (row?.group ?? (meta['group'] as string | undefined)) ?? null,
        cwd: (meta['cwd'] as string | undefined) ?? null,
        pinned: row?.pinned != null ? row.pinned === 1 : meta['pinned'] === true,
        archived: meta['archived'] === true,
        unread: meta['unread'] === true,
        sessionDir: s.dir,
        rolloutPath: path.join(this.rolloutDir(), `model-io-${s.sessionId}.jsonl`),
      });
    }
    return out;
  }

  private rolloutDir(): string {
    return path.join(AppServer.stateHome(), 'rollout');
  }
}

function createEchoProvider(model: string): ModelProvider {
  return {
    id: 'echo',
    defaultModel: model,
    async chat(req) {
      const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
      return {
        message: {
          role: 'assistant',
          content: `[mock] 模型=${req.model}，收到: ${lastUser && lastUser.role === 'user' ? lastUser.content.slice(0, 200) : ''}`,
        },
        usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
        finishReason: 'stop',
      };
    },
  };
}

/** 以当前进程的 stdin/stdout 运行（ bajin app-server --stdio ） */
export function runAppServer(): void {
  const server = new AppServer(
    (line) => process.stdout.write(`${line}\n`),
    () => process.exit(0),
  );
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: RpcRequest;
    try {
      req = JSON.parse(trimmed) as RpcRequest;
    } catch {
      process.stderr.write(`[app-server] 无法解析的行: ${trimmed.slice(0, 100)}\n`);
      return;
    }
    void server.handleRequest(req).catch((err) => {
      process.stderr.write(`[app-server] 处理失败: ${err instanceof Error ? err.message : err}\n`);
    });
  });
  rl.on('close', () => process.exit(0));
  process.stderr.write('[app-server] ready (bajin-rpc/1, multi-session)\n');
}
