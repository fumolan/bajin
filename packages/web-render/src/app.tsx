import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState, useCallback, Component as ReactComponent, type ReactNode, type ErrorInfo } from 'react';
import { createPortal } from 'react-dom';
import { terminalShellOptions } from '@bajin/shared/platform/shell-options';
import { renderMarkdown } from './markdown.js';
import { highlightCode, langFromPath } from './highlight.js';
import { normalizeBrowserUrl } from '@bajin/shared/browser-url';
import { shouldCollapsePlan } from '@bajin/shared/plan-view';
import { taskIcon } from '@bajin/shared/task-icon';
import { closeOthers as tabCloseOthers, closeAll as tabCloseAll, reopenTab as tabReopenGeneric } from '@bajin/shared/tab-ops';

/* ---------- 类型 ---------- */

type TodoItem = { content: string; status: string; priority: string };

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'reasoning'; text: string; startedAt: number; lastAt: number }
  | { kind: 'tool'; name: string; summary: string; output?: string; ok?: boolean; denied?: boolean; startedAt: number; endedAt?: number }
  | { kind: 'system'; text: string };

interface Tab {
  /** 恢复定位用（R8-3）：创建序号，reopen 按它插回原位 */
  id: number;
  /** 本轮工作开始时刻（R9 对标 ZCode「已工作 X 分 X 秒」）；send 时置位，done 清空 */
  workStartedAt: number | null;
  /** 输出档位（R9-3）：最高/高/中/低 → maxTokens 32k/16k/8k/4k */
  effort: string;
  /** 最近一轮统计（R12：工作时长条点击展开显示，对标 ZCode 可展开箭头） */
  lastRun: { iterations: number; toolCalls: number; tokens: number; at: number } | null;
  sessionId: string | null;
  title: string;
  items: Item[];
  busy: boolean;
  approval: { requestId: string; name: string; summary: string; plan?: string; args?: Record<string, unknown> } | null;
  ask: { requestId: string; question: string; options?: Array<{ label: string; description?: string }>; header?: string; multiSelect?: boolean } | null;
  todos: TodoItem[];
  tokens: number;
  contextUsage?: { tokens: number; maxTokens: number; percent: number; level: string; suggest: string | null };
  model: string;
  mode: string;
  planMode: boolean;
  /** 任务工作目录（空 = 应用启动目录，即「不在项目中工作」） */
  cwd?: string;
}

interface HistoryItem {
  sessionId: string;
  title: string;
  modifiedAt: number;
  createdAt?: number;
  group: string | null;
  cwd: string | null;
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
  sessionDir?: string;
  rolloutPath?: string;
}

interface ModelOpt {
  id: string;
  label?: string;
  source: 'builtin' | 'custom';
  baseUrl?: string;
  provider?: string;
}

interface ProviderInfo {
  name: string;
  baseUrl?: string;
  apiKey?: string;
  apiFormat?: 'openai' | 'anthropic';
  models?: string[];
}

interface CustomCommand {
  name: string;
  description: string;
  argumentHint?: string;
  source: string;
}

type View = 'chat' | 'settings' | 'search' | 'automations' | 'skills' | 'knowledge';

/** 设置页二级分区（对标 ZCode 设置页左侧导航；Agent 组 8 项与 ZCode agentCapabilities 一一对应） */
type SettingsSection =
  | 'general' | 'appearance' | 'models' | 'browser'
  | 'agent-memory' | 'agent-plugins' | 'agent-skills' | 'agent-subagents' | 'agent-automations' | 'agent-mcp' | 'agent-commands' | 'agent-hooks'
  | 'usage' | 'logs' | 'about';

/**
 * 平台 id（UI 平台分流用）：主进程 bootstrap 注入为准确值；bootstrap 完成前以 navigator 自检兜底。
 * 选项列表等分流逻辑在 @bajin/shared/platform/shell-options（纯函数，渲染层可直接 import）。
 */
let bajinPlatformId: string | null = null;
const platformId = (): string =>
  (bajinPlatformId ??= navigator.platform.startsWith('Win') ? 'win32' : 'linux');

/** 消息内引用物提取（R9-5）：绝对路径文件 / http(s) URL / ```代码块 → 预览卡 */
interface MessageRef { kind: 'file' | 'url' | 'code'; label: string; detail: string; }

function extractRefs(text: string): { body: string; refs: MessageRef[] } {
  const refs: MessageRef[] = [];
  let body = text;
  // 代码块优先抽出
  body = body.replace(/```[\w]*\n([\s\S]{40,600}?)\n```/g, (_m, code: string) => {
    refs.push({ kind: 'code', label: `代码片段 ${code.split('\n').length} 行`, detail: code.slice(0, 400) });
    return '[代码片段]';
  });
  // 绝对路径文件（存在性由点击侧判断，仅样式识别）
  body = body.replace(/(^|\s)(\/(?:[\w.-]+\/)+[\w.-]+\.[a-z]{1,5})/gi, (_m, pre: string, fp: string) => {
    refs.push({ kind: 'file', label: fp.split('/').pop() ?? fp, detail: fp });
    return `${pre}[文件 ${fp.split('/').pop()}]`;
  });
  // URL
  body = body.replace(/https?:\/\/[^\s)]+/g, (u) => {
    refs.push({ kind: 'url', label: u.replace(/^https?:\/\//, '').slice(0, 48), detail: u });
    return `[链接 ${u.slice(0, 30)}…]`;
  });
  return { body: body.replace(/\n{3,}/g, '\n\n').trim(), refs: refs.slice(0, 4) };
}

/** 用户消息：正文 + 底部引用预览卡（点击文件直接进编辑器） */
function UserMessage({ text, onOpenFile }: { text: string; onOpenFile: (f: string) => void }): ReactNode {
  const { body, refs } = extractRefs(text);
  return (
    <div className="msg user">
      <div className="body">{body}</div>
      {refs.length > 0 && (
        <div className="msg-refs">
          {refs.map((r, i) => (
            <button key={i} className={`ref-card ref-${r.kind}`}
              title={r.detail}
              onClick={() => { if (r.kind === 'file') onOpenFile(r.detail); else if (r.kind === 'url') window.open(r.detail, '_blank', 'noopener'); }}>
              <span className="ref-ico">{r.kind === 'file' ? '📄' : r.kind === 'url' ? '🔗' : '⌨'}</span>
              <span className="ref-label">{r.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 工作时长格式化（R9 对标 ZCode「已工作 1 分 51 秒」） */
function formatWorkDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${sec} 秒`;
  return `${sec} 秒`;
}

/** 工作时长条（R12：点击展开本轮统计——迭代/工具调用/tokens，对标 ZCode 可展开箭头） */
function WorkTimer({ busy, startedAt, lastRun }: { busy: boolean; startedAt: number; lastRun: { iterations: number; toolCalls: number; tokens: number; at: number } | null }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div className="work-timer-wrap">
      <button className="work-timer clickable" title="本轮会话累计工作时长（点击查看上轮统计）" onClick={() => setOpen((v) => !v)}>
        {busy ? '已工作' : '上次工作'} {formatWorkDuration(Date.now() - startedAt)}
        <span className="chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="work-stats">
          {lastRun
            ? <>上轮 {lastRun.iterations} 轮迭代 · {lastRun.toolCalls} 次工具调用 · {lastRun.tokens > 1000 ? `${Math.round(lastRun.tokens / 1000)}k` : lastRun.tokens} tokens</>
            : '暂无上轮统计（本轮结束后显示）'}
        </div>
      )}
    </div>
  );
}

/** Electron <webview> 最小接口（纯 web 包不含 electron 类型；运行时无 Electron 时不会触达） */
interface ElectronWebviewTag {
  loadURL(url: string): Promise<void>;
  executeJavaScript<T = unknown>(code: string): Promise<T>;
  setZoomFactor(f: number): void;
  reload(): void;
  addEventListener(type: string, fn: (e: Event) => void): void;
  removeEventListener(type: string, fn: (e: Event) => void): void;
}

/** 浏览器（web shim）模式：webview 内嵌浏览器等 Electron 专属能力降级隐藏 */
const IS_WEB = !!(window as { bajin?: { __web?: boolean } }).bajin?.__web;
/** 长会话默认渲染窗口（尾部锚定，滚顶加载更早 200 条） */
const LOG_WINDOW = 150;
/** 侧栏任务列表默认渲染上限（窗口化，超出显示「显示更多」） */
const SIDEBAR_WINDOW = 120;

const MODES = ['plan', 'build', 'edit', 'yolo'];

/** 权限模式显示名（对标 ZCode mode.label.*：默认模式/计划模式/接受编辑/完全访问） */
const MODE_LABELS: Record<string, string> = {
  build: '默认模式',
  plan: '计划模式',
  edit: '接受编辑',
  yolo: '完全访问',
};
/** 模式说明（下拉菜单副标题，对标 ZCode mode 描述） */
const MODE_DESC: Record<string, string> = {
  plan: '只读调研并产出实施计划，不改动文件',
  build: '文件编辑与命令执行需逐项批准',
  edit: '文件编辑自动通过，命令仍需批准',
  yolo: '所有工具免审批直接执行，谨慎使用',
};

/** 侧边栏菜单（对标 ZCode：新建任务/搜索/自动化/技能/知识图谱 + 任务视图切换 + 底部设置） */
/* ---------- i18n（对标 ZCode settings.locale：中文默认，英文覆盖主界面，逐步补全） ---------- */

const EN: Record<string, string> = {
  '新建任务': 'New Task', '搜索': 'Search', '自动化': 'Automations', '技能': 'Skills', '知识图谱': 'Knowledge',
  '分组': 'Groups', '项目': 'Projects', '已置顶': 'Pinned', '未分组': 'Ungrouped', '未知目录': 'Unknown Dir',
  '基础': 'Basics', '数据与统计': 'Data & Stats', '关于': 'About', '常规': 'General', '模型设置': 'Models',
  'Agent 能力': 'Agent', '使用统计': 'Usage', '日志': 'Logs', '帮助': 'Help',
  '记忆': 'Memory', '插件': 'Plugins', '子代理': 'Subagents',
  '命令': 'Commands', '钩子': 'Hooks',
  '置顶任务': 'Pin task', '取消置顶任务': 'Unpin task', '重命名任务': 'Rename task',
  '归档任务': 'Archive task', '取消归档任务': 'Unarchive task', '标记为未读': 'Mark as unread',
  '在分屏打开': 'Open in split pane', '在文件管理器中打开': 'Reveal in file manager',
  '复制路径': 'Copy path', '复制任务路径': 'Copy task path', '复制日志路径': 'Copy log path',
  '复制会话 ID': 'Copy session ID', '前往配置': 'Open settings', '查看调用轨迹': 'View trajectory',
  '删除任务': 'Delete task', '反馈问题': 'Feedback', '任务视图选项': 'Task view options', '排序': 'Sort by',
  '按更新时间': 'Updated time', '按创建时间': 'Created time', '收起全部分组': 'Collapse all groups',
  '自定义技能': 'Custom skills', '内置技能': 'Built-in skills',
  '还没有自定义技能：点右上「＋ 新建技能」，或在 ~/.bajin/skills/<名称>/SKILL.md 手写': 'No custom skills yet: click "+ New skill", or hand-write ~/.bajin/skills/<name>/SKILL.md',
  '只读调研并产出实施计划，不改动文件': 'Read-only research and plan; no file changes',
  '文件编辑与命令执行需逐项批准': 'Edits and commands need per-item approval',
  '文件编辑自动通过，命令仍需批准': 'Edits auto-approved; commands still need approval',
  '所有工具免审批直接执行，谨慎使用': 'All tools run without approval; use with care',
  '浏览器面板': 'Browser panel', '暂无插件': 'No plugins',
  '返回任务': 'Back to tasks', '没有匹配的技能': 'No matching skills', '外观': 'Appearance', '浏览器': 'Browser', '界面主题与色调': 'Interface theme & tint',
  '界面': 'Interface', '浅色调 / 深色调 / 跟随系统，即时生效': 'Light / Dark / System, applied instantly',
  '跟随系统': 'System', '深色调': 'Dark', '浅色调': 'Light',
  '内嵌网页的缓存与站点数据维护': 'Cache & site data maintenance for embedded web views',
  '清理缓存': 'Clear cache', '清除图片/资源缓存，不影响登录状态': 'Clears image/resource cache, keeps logins',
  '清除所有站点数据': 'Clear all site data', '包含缓存、Cookie、本地存储；需要确认': 'Cache, cookies, local storage; confirmation required',
  '缓存已清理': 'Cache cleared', '站点数据已清除': 'Site data cleared', '确定清除全部站点数据？': 'Clear all site data?',
  '搜索技能…': 'Search skills…', '新建技能': 'New skill', '查看正文': 'View content', '已启用': 'Enabled', '已禁用': 'Disabled',
  '状态': 'Status', '作用域': 'Scope', '路径': 'Path', '本地技能': 'Local skills', '项目级': 'Project', '用户级': 'User',
  'SKILL.md 操作指南，agent 按需自动加载；禁用后模型不可见': 'SKILL.md guides auto-loaded by the agent; disabled skills are hidden from the model',
  '暂无技能（在 .bajin/skills 或 ~/.bajin/skills 放 SKILL.md）': 'No skills yet (place SKILL.md under .bajin/skills or ~/.bajin/skills)',
  '内置技能：删除后重启可恢复': 'Built-in skill: restored on restart if deleted',
  '展开全部分组': 'Expand all groups', '显示归档任务': 'Show archived tasks',
  '搜索任务...': 'Search tasks...', '暂无任务（发送消息后生成）': 'No tasks yet', '刷新任务列表': 'Refresh',
  '设置': 'Settings', '终端': 'Terminal', '面板': 'Panel',
  '开始对话': 'Start a conversation', '早上好呀，新的一天开始啦': 'Good morning, a fresh day begins',
  '中午好呀，要不要先休息一下': 'Good noon, take a break?', '下午好呀，接下来交给我吧': 'Good afternoon, leave it to me',
  '晚上好呀，今天辛苦啦': 'Good evening, great work today', '夜深啦，别忘了照顾好自己哦': 'It\'s late, take care of yourself',
  '描述你想做的事，或先选择项目文件夹…': 'Describe what you want to do, or pick a project folder…',
  '选择项目': 'Select Project', '主目录': 'Home', '不在项目中工作': 'Work outside a project', '选择文件夹…': 'Choose folder…',
  '搜索工作区': 'Search workspaces', '没有匹配的工作区': 'No matching workspaces', 'SSH 远程工作区': 'SSH Remote',
  '添加 SSH 连接…': 'Add SSH connection…', '任务': 'Tasks',
  'Git 站会摘要': 'Git standup summary', '修复失败测试': 'Fix failing tests',
  '写单元测试': 'Write unit tests', '项目脚手架': 'Project scaffold',
  '发送（Enter）': 'Send (Enter)', '切换模式': 'Switch mode', '选择模型': 'Select model', '停止（Esc）': 'Stop (Esc)',
  '保存': 'Save', '取消': 'Cancel', '删除': 'Delete', '关闭': 'Close', '添加': 'Add', '刷新': 'Refresh',
  '终端 —': 'Terminal —', '关闭终端': 'Close terminal', '输入命令…': 'Type a command…',
  '会话': 'Session', '目标': 'Goal', '计划': 'Plan', '进程': 'Progress',
  '向 bajin 提问，使用 / 选择命令或能力': 'Ask bajin anything, use / for commands',
  '任务执行中…（可点「停止」中断）': 'Task running… (click Stop to interrupt)',
  '初始化失败': 'Initialization failed', '发送失败': 'Send failed', '打开会话失败': 'Failed to open session',
  '查看会话': 'View session', '搜索当前会话...': 'Search current session…',
  '变更文件': 'Changed files', '最近提交': 'Recent commits', '文件树': 'File tree',
  '快捷键': 'Shortcuts', '暂停': 'Pause', '已暂停': 'Paused', '启用': 'Enable',
  '插件市场': 'Plugin Marketplace',
  '从 git 仓库一键安装（clone 后落入 ~/.bajin/plugins/）': 'One-click install from a git repo (cloned into ~/.bajin/plugins/)',
  '把插件目录放到 ~/.bajin/plugins/ 下（含 plugin.json + skills/ 或 commands/），自动发现': 'Drop plugin dirs into ~/.bajin/plugins/ (plugin.json + skills/ or commands/); auto-discovered',
};
let LANG: 'zh-CN' | 'en-US' = 'zh-CN';
function setLang(l: 'system' | 'zh-CN' | 'en-US' | undefined): void {
  LANG = l === 'en-US' ? 'en-US' : 'zh-CN';
}
function t(zh: string): string {
  return LANG === 'en-US' ? EN[zh] ?? zh : zh;
}

/** 任务完成提示音（双音上行，WebAudio 合成无需音频文件） */
function playDoneChime(): void {
  try {
    const ctx = new AudioContext();
    const mk = (freq: number, at: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.2);
    };
    mk(660, 0);
    mk(880, 0.12);
    setTimeout(() => void ctx.close().catch(() => undefined), 600);
  } catch {
    /* 无音频环境忽略 */
  }
}

const SIDE_MENU: Array<{ view: View | 'new'; icon: string; label: string; target?: string }> = [
  { view: 'new', icon: '＋', label: '新建任务' },
  { view: 'search', icon: '🔍', label: '搜索' },
  { view: 'automations', icon: '⏰', label: '自动化' },
  { view: 'settings', icon: '🛒', label: '插件市场', target: 'agent-plugins' },
  { view: 'skills', icon: '🛠', label: '技能' },
  { view: 'knowledge', icon: '🕸', label: '知识图谱' },
];

/** 任务列表视图模式（对标 ZCode workspaceSidebar.organize：分组/按项目） */
type TaskViewMode = 'grouped' | 'projects';
const TASK_VIEW_MODES: Array<{ id: TaskViewMode; label: string }> = [
  { id: 'grouped', label: '分组' },
  { id: 'projects', label: '项目' },
];

/** 设置页二级导航（对标 ZCode：基础 / Agent 能力 / 数据与统计 / 关于） */
const SETTINGS_NAV: Array<{ group: string; items: Array<{ id: SettingsSection; icon: string; label: string }> }> = [
  {
    group: '基础',
    items: [
      { id: 'general', icon: '⚙', label: '常规' },
      { id: 'appearance', icon: '🎨', label: '外观' },
      { id: 'models', icon: '🧠', label: '模型设置' },
      { id: 'browser', icon: '🌐', label: '浏览器' },
    ],
  },
  {
    group: 'Agent 能力',
    items: [
      { id: 'agent-memory', icon: '🧠', label: '记忆' },
      { id: 'agent-plugins', icon: '🧩', label: '插件' },
      { id: 'agent-skills', icon: '🛠', label: '技能' },
      { id: 'agent-subagents', icon: '👥', label: '子代理' },
      { id: 'agent-automations', icon: '⏰', label: '自动化' },
      { id: 'agent-mcp', icon: '🔌', label: 'MCP' },
      { id: 'agent-commands', icon: '⌨', label: '命令' },
      { id: 'agent-hooks', icon: '🪝', label: '钩子' },
    ],
  },
  {
    group: '数据与统计',
    items: [
      { id: 'usage', icon: '📊', label: '使用统计' },
      { id: 'logs', icon: '📄', label: '日志' },
    ],
  },
  {
    group: '关于',
    items: [{ id: 'about', icon: '❓', label: '帮助' }],
  },
];

const SLASH_COMMANDS: Array<{ cmd: string; desc: string }> = [
  { cmd: '/compact', desc: '压缩会话历史' },
  { cmd: '/mode <m>', desc: '切权限模式 plan|build|edit|yolo' },
  { cmd: '/model <m>', desc: '切模型' },
  { cmd: '/new', desc: '新开会话标签' },
  { cmd: '/interrupt', desc: '中断当前任务' },
];

/** 内置斜杠命令名（在渲染层处理）；其余 /xxx 透传 app-server 按自定义命令展开 */
const BUILTIN_SLASH = ['compact', 'mode', 'model', 'new', 'interrupt'];

interface RemoteWorkspace {
  name: string;
  host: string;
  port?: number;
  user?: string;
  path: string;
}

declare global {
  interface Window {
    bajin: {
      bootstrap(): Promise<{ mock: boolean; apiKey: string | null; model: string | null; mode: string | null; baseUrl: string | null; home: string | null; platform: string }>;
      rpc<T = Record<string, unknown>>(method: string, params?: unknown): Promise<T>;
      pickDir(): Promise<string | null>;
      remotesList(): Promise<RemoteWorkspace[]>;
      remotesAdd(r: RemoteWorkspace): Promise<RemoteWorkspace[]>;
      remotesRemove(name: string): Promise<RemoteWorkspace[]>;
      connectRemote(name: string): Promise<{ ok: boolean; error?: string }>;
      termStart(cwd?: string): Promise<{ ok: boolean; error?: string }>;
      termInput(input: string): Promise<{ ok: boolean }>;
      termStop(): Promise<{ ok: boolean }>;
      configGetSettings<T = Record<string, unknown>>(): Promise<T>;
      configSetSettings(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
      configPatch(patch: Record<string, unknown>): Promise<{ dataDir: string | null; mcpCount: number }>;
      mcpGet<T = Record<string, unknown>>(): Promise<T>;
      dataDirGet(): Promise<string | null>;
      dataMigrate(target: string): Promise<{ ok: boolean; error?: string }>;
      notify(title: string, body: string): Promise<boolean>;
      hooksGet<T = Record<string, unknown> | null>(): Promise<T>;
      hooksSetEnabled(enabled: boolean): Promise<Record<string, unknown>>;
      hooksSave(hooks: Record<string, unknown>): Promise<Record<string, unknown>>;
      revealPath(p: string): Promise<boolean>;
      openExternal(url: string): Promise<boolean>;
      browserClearCache(): Promise<boolean>;
      browserClearData(): Promise<boolean>;
      browserNavigate(url: string): Promise<boolean>;
      browserOpenExternal?(url: string): Promise<boolean>;
      onBrowserNavigate(cb: (url: string) => void): () => void;
      onEvent(cb: (p: { event: string; params: unknown }) => void): () => void;
    };
  }
}

/* ---------- 工具 ---------- */

function summarizeArgs(name: string, args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  switch (name) {
    case 'Read':
      return String(a['file_path'] ?? '');
    case 'Write':
      return `${a['file_path']}（${String(a['content'] ?? '').length} 字符）`;
    case 'Edit':
      return `${a['file_path']}（替换 ${String(a['old_string'] ?? '').length} 字符）`;
    case 'Bash':
      return String(a['command'] ?? '').slice(0, 140);
    case 'Glob':
      return String(a['pattern'] ?? '');
    case 'Grep':
      return `/${String(a['pattern'] ?? '')}/`;
    case 'Agent':
      return `[${a['subagent_type'] ?? 'Explore'}] ${a['description'] ?? ''}`;
    default:
      return JSON.stringify(args).slice(0, 140);
  }
}

const MAX_TOOL_LINES = 50;

const TODO_ICON: Record<string, string> = { pending: '○', in_progress: '◉', completed: '●' };
const TODO_COLOR: Record<string, string> = { high: 'var(--warn)', medium: 'var(--dim)', low: 'var(--dim)' };

/** 按当前时段返回问候语（对标 ZCode chat.empty.greeting.*） */
function greetingForHour(): string {
  const h = new Date().getHours();
  if (h < 6) return '夜深啦，别忘了照顾好自己哦';
  if (h < 11) return '早上好呀，新的一天开始啦';
  if (h < 13) return '中午好呀，要不要先休息一下';
  if (h < 18) return '下午好呀，接下来交给我吧';
  if (h < 22) return '晚上好呀，今天辛苦啦';
  return '夜深啦，别忘了照顾好自己哦';
}

/** 模式菜单（对标 ZCode：任意时刻可切，名称+说明+当前项勾选；向上弹出） */
function ModeMenu({ mode, onPick }: { mode: string; onPick: (m: string) => void }): ReactNode {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  function toggle(): void {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: Math.max(8, r.top - 4 - 190), left: Math.min(r.left, window.innerWidth - 268) });
    }
    setOpen((v) => !v);
  }
  return (
    <div className="mode-menu-wrap">
      <button ref={btnRef} className={`mode-trigger ${open ? 'on' : ''}`} onClick={toggle} title={t('切换模式')}>
        {MODE_LABELS[mode] ?? mode} <span className="chevron">▾</span>
      </button>
      {open && createPortal(
        <div className="ws-backdrop" onClick={() => setOpen(false)}>
          <div className="mode-menu" style={{ position: 'fixed', top: pos.top, left: pos.left }} onClick={(e) => e.stopPropagation()}>
            {MODES.map((m) => (
              <button key={m} className={`mode-item ${mode === m ? 'on' : ''}`} onClick={() => { setOpen(false); onPick(m); }}>
                <span className="mode-item-name">{mode === m ? '✓ ' : ''}{t(MODE_LABELS[m] ?? m)}</span>
                <span className="mode-item-desc">{t(MODE_DESC[m] ?? '')}</span>
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/** 统一输入框（欢迎页与会话页共用，对标 ZCode chat-composer-input-surface：rounded-2xl 单卡片） */
function Composer({ input, setInput, onSend, onStop, busy, disabled, cwd, onPickWorkspace, mode, onModeChange, model, onModelClick, placeholder, centered, contextUsage, effort, onEffortChange }: {
  input: string;
  setInput: (v: string | ((prev: string) => string)) => void;
  onSend: () => void;
  onStop?: () => void;
  busy: boolean;
  disabled: boolean;
  cwd?: string;
  onPickWorkspace: (dir: string | null) => void;
  mode: string;
  onModeChange: (m: string) => void;
  model: string;
  onModelClick: () => void;
  placeholder: string;
  centered?: boolean;
  contextUsage?: { tokens: number; maxTokens: number; percent: number; level: string; suggest: string | null };
  /** 输出档位（R9-3 对标 ZCode「最高 ▾」）：映射 maxTokens 经 session/set-params 生效 */
  effort?: string;
  onEffortChange?: (e: string) => void;
}): ReactNode {
  const [attachments, setAttachments] = useState<Array<{ name: string; size: number; type: string; content?: string; image?: string; thumb?: string }>>([]);
  const [previewAttach, setPreviewAttach] = useState<{ name: string; content?: string } | null>(null);
  const attachInputRef = useRef<HTMLInputElement | null>(null);

  function addAttachment(f: { name: string; size: number; type: string; content?: string; image?: string; thumb?: string }): void {
    if (attachments.length >= 5) return;
    setAttachments((prev) => [...prev, f]);
  }

  /** 图片 → canvas 压缩：发送图（≤1024px 长边）+ 缩略图（≤96px），JPEG 质量 0.8 */
  function readImageAttachment(file: File, callback: (r: { image: string; thumb: string }) => void): void {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const shrink = (max: number, quality: number): string => {
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) return '';
          ctx.drawImage(img, 0, 0, w, h);
          return canvas.toDataURL('image/jpeg', quality);
        };
        callback({ image: shrink(1024, 0.8), thumb: shrink(96, 0.6) });
      };
      img.onerror = () => callback({ image: '', thumb: '' });
      img.src = String(reader.result ?? '');
    };
    reader.onerror = () => callback({ image: '', thumb: '' });
    reader.readAsDataURL(file);
  }

  /** 读取文件内容：文本 ≤20KB 全读，大文件截取前 2k 字符，图片压缩为 base64 供 vision 输入 */
  function readFileContent(file: File, callback: (content: string) => void, imageBack?: (r: { image: string; thumb: string }) => void): void {
    if (file.type.startsWith('image/')) {
      if (imageBack) {
        readImageAttachment(file, (r) => {
          imageBack(r);
          callback(r.image ? `[图片 ${file.name}]（base64 已附，模型可视觉理解）` : `[图片读取失败] ${file.name}`);
        });
        return;
      }
      callback(`[图片] ${file.name} · ${file.type} · ${Math.round(file.size / 1024)}KB`);
      return;
    }
    if (file.size > 20 * 1024) {
      callback(`[文件过大，截取前 2000 字符] ${file.name}`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => callback(String(reader.result ?? ''));
    reader.onerror = () => callback(`[读取失败] ${file.name}`);
    reader.readAsText(file);
  }

  function handleDropWithContent(e: React.DragEvent): void {
    e.preventDefault();
    e.stopPropagation();
    for (const f of Array.from(e.dataTransfer.files)) {
      readFileContent(f,
        (content) => addAttachment({ name: f.name, size: f.size, type: f.type || 'unknown', content }),
        (r) => setAttachments((prev) => (prev.length >= 5 ? prev : [...prev, { name: f.name, size: f.size, type: f.type || 'unknown', image: r.image, thumb: r.thumb }])));
    }
  }

  function handleDrop(e: React.DragEvent): void {
    e.preventDefault();
    e.stopPropagation();
    for (const f of Array.from(e.dataTransfer.files)) {
      addAttachment({ name: f.name, size: f.size, type: f.type || 'unknown' });
    }
  }

  function handlePaste(e: React.ClipboardEvent): void {
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) {
          e.preventDefault();
          readFileContent(f,
            (content) => addAttachment({ name: f.name || 'clipboard', size: f.size, type: f.type || 'unknown', content }),
            (r) => setAttachments((prev) => (prev.length >= 5 ? prev : [...prev, { name: f.name || 'clipboard.png', size: f.size, type: f.type || 'image/png', image: r.image, thumb: r.thumb }])));
        }
      }
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!busy && !disabled) {
        // 附件块：图片附 dataURL（vision 输入），文本附原文
        const attachText = attachments
          .filter((a) => a.content || a.image)
          .map((a) => `--- 附件: ${a.name} ---\n${a.image ? `![${a.name}](${a.image})\n` : ''}${a.content ?? ''}\n--- 附件结束 ---`)
          .join('\n\n');
        if (attachText) {
          setInput((prev) => `${prev}\n\n${attachText}`);
          // 延迟一帧让 state 更新再发送
          setTimeout(() => { onSend(); setAttachments([]); }, 50);
        } else {
          onSend();
          setAttachments([]);
        }
      }
    }
  };
  return (
    <div className={`composer ${centered ? 'centered' : ''}`}>
      <div className="composer-card" onDrop={handleDropWithContent} onDragOver={(e) => e.preventDefault()} onPaste={handlePaste}>
        {attachments.length > 0 && (
          <div className="attachment-row">
            {attachments.map((a, i) => (
              <span key={i} className="attachment-chip clickable" title={`${a.name} · ${a.size}B`} onClick={() => setPreviewAttach(a)}>
                {a.thumb ? <img className="attach-thumb" src={a.thumb} alt={a.name} /> : '📎'} {a.name} <span className="log-meta">{a.size > 1024 ? `${Math.round(a.size / 1024)}KB` : `${a.size}B`}</span>
                <button className="attachment-remove" onClick={(e) => { e.stopPropagation(); setAttachments((prev) => prev.filter((_, idx) => idx !== i)); }}>×</button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-chip-row">
          <WorkspaceChip cwd={cwd} onPick={(dir) => onPickWorkspace(dir)} />
        </div>
        <textarea
          value={input}
          placeholder={busy ? t('任务执行中…（可点「停止」中断）') : (input.trim() ? placeholder : t('提出后续修改要求，或描述新任务…'))}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="composer-bar">
          <input ref={attachInputRef} type="file" multiple style={{ display: 'none' }}
            onChange={(e) => {
              for (const f of Array.from(e.target.files ?? [])) {
                readFileContent(f,
                  (content) => addAttachment({ name: f.name, size: f.size, type: f.type || 'unknown', content }),
                  (r) => setAttachments((prev) => (prev.length >= 5 ? prev : [...prev, { name: f.name, size: f.size, type: f.type || 'image/png', image: r.image, thumb: r.thumb }])));
              }
              e.target.value = '';
            }} />
          <button className="composer-plus" title="添加附件（文本/图片）" onClick={() => attachInputRef.current?.click()}>＋</button>
          <ModeMenu mode={mode} onPick={onModeChange} />
          <ContextIndicator usage={contextUsage} />
          <span className="spacer" />
          <button className="model-switch-btn" disabled={busy} onClick={onModelClick} title={t('选择模型')}>
            {model} <span className="chevron">▾</span>
          </button>
          {onEffortChange && (
            <select className="effort-select" value={effort ?? '高'} disabled={busy} title="输出档位（最大输出 tokens）"
              onChange={(e) => onEffortChange(e.target.value)}>
              <option value="最高">⚡ 最高</option>
              <option value="高">高</option>
              <option value="中">中</option>
              <option value="低">低</option>
            </select>
          )}
          <VoiceButton onText={(t) => setInput((p) => p + (p ? " " : "") + t)} />
          {busy ? (
            <button className="send-btn stop-mode" onClick={onStop} title={t('停止（Esc）')}>⏹</button>
          ) : (
            <button className="send-btn round" onClick={onSend} disabled={disabled} title={t('发送（Enter）')}>↑</button>
          )}
        </div>
      </div>
      {mode === 'plan' && <div className="mode-hint">⎇ 计划模式已开启：只调研并产出实施计划，不会改动任何文件。</div>}
      {mode === 'yolo' && <div className="mode-hint warn">⚡ 完全访问模式：所有工具免审批直接执行，请谨慎使用。</div>}
      {previewAttach && (
        <div className="ws-backdrop" onClick={() => setPreviewAttach(null)}>
          <div className="modal attachment-preview" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>📎 {previewAttach.name}</span>
              <button className="icon-btn" onClick={() => setPreviewAttach(null)}>×</button>
            </div>
            <pre className="attachment-preview-body">{previewAttach.content || '(无预览内容)'}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

/** 工作区选择器（对标 chat.empty.workspaceMenu：选择项目/主目录/不在项目中工作/打开文件夹） */
function WorkspaceChip({ cwd, onPick }: { cwd?: string; onPick: (dir: string | null, label: string) => void }): ReactNode {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Array<{ cwd: string; count: number; lastModifiedAt: number }>>([]);
  const [query, setQuery] = useState('');
  const [remotes, setRemotes] = useState<RemoteWorkspace[]>([]);
  const [addingRemote, setAddingRemote] = useState(false);
  const [rf, setRf] = useState<RemoteWorkspace>({ name: '', host: '', path: '' });
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const label = cwd ? (cwd.split('/').pop() || cwd) : '选择项目';
  const q = query.trim().toLowerCase();

  useEffect(() => {
    if (!open) return;
    void window.bajin.rpc<{ projects: Array<{ cwd: string; count: number; lastModifiedAt: number }> }>('projects/list')
      .then((r) => setProjects(r.projects ?? []))
      .catch(() => undefined);
    void window.bajin.remotesList().then(setRemotes).catch(() => undefined);
  }, [open]);

  function toggle() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const below = r.bottom + 4 + 380 < window.innerHeight;
      setPos({
        top: below ? r.bottom + 4 : r.top - 384,
        left: Math.min(r.left, window.innerWidth - 308),
      });
    }
    setOpen((v) => !v);
  }

  /** 连接远程工作区：agent 切到远程主机跑（ssh ... node bajin.cjs app-server --stdio） */
  async function connectRemote(name: string): Promise<void> {
    const r = await window.bajin.connectRemote(name);
    if (!r.ok) {
      alert(`连接远程工作区失败: ${r.error ?? '未知错误'}
前提：远程主机已安装 node，且 ${'/'}bajin.cjs 放置在配置的路径下（scp 本地 packages/cli/dist/bundle/bajin.cjs 过去即可）`);
      return;
    }
    location.reload();
  }

  const recent = projects
    .filter((p) => !q || p.cwd.toLowerCase().includes(q))
    .sort((a, b) => b.lastModifiedAt - a.lastModifiedAt)
    .slice(0, 8);

  return (
    <div className="ws-chip-wrap">
      <button ref={btnRef} className="ws-chip" title={cwd ?? '选择要工作的项目文件夹'} onClick={toggle}>
        📁 <span className="ws-chip-label">{label}</span> <span className="chevron">▾</span>
      </button>
      {open && createPortal(
        <div className="ws-backdrop" onClick={() => setOpen(false)}>
          <div className="ws-picker" style={{ position: 'fixed', top: pos.top, left: pos.left }} onClick={(e) => e.stopPropagation()}>
            <div className="mp-search">
              <input autoFocus value={query} placeholder="搜索工作区" onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="ws-list">
              {recent.map((p) => (
                <div key={p.cwd} className={`ws-item ${cwd === p.cwd ? 'on' : ''}`} onClick={() => { setOpen(false); onPick(p.cwd, p.cwd.split('/').pop() || p.cwd); }}>
                  <span className="ws-name">{p.cwd.split('/').pop() || p.cwd}</span>
                  <span className="log-meta">{p.cwd} · {p.count} 任务</span>
                </div>
              ))}
              {!recent.length && <div className="history-empty" style={{ padding: '10px 14px' }}>没有匹配的工作区</div>}
            </div>
            <div className="ws-remote-title">SSH 远程工作区</div>
            <div className="ws-list">
              {remotes.map((r) => (
                <div key={r.name} className="ws-item" onClick={() => { setOpen(false); void connectRemote(r.name); }}>
                  <span className="ws-name">🖥 {r.name} <span className="log-meta">{r.user ? `${r.user}@` : ''}{r.host}{r.port ? `:${r.port}` : ''}:{r.path}</span></span>
                  <span className="ws-del" onClick={(e) => { e.stopPropagation(); void window.bajin.remotesRemove(r.name).then(setRemotes); }}>删除</span>
                </div>
              ))}
              {addingRemote ? (
                <div className="ws-add-remote">
                  <input placeholder="名称 *" value={rf.name} onChange={(e) => setRf({ ...rf, name: e.target.value })} />
                  <input placeholder="Host *" value={rf.host} onChange={(e) => setRf({ ...rf, host: e.target.value })} />
                  <input placeholder="Port（默认22）" value={rf.port ?? ''} onChange={(e) => setRf({ ...rf, port: e.target.value ? Number(e.target.value) : undefined })} />
                  <input placeholder="用户名（可选）" value={rf.user ?? ''} onChange={(e) => setRf({ ...rf, user: e.target.value })} />
                  <input placeholder="远程路径 *（bajin.cjs 所在目录，如 /home/u/bajin）" value={rf.path} onChange={(e) => setRf({ ...rf, path: e.target.value })} />
                  <button className="primary" onClick={() => { if (!rf.name.trim() || !rf.host.trim() || !rf.path.trim()) return; void window.bajin.remotesAdd({ ...rf, name: rf.name.trim(), host: rf.host.trim(), path: rf.path.trim() }).then(setRemotes); setAddingRemote(false); }}>保存</button>
                </div>
              ) : (
                <div className="ws-item" onClick={() => setAddingRemote(true)}>
                  <span className="ws-name">➕ 添加 SSH 连接…</span>
                </div>
              )}
            </div>
            <div className="ws-fixed">
              <div className="ws-item" onClick={() => { void window.bajin.pickDir().then((dir) => { setOpen(false); if (dir) onPick(dir, dir.split('/').pop() || dir); }); }}>
                <span className="ws-name">📂 选择文件夹…</span>
              </div>
              {bootHome && (
                <div className={`ws-item ${cwd === bootHome ? 'on' : ''}`} onClick={() => { setOpen(false); onPick(bootHome, '主目录'); }}>
                  <span className="ws-name">🏠 主目录</span>
                  <span className="log-meta">{bootHome}</span>
                </div>
              )}
              <div className="ws-item" onClick={() => { setOpen(false); onPick(null, '不在项目中工作'); }}>
                <span className="ws-name">🚫 不在项目中工作</span>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/** 内置默认技能名（种子清单，与 core BUILTIN_SKILLS 保持一致；仅用于 UI 标注） */
const BUILTIN_SKILL_NAMES = new Set(['skill-creator', 'docx', 'pptx', 'pdf', 'self-check', 'diagnosing-commands', 'diagnosing-hooks', 'diagnosing-mcp', 'diagnosing-skills', 'configuration-guide']);

let bootHome: string | null = null;

/** 任务视图选项菜单（对标 workspaceSidebar.organize/sortBy/toggleArchivedTasks） */
function TaskViewOptionsMenu({ sortBy, onSortBy, showArchived, onShowArchived, collapsed, onCollapseAll, onExpandAll }: {
  sortBy: 'updated' | 'created';
  onSortBy: (v: 'updated' | 'created') => void;
  showArchived: boolean;
  onShowArchived: (v: boolean) => void;
  collapsed: Set<string>;
  onCollapseAll: () => void;
  onExpandAll: () => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  function toggle(): void {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: Math.min(r.left, window.innerWidth - 220) });
    }
    setOpen((v) => !v);
  }
  return (
    <div className="tvo-menu-wrap">
      <button ref={btnRef} className={`tvo-trigger ${open ? 'on' : ''}`} title={t('任务视图选项')} onClick={toggle}>▾</button>
      {open && createPortal(
        <div className="ws-backdrop" onClick={() => setOpen(false)}>
          <div className="history-menu tvo-menu" style={{ position: 'fixed', top: pos.top, left: pos.left }} onClick={(e) => e.stopPropagation()}>
            <div className="menu-title">{t('排序')}</div>
            <button className={sortBy === 'updated' ? 'checked' : ''} onClick={() => { onSortBy('updated'); setOpen(false); }}>{sortBy === 'updated' ? '● ' : '○ '}{t('按更新时间')}</button>
            <button className={sortBy === 'created' ? 'checked' : ''} onClick={() => { onSortBy('created'); setOpen(false); }}>{sortBy === 'created' ? '● ' : '○ '}{t('按创建时间')}</button>
            <div className="menu-sep" />
            <button onClick={() => { onCollapseAll(); setOpen(false); }} disabled={!collapsed.size ? false : false}>{t('收起全部分组')}</button>
            <button onClick={() => { onExpandAll(); setOpen(false); }}>{t('展开全部分组')}</button>
            <div className="menu-sep" />
            <button className={showArchived ? 'checked' : ''} onClick={() => onShowArchived(!showArchived)}>{showArchived ? '✓ ' : ''}{t('显示归档任务')}</button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/** 任务项：点击打开 + 悬浮菜单（对标 ZCode taskList 13 项，顺序一致） */
function TaskListItem({ item, showProject, onOpen, onChanged, onGoSettings }: {
  item: HistoryItem;
  showProject: boolean;
  onOpen: () => void;
  onChanged: () => void;
  onGoSettings: (sec: SettingsSection) => void;
}): ReactNode {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [grouping, setGrouping] = useState(false);
  const [draft, setDraft] = useState(item.title);
  const [groupName, setGroupName] = useState(item.group ?? '');

  function copy(text: string): void {
    if (text) void navigator.clipboard.writeText(text).catch(() => undefined);
  }

  async function act(method: string, params: Record<string, unknown>): Promise<void> {
    await window.bajin.rpc(method, { sessionId: item.sessionId, ...params }).catch(() => undefined);
    setMenu(false);
    onChanged();
  }

  return (
    <div className="history-item-wrap">
      <div className={`history-item ${item.pinned ? 'pinned' : ''}`} onClick={onOpen} title={`${item.sessionId}${item.cwd ? ` · ${item.cwd}` : ''}`}>
        {renaming ? (
          <input
            autoFocus
            className="rename-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.trim()) { void act('session/rename', { title: draft.trim() }); setRenaming(false); }
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : grouping ? (
          <input
            autoFocus
            className="rename-input"
            placeholder="分组名（留空取消分组）"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { void act('session/set-group', groupName.trim() ? { group: groupName.trim() } : {}); setGrouping(false); }
              if (e.key === 'Escape') setGrouping(false);
            }}
          />
        ) : (
          <>
            <span className="task-ico">{taskIcon(item.title || item.sessionId || '')}</span>
            <span className={`history-title ${item.unread ? 'unread' : ''}`}>{item.unread ? '● ' : ''}{item.title || '(无标题)'}</span>
            <span className="history-quick">
              <button className="hq-btn" title="复制会话 ID" onClick={(e) => { e.stopPropagation(); copy(item.sessionId); }}>⧉</button>
              <button className="hq-btn hq-del" title="删除任务" onClick={(e) => { e.stopPropagation(); void act('session/delete', {}).then(onChanged); }}>🗑</button>
            </span>
            <span className="history-time">{formatTaskTime(item.modifiedAt)}</span>
          </>
        )}
      </div>
      {!renaming && !grouping && (
        <button
          className="history-more"
          title="任务操作"
          onClick={(e) => { e.stopPropagation(); setMenu((v) => !v); }}
        >⋯</button>
      )}
      {menu && !renaming && !grouping && (
        <div className="history-menu" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => void act('session/pin', { pinned: !item.pinned })}>{item.pinned ? t('取消置顶任务') : t('置顶任务')}</button>
          <button onClick={() => { setMenu(false); setRenaming(true); }}>{t('重命名任务')}</button>
          <button onClick={() => void act('session/archive', { archived: !item.archived })}>{item.archived ? t('取消归档任务') : t('归档任务')}</button>
          <button onClick={() => void act('session/unread', { unread: true })}>{t('标记为未读')}</button>
          <div className="menu-sep" />
          <button onClick={() => { setMenu(false); onOpen(); }}>{t('在分屏打开')}</button>
          <button onClick={() => { setMenu(false); void window.bajin.revealPath(item.sessionDir ?? item.cwd ?? ''); }}>{t('在文件管理器中打开')}</button>
          <div className="menu-sep" />
          <button onClick={() => { setMenu(false); copy(item.cwd ?? ''); }}>{t('复制路径')}</button>
          <button onClick={() => { setMenu(false); copy(item.sessionDir ?? ''); }}>{t('复制任务路径')}</button>
          <button onClick={() => { setMenu(false); copy(item.rolloutPath ?? ''); }}>{t('复制日志路径')}</button>
          <button onClick={() => { setMenu(false); copy(item.sessionId); }}>{t('复制会话 ID')}</button>
          <div className="menu-sep" />
          <button onClick={() => { setMenu(false); onGoSettings('models'); }}>{t('前往配置')}</button>
          <button onClick={() => { setMenu(false); onGoSettings('logs'); }}>{t('查看调用轨迹')}</button>
          <button onClick={() => { setMenu(false); void window.bajin.openExternal('https://github.com/'); }}>{t('反馈问题')}</button>
          <div className="menu-sep" />
          <button className="danger" onClick={() => {
            setMenu(false);
            if (confirm(`删除任务「${item.title || item.sessionId}」？不可恢复`)) void act('session/delete', {});
          }}>{t('删除任务')}</button>
        </div>
      )}
    </div>
  );
}

/** 历史消息还原为对话项（含工具卡配对：assistant.toolCalls 占位 → tool 消息回填输出） */
function historyToItems(msgs: Array<Record<string, unknown>>): Item[] {
  const items: Item[] = [];
  const pending = new Map<string, number[]>();
  for (const m of msgs) {
    const role = m['role'];
    const content = typeof m['content'] === 'string' ? m['content'] : '';
    if (role === 'user') {
      items.push({ kind: 'user', text: content });
    } else if (role === 'assistant') {
      if (content) items.push({ kind: 'assistant', text: content });
      for (const c of (m['toolCalls'] as Array<{ name: string; arguments: string }> | undefined) ?? []) {
        let args: unknown;
        try { args = JSON.parse(c.arguments || '{}'); } catch { args = {}; }
        const idx = items.push({ kind: 'tool', name: c.name, summary: summarizeArgs(c.name, args), output: '', ok: true, startedAt: 0, endedAt: 0 }) - 1;
        (pending.get(c.name) ?? pending.set(c.name, []).get(c.name)!).push(idx);
      }
    } else if (role === 'tool') {
      const name = String(m['name'] ?? '');
      const idx = pending.get(name)?.shift();
      if (idx !== undefined) items[idx] = { ...(items[idx] as Extract<Item, { kind: 'tool' }>), output: content };
      else items.push({ kind: 'tool', name, summary: '', output: content, ok: true, startedAt: 0, endedAt: 0 });
    }
  }
  return items;
}

/** 任务标题过滤（对标 workspaceSidebar.searchTasks） */
function filterHistory(history: HistoryItem[], q: string): HistoryItem[] {
  const query = q.trim().toLowerCase();
  if (!query) return history;
  return history.filter((h) => h.title.toLowerCase().includes(query) || h.sessionId.toLowerCase().includes(query));
}

/** 任务列表分桶（对标 ZCode workspaceSidebar.organize：分组/按项目；置顶永远在最前）。
 *  项目模式按完整 cwd 分组（最后一段会撞名且嵌套子目录脱离主项目组）。 */
function bucketTasks(history: HistoryItem[], mode: TaskViewMode): Array<[string, HistoryItem[]]> {
  const buckets = new Map<string, HistoryItem[]>();
  const put = (key: string, h: HistoryItem) => (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(h);
  for (const h of history.filter((x) => x.pinned)) put('已置顶', h);
  const rest = history.filter((x) => !x.pinned);
  if (mode === 'projects') {
    for (const h of rest) put(h.cwd || '未知目录', h);
  } else {
    for (const h of rest) put(h.group ?? '未分组', h);
  }
  const ORDER = ['已置顶'];
  return [...buckets.entries()].sort((a, b) => {
    const ai = ORDER.indexOf(a[0]); const bi = ORDER.indexOf(b[0]);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
}

/** 任务时间（对标 ZCode taskList 的相对时间：刚刚/N分/N小时/N天） */
function formatTaskTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}天`;
  return new Date(ts).toLocaleDateString();
}

interface StarterTemplate {
  icon: string;
  title: string;
  desc: string;
  prompt: string;
}
const STARTER_TEMPLATES: StarterTemplate[] = [
  { icon: '📋', title: 'Git 站会摘要', desc: '每周五总结代码提交', prompt: '查看本仓库本周的 git 提交，按作者汇总成 3-5 条站会要点' },
  { icon: '🧪', title: 'CI 失败与不稳定测试', desc: '找出最近失败的 CI 与不稳定用例', prompt: '检查本仓库最近一次 CI 运行的失败原因，以及不稳定/跳过的测试，给出修复建议' },
  { icon: '✨', title: '自定义', desc: '跳过模板，直接描述你的任务', prompt: '' },
];

let tabSeq = 0;
function blankTab(): Tab {
  return {
    id: ++tabSeq,
    workStartedAt: null,
    effort: '高',
    lastRun: null,
    sessionId: null,
    title: `新会话 ${++tabSeq}`,
    items: [],
    busy: false,
    approval: null,
    ask: null,
    todos: [],
    tokens: 0,
    model: 'glm-5.3',
    mode: 'build',
    planMode: false,
  };
}

/* ---------- 应用 ---------- */

function App() {
  const [tabs, setTabs] = useState<Tab[]>([blankTab()]);
  const [active, setActive] = useState(0);
  const [input, setInput] = useState('');
  const [isMock, setIsMock] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [taskViewMode, setTaskViewMode] = useState<TaskViewMode>('grouped');
  const [taskFilter, setTaskFilter] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [view, setView] = useState<View>('chat');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const [models, setModels] = useState<ModelOpt[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [customCommands, setCustomCommands] = useState<CustomCommand[]>([]);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showPanel, setShowPanel] = useState(true);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  /* 浏览器面板指令（R6）：BrowserNavigate 工具事件 → 面板打开并应用 */
  const [browserDirective, setBrowserDirective] = useState<{ url?: string; viewport?: { width: number; height: number }; zoom?: number; action?: 'click' | 'type'; selector?: string; text?: string; seq?: number } | null>(null);
  const [showFileTree, setShowFileTree] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [sessionSearch, setSessionSearch] = useState('');
  const [showProcMonitor, setShowProcMonitor] = useState(false);
  /* 通知中心（对标 ZCode 通知历史）：approval/完成/错误 全量留档，右下角 🔔 查看 */
  const [notifications, setNotifications] = useState<Array<{ id: number; kind: 'approval' | 'done' | 'error' | 'info'; title: string; body: string; ts: number; read: boolean }>>([]);
  const [showNotifCenter, setShowNotifCenter] = useState(false);
  const notifSeqRef = useRef(0);
  const pushNotif = useCallback((kind: 'approval' | 'done' | 'error' | 'info', title: string, body: string): void => {
    setNotifications((prev) => [...prev.slice(-49), { id: ++notifSeqRef.current, kind, title, body, ts: Date.now(), read: false }]);
  }, []);
  const [gitStatus, setGitStatus] = useState<{ isRepo: boolean; branch: string; dirtyCount: number; staged: number; unstaged: number; dirtyFiles: string[]; recentCommits: Array<{ hash: string; message: string }>; diffStat: string } | null>(null);
  const [showGitPanel, setShowGitPanel] = useState(false);
  const [editorFile, setEditorFile] = useState<string | null>(null);
  const [uiSettings, setUiSettings] = useState<UISettings>({});
  const [, forceI18n] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);
  /* 长会话虚拟滚动（R5-2）：每会话渲染窗口，默认尾部 150 条，滚顶加载更早 */
  const [logLimits, setLogLimits] = useState<Record<string, number>>({});
  /* 侧栏任务窗口化（R5-2）：默认渲染前 120 个，超出显示「显示更多」 */
  const [sidebarLimit, setSidebarLimit] = useState(SIDEBAR_WINDOW);
  /* 时间线刻度进度（R9-4）：按滚动位置 0-100%，滚动条本身即会话进度 */
  const [tlProgress, setTlProgress] = useState(0);
  /* 标签恢复栈（R8-3）：closeOne/Others/All 统一入栈，Ctrl+Shift+T 或菜单恢复 */
  const [closedTabs, setClosedTabs] = useState<Pick<Tab, 'id' | 'title' | 'sessionId'>[]>([]);
  const [tabMenu, setTabMenu] = useState<{ idx: number; x: number; y: number } | null>(null);
  const bootRef = useRef<{ mock: boolean; apiKey: string | null; model: string | null; mode: string | null; baseUrl: string | null; home: string | null } | null>(null);
  const tab = tabs[active] ?? tabs[0]!;

  const patchTab = useCallback((sessionId: string | null, fn: (t: Tab) => Tab) => {
    setTabs((prev) => prev.map((t) => (t.sessionId === sessionId || (!t.sessionId && !sessionId) ? fn(t) : t)));
  }, []);

  const pushItem = useCallback((sessionId: string | null, item: Item) => {
    patchTab(sessionId, (t) => ({ ...t, items: [...t.items, item] }));
  }, [patchTab]);

  const patchLast = useCallback((sessionId: string | null, kind: Item['kind'], fn: (i: Extract<Item, { kind: typeof kind }>) => Extract<Item, { kind: typeof kind }>) => {
    patchTab(sessionId, (t) => {
      for (let i = t.items.length - 1; i >= 0; i--) {
        if (t.items[i]!.kind === kind) {
          const next = [...t.items];
          next[i] = fn(next[i] as Extract<Item, { kind: typeof kind }>);
          return { ...t, items: next };
        }
      }
      return t;
    });
  }, [patchTab]);

  const refreshModels = useCallback(async () => {
    try {
      const res = await window.bajin.rpc<{ models: ModelOpt[] }>('models/list');
      setModels(res.models ?? []);
    } catch {
      /* 忽略 */
    }
  }, []);

  const refreshProviders = useCallback(async () => {
    try {
      const res = await window.bajin.rpc<{ providers: ProviderInfo[] }>('providers/list');
      setProviders(res.providers ?? []);
    } catch {
      /* 忽略 */
    }
  }, []);

  const refreshCommands = useCallback(async () => {
    try {
      const res = await window.bajin.rpc<{ commands: CustomCommand[] }>('commands/list');
      setCustomCommands(res.commands ?? []);
    } catch {
      /* 忽略 */
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      const res = await window.bajin.rpc<{ sessions: HistoryItem[] }>('list-sessions');
      let list = res.sessions ?? [];
      const s = uiSettingsRef.current;
      if (s.taskAutoArchiveEnabled) {
        const cutoff = Date.now() - (s.taskAutoArchiveOlderThanDays ?? 14) * 86400000;
        list = list.filter((h) => h.pinned || h.modifiedAt >= cutoff);
      }
      setHistory(list);
    } catch {
      /* 忽略 */
    }
  }, []);

  /** 任务列表可见集：归档过滤（显示归档开关）+ 排序（更新时间/创建时间，置顶不动） */
  const visibleHistory = useCallback(() => {
    const showArchived = uiSettingsRef.current.showArchivedTasks === true;
    const byCreated = uiSettingsRef.current.taskSortBy === 'created';
    const list = filterHistory(history, taskFilter).filter((h) => showArchived || !h.archived);
    return [...list].sort((a, b) => {
      if (Boolean(b.pinned) !== Boolean(a.pinned)) return b.pinned ? 1 : -1;
      const ka = byCreated ? (a.createdAt ?? a.modifiedAt) : a.modifiedAt;
      const kb = byCreated ? (b.createdAt ?? b.modifiedAt) : b.modifiedAt;
      return kb - ka;
    });
  }, [history, taskFilter]);

  const toggleGroup = useCallback((bucket: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(bucket)) next.delete(bucket);
      else next.add(bucket);
      return next;
    });
  }, []);

  /* 草稿保存 */
  useEffect(() => {
    const saved = localStorage.getItem('bajin-draft');
    if (saved && !input) setInput(saved);
  }, []);
  useEffect(() => {
    if (input) localStorage.setItem('bajin-draft', input); else localStorage.removeItem('bajin-draft');
  }, [input]);

  /* Git 状态加载 */
  const refreshGitStatus = useCallback(() => {
    void window.bajin.rpc('git/status').then((r) => setGitStatus(r as typeof gitStatus)).catch(() => setGitStatus(null));
  }, []);
  useEffect(() => { refreshGitStatus(); }, [refreshGitStatus, tab.cwd]);

  /* 自动更新检查（对标 ZCode：启动时查 GitHub Releases） */
  useEffect(() => {
    void fetch('https://api.github.com/repos/fumolan/bajin/releases/latest', { signal: AbortSignal.timeout(5000) } as RequestInit)
      .then((r) => r.json())
      .then((d: { tag_name?: string }) => {
        if (d.tag_name && d.tag_name !== 'v0.1.0') {
          pushItem(null, { kind: 'system', text: `🆕 bajin ${d.tag_name} 可用。到 https://github.com/fumolan/bajin/releases 下载` });
        }
      })
      .catch(() => undefined); // 静默失败
  }, []);

  /* 主题应用：settings.theme → 根节点 data-theme；system 跟随媒体查询 */
  useEffect(() => {
    const apply = (): void => {
      const pref = uiSettings.theme ?? 'dark';
      const resolved = pref === 'system'
        ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
        : pref;
      document.documentElement.setAttribute('data-theme', resolved);
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [uiSettings.theme]);

  /** 界面设置变更：写盘 + 更新内存态（立即生效，无需重启）；语言切换触发全量重渲染 */
  const patchUiSettings = useCallback((patch: Partial<UISettings>) => {
    setUiSettings((prev) => ({ ...prev, ...patch }));
    void window.bajin.configSetSettings(patch as Record<string, unknown>).catch(() => undefined);
    if ('locale' in patch) { setLang(patch.locale); forceI18n((n) => n + 1); }
    if ('taskAutoArchiveEnabled' in patch || 'taskAutoArchiveOlderThanDays' in patch) void refreshHistory();
  }, []);

  /* 启动：bootstrap → initialize 第一个会话 */
  useEffect(() => {
    void (async () => {
      try {
        const boot = await window.bajin.bootstrap();
        bootRef.current = boot;
        bootHome = boot.home ?? null;
        bajinPlatformId = boot.platform;
        void window.bajin.configGetSettings<UISettings>().then((s) => { setUiSettings(s); setLang(s.locale); forceI18n((n) => n + 1); }).catch(() => undefined);
        const res = await window.bajin.rpc<Record<string, unknown>>('initialize', {
          mock: boot.mock,
          ...(boot.apiKey ? { apiKey: boot.apiKey } : {}),
          ...(boot.model ? { model: boot.model } : {}),
          ...(boot.mode ? { mode: boot.mode } : {}),
          ...(boot.baseUrl ? { baseUrl: boot.baseUrl } : {}),
          persist: true,
        });
        const sessionId = String(res['sessionId']);
        setIsMock(Boolean(res['mock']));
        patchTab(null, (t) => ({
          ...t,
          sessionId,
          model: String(res['model'] ?? t.model),
          mode: String(res['mode'] ?? t.mode),
          title: '会话 1',
        }));
        if (boot.mock) {
          pushItem(sessionId, { kind: 'system', text: '未检测到任何 API Key（全局 BIGMODEL_API_KEY 或供应商 Key），已降级 mock 模式。到「设置 → 模型设置」给供应商配置 API Key 后重启即可使用真实模型。' });
        }
        // 分享链接直达：?session=<id> 打开指定历史会话（web 模式链接分享）
        const shared = new URLSearchParams(window.location.search).get('session');
        if (shared) void openHistoryRef.current(shared);
        void refreshHistory();
        void refreshModels();
        void refreshProviders();
        void refreshCommands();
      } catch (err) {
        pushItem(null, { kind: 'system', text: `⚠ ${t('初始化失败')}: ${friendlyError(err)}` });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 事件路由（uiSettingsRef 让通知开关在事件回调里取最新值而不用重挂监听） */
  const uiSettingsRef = useRef<UISettings>({});
  useEffect(() => { uiSettingsRef.current = uiSettings; }, [uiSettings]);
  useEffect(() => {
    return window.bajin.onEvent(({ event, params }) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const sid = p['sessionId'] as string | undefined;
      switch (event) {
        case 'text-delta':
          patchTab(sid ?? null, (t) => {
            const items = [...t.items];
            // 找最后一个空/进行中的 assistant 块追加
            for (let i = items.length - 1; i >= 0; i--) {
              if (items[i]!.kind === 'assistant') {
                items[i] = { ...(items[i] as { kind: 'assistant'; text: string }), text: (items[i] as { text: string }).text + String(p['delta'] ?? '') };
                return { ...t, items };
              }
              if (items[i]!.kind === 'user') break;
            }
            items.push({ kind: 'assistant', text: String(p['delta'] ?? '') });
            return { ...t, items };
          });
          break;
        case 'reasoning-delta':
          patchTab(sid ?? null, (t) => {
            const items = [...t.items];
            const now = Date.now();
            if (items.length && items[items.length - 1]!.kind === 'reasoning') {
              const prev = items[items.length - 1] as { kind: 'reasoning'; text: string; startedAt: number; lastAt: number };
              items[items.length - 1] = { ...prev, text: prev.text + String(p['delta'] ?? ''), lastAt: now };
            } else {
              items.push({ kind: 'reasoning', text: String(p['delta'] ?? ''), startedAt: now, lastAt: now });
            }
            return { ...t, items };
          });
          break;
        case 'tool-call':
          pushItem(sid ?? null, { kind: 'tool', name: String(p['name']), summary: summarizeArgs(String(p['name']), p['args']), startedAt: Date.now() });
          break;
        case 'tool-result':
          patchTab(sid ?? null, (t) => {
            const items = [...t.items];
            for (let i = items.length - 1; i >= 0; i--) {
              const it = items[i]!;
              if (it.kind === 'tool' && it.name === String(p['name']) && it.output === undefined) {
                items[i] = { ...it, output: String(p['output'] ?? ''), ok: Boolean(p['ok']), denied: Boolean(p['denied']), endedAt: Date.now() };
                break;
              }
            }
            return { ...t, items };
          });
          break;
        case 'todo-updated':
          patchTab(sid ?? null, (t) => ({ ...t, todos: (p['todos'] as TodoItem[]) ?? [] }));
          break;
        case 'approval-request': {
          const name = String(p['name']);
          const args = p['args'] as Record<string, unknown> | undefined;
          const plan = name === 'ExitPlanMode' && args && typeof args['plan'] === 'string' ? args['plan'] : undefined;
          patchTab(sid ?? null, (t) => ({
            ...t,
            approval: { requestId: String(p['requestId']), name, summary: summarizeArgs(name, args), plan, args },
          }));
          pushNotif('approval', '等待审批', `${name}: ${summarizeArgs(name, args)}`);
          break;
        }
        case 'ask-user':
          patchTab(sid ?? null, (t) => ({
            ...t,
            ask: {
              requestId: String(p['requestId']),
              ...(p['question'] as { question: string; options?: Array<{ label: string; description?: string }>; header?: string; multiSelect?: boolean }),
            },
          }));
          break;
        case 'compact-queued':
          pushItem(sid ?? null, { kind: 'system', text: '⏳ 压缩已排队，任务完成后自动执行' });
          break;
        case 'done': {
          const doneText = typeof p['text'] === 'string' ? (p['text'] as string) : '';
          patchTab(sid ?? null, (t) => {
            // 兜底：若整轮没收到任何 text-delta（非流式 provider），最后一个空 assistant 气泡用 done.text 补上
            let items = t.items;
            if (doneText && !p['cancelled']) {
              const last = items[items.length - 1];
              if (last && last.kind === 'assistant' && !(last as { text: string }).text) {
                items = [...items.slice(0, -1), { kind: 'assistant', text: doneText } as Item];
              }
            }
            return {
              ...t,
              busy: false,
              approval: null,
              ask: null,
              tokens: Number(p['tokens'] ?? t.tokens),
              contextUsage: (p['contextUsage'] as Tab['contextUsage']) ?? t.contextUsage,
              lastRun: {
                iterations: Number(p['iterations'] ?? 0),
                toolCalls: Number(p['toolCalls'] ?? 0),
                tokens: Number(p['tokens'] ?? 0),
                at: Date.now(),
              },
              items: p['cancelled']
                ? [...items, { kind: 'system', text: '⏹ 任务已被用户中断' } as Item]
                : items,
            };
          });
          if (uiSettingsRef.current.notificationEnabled) {
            void window.bajin.notify('bajin 任务完成', p['cancelled'] ? '任务已被中断' : '任务执行完毕，回来查看结果吧').catch(() => undefined);
          }
          if (uiSettingsRef.current.notificationSoundEnabled) playDoneChime();
          pushNotif(p['cancelled'] ? 'info' : 'done', p['cancelled'] ? '任务已中断' : '任务完成', typeof p['text'] === 'string' ? String(p['text']).slice(0, 120) : '本轮执行结束');
          break;
        }
        case 'agent-error':
          patchTab(sid ?? null, (t) => ({
            ...t,
            busy: false,
            items: [...t.items, { kind: 'system', text: `⚠ ${friendlyError(p['message'])}` } as Item],
          }));
          pushNotif('error', '执行出错', friendlyError(p['message']));
          break;
        case 'session-resumed':
          break;
        case 'server-exit': {
          // R7-4：崩溃自动恢复分级——willRestart 安抚提示 / gaveUp 才要求重启应用
          const d = p as { willRestart?: boolean; attempt?: number; delayMs?: number; gaveUp?: boolean };
          const text = d['willRestart']
            ? `⚠ 后端异常退出，${Math.ceil(Number(d['delayMs'] ?? 1000) / 1000)} 秒后自动重启（第 ${Number(d['attempt'] ?? 1)} 次），会话将自动恢复…`
            : d['gaveUp']
              ? '⚠ 后端多次重启失败，请手动重启应用后从任务列表恢复会话'
              : '⚠ agent 进程已退出';
          setTabs((prev) => prev.map((t) => ({ ...t, busy: false, items: [...t.items, { kind: 'system', text } as Item] })));
          break;
        }
        // R7-4：后端已自动重启——重新 initialize 并恢复各标签会话
        case 'server-restarted': {
          const boot = bootRef.current;
          void (async () => {
            try {
              const res = await window.bajin.rpc<Record<string, unknown>>('initialize', {
                mock: Boolean(boot?.mock),
                ...(boot?.apiKey ? { apiKey: boot.apiKey } : {}),
                ...(boot?.model ? { model: boot.model } : {}),
                ...(boot?.mode ? { mode: boot.mode } : {}),
                ...(boot?.baseUrl ? { baseUrl: boot.baseUrl } : {}),
                persist: true,
              });
              const newSid = String(res['sessionId'] ?? '');
              setTabs((prev) => prev.map((t) => ({ ...t, busy: false, items: [...t.items, { kind: 'system', text: `✓ 后端已自动恢复（第 ${String(p['attempt'] ?? '?')} 次重启）` } as Item] })));
              // 各标签旧会话重新打开（历史从持久化恢复）
              if (newSid) void newSid;
              tabsRef.current.forEach((t) => { if (t.sessionId) void openHistoryRef.current(t.sessionId); });
            } catch (err) {
              setTabs((prev) => prev.map((t) => ({ ...t, items: [...t.items, { kind: 'system', text: `⚠ 恢复会话失败: ${friendlyError(err)}` } as Item] })));
            }
          })();
          break;
        }
        // 浏览器面板控制（R6）：BrowserNavigate/Click/Type 工具 → 面板自动打开并应用
        case 'browser-panel': {
          const d = p as { url?: string; viewport?: { width: number; height: number }; zoom?: number; action?: 'click' | 'type'; selector?: string; text?: string; seq?: number };
          if (d['url'] || d['viewport'] || d['zoom'] || d['action']) {
            setBrowserDirective(d);
            setShowBrowser(true);
          }
          break;
        }
      }
    });
  }, [patchTab, pushItem]);

  /* 全局快捷键（对标 ZCode：Ctrl+N 新建任务 / Ctrl+K 搜索 / Ctrl+W 关标签 / Esc 停止） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && tab.busy && tab.sessionId) {
        void window.bajin.rpc('interrupt', { sessionId: tab.sessionId });
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === '/') {
        e.preventDefault();
        setShowShortcuts((v) => !v);
        return;
      }
      if (mod && e.key === 'f') {
        e.preventDefault();
        const q = prompt(t('搜索当前会话...')) ?? '';
        setSessionSearch(q);
        return;
      }
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'n') { e.preventDefault(); void newTabRef.current(); }
      else if (k === 'k') { e.preventDefault(); setView('search'); }
      else if (k === 'w') { e.preventDefault(); closeTabRef.current(activeRef.current); }
      else if (k === 'm') { e.preventDefault(); window.dispatchEvent(new CustomEvent('bajin:voice-toggle')); }
      else if (k === 't' && e.shiftKey) { e.preventDefault(); reopenClosedTabRef.current(); }
      else if (k === 'e') { e.preventDefault(); setShowFileTree((v) => !v); }
      else if (k === 'g') { e.preventDefault(); if (gitStatus?.isRepo) setShowGitPanel((v) => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab.busy, tab.sessionId]);
  const newTabRef = useRef(() => {});
  const closeTabRef = useRef((_: number) => {});
  const openHistoryRef = useRef((_: string) => {});
  const tabsRef = useRef<Array<{ sessionId: string | null }>>([]);
  const reopenClosedTabRef = useRef(() => {});
  const activeRef = useRef(0);
  newTabRef.current = () => void newTab();
  closeTabRef.current = (i: number) => closeTab(i);
  openHistoryRef.current = (sid: string) => openHistory(sid);
  tabsRef.current = tabs;
  reopenClosedTabRef.current = reopenClosedTab;
  activeRef.current = active;

  /* 任务运行中/有工作时长时每秒重渲染（工具卡耗时 + 「已工作」显示） */
  const [, setClock] = useState(0);
  useEffect(() => {
    if (!tab.busy && !tab.workStartedAt) return;
    const timer = setInterval(() => setClock((c) => c + 1), 1000);
    return () => clearInterval(timer);
  }, [tab.busy, tab.workStartedAt]);

  /* token 轮询 */
  useEffect(() => {
    const timer = setInterval(() => {
      const t = tabs[active];
      if (t?.sessionId && !t.busy) {
        void window.bajin
          .rpc('status', { sessionId: t.sessionId })
          .then((st) => patchTab(t.sessionId, (x) => ({ ...x, tokens: Number((st as { tokens?: number }).tokens ?? x.tokens), planMode: Boolean((st as { planMode?: boolean }).planMode) })))
          .catch(() => undefined);
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [tabs, active, patchTab]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
    setTlProgress(100);
  }, [tab.items.length, tab.approval, tab.ask, active]);

  /* ---------- 动作 ---------- */

  /** 确保当前标签页有 sessionId（首次发消息时自动创建，对标 ZCode） */
  async function ensureSession(): Promise<boolean> {
    if (tab.sessionId) return true;
    try {
      const res = await window.bajin.rpc<Record<string, unknown>>('session/new', { cwd: tab.cwd ?? undefined });
      const sid = String(res['sessionId']);
      patchTab(null, (t) => ({ ...t, sessionId: sid, title: `会话 ${tabSeq}` }));
      return true;
    } catch {
      return false;
    }
  }

/** 输出档位映射（R9-3）：经 session/set-params 落到 chatParams.maxTokens */
  const EFFORT_TOKENS: Record<string, number> = { '最高': 32768, '高': 16384, '中': 8192, '低': 4096 };
  async function applyEffort(e: string): Promise<void> {
    if (!tab.sessionId) return;
    await window.bajin.rpc('session/set-params', { sessionId: tab.sessionId, maxTokens: EFFORT_TOKENS[e] ?? 16384 }).catch(() => undefined);
  }

  async function send(): Promise<void> {
    const text = input.trim();
    if (!text || tab.busy) return;
    if (!tab.sessionId && !(await ensureSession())) return;
    setInput('');
    if (text.startsWith('/')) {
      const first = text.slice(1).split(/\s+/)[0] ?? '';
      if (BUILTIN_SLASH.includes(first)) {
        await runSlash(text);
        return;
      }
      // 自定义命令：透传 app-server 展开执行；既非内置也非自定义则提示
      if (!customCommands.some((c) => `/${c.name}` === `/${first}`.toLowerCase())) {
        pushItem(tab.sessionId, { kind: 'system', text: `未知命令 /${first}（内置 /compact /mode /model /new /interrupt；自定义命令放 .bajin/commands）` });
        return;
      }
    }
    patchTab(tab.sessionId, (t) => ({ ...t, busy: true, workStartedAt: t.workStartedAt ?? Date.now(), items: [...t.items, { kind: 'user', text }, { kind: 'assistant', text: '' }] }));
    try {
      await window.bajin.rpc('send', { sessionId: tab.sessionId, text });
    } catch (err) {
      patchTab(tab.sessionId, (tb) => ({ ...tb, busy: false, items: [...tb.items, { kind: 'system', text: `⚠ ${t('发送失败')}: ${friendlyError(err)}` } as Item] }));
    }
    void refreshHistory();
  }

  /** 重新生成（R5-3）：回退最后一轮（session/rewind 后端裁剪 transcript）再原样重发 */
  async function regenerate(): Promise<void> {
    if (!tab.sessionId || tab.busy) return;
    // 找最后一条用户消息文本
    const lastUser = [...tab.items].reverse().find((it) => it.kind === 'user');
    const text = lastUser && lastUser.kind === 'user' ? lastUser.text.trim() : '';
    if (!text) return;
    try {
      await window.bajin.rpc('session/rewind', { sessionId: tab.sessionId, n: 1 });
    } catch (err) {
      pushItem(tab.sessionId, { kind: 'system', text: `⚠ 回退失败: ${friendlyError(err)}` });
      return;
    }
    // 本地移除最后一轮（自最后一条 user 起），再重发
    patchTab(tab.sessionId, (t2) => {
      const flags = t2.items.map((it) => it.kind === 'user');
      const idx = flags.lastIndexOf(true);
      return { ...t2, busy: true, items: [...t2.items.slice(0, idx), { kind: 'user', text }, { kind: 'assistant', text: '' }] };
    });
    try {
      await window.bajin.rpc('send', { sessionId: tab.sessionId, text });
    } catch (err) {
      patchTab(tab.sessionId, (tb) => ({ ...tb, busy: false, items: [...tb.items, { kind: 'system', text: `⚠ ${t('发送失败')}: ${friendlyError(err)}` } as Item] }));
    }
    void refreshHistory();
  }

  async function runSlash(text: string): Promise<void> {
    const [cmdRaw, ...rest] = text.slice(1).split(/\s+/);
    const cmd = cmdRaw ?? '';
    const arg = rest.join(' ').trim();
    const sys = (msg: string) => pushItem(tab.sessionId, { kind: 'system', text: msg });
    switch (cmd) {
      case 'compact': {
        const r = await window.bajin.rpc('compact', { sessionId: tab.sessionId }).catch(() => null);
        if (r && (r as { queued?: boolean }).queued) {
          sys('⏳ 任务执行中，压缩已排队（完成后自动执行）');
        } else if (r) {
          sys(`已压缩：约 ${(r as { before: number }).before} → ${(r as { after: number }).after} tokens`);
        } else {
          sys('压缩失败');
        }
        break;
      }
      case 'mode':
        if (MODES.includes(arg)) {
          await window.bajin.rpc('set-mode', { sessionId: tab.sessionId, mode: arg });
          patchTab(tab.sessionId, (t) => ({ ...t, mode: arg }));
          sys(`权限模式 → ${arg}`);
        } else sys(`用法: /mode <${MODES.join('|')}>`);
        break;
      case 'model':
        if (arg) {
          await window.bajin.rpc('set-model', { sessionId: tab.sessionId, model: arg });
          patchTab(tab.sessionId, (t) => ({ ...t, model: arg }));
          sys(`模型 → ${arg}`);
        } else sys('用法: /model <名称>');
        break;
      case 'new':
        await newTab();
        break;
      case 'interrupt':
        await window.bajin.rpc('interrupt', { sessionId: tab.sessionId });
        break;
      default:
        sys(`未知命令 /${cmd}`);
    }
  }

  async function newTab(): Promise<void> {
    try {
      const res = await window.bajin.rpc<Record<string, unknown>>('session/new', {});
      const t = blankTab();
      t.sessionId = String(res['sessionId']);
      t.title = `会话 ${tabs.length + 1}`;
      t.model = tab.model;
      t.mode = tab.mode;
      setTabs((prev) => [...prev, t]);
      setActive(tabs.length);
      setView('chat');
      void refreshHistory();
    } catch (err) {
      pushItem(tab.sessionId, { kind: 'system', text: `新会话创建失败: ${err instanceof Error ? err.message : err}` });
    }
  }

  async function forkTab(): Promise<void> {
    if (!tab.sessionId) return;
    try {
      const res = await window.bajin.rpc<Record<string, unknown>>('session/new', { forkFrom: tab.sessionId });
      const t = blankTab();
      t.sessionId = String(res['sessionId']);
      t.title = `分叉 ${tab.title}`;
      t.model = tab.model;
      t.mode = tab.mode;
      // 把当前消息复制显示
      t.items = tab.items.filter((x) => x.kind !== 'system');
      setTabs((prev) => [...prev, t]);
      setActive(tabs.length);
    } catch {
      /* 忽略 */
    }
  }

  async function openHistory(sessionId: string): Promise<void> {
    try {
      const res = await window.bajin.rpc<Record<string, unknown>>('session/open', { sessionId });
      const t = blankTab();
      t.sessionId = String(res['sessionId']);
      t.title = String(res['title'] ?? sessionId.slice(0, 12));
      t.model = String(res['model'] ?? tab.model);
      t.mode = String(res['mode'] ?? tab.mode);
      const hit = history.find((h) => h.sessionId === sessionId);
      if (hit?.cwd) t.cwd = hit.cwd;
      if (hit?.unread) void window.bajin.rpc('session/unread', { sessionId, unread: false }).then(() => refreshHistory()).catch(() => undefined);
      t.items = historyToItems((res['messages'] as Array<Record<string, unknown>>) ?? []);
      setTabs((prev) => [...prev, t]);
      setActive(tabs.length);
      setView('chat');
    } catch (err) {
      pushItem(tab.sessionId, { kind: 'system', text: `⚠ ${t('打开会话失败')}: ${friendlyError(err)}` });
    }
  }

  /** 在指定项目目录（cwd）新建会话（项目页用） */
  async function newTabIn(cwd: string): Promise<void> {
    try {
      const res = await window.bajin.rpc<Record<string, unknown>>('session/new', { cwd });
      const t = blankTab();
      t.sessionId = String(res['sessionId']);
      t.title = `会话 ${tabs.length + 1}·${cwd.split('/').pop() ?? cwd}`;
      t.model = tab.model;
      t.mode = tab.mode;
      t.cwd = cwd;
      setTabs((prev) => [...prev, t]);
      setActive(tabs.length);
      setView('chat');
      void refreshHistory();
    } catch (err) {
      pushItem(tab.sessionId, { kind: 'system', text: `新会话创建失败: ${err instanceof Error ? err.message : err}` });
    }
  }

  function closeTab(idx: number): void {
    const t = tabs[idx]!;
    if (t.sessionId) void window.bajin.rpc('session/close', { sessionId: t.sessionId }).catch(() => undefined);
    if (tabs.length === 1) {
      const fresh = blankTab();
      setTabs([fresh]);
      setActive(0);
      return;
    }
    setTabs((prev) => prev.filter((_, i) => i !== idx));
    setActive((a) => (a >= idx && a > 0 ? a - 1 : a));
  }

  /** 关闭其他标签（R8-3）：其余全部入恢复栈 */
  function closeOtherTabs(idx: number): void {
    const r = tabCloseOthers(tabs, idx);
    for (const t of r.closed) if (t.sessionId) void window.bajin.rpc('session/close', { sessionId: t.sessionId }).catch(() => undefined);
    setTabs(r.next);
    setActive(r.nextActive);
    setClosedTabs((prev) => [...prev, ...r.closed].slice(-20));
    setTabMenu(null);
  }
  /** 关闭全部标签（R8-3）：全部入栈，落一个空白标签承接 */
  function closeAllTabs(): void {
    const r = tabCloseAll(tabs);
    for (const t of r.closed) if (t.sessionId) void window.bajin.rpc('session/close', { sessionId: t.sessionId }).catch(() => undefined);
    setClosedTabs((prev) => [...prev, ...r.closed].slice(-20));
    setTabs([blankTab()]);
    setActive(0);
    setTabMenu(null);
  }
  /** 恢复最近关闭（R8-3）：弹栈插回原位（不重开 app-server 会话——历史列表仍在，点击可找回） */
  function reopenClosedTab(): void {
    const r = tabReopenGeneric<typeof tabs[number]>(tabs, closedTabs as typeof tabs);
    if (!r) return;
    setTabs(r.next);
    setActive(r.nextActive);
    setClosedTabs(r.stack as typeof closedTabs);
  }

  async function respondApproval(approved: boolean, always = false, planNote = ''): Promise<void> {
    if (!tab.approval || !tab.sessionId) return;
    const { requestId, name } = tab.approval;
    const isPlan = Boolean(tab.approval.plan);
    patchTab(tab.sessionId, (t) => ({ ...t, approval: null, items: [...t.items, { kind: 'system', text: approved ? (always ? `✓ 已批准并始终允许 ${name}` : `✓ 已批准 ${name}`) : `✗ 已拒绝 ${name}` } as Item] }));
    if (approved && always) await window.bajin.rpc('set-allowed-tools', { sessionId: tab.sessionId, add: name }).catch(() => undefined);
    await window.bajin.rpc('approval:respond', { requestId, approved }).catch(() => undefined);
    // 计划批准时的补充要求（R6-6）：作为追加指令发给会话，实施前并入计划
    if (approved && isPlan && planNote.trim()) {
      patchTab(tab.sessionId, (t) => ({ ...t, items: [...t.items, { kind: 'user', text: `补充计划要求：${planNote.trim()}` } as Item] }));
      await window.bajin.rpc('send', { sessionId: tab.sessionId, text: `补充计划要求（批准时追加，请并入当前计划后继续实施）：${planNote.trim()}` }).catch(() => undefined);
    }
  }

  async function respondAsk(answer: string | null): Promise<void> {
    if (!tab.ask) return;
    const { requestId } = tab.ask;
    patchTab(tab.sessionId!, (t) => ({
      ...t,
      ask: null,
      items: [...t.items, { kind: 'system', text: answer ? `你回答了：${answer}` : '（跳过提问）' } as Item],
    }));
    await window.bajin.rpc('ask-user:respond', { requestId, ...(answer ? { answer: { answer } } : {}) }).catch(() => undefined);
  }

  async function changeMode(mode: string): Promise<void> {
    patchTab(tab.sessionId, (t) => ({ ...t, mode }));
    await window.bajin.rpc('set-mode', { sessionId: tab.sessionId, mode }).catch(() => undefined);
  }

  async function changeModel(model: string): Promise<void> {
    patchTab(tab.sessionId, (t) => ({ ...t, model }));
    await window.bajin.rpc('set-model', { sessionId: tab.sessionId, model }).catch(() => undefined);
  }

  const slashMatches = input.startsWith('/') && !input.includes(' ')
    ? [
        ...SLASH_COMMANDS.filter((c) => c.cmd.startsWith(input.split(' ')[0]!)),
        ...customCommands
          .filter((c) => `/${c.name}`.startsWith(input.split(' ')[0]!.toLowerCase()))
          .map((c) => ({ cmd: `/${c.name}`, desc: c.description })),
      ]
    : [];

  /* ---------- 渲染 ---------- */

  return (
    <div className="app">
      {/* 侧边栏（对标 ZCode：设置态下任务菜单被设置导航替换，同位置切换） */}
      <aside className="sidebar">
        {view === 'settings' ? (
          <div className="settings-sidebar">
            <button className="settings-back" onClick={() => setView('chat')}>← {t('返回任务')}</button>
            <div className="settings-sidebar-scroll">
              {SETTINGS_NAV.map((g) => (
                <div key={g.group} className="settings-nav-group">
                  <div className="settings-nav-group-title">{t(g.group)}</div>
                  {g.items.map((it) => (
                    <div key={it.id} className={`settings-nav-item ${settingsSection === it.id ? 'on' : ''}`} onClick={() => setSettingsSection(it.id)}>
                      <span className="side-icon">{it.icon}</span>
                      <span>{t(it.label)}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        ) : (
        <>
        <div className="task-filter">
          <input value={taskFilter} placeholder={t('搜索任务...')} onChange={(e) => setTaskFilter(e.target.value)} />
        </div>
        <div className="side-menu">
          {SIDE_MENU.map((m) => (
            <div
              key={m.label}
              className={`side-item ${m.view === 'new' ? 'side-item-accent' : ''} ${view === m.view ? 'on' : ''}`}
              onClick={() => {
                if (m.view === 'new') { void newTab(); return; }
                if (m.target) { setView('settings'); setSettingsSection(m.target as SettingsSection); return; }
                setView(m.view as View);
              }}
            >
              <span className="side-icon">{m.icon}</span>
              <span className="side-label">{t(m.label)}</span>
              {(m.label === '新建任务' || m.label === '搜索') && (
                <span className="side-kbd">{m.label === '新建任务' ? 'Ctrl+N' : 'Ctrl+K'}</span>
              )}
            </div>
          ))}
        </div>
        <div className="history-head">
          <div className="view-toggle">
            {TASK_VIEW_MODES.map((m) => (
              <button key={m.id} className={`view-tab ${taskViewMode === m.id ? 'on' : ''}`} onClick={() => setTaskViewMode(m.id)}>
                <span className="view-tab-icon">{m.id === 'grouped' ? '#' : '🗂'}</span>
                {t(m.label)}
              </button>
            ))}
          </div>
          <TaskViewOptionsMenu
            sortBy={uiSettings.taskSortBy ?? 'updated'}
            onSortBy={(v) => patchUiSettings({ taskSortBy: v })}
            showArchived={uiSettings.showArchivedTasks === true}
            onShowArchived={(v) => { patchUiSettings({ showArchivedTasks: v }); void refreshHistory(); }}
            collapsed={collapsedGroups}
            onCollapseAll={() => setCollapsedGroups(new Set(bucketTasks(filterHistory(history, taskFilter), taskViewMode).map(([b]) => b)))}
            onExpandAll={() => setCollapsedGroups(new Set())}
          />
          <span className="refresh" title={t('刷新任务列表')} onClick={() => void refreshHistory()}>⟳</span>
        </div>
        <div className="history-list">
          {taskViewMode === 'projects' ? (
            bucketTasks(visibleHistory().slice(0, sidebarLimit), 'projects').map(([cwd, items]) => {
              const name = cwd.split('/').pop() || cwd;
              const collapsed = collapsedGroups.has(cwd);
              return (
                <div key={cwd} className={`project-card ${collapsed ? 'collapsed' : ''}`}>
                  <div className="project-card-head" onClick={() => toggleGroup(cwd)}>
                    <span className="project-card-chevron">{collapsed ? '▸' : '▾'}</span>
                    <span className="project-card-icon">📁</span>
                    <span className="project-card-name">{name}</span>
                    <span className="project-card-count">{items.length}</span>
                  </div>
                  <div className="project-card-path" title={cwd}>{cwd}</div>
                  {!collapsed && items.map((h) => (
                    <TaskListItem
                      key={h.sessionId}
                      item={h}
                      showProject={false}
                      onOpen={() => void openHistory(h.sessionId)}
                      onChanged={() => void refreshHistory()}
                      onGoSettings={(sec) => { setView('settings'); setSettingsSection(sec); }}
                    />
                  ))}
                </div>
              );
            })
          ) : (
            bucketTasks(visibleHistory().slice(0, sidebarLimit), 'grouped').map(([bucket, items]) => (
              <div key={bucket}>
                <div
                  className={`history-group clickable ${bucket === '已置顶' ? 'pinned-group' : ''} ${collapsedGroups.has(bucket) ? 'collapsed' : ''}`}
                  onClick={() => toggleGroup(bucket)}
                >{bucket === '已置顶' ? '📌 ' : ''}{collapsedGroups.has(bucket) ? '▸' : '▾'} {t(bucket)}</div>
                {!collapsedGroups.has(bucket) && items.map((h) => (
                  <TaskListItem
                    key={h.sessionId}
                    item={h}
                    showProject={false}
                    onOpen={() => void openHistory(h.sessionId)}
                    onChanged={() => void refreshHistory()}
                    onGoSettings={(sec) => { setView('settings'); setSettingsSection(sec); }}
                  />
                ))}
              </div>
            ))
          )}
          {!history.length && <div className="history-empty">{t('暂无任务（发送消息后生成）')}</div>}
          {visibleHistory().length > sidebarLimit && (
            <div className="log-load-more" onClick={() => setSidebarLimit((n) => n + 200)}>↓ 显示更多任务（还有 {visibleHistory().length - sidebarLimit} 个）</div>
          )}
        </div>
        <div className="side-foot">
          <span className="user-chip" title="bajin 本地用户">
            <span className="user-avatar">B</span>
            <span className="user-name">本地用户</span>
          </span>
          <span className="tokens" title="当前会话 tokens">{tab.tokens > 1000 ? `${Math.round(tab.tokens / 1000)}k` : tab.tokens || '—'} tk</span>
          <span className="spacer" />
          {/* 非 settings 分支内 view 已被收窄（不含 'settings'），切换即进入设置页 */}
          <button
            className="side-settings"
            title="设置"
            onClick={() => setView('settings')}
          >⚙</button>
        </div>
        </>
        )}
      </aside>

      {view === 'chat' ? (
      <div className="main">
        {/* 顶栏（面包屑 + 标签 + 操作合一，对标 ZCode「任务名 📁 项目 ⋯」单条顶栏） */}
        <div className="topbar">
          <div className="crumb" title={tab.sessionId ?? ''}>
            <span className="crumb-title">{tab.title || '会话'}</span>
            {tab.cwd && <span className="crumb-sep">›</span>}
            {tab.cwd && <span className="crumb-proj">📁 {tab.cwd.split('/').pop()}</span>}
          </div>
          <div className="topbar-tabs">
            {tabs.map((t, i) => (
              <div key={t.sessionId ?? `blank-${i}`} className={`tab ${i === active ? 'active' : ''}`} onClick={() => setActive(i)}
                onContextMenu={(e) => { e.preventDefault(); setTabMenu({ idx: i, x: e.clientX, y: e.clientY }); }}>
                <span className="tab-title">{t.title}</span>
                <span
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(i);
                  }}
                >
                  ×
                </span>
              </div>
            ))}
            <div className="tab tab-new" onClick={() => void newTab()}>＋</div>
            {closedTabs.length > 0 && (
              <div className="tab tab-new" title="恢复最近关闭的标签（Ctrl+Shift+T）" onClick={reopenClosedTab}>↺</div>
            )}
            {tabMenu && (
              <div className="tab-menu" style={{ left: tabMenu.x, top: tabMenu.y + 8 }} onClick={() => setTabMenu(null)}>
                <div className="tab-menu-item" onClick={() => closeTab(tabMenu.idx)}>关闭标签</div>
                <div className="tab-menu-item" onClick={() => closeOtherTabs(tabMenu.idx)}>关闭其他标签</div>
                <div className="tab-menu-item" onClick={closeAllTabs}>关闭所有标签</div>
                {closedTabs.length > 0 && <div className="tab-menu-item" onClick={reopenClosedTab}>恢复最近关闭（{closedTabs.length}）</div>}
              </div>
            )}
          </div>
          <span className="spacer" />
          {tabs.filter((t) => t.busy).length > 0 && (
            <span className="bg-tasks" title={`${tabs.filter((t) => t.busy).length} 个任务在后台运行`}>
              ⚡ {tabs.filter((t) => t.busy).length} 后台
            </span>
          )}
          <button
            className={`icon-only ${showTerminal ? 'on' : ''}`}
            title="终端（在当前工作目录打开 bash）"
            onClick={() => { setShowTerminal((v) => !v); }}
          >⌗</button>
          <button
            className={`icon-only ${showProcMonitor ? 'on' : ''}`}
            title="系统监控（CPU / 内存 / 进程）"
            onClick={() => { setShowProcMonitor((v) => !v); }}
          >📈</button>
          <button
            className={`icon-only ${showPanel ? 'on' : ''}`}
            title="切换右侧状态面板（目标 / 计划 / 进程）"
            onClick={() => setShowPanel((v) => !v)}
          >▤</button>
          <button
            className={`icon-only ${showFileTree ? 'on' : ''}`}
            title={t('文件树')}
            onClick={() => { setShowFileTree((v) => !v); }}
          >🗂</button>
          {!IS_WEB && (
            <button
              className={`icon-only ${showBrowser ? 'on' : ''}`}
              title={t('浏览器面板')}
              onClick={() => { setShowBrowser((v) => !v); }}
            >🌐</button>
          )}
        </div>

        {/* 消息流 + 右侧状态面板（对标 ZCode chat.statusPanel）；左栏可选文件树 */}
        <div className="chat-row">
        {tab.workStartedAt && (
          <WorkTimer
            busy={tab.busy}
            startedAt={tab.workStartedAt}
            lastRun={tab.lastRun}
          />
        )}
        {showProcMonitor && (<ProcessMonitorPanel onClose={() => setShowProcMonitor(false)} />)}
        {editorFile && (<FileEditorPanel filePath={editorFile} onClose={() => setEditorFile(null)} />)}
        {showFileTree && <FileTreePanel cwd={tab.cwd} onPick={(p) => setInput(`Read ${p}`)} onEdit={(p) => setEditorFile(p)} />}
        <div className="log" ref={logRef}
          onScroll={(e) => {
            // 长会话窗口化：滚到顶部附近自动加载更早 200 条（保持视觉位置不跳动）
            const el = e.currentTarget;
            const max = el.scrollHeight - el.clientHeight;
            setTlProgress(max > 0 ? Math.min(100, Math.round((el.scrollTop / max) * 100)) : 0);
            if (el.scrollTop < 80 && (logLimits[tab.sessionId ?? ''] ?? LOG_WINDOW) < tab.items.length) {
              const prevHeight = el.scrollHeight;
              setLogLimits((m) => ({ ...m, [tab.sessionId ?? '']: (m[tab.sessionId ?? ''] ?? LOG_WINDOW) + 200 }));
              requestAnimationFrame(() => { el.scrollTop += el.scrollHeight - prevHeight; });
            }
          }}>
          {(logLimits[tab.sessionId ?? ''] ?? LOG_WINDOW) < tab.items.length && (
            <div className="log-load-more" onClick={() => {
              const el = logRef.current;
              const prevHeight = el?.scrollHeight ?? 0;
              setLogLimits((m) => ({ ...m, [tab.sessionId ?? '']: (m[tab.sessionId ?? ''] ?? LOG_WINDOW) + 200 }));
              requestAnimationFrame(() => { if (el) el.scrollTop += el.scrollHeight - prevHeight; });
            }}>↑ 加载更早消息（还有 {tab.items.length - (logLimits[tab.sessionId ?? ''] ?? LOG_WINDOW)} 条）</div>
          )}
          {tab.items.slice(-(logLimits[tab.sessionId ?? ''] ?? LOG_WINDOW)).map((it, i) => {
            if (it.kind === 'user') {
              return (
                <UserMessage key={i} text={it.text} onOpenFile={(f) => setEditorFile(f)} />
              );
            }
            if (it.kind === 'reasoning' && it.text) {
              if (uiSettings.messageStreamShowReasoning === false) return null;
              return <ThinkingBlock key={i} item={it} active={tab.busy && i === tab.items.length - 1} />;
            }
            if (it.kind === 'assistant') {
              return <AssistantMessage key={i} item={it} busy={tab.busy} isLast={i === tab.items.length - 1} onRegenerate={() => void regenerate()} />;
            }
            if (it.kind === 'tool') {
              return <ToolCard key={i} item={it} />;
            }
            return (
              <div className="msg system" key={i}>
                {it.text}
              </div>
            );
          })}

          {/* 计划审批卡片（R6-6：查看完整计划 + 添加计划） */}
          {tab.approval?.plan && (
            <PlanApprovalCard
              plan={tab.approval.plan}
              busy={tab.busy}
              onApprove={(note) => void respondApproval(true, false, note)}
              onReject={() => void respondApproval(false)}
            />
          )}

          {/* 普通审批条 */}
          {tab.approval && !tab.approval.plan && (
            <div className="card approval-card">
              <div className="card-title">⚠ 需要批准：{tab.approval.name}</div>
              <div className="card-sub">{tab.approval.summary}</div>
              {tab.approval.name.startsWith('Browser') && (
                <div className="cua-note">🖥 计算机使用（CUA）：该操作将驱动内置浏览器页面，可在浏览器面板中实时观察并录制留证。批准后本次会话内同类操作可能不再询问（「始终允许」）。</div>
              )}
              <ApprovalDiffPreview name={tab.approval.name} args={tab.approval.args} />
              <div className="card-actions">
                <button className="primary" onClick={() => void respondApproval(true)}>允许</button>
                <button onClick={() => void respondApproval(true, true)}>始终允许 {tab.approval!.name}</button>
                <button onClick={() => void respondApproval(false)}>拒绝</button>
              </div>
            </div>
          )}

          {/* 用户提问卡片 */}
          {tab.ask && (
            <div className="card ask-card">
              <div className="card-title">❓ {tab.ask.header ? `[${tab.ask.header}] ` : ''}{tab.ask.question}{tab.ask.multiSelect ? `（可多选）` : ''}</div>
              {tab.ask.multiSelect ? (
                <AskMultiCard options={tab.ask.options ?? []} onSubmit={(v) => void respondAsk(v)} />
              ) : (
                <>
                  {tab.ask.options?.map((o, i) => (
                    <button key={i} className="ask-option" onClick={() => void respondAsk(o.label)}>
                      {o.label}
                      {o.description ? <span className="ask-desc"> — {o.description}</span> : null}
                    </button>
                  ))}
                  <AskInput onSubmit={(v) => void respondAsk(v)} placeholder="或输入其他回答…" />
                </>
              )}
            </div>
          )}

          {/* 新建任务欢迎页（空会话时居中展示） */}
          {tab.items.length === 0 && !tab.busy && !tab.approval && !tab.ask && (
            <WelcomePage
              onPickTemplate={(prompt) => {
                if (prompt) setInput(prompt);
                else setInput('');
              }}
              input={input}
              setInput={setInput}
              onSend={() => void send()}
              busy={tab.busy}
              cwd={tab.cwd}
              onPickWorkspace={(dir) => {
                if (dir === (tab.cwd ?? null)) return;
                if (dir) void newTabIn(dir);
                else void newTab();
              }}
              mode={tab.mode}
              onModeChange={(m) => void changeMode(m)}
              model={tab.model}
              onModelClick={() => setShowModelPicker(true)}
            />
          )}
        </div>

        {/* 右侧状态面板（对标 ZCode chat.statusPanel：目标 / 计划 / 进程；受「面板」按钮开关） */}
        {showPanel && (tab.items.length > 0 || tab.todos.length > 0) && (
          <aside className="status-panel">
            <div className="sp-section">
              <div className="sp-title">目标</div>
              <div className="sp-goal">{(tab.items.find((x) => x.kind === 'user') as { text?: string } | undefined)?.text?.slice(0, 120) ?? '—'}</div>
            </div>
            {tab.approval?.plan && (
              <div className="sp-section">
                <div className="sp-title">计划</div>
                <pre className="sp-plan">{tab.approval.plan.slice(0, 600)}</pre>
              </div>
            )}
            {tab.todos.length > 0 && uiSettings.messageStreamShowTodos !== false && (
              <div className="sp-section">
                <div className="sp-title">进程 <span className="log-meta">{tab.todos.filter((t) => t.status === 'completed').length}/{tab.todos.length}</span></div>
                <TodoPanel todos={tab.todos} />
              </div>
            )}
            <div className="sp-section">
              <div className="sp-title">会话</div>
              <div className="sp-goal">{tab.model} · {MODE_LABELS[tab.mode] ?? tab.mode} · {tab.tokens > 1000 ? `${Math.round(tab.tokens / 1000)}k` : tab.tokens || '—'} tokens</div>
              <button className="share-btn" title="复制分享链接（浏览器打开直达本会话）"
                onClick={() => {
                  const link = IS_WEB
                    ? `${window.location.origin}/?session=${tab.sessionId}`
                    : `bajin://session/${tab.sessionId}`;
                  void navigator.clipboard.writeText(link).then(
                    () => pushNotif('info', '分享链接已复制', link),
                    () => pushNotif('error', '复制失败', link),
                  );
                }}>🔗 复制分享链接</button>
            </div>
          </aside>
        )}
        </div>

        {/* 集成终端面板（对标 ZCode 终端面板：底部 bash，IPC 流式） */}
        {showBrowser && (
          <BrowserPanel directive={browserDirective} onClose={() => setShowBrowser(false)} />
        )}
        {showTerminal && (
          <TerminalPanel cwd={tab.cwd} fontFamily={uiSettings.terminalFontFamily || undefined} onClose={() => { void window.bajin.termStop(); setShowTerminal(false); }} />
        )}

        {showShortcuts && <ShortcutsPanel onClose={() => setShowShortcuts(false)} />}

        {showGitPanel && gitStatus?.isRepo && (
          <GitPanel status={gitStatus as never} sessionId={tab.sessionId} onClose={() => setShowGitPanel(false)} onRefresh={() => refreshGitStatus()} />
        )}
        {sessionSearch && (
          <div className="session-search-bar">
            <span>🔍 {sessionSearch}</span>
            <button className="icon-btn" onClick={() => setSessionSearch('')}>×</button>
          </div>
        )}

        {/* 斜杠命令提示 */}
        {slashMatches.length > 0 && (
          <div className="slash-hints">
            {slashMatches.map((c) => (
              <div key={c.cmd} className="slash-item" onClick={() => setInput(c.cmd.split(' ')[0]! + (c.cmd.includes('<') ? ' ' : ''))}>
                <span className="slash-cmd">{c.cmd}</span>
                <span className="slash-desc">{c.desc}</span>
              </div>
            ))}
          </div>
        )}

        {/* 输入区（统一 Composer：空会话时由欢迎页的居中输入框承担，不重复显示） */}
        {!(tab.items.length === 0 && !tab.busy && !tab.approval && !tab.ask) && (
        <Composer
          input={input}
          setInput={setInput}
          onSend={() => void send()}
          onStop={() => void window.bajin.rpc('interrupt', { sessionId: tab.sessionId })}
          busy={tab.busy}
          contextUsage={tab.contextUsage}
          disabled={!input.trim()}
          cwd={tab.cwd}
          onPickWorkspace={(dir) => {
            if (dir === (tab.cwd ?? null)) return;
            if (dir) void newTabIn(dir);
            else void newTab();
          }}
          mode={tab.mode}
          onModeChange={(m) => void changeMode(m)}
          effort={tab.effort}
          onEffortChange={(e) => { patchTab(tab.sessionId, (t) => ({ ...t, effort: e })); void applyEffort(e); }}
          model={tab.model}
          onModelClick={() => setShowModelPicker(true)}
          placeholder={tab.busy ? t('任务执行中…（可点「停止」中断）') : t('向 bajin 提问，使用 / 选择命令或能力')}
        />
        )}
      </div>
      ) : (
        <div className="view-page">
          {view === 'settings' && (
            <SettingsView
              section={settingsSection}
              onSection={setSettingsSection}
              isMock={isMock}
              models={models}
              providers={providers}
              refreshModels={() => void refreshModels()}
              refreshProviders={() => void refreshProviders()}
              onUseModel={(id) => {
                setView('chat');
                void changeModel(id);
              }}
              uiSettings={uiSettings}
              patchUiSettings={patchUiSettings}
              onOpenSession={(sid) => { setView('chat'); void openHistory(sid); }}
            />
          )}
          {view === 'search' && <SearchView onOpen={(sid) => { setView('chat'); void openHistory(sid); }} />}
          {view === 'automations' && <AutomationsView onOpenSession={(sid) => { setView('chat'); void openHistory(sid); }} />}
          {view === 'skills' && <SkillsView />}
          {view === 'knowledge' && <KnowledgeView />}
        </div>
      )}

      {/* 通知中心（右下角 🔔，历史 approval/完成/错误） */}
      <NotificationCenter
        notifications={notifications}
        open={showNotifCenter}
        unread={notifications.filter((n) => !n.read).length}
        onToggle={() => setShowNotifCenter((v) => {
          if (!v) setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
          return !v;
        })}
        onClear={() => setNotifications([])}
      />

      {/* 模型切换弹窗（按供应商分组，对标 ZCode 模型下拉） */}
      {showModelPicker && (
        <ModelPicker
          current={tab.model}
          sessionId={tab.sessionId}
          models={models}
          providers={providers}
          onPick={(id) => { void changeModel(id); setShowModelPicker(false); }}
          onManage={() => { setShowModelPicker(false); setView('settings'); setSettingsSection('models'); }}
          onClose={() => setShowModelPicker(false)}
        />
      )}
    </div>
  );
}

/** 计划审批卡（R6-6）：长计划折叠+「查看完整计划」；批准前可「添加计划」补充要求 */
function PlanApprovalCard({ plan, busy, onApprove, onReject }: { plan: string; busy: boolean; onApprove: (note: string) => void; onReject: () => void }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState('');
  const lines = plan.split('\n').length;
  const long = shouldCollapsePlan(plan);
  const shown = long && !expanded ? `${plan.slice(0, 1800)}…` : plan;
  return (
    <div className="card plan-card">
      <div className="card-title">
        📋 实施计划（待批准） <span className="log-meta">{lines} 行</span>
        <span style={{ flex: 1 }} />
        {long && (
          <button className="msg-copy" onClick={() => setExpanded((v) => !v)}>{expanded ? '收起' : '查看完整计划'}</button>
        )}
      </div>
      <pre className={`plan-body ${long && !expanded ? 'collapsed' : ''}`}>{shown}</pre>
      {adding ? (
        <div className="plan-add">
          <textarea
            value={note}
            placeholder="补充要求（批准后作为追加指令发给会话，实施前并入计划）…"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onApprove(note); } }}
          />
          <div className="card-actions">
            <button className="primary" disabled={busy} onClick={() => onApprove(note)}>批准并开始实施（含补充）</button>
            <button onClick={() => setAdding(false)}>取消补充</button>
            <button onClick={onReject}>拒绝</button>
          </div>
        </div>
      ) : (
        <div className="card-actions">
          <button className="primary" disabled={busy} onClick={() => onApprove('')}>批准并开始实施</button>
          <button onClick={() => { setAdding(true); setNote(''); }}>➕ 添加计划</button>
          <button onClick={onReject}>拒绝</button>
        </div>
      )}
    </div>
  );
}

/** 审批 diff 预览（R5-4）：Write/Edit 审批卡内直接看变更，拒绝盲批。
 *  Edit：old_string vs new_string；Write：读现文件 vs 新内容。>200 行折叠为摘要。 */
function ApprovalDiffPreview({ name, args }: { name: string; args?: Record<string, unknown> }): ReactNode {
  const [diff, setDiff] = useState<Array<{ t: ' ' | '-' | '+'; line: string }> | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'none'>('loading');
  useEffect(() => {
    let alive = true;
    void (async () => {
      const fp = typeof args?.['file_path'] === 'string' ? String(args['file_path']) : '';
      if (!fp) { if (alive) setState('none'); return; }
      try {
        if (name === 'Edit') {
          const oldS = String(args?.['old_string'] ?? '');
          const newS = String(args?.['new_string'] ?? '');
          if (alive) { setDiff(lineDiff(oldS, newS)); setState('ready'); }
        } else if (name === 'Write') {
          const cur = await window.bajin.rpc('fs/read', { path: fp }).catch(() => null);
          const prev = cur && typeof (cur as { content?: string }).content === 'string' ? String((cur as { content?: string }).content) : '';
          const next = String(args?.['content'] ?? '');
          if (alive) { setDiff(lineDiff(prev, next)); setState('ready'); }
        } else {
          if (alive) setState('none');
        }
      } catch {
        if (alive) setState('none');
      }
    })();
    return () => { alive = false; };
  }, [name, args]);
  if (state !== 'ready' || !diff) return null;
  const changed = diff.filter((o) => o.t !== ' ').length;
  if (changed === 0) return null;
  const MAX_SHOW = 200;
  const shown = diff.slice(0, MAX_SHOW);
  return (
    <details className="approval-diff">
      <summary>变更预览（{changed} 处{changed > MAX_SHOW ? `，仅显示前 ${MAX_SHOW} 处` : ''}）</summary>
      <pre className="diff">
        {shown.map((o, k) => (
          <span key={k} className={o.t === '+' ? 'dl-add' : o.t === '-' ? 'dl-del' : 'dl-ctx'}>{o.t === ' ' ? ' ' : o.t} {o.line}{'\n'}</span>
        ))}
      </pre>
    </details>
  );
}

/** 通知中心（对标 ZCode 通知历史）：右下角 🔔 + 弹出历史列表（approval/完成/错误） */
function NotificationCenter({ notifications, open, unread, onToggle, onClear }: {
  notifications: Array<{ id: number; kind: 'approval' | 'done' | 'error' | 'info'; title: string; body: string; ts: number; read: boolean }>;
  open: boolean; unread: number; onToggle: () => void; onClear: () => void;
}): ReactNode {
  const fmt = (ts: number): string => {
    const d = new Date(ts);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  };
  const icon = (kind: string): string => (kind === 'approval' ? '⏸' : kind === 'done' ? '✓' : kind === 'error' ? '⚠' : 'ℹ');
  return (
    <>
      <button className={`notif-fab ${unread > 0 ? 'has-unread' : ''}`} onClick={onToggle} title="通知中心">
        🔔{unread > 0 && <span className="notif-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="notif-panel">
          <div className="notif-head">
            <span>通知中心</span>
            <span style={{ flex: 1 }} />
            <button className="icon-btn" onClick={onClear} title="清空">清空</button>
            <button className="icon-btn" onClick={onToggle}>×</button>
          </div>
          <div className="notif-list">
            {notifications.length === 0 && <div className="notif-empty">暂无通知</div>}
            {[...notifications].reverse().map((n) => (
              <div key={n.id} className={`notif-item ${n.read ? '' : 'unread'}`}>
                <span className={`notif-ico k-${n.kind}`}>{icon(n.kind)}</span>
                <div className="notif-body">
                  <div className="notif-title">{n.title} <span className="log-meta">{fmt(n.ts)}</span></div>
                  <div className="notif-text">{n.body}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/* ---------- 对话层组件（对标 ZCode：思考块/工具卡/进程面板） ---------- */

/** 助手消息：复制 + 长消息展开/收起（对标 chat.message.copy/expand/collapse） */
function AssistantMessage({ item, busy, isLast, onRegenerate }: { item: Extract<Item, { kind: 'assistant' }>; busy: boolean; isLast: boolean; onRegenerate?: () => void }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const streaming = busy && isLast && !item.text;
  const long = item.text.length > 1500;
  const shown = long && !expanded ? `${item.text.slice(0, 1500)}…` : item.text;
  return (
    <div className="msg assistant">
      <div className="msg-row">
        <span className="spacer" />
        {long && (
          <button className="msg-copy" onClick={() => setExpanded((v) => !v)}>{expanded ? '收起' : '展开'}</button>
        )}
        {item.text && (
          <button className="msg-copy" title="复制" onClick={() => void navigator.clipboard.writeText(item.text).catch(() => undefined)}>复制</button>
        )}
        {/* 最后一条完整回复且空闲时显示「重新生成」：回退一轮重发（R5-3） */}
        {!busy && isLast && item.text && onRegenerate && (
          <button className="msg-copy" title="回退本轮重新生成" onClick={onRegenerate}>↻ 重新生成</button>
        )}
      </div>
      <div className="body md">{item.text ? renderMarkdown(shown) : streaming ? <span className="cursor">▍</span> : null}</div>
    </div>
  );
}

/** 工具动词表（对标 chat.toolCall.read/edit/execute/search/todo/skill/agent.*） */
const TOOL_VERBS: Record<string, { doing: string; done: string }> = {
  Read: { doing: '读取中', done: '已读取' },
  Bash: { doing: '执行中', done: '已执行' },
  Edit: { doing: '编辑中', done: '已编辑' },
  Write: { doing: '写入中', done: '已写入' },
  Grep: { doing: '搜索中', done: '已搜索' },
  Glob: { doing: '列出中', done: '已列出' },
  TodoWrite: { doing: '更新待办', done: '已更新待办' },
  Skill: { doing: '技能运行中', done: '已运行技能' },
  Agent: { doing: '子智能体运行中', done: '子智能体完成' },
};

function toolVerb(name: string): { doing: string; done: string } {
  return TOOL_VERBS[name] ?? { doing: '调用中', done: '已调用' };
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

type ReasoningItem = Extract<Item, { kind: 'reasoning' }>;
type ToolItem = Extract<Item, { kind: 'tool' }>;

/** 思考块（对标 chat.reasoning：思考中.../思考过程/持续了 N 秒，默认折叠随时可展开） */
function ThinkingBlock({ item, active }: { item: ReasoningItem; active: boolean }): ReactNode {
  const [open, setOpen] = useState(false);
  const seconds = Math.max(1, Math.round((item.lastAt - item.startedAt) / 1000));
  return (
    <div className={`thinking ${active ? 'active' : ''}`}>
      <div className="thinking-head clickable" onClick={() => setOpen((v) => !v)}>
        <span className="thinking-icon">{active ? <span className="spin">✻</span> : '✻'}</span>
        <span>{active ? `思考中... ${fmtElapsed(Date.now() - item.startedAt)}` : `思考过程（持续了${seconds >= 4 ? ` ${seconds} 秒` : '几秒'}）`}</span>
        <span className="chevron">{open ? '▾' : '▸'}</span>
      </div>
      <div className={`thinking-body ${open ? '' : 'collapsed'}`}>{item.text}</div>
    </div>
  );
}

/** 紧凑工具行（对标 ZCode：只读工具 Read/Grep/Glob/LS 显示为单行条目，点击展开） */
const COMPACT_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'LSGrep']);
const TOOL_ICON: Record<string, string> = {
  Read: '📄', Grep: '🔍', Glob: '✳', LS: '📁', LSGrep: '📁',
  Edit: '✎', Write: '✚', Bash: '$', Agent: '◇', TodoWrite: '☑', Skill: '⚡',
};

/** 工具卡（对标 chat.toolCall：只读工具紧凑单行；修改类动词化状态 + 可展开详情 + Edit/Write 渲染 diff） */
function ToolCard({ item }: { item: ToolItem }): ReactNode {
  const [open, setOpen] = useState(false);
  const verb = toolVerb(item.name);
  const running = item.output === undefined;
  const state = running ? 'running' : item.denied ? 'denied' : item.ok ? 'ok' : 'failed';
  const compact = COMPACT_TOOLS.has(item.name);

  if (compact) {
    return (
      <div className={`tool-row ${state}`}>
        <div className="tool-row-head" onClick={() => !running && item.output && setOpen((v) => !v)}>
          <span className="tool-row-icon">{TOOL_ICON[item.name] ?? '◇'}</span>
          <span className="tool-row-name">{item.name}</span>
          <span className="tool-row-summary">{item.summary}</span>
          {running && <span className="spin tool-row-spin">◐</span>}
          {!running && item.output && <span className="chevron">{open ? '▾' : '▸'}</span>}
        </div>
        {open && item.output && <pre className="tool-row-output">{item.output.slice(0, 4000)}</pre>}
      </div>
    );
  }

  const statusLabel = item.denied ? '已拒绝' : running ? verb.doing : item.ok ? verb.done : '执行失败';
  const isDiff = (item.name === 'Edit' || item.name === 'Write') && Boolean(item.output);
  const diffLines = isDiff ? item.output!.split('\n') : null;
  return (
    <div className={`tool-card ${state}`}>
      <div className={`tool-card-head ${open && !running ? 'expanded' : ''}`} onClick={() => !running && setOpen((v) => !v)}>
        <span className="tool-row-icon">{TOOL_ICON[item.name] ?? '◇'}</span>
        <span className="tool-status">{statusLabel}</span>
        <span className="tool-name">{item.name}</span>
        <span className="tool-summary">{item.summary}</span>
        {running ? (
          <span className="tool-elapsed">{fmtElapsed(Date.now() - item.startedAt)}</span>
        ) : item.endedAt != null && item.endedAt - item.startedAt > 1000 ? (
          <span className="tool-elapsed dim">{fmtElapsed(item.endedAt - item.startedAt)}</span>
        ) : null}
        {item.output && (
          <button
            className="tool-copy"
            title="复制结果"
            onClick={(e) => { e.stopPropagation(); void navigator.clipboard.writeText(item.output!).catch(() => undefined); }}
          >⧉</button>
        )}
        {!running && <span className="chevron">{open ? '▾' : '▸'}</span>}
      </div>
      <div className={`tool-output ${open && diffLines ? '' : 'collapsed'}`}>
        {diffLines && (
          <pre className="diff">
            {diffLines.map((l, j) => (
              <span key={j} className={l.startsWith('+') && !l.startsWith('++') ? 'dl-add' : l.startsWith('-') && !l.startsWith('--') ? 'dl-del' : l.startsWith(' ...') ? 'dl-gap' : 'dl-ctx'}>
                {l}
                {'\n'}
              </span>
            ))}
          </pre>
        )}
      </div>
      {open && !diffLines && item.output && <pre className="tool-output">{item.output.slice(0, 4000)}</pre>}
    </div>
  );
}

/** 进程面板（对标 chat.statusPanel.todo：进行中置顶，已完成可折叠） */
function TodoPanel({ todos }: { todos: TodoItem[] }): ReactNode {
  const [showDone, setShowDone] = useState(false);
  const pending = todos.filter((t) => t.status !== 'completed');
  const done = todos.filter((t) => t.status === 'completed');
  const row = (t: TodoItem, i: number): ReactNode => (
    <div key={i} className={`todo-item ${t.status}`}>
      <span style={{ color: t.status === 'completed' ? 'var(--ok)' : t.status === 'in_progress' ? 'var(--accent)' : 'var(--dim)' }}>
        {TODO_ICON[t.status] ?? '○'}
      </span>
      <span className={t.status === 'completed' ? 'done' : ''}>{t.content}</span>
    </div>
  );
  return (
    <div className="todo-list">
      {pending.map(row)}
      {done.length > 0 && (
        <button className="todo-fold" onClick={() => setShowDone((v) => !v)}>
          {showDone ? `收起 ${done.length} 项已完成` : `已完成 ${done.length} 项`}
        </button>
      )}
      {showDone && done.map(row)}
    </div>
  );
}

/* ---------- 集成终端面板（对标 ZCode 终端面板） ---------- */

/* 文件树面板（对标 ZCode 文件树，220px 左栏）：fs/list 懒加载逐层展开；点击文件 → 填入 Read 提示词 */
interface FsEntry { name: string; isDir: boolean; size: number; path: string; }

function FileTreePanel({ cwd, onPick, onEdit }: { cwd?: string; onPick: (file: string) => void; onEdit: (file: string) => void }): ReactNode {
  const [root, setRoot] = useState('');
  const [children, setChildren] = useState<Record<string, FsEntry[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);

  const list = async (dir?: string): Promise<void> => {
    setLoading(true);
    try {
      const res = await window.bajin.rpc<{ cwd?: string; items?: FsEntry[] }>('fs/list', dir ? { path: dir } : {});
      setRoot(res['cwd'] ?? root);
      setChildren((c) => ({ ...c, [dir ?? '']: res['items'] ?? [] }));
    } catch {
      setChildren((c) => ({ ...c, [dir ?? '']: [] }));
    } finally {
      setLoading(false);
    }
  };
  // 空会话 cwd 未定：首次渲染时以 app-server 侧会话 cwd 为根
  useEffect(() => { void list(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const toggle = (dir: string): void => {
    setExpanded((e) => {
      const next = { ...e, [dir]: !e[dir] };
      if (next[dir] && !children[dir]) void list(dir);
      return next;
    });
  };

  const renderLevel = (dir: string, depth: number): ReactNode =>
    (children[dir] ?? []).map((e) =>
      e.isDir ? (
        <div key={e.path}>
          <div className="ft-item dir" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => toggle(e.path)}>
            <span className="ft-icon">{expanded[e.path] ? '📂' : '📁'}</span>
            <span className="ft-name">{e.name}</span>
          </div>
          {expanded[e.path] && renderLevel(e.path, depth + 1)}
        </div>
      ) : (
        <div
          key={e.path}
          className="ft-item file"
          style={{ paddingLeft: 8 + depth * 12 }}
          title={`${e.path}（双击编辑）`}
          onClick={() => onPick(e.path)}
          onDoubleClick={() => onEdit(e.path)}
        >
          <span className="ft-icon">📄</span>
          <span className="ft-name">{e.name}</span>
          <span className="ft-size">{e.size >= 1024 ? `${Math.round(e.size / 1024)}k` : e.size || ''}</span>
        </div>
      ),
    );

  const rootItems = children[''] ?? [];
  const rootLabel = (root || cwd || '').split(/[\\/]/).pop() || '—';
  return (
    <div className="file-tree-panel">
      <div className="ft-head">
        <span className="ft-title">文件树</span>
        <span className="ft-cwd" title={root || cwd || ''}>{rootLabel}</span>
      </div>
      <div className="ft-body">
        {loading && rootItems.length === 0 && <div className="ft-empty">加载中…</div>}
        {!loading && rootItems.length === 0 && <div className="ft-empty">空目录（或不可读）</div>}
        {renderLevel('', 0)}
      </div>
    </div>
  );
}

/** Web Speech API 最小接口（浏览器原生，无官方类型定义） */
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: unknown;
  onend: unknown;
  onerror: unknown;
}

function VoiceButton({ onText }: { onText: (t: string) => void }): ReactNode {
  const [on, setOn] = useState(false);
  const ref = useRef<{ stop: () => void } | null>(null);
  function toggle(): void {
    if (on) { ref.current?.stop(); setOn(false); return; }
    const W = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
    const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = 'zh-CN';
    rec.continuous = true;
    rec.onresult = (e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => {
      for (let i = e.resultIndex; i < e.results.length; i++) onText(e.results[i]![0]!.transcript);
    };
    rec.onend = () => setOn(false);
    rec.onerror = () => setOn(false);
    rec.start();
    ref.current = rec;
    setOn(true);
  }
  // Ctrl+M 全局快捷键（App 侧 dispatch 'bajin:voice-toggle'）
  useEffect(() => {
    const h = (): void => { toggle(); };
    window.addEventListener('bajin:voice-toggle', h);
    return () => window.removeEventListener('bajin:voice-toggle', h);
  });
  return <button className={`voice-btn ${on ? 'on' : ''}`} onClick={toggle} title={on ? '停止（Ctrl+M）' : '🎤 语音输入（Ctrl+M）'}>{on ? '🔴' : '🎤'}</button>;
}

/** 行级 LCS diff（编辑器保存对比用，>1200 行退化为整块替换展示） */
function lineDiff(aText: string, bText: string): Array<{ t: ' ' | '-' | '+'; line: string }> {
  const a = aText.split('\n');
  const b = bText.split('\n');
  if (a.length > 1200 || b.length > 1200) {
    return [...a.map((line) => ({ t: '-' as const, line })), ...b.map((line) => ({ t: '+' as const, line }))];
  }
  const n = a.length, m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: Array<{ t: ' ' | '-' | '+'; line: string }> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: ' ', line: a[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { ops.push({ t: '-', line: a[i]! }); i++; }
    else { ops.push({ t: '+', line: b[j]! }); j++; }
  }
  while (i < n) { ops.push({ t: '-', line: a[i]! }); i++; }
  while (j < m) { ops.push({ t: '+', line: b[j]! }); j++; }
  return ops;
}

/** 文件编辑器：语法着色 overlay + 保存前 diff 确认（对标 ZCode 编辑器体验） */
function FileEditorPanel({ filePath, onClose }: { filePath: string; onClose: () => void }): ReactNode {
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pendingDiff, setPendingDiff] = useState<Array<{ t: ' ' | '-' | '+'; line: string }> | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const hlRef = useRef<HTMLPreElement | null>(null);
  const lang = langFromPath(filePath);
  useEffect(() => {
    void window.bajin.rpc('fs/read', { path: filePath })
      .then((r) => { const c = String((r as { content?: string }).content ?? ''); setContent(c); setOriginal(c); })
      .catch(() => setContent('// 无法读取'));
  }, [filePath]);
  async function write(): Promise<void> {
    setSaving(true);
    try {
      await window.bajin.rpc('fs/write', { path: filePath, content });
      setDirty(false); setOriginal(content); setPendingDiff(null); setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch { /* */ }
    setSaving(false);
  }
  /** 保存前先出 diff（原 vs 改）确认——只有确认后才真正落盘 */
  function requestSave(): void {
    if (!dirty || saving) return;
    const ops = lineDiff(original, content);
    // 没有实际变化（如改了又改回去）直接静默重置脏标记
    if (!ops.some((o) => o.t !== ' ')) { setDirty(false); return; }
    setPendingDiff(ops);
  }
  const changed = pendingDiff?.filter((o) => o.t !== ' ').length ?? 0;
  return (
    <div className="file-editor">
      <div className="ft-head">
        <span className="ft-title">📝 {filePath.split('/').pop()}</span>
        <span className="log-meta">{filePath.split('/').length - 1} 行 · {lang.toUpperCase()}</span>
        <span style={{ flex: 1 }} />
        {saved && <span style={{ color: 'var(--ok)', fontSize: 12 }}>✓ 已保存</span>}
        <button disabled={!dirty || saving || pendingDiff !== null} onClick={requestSave} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 4, padding: '2px 12px', cursor: 'pointer' }}>保存</button>
        <button className="icon-btn" onClick={onClose}>×</button>
      </div>
      {pendingDiff && (
        <div className="save-diff">
          <div className="save-diff-head">
            保存对比（{changed} 处变更）
            <span style={{ flex: 1 }} />
            <button className="primary" disabled={saving} onClick={() => void write()}>确认保存</button>
            <button onClick={() => setPendingDiff(null)}>继续编辑</button>
          </div>
          <pre className="diff">
            {pendingDiff.map((o, k) => (
              <span key={k} className={o.t === '+' ? 'dl-add' : o.t === '-' ? 'dl-del' : 'dl-ctx'}>{o.t === ' ' ? ' ' : o.t} {o.line}{'\n'}</span>
            ))}
          </pre>
        </div>
      )}
      <div className="editor-wrap">
        <pre ref={hlRef} className="editor-hl" aria-hidden="true"><code dangerouslySetInnerHTML={{ __html: highlightCode(content, lang) }} />{'\n'}</pre>
        <textarea ref={taRef} className="editor-textarea" value={content} spellCheck={false} wrap="off"
          onChange={(e) => { setContent(e.target.value); setDirty(true); }}
          onScroll={() => { if (hlRef.current && taRef.current) { hlRef.current.scrollTop = taRef.current.scrollTop; hlRef.current.scrollLeft = taRef.current.scrollLeft; } }}
          onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); requestSave(); } }} />
      </div>
    </div>
  );
}

function GitChip({ status, onToggle, expanded }: { status: { isRepo: boolean; branch: string; dirtyCount: number } | null; onToggle: () => void; expanded: boolean }): ReactNode | null {
  if (!status?.isRepo) return null;
  return (
    <button className={`git-chip ${expanded ? 'on' : ''}`} onClick={onToggle} title={`${status.branch} · ${status.dirtyCount} 变更`}>
      ⎇ {status.branch}{status.dirtyCount > 0 && <span className="git-dirty">{status.dirtyCount}</span>}
    </button>
  );
}

/** 系统监控面板（对标 ZCode process-monitor）：CPU/内存/负载概览 + top 进程表，2s 轮询 */
function ProcessMonitorPanel({ onClose }: { onClose: () => void }): ReactNode {
  const [info, setInfo] = useState<{
    cpuPercent: number; memPercent: number; totalMem: number; freeMem: number;
    loadAvg: number[]; uptimeSeconds: number;
    agentMemoryMB: number; agentHeapMB: number;
    processes: Array<{ user: string; pid: number; cpu: number; mem: number; rss: number; command: string }>;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        const r = await window.bajin.rpc('sys/proc', {});
        if (alive && r && typeof r === 'object') setInfo(r as typeof info);
      } catch { /* app-server 不在时静默 */ }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const fmtGB = (bytes: number): string => `${(bytes / 1024 / 1024 / 1024).toFixed(1)}G`;
  const fmtUp = (s: number): string => s > 86400 ? `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h` : s > 3600 ? `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m`;

  return (
    <div className="proc-monitor">
      <div className="ft-head">
        <span className="ft-title">📈 系统监控</span>
        <span className="log-meta">{info ? `agent ${info.agentMemoryMB}MB · heap ${info.agentHeapMB}MB` : '…'}</span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose}>×</button>
      </div>
      <div className="proc-summary">
        <span className="proc-stat"><span className="proc-label">CPU</span><span className="proc-value">{info ? `${info.cpuPercent}%` : '—'}</span></span>
        <span className="proc-stat"><span className="proc-label">内存</span><span className="proc-value">{info ? `${info.memPercent}%` : '—'}</span></span>
        <span className="proc-stat"><span className="proc-label">可用</span><span className="proc-value">{info ? fmtGB(info.freeMem) : '—'}</span></span>
        <span className="proc-stat"><span className="proc-label">负载</span><span className="proc-value">{info ? info.loadAvg.map((l) => l.toFixed(2)).join(' ') : '—'}</span></span>
        <span className="proc-stat"><span className="proc-label">运行</span><span className="proc-value">{info ? fmtUp(info.uptimeSeconds) : '—'}</span></span>
      </div>
      <div className="proc-table">
        <div className="proc-table-head"><span>PID</span><span>USER</span><span>CPU%</span><span>MEM%</span><span>COMMAND</span></div>
        {(info?.processes ?? []).map((p) => (
          <div key={p.pid} className="proc-table-row">
            <span>{p.pid}</span><span>{p.user}</span><span>{p.cpu}</span><span>{p.mem}</span><span className="proc-cmd" title={p.command}>{p.command}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 撤销本轮文件改动（R7-5，对标 ZCode 可安全撤销）：dry-run 预览 → 确认执行 */
function SessionRevert({ sessionId, onReverted }: { sessionId: string | null; onReverted: () => void }): ReactNode {
  const [touched, setTouched] = useState<Array<string>>([]);
  const [plan, setPlan] = useState<{ safe: Array<{ path: string }>; risky: Array<{ path: string; action: string; reason: string }> } | null>(null);
  const [msg, setMsg] = useState('');
  const refresh = useCallback(() => {
    if (!sessionId) { setTouched([]); return; }
    void window.bajin.rpc<{ files: string[] }>('session/touched-files', { sessionId })
      .then((r) => setTouched(r.files ?? []))
      .catch(() => setTouched([]));
  }, [sessionId]);
  useEffect(refresh, [refresh]);
  if (!touched.length) return null;
  async function preview(): Promise<void> {
    if (!sessionId) return;
    const r = await window.bajin.rpc<{ safe: Array<{ path: string }>; risky: Array<{ path: string; action: string; reason: string }> }>('session/revert-files', { sessionId, dryRun: true });
    setPlan(r);
  }
  async function apply(): Promise<void> {
    if (!sessionId) return;
    const r = await window.bajin.rpc<{ done: string[]; skipped: string[]; remaining: Array<{ action: string }> }>('session/revert-files', { sessionId, confirmDelete: true });
    setMsg(`已撤销 ${r.done.length} 个文件${r.skipped.length ? `，跳过 ${r.skipped.length} 个` : ''}${r.remaining.length ? `；${r.remaining.length} 个需人工处理（暂存/重命名）` : ''}`);
    setPlan(null);
    refresh();
    onReverted();
  }
  return (
    <div className="git-section session-revert">
      <div className="settings-nav-group-title">↩ 本轮文件改动（{touched.length}）</div>
      <div className="settings-desc" style={{ marginBottom: 6 }}>本会话工具改过 {touched.length} 个文件，可按 git 状态安全撤销。</div>
      {plan && (
        <div className="revert-plan">
          {plan.safe.length > 0 && <div className="log-meta">✓ 可安全撤销 {plan.safe.length}：{plan.safe.slice(0, 5).map((x) => x.path.split('/').pop()).join('、')}{plan.safe.length > 5 ? '…' : ''}</div>}
          {plan.risky.length > 0 && <div className="log-meta" style={{ color: 'var(--warn)' }}>⚠ 需注意 {plan.risky.length}：{plan.risky.slice(0, 3).map((x) => `${x.path.split('/').pop()}（${x.reason}）`).join('；')}{plan.risky.length > 3 ? '…' : ''}</div>}
        </div>
      )}
      <div className="card-actions">
        {!plan
          ? <button onClick={() => void preview()}>预览撤销</button>
          : <button className="primary" onClick={() => void apply()}>确认撤销（含删除本会话新建文件）</button>}
        {plan && <button onClick={() => setPlan(null)}>取消</button>}
      </div>
      {msg && <div className="log-meta">{msg}</div>}
    </div>
  );
}

function GitPanel({ status, sessionId, onClose, onRefresh }: { status: { branch: string; staged: number; unstaged: number; dirtyFiles: string[]; recentCommits: Array<{ hash: string; message: string }>; diffStat: string }; sessionId: string | null; onClose: () => void; onRefresh: () => void }): ReactNode {
  return (
    <div className="git-panel">
      <div className="ft-head">
        <span className="ft-title">⎇ {status.branch}</span>
        <span className="log-meta">{status.staged}+{status.unstaged}</span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onRefresh}>⟳</button>
        <button className="icon-btn" onClick={onClose}>×</button>
      </div>
      <div className="git-panel-body">
        <SessionRevert sessionId={sessionId} onReverted={onRefresh} />
        {status.dirtyFiles.length > 0 && (
          <div className="git-section">
            <div className="settings-nav-group-title">{t('变更文件')} ({status.dirtyFiles.length})</div>
            {status.dirtyFiles.map((f, i) => (
              <div key={i} className="git-file-row"><span className="git-file-status">{f.slice(0, 2)}</span><span className="git-file-name">{f.slice(3)}</span></div>
            ))}
          </div>
        )}
        <div className="git-section">
          <div className="settings-nav-group-title">{t('最近提交')}</div>
          {status.recentCommits.map((c) => (
            <div key={c.hash} className="git-commit-row"><code className="git-hash">{c.hash.slice(0, 7)}</code><span>{c.message}</span></div>
          ))}
        </div>
        <div className="git-section">
          <div className="settings-nav-group-title">Diff</div>
          <pre className="git-diff-stat">{status.diffStat}</pre>
        </div>
      </div>
    </div>
  );
}

/** 浏览器面板（对标 ZCode 内置浏览器）：URL + 视口预设/自由尺寸 + 缩放（R6） */
function BrowserPanel({ directive, onClose }: { directive: { url?: string; viewport?: { width: number; height: number }; zoom?: number; action?: 'click' | 'type'; selector?: string; text?: string; seq?: number } | null; onClose: () => void }): ReactNode {
  const [url, setUrl] = useState('');
  const [loaded, setLoaded] = useState('');
  const [vw, setVw] = useState(1280);
  const [vh, setVh] = useState(800);
  const [zoom, setZoom] = useState(1);
  const [loadError, setLoadError] = useState(''); // R6-3：did-fail-load / 规范化失败提示
  const [reloadKey, setReloadKey] = useState(0);
  // R6-4 屏幕录制：webm 留档 + 回放
  const [recording, setRecording] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  const [records, setRecords] = useState<Array<{ name: string; size: number; mtimeMs: number }>>([]);
  const [playUrl, setPlayUrl] = useState<string | null>(null);
  // R7-6：内容时效 chip（面板打开期间每 5s 刷新；>5 分钟标陈旧提示重开页面）
  const [contentAge, setContentAge] = useState<number | null>(null);
  const recorderRef = useRef<{ stop: () => void } | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // Electron 环境（有 process.versions.electron）用 <webview>；浏览器用 <iframe>
  const isElectron = typeof process !== 'undefined' && process.versions?.electron;
  const webviewRef = useRef<ElectronWebviewTag>(null);
  useEffect(() => {
    const off = window.bajin.onBrowserNavigate((u) => setUrl(u));
    return off;
  }, []);
  useEffect(() => {
    if (url && isElectron && webviewRef.current?.loadURL) {
      void webviewRef.current.loadURL(url).then(() => setLoaded(url)).catch(() => undefined);
    } else if (url) {
      setLoaded(url); // 浏览器模式：iframe src 直接生效
    }
  }, [url, isElectron]);
  // 工具指令（BrowserNavigate 事件）：应用 URL/视口/缩放
  useEffect(() => {
    if (!directive) return;
    if (directive.url) setUrl(directive.url);
    if (directive.viewport) { setVw(directive.viewport.width); setVh(directive.viewport.height); }
    if (directive.zoom != null) setZoom(directive.zoom);
  }, [directive]);
  // CUA 动作（R6-5/R7-2）：点击/键入由面板页面执行；结果回填 app-server（工具不再盲报成功）。
  // Electron webview executeJavaScript 可跨域执行；web 模式 iframe 受同源限制——诚实上报失败原因。
  useEffect(() => {
    if (!directive?.action || !directive.selector) return;
    const { action, selector, text, seq } = directive;
    const report = (ok: boolean, reason?: string): void => {
      setLoadError(ok ? '' : `CUA 失败：${reason ?? selector}`);
      if (seq !== undefined) void window.bajin.rpc('browser/action-result', { seq, ok, reason }).catch(() => undefined);
    };
    const js = action === 'click'
      ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) { el.click(); return true; } return false; })()`
      : `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;
          el.focus(); el.value = ${JSON.stringify(text ?? '')};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          return true; })()`;
    if (isElectron) {
      void webviewRef.current?.executeJavaScript(js)
        .then((hit: unknown) => { report(Boolean(hit), hit ? undefined : `元素未命中 ${selector}`); })
        .catch((e: unknown) => report(false, `执行失败: ${e instanceof Error ? e.message : String(e)}`));
    } else {
      try {
        const frame = document.querySelector<HTMLIFrameElement>('.browser-view');
        const doc = frame?.contentDocument; // 同源才可访问；跨域抛错/null 走失败上报
        const el = doc?.querySelector(selector);
        if (!el) { report(false, '跨域受限或元素未命中（web 模式 iframe 同源策略；跨站操作请在桌面端进行）'); return; }
        if (action === 'click') (el as HTMLElement).click();
        else {
          const input = el as HTMLInputElement;
          input.focus(); input.value = text ?? '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        report(true);
      } catch {
        report(false, '跨域受限（web 模式 iframe 同源策略；跨站操作请在桌面端进行）');
      }
    }
  }, [directive]);
  // 状态回读（R6-2）：页面加载完成后把 URL/文本推给 app-server（BrowserContent 工具读真实面板）。
  // Electron webview 可读跨域页 innerText；web 模式 iframe 受同源限制，只报 URL。
  function refreshRecords(): void {
    void window.bajin.rpc<{ recordings: Array<{ name: string; size: number; mtimeMs: number }> }>('browser/record-list')
      .then((r) => setRecords(r.recordings ?? []))
      .catch(() => undefined);
  }
  useEffect(() => { refreshRecords(); }, []);
  useEffect(() => {
    const t = setInterval(() => {
      void window.bajin.rpc<{ content: string | null; updatedAt: number }>('browser/state-get')
        .then((r) => setContentAge(r.content != null ? Date.now() - Number(r.updatedAt) : null))
        .catch(() => undefined);
    }, 5000);
    return () => clearInterval(t);
  }, []);
  /** 屏幕录制（R6-4）：getDisplayMedia + MediaRecorder(webm)，停止后 base64 存 app-server，≤50MB */
  async function toggleRecord(): Promise<void> {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
      const rec = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : '' });
      chunksRef.current = [];
      rec.ondataavailable = (e: BlobEvent): void => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = (): void => {
        stream.getTracks().forEach((tr) => tr.stop());
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: 'video/webm' });
        if (blob.size > 50 * 1024 * 1024) { setLoadError(`录制 ${Math.round(blob.size / 1048576)}MB 超 50MB 上限，未保存`); return; }
        const reader = new FileReader();
        reader.onload = () => {
          const b64 = String(reader.result ?? '').split(',')[1] ?? '';
          void window.bajin.rpc('browser/record-save', { name: `panel-${new Date().toISOString().slice(0, 19)}`, dataBase64: b64 })
            .then(() => { setLoadError(''); refreshRecords(); })
            .catch((e2: unknown) => setLoadError(`录制保存失败: ${e2 instanceof Error ? e2.message : String(e2)}`));
        };
        reader.readAsDataURL(blob);
      };
      recorderRef.current = rec;
      setRecSecs(0);
      rec.start(1000);
      setRecording(true);
    } catch (e) {
      setLoadError(`无法开始录制: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // 录制计时
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setRecSecs((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  function reportState(u: string): void {
    if (!u || !u.startsWith('http')) return;
    if (isElectron) {
      void webviewRef.current?.executeJavaScript('document.body ? document.body.innerText : ""')
        .then((text: unknown) => {
          void window.bajin.rpc('browser/state', { url: u, content: String(text ?? '').slice(0, 20000) }).catch(() => undefined);
        })
        .catch(() => {
          void window.bajin.rpc('browser/state', { url: u }).catch(() => undefined);
        });
    } else {
      void window.bajin.rpc('browser/state', { url: u }).catch(() => undefined);
    }
  }
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => reportState(loaded), 600); // 等 DOM 稳定再取文本
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);
  // 缩放应用到 webview（iframe 用 CSS zoom）；Electron 类型定义 setZoomFactor 返回 void
  useEffect(() => {
    if (isElectron) webviewRef.current?.setZoomFactor(zoom);
  }, [zoom, loaded, isElectron]);
  // webview 加载失败（React 不认 <webview> 自定义事件，手动监听）
  useEffect(() => {
    if (!isElectron) return;
    const wv = webviewRef.current;
    if (!wv) return;
    const onFail = (e: Event): void => {
      const code = (e as Event & { errorCode?: number }).errorCode;
      setLoadError(`加载失败${code ? `（${code}）` : ''}— 可点 ⟳ 重试或 ↗ 外链打开`);
    };
    wv.addEventListener('did-fail-load', onFail);
    return () => { wv.removeEventListener('did-fail-load', onFail); };
  }, [isElectron, reloadKey]);
  return (
    <div className="browser-panel">
      <div className="browser-head">
        <span className="browser-url">
          {loaded || url || '浏览器'}
          {contentAge != null && (
            <span className={`content-age ${contentAge > 300_000 ? 'stale' : ''}`} title="面板内容更新距今">
              {contentAge > 300_000 ? `⚠ ${Math.round(contentAge / 60000)} 分钟前` : `${Math.round(contentAge / 1000)}s`}
            </span>
          )}
        </span>
        <input className="browser-input" value={url} placeholder="输入 URL…" onChange={(e) => { setUrl(e.target.value); setLoadError(''); }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !url.trim()) return;
            const n = normalizeBrowserUrl(url);
            if (n.ok) { setUrl(n.url); setLoadError(''); }
            else setLoadError(n.reason);
          }} />
        <button className="icon-btn" title="桌面视口 1280×800" onClick={() => { setVw(1280); setVh(800); }}>🖥</button>
        <button className="icon-btn" title="移动视口 390×844" onClick={() => { setVw(390); setVh(844); }}>📱</button>
        <input className="browser-vp" type="number" min={200} max={3840} value={vw} title="视口宽（px）" onChange={(e) => setVw(Math.max(200, Math.min(3840, Number(e.target.value) || 1280)))} />
        <span className="log-meta">×</span>
        <input className="browser-vp" type="number" min={200} max={4320} value={vh} title="视口高（px）" onChange={(e) => setVh(Math.max(200, Math.min(4320, Number(e.target.value) || 800)))} />
        <button className="icon-btn" title="缩小" onClick={() => setZoom((z) => Math.max(0.25, Math.round((z - 0.25) * 100) / 100))}>−</button>
        <span className="log-meta" title="缩放">{Math.round(zoom * 100)}%</span>
        <button className="icon-btn" title="放大" onClick={() => setZoom((z) => Math.min(5, Math.round((z + 0.25) * 100) / 100))}>＋</button>
        <button className="icon-btn" title="重试（重新加载当前页）" onClick={() => {
          if (!loaded) return;
          setLoadError('');
          if (isElectron) webviewRef.current?.reload();
          setReloadKey((k) => k + 1); // iframe 重挂；webview 兜底
        }}>⟳</button>
        <button className={`icon-btn ${recording ? 'rec-on' : ''}`} title={recording ? `停止录制（已录 ${recSecs}s）` : '屏幕录制（webm，存档可回放）'} onClick={() => void toggleRecord()}>
          {recording ? `■ ${recSecs}s` : '●'}
        </button>
        {records.length > 0 && (
          <button className="icon-btn" title={`录制存档（${records.length}）`} onClick={() => setPlayUrl('__LIST__')}>🎬</button>
        )}
        <button className="icon-btn" title="在默认浏览器中打开" onClick={() => {
          const n = normalizeBrowserUrl(loaded || url);
          if (!n.ok) { setLoadError(n.reason); return; }
          if (isElectron) void window.bajin.browserOpenExternal?.(n.url);
          else window.open(n.url, '_blank', 'noopener');
        }}>↗</button>
        <button className="icon-btn" onClick={onClose}>×</button>
      </div>
      {loadError && <div className="browser-err">⚠ {loadError}</div>}
      <div className="browser-stage" key={reloadKey}>
        {/* 纯 web 包：一律 iframe（原 Electron <webview> 分支随桌面 app 移除） */}
        <iframe className="browser-view" style={{ width: vw, height: vh, zoom }} src={url || 'about:blank'} sandbox="allow-scripts allow-same-origin allow-forms" title="browser" />
      </div>
      {playUrl && (
        <div className="rec-overlay" onClick={() => { if (playUrl !== '__LIST__') setPlayUrl(null); }}>
          {playUrl === '__LIST__' ? (
            <div className="rec-list" onClick={(e) => e.stopPropagation()}>
              <div className="rec-list-head">录制存档 <span style={{ flex: 1 }} /><button className="icon-btn" onClick={() => setPlayUrl(null)}>×</button></div>
              {records.map((r) => (
                <div key={r.name} className="rec-item">
                  <span className="rec-name" title={r.name}>{new Date(r.mtimeMs).toLocaleString()}</span>
                  <span className="log-meta">{(r.size / 1048576).toFixed(1)}MB</span>
                  <button className="primary" onClick={() => {
                    void window.bajin.rpc<{ dataBase64: string }>('browser/record-read', { name: r.name }).then((res) => {
                      const bin = atob(res.dataBase64);
                      const bytes = new Uint8Array(bin.length);
                      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                      setPlayUrl(URL.createObjectURL(new Blob([bytes], { type: 'video/webm' })));
                    }).catch((e: unknown) => setLoadError(`读取录制失败: ${e instanceof Error ? e.message : String(e)}`));
                  }}>▶</button>
                </div>
              ))}
            </div>
          ) : (
            <video className="rec-video" src={playUrl} controls autoPlay onClick={(e) => e.stopPropagation()} />
          )}
        </div>
      )}
    </div>
  );
}

function TerminalPanel({ cwd, onClose, fontFamily }: { cwd?: string; onClose: () => void; fontFamily?: string }): ReactNode {
  const [lines, setLines] = useState('');
  const [cmd, setCmd] = useState('');
  const [history, setCmdHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const preRef = useRef<HTMLPreElement>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void window.bajin.termStart(cwd).then((r) => {
      if (!r.ok) setLines(`终端启动失败: ${r.error ?? '未知错误'}`);
    });
  }, [cwd]);

  useEffect(() => {
    return window.bajin.onEvent(({ event, params }) => {
      const p = (params ?? {}) as Record<string, unknown>;
      if (event === 'term-data') setLines((prev) => (prev + String(p['data'] ?? '')).slice(-40000));
      if (event === 'term-exit') setLines((prev) => `${prev}\n[进程已退出]\n`);
    });
  }, []);

  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [lines]);

  function run(): void {
    const line = cmd;
    setCmdHistory((h) => [line, ...h]);
    setHistIdx(-1);
    setCmd('');
    void window.bajin.termInput(`${line}\n`);
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-head">
        <span>终端 — {cwd ? cwd.split('/').pop() : '~'}</span>
        <button className="icon-btn" title="关闭终端" onClick={onClose}>×</button>
      </div>
      <pre
        className="terminal-out"
        ref={preRef}
        style={fontFamily ? { fontFamily } : undefined}
      >{lines || '（bash 已启动，输入命令回车执行；↑↓ 翻历史）'}</pre>
      <div className="terminal-input-row">
        <span className="terminal-prompt">$</span>
        <input
          autoFocus
          style={fontFamily ? { fontFamily } : undefined}
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          placeholder="输入命令…"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && cmd.trim()) { e.preventDefault(); run(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); const next = Math.min(histIdx + 1, history.length - 1); if (next >= 0) { setHistIdx(next); setCmd(history[next] ?? ''); } }
            else if (e.key === 'ArrowDown') { e.preventDefault(); const next = histIdx - 1; setHistIdx(next); setCmd(next >= 0 ? (history[next] ?? '') : ''); }
          }}
        />
      </div>
    </div>
  );
}

/* ---------- 模型切换弹窗 ---------- */

function ModelPicker({ current, sessionId, models, providers, onPick, onManage, onClose }: {
  current: string;
  sessionId: string | null;
  models: ModelOpt[];
  providers: ProviderInfo[];
  onPick: (id: string) => void;
  onManage: () => void;
  onClose: () => void;
}): ReactNode {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const match = (m: ModelOpt): boolean => !q || m.id.toLowerCase().includes(q) || (m.label ?? '').toLowerCase().includes(q);
  const custom = models.filter((m) => m.source === 'custom' && match(m));
  const builtin = models.filter((m) => m.source === 'builtin' && match(m));
  // 按供应商分组的自定义模型
  const byProvider = new Map<string, ModelOpt[]>();
  for (const m of custom) {
    const p = m.provider ?? '独立端点';
    if (!byProvider.has(p)) byProvider.set(p, []);
    byProvider.get(p)!.push(m);
  }

  return (
    <div className="model-picker-overlay" onClick={onClose}>
      <div className="model-picker" onClick={(e) => e.stopPropagation()}>
        <div className="model-picker-head">
          <span>选择模型</span>
          <button className="icon-btn" onClick={onClose}>×</button>
        </div>
        <div className="mp-search">
          <input autoFocus value={query} placeholder="搜索模型..." onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="model-picker-list">
          {[...byProvider.entries()].map(([prov, ms]) => (
            <div key={prov} className="mp-group">
              <div className="mp-group-title">{prov}</div>
              {ms.map((m) => (
                <div key={m.id} className={`mp-item ${m.id === current ? 'on' : ''}`} onClick={() => onPick(m.id)}>
                  <span className="mp-check">{m.id === current ? '✓' : ''}</span>
                  <span className="mp-name">{m.id}{m.label ? `（${m.label}）` : ''}</span>
                </div>
              ))}
            </div>
          ))}
          {custom.length > 0 && builtin.length > 0 && <div className="mp-sep" />}
          {builtin.length > 0 && (
            <div className="mp-group">
              <div className="mp-group-title">内置（GLM）</div>
              {builtin.map((m) => (
                <div key={m.id} className={`mp-item ${m.id === current ? 'on' : ''}`} onClick={() => onPick(m.id)}>
                  <span className="mp-check">{m.id === current ? '✓' : ''}</span>
                  <span className="mp-name">{m.id}</span>
                </div>
              ))}
            </div>
          )}
          {!custom.length && !builtin.length && <div className="history-empty" style={{ padding: '20px 18px' }}>未找到匹配模型</div>}
        </div>
        <ModelAdvancedParams sessionId={sessionId} />
        <div className="model-picker-foot">
          <button onClick={onManage}>管理模型</button>
        </div>
      </div>
    </div>
  );
}

/** 模型高级参数（R5-6）：temperature / top_p / 最大输出，session/set-params 即时生效 */
function ModelAdvancedParams({ sessionId }: { sessionId: string | null }): ReactNode {
  const [open, setOpen] = useState(false);
  const [temperature, setTemperature] = useState('');
  const [topP, setTopP] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [msg, setMsg] = useState('');
  function apply(): void {
    const params: Record<string, number> = {};
    const t = parseFloat(temperature);
    const p = parseFloat(topP);
    const m = parseInt(maxTokens, 10);
    if (!Number.isNaN(t)) params['temperature'] = t;
    if (!Number.isNaN(p)) params['topP'] = p;
    if (!Number.isNaN(m)) params['maxTokens'] = m;
    if (!Object.keys(params).length) { setMsg('未填写任何参数'); return; }
    if (!sessionId) { setMsg('会话未就绪'); return; }
    void window.bajin.rpc('session/set-params', { sessionId, ...params })
      .then(() => setMsg('✓ 已应用（下次请求生效）'))
      .catch((e: unknown) => setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`));
  }
  return (
    <div className="mp-advanced">
      <div className="mp-advanced-toggle clickable" onClick={() => setOpen((v) => !v)}>{open ? '▾' : '▸'} 高级参数（temperature / top_p / 最大输出）</div>
      {open && (
        <div className="mp-advanced-body">
          <label>temperature <input value={temperature} placeholder="0–2，如 0.7" onChange={(e) => setTemperature(e.target.value)} /></label>
          <label>top_p <input value={topP} placeholder="0–1，如 0.9" onChange={(e) => setTopP(e.target.value)} /></label>
          <label>最大输出 tokens <input value={maxTokens} placeholder="如 8192" onChange={(e) => setMaxTokens(e.target.value)} /></label>
          <div className="mp-advanced-row">
            <button className="primary" onClick={apply}>应用</button>
            {msg && <span className="log-meta">{msg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- 新建任务欢迎页（对标 ZCode chat.empty：问候 + 居中 composer + 推荐卡片） ---------- */

const SESSION_TEMPLATES: Array<{ icon: string; label: string; prompt: string }> = [
  { icon: '🐛', label: 'Bug 修复', prompt: '请分析以下 bug 的根因并提供修复方案：\n\n' },
  { icon: '🔍', label: '代码评审', prompt: '请对当前项目的核心代码进行评审，关注：正确性、边界情况、性能、可读性。' },
  { icon: '📝', label: '文档生成', prompt: '请为当前项目生成 README.md，包含：项目简介、快速开始、API 文档、架构说明。' },
  { icon: '🏗', label: '项目脚手架', prompt: '帮我初始化一个新项目：' },
];

const SUGGESTIONS = [
  { icon: '📋', label: 'Git 站会摘要', prompt: '阅读 git log 和 git diff，生成今日站会摘要：完成了什么、正在做什么、有什么阻塞' },
  { icon: '🧪', label: '修复失败测试', prompt: '查看最近的测试失败日志，分析根因并提供修复方案' },
  { icon: '📝', label: '写单元测试', prompt: '为当前项目最需要覆盖的模块编写单元测试，遵循项目现有测试风格' },
  { icon: '🏗', label: '项目脚手架', prompt: '帮我初始化一个新项目：选择技术栈、搭建目录结构、配置构建和测试工具' },
];

function WelcomePage({ onPickTemplate, input, setInput, onSend, busy, cwd, onPickWorkspace, mode, onModeChange, model, onModelClick }: {
  onPickTemplate: (prompt: string) => void;
  input: string;
  setInput: (v: string | ((prev: string) => string)) => void;
  onSend: () => void;
  busy: boolean;
  cwd?: string;
  onPickWorkspace: (dir: string | null) => void;
  mode: string;
  onModeChange: (m: string) => void;
  model: string;
  onModelClick: () => void;
}): ReactNode {
  return (
    <div className="welcome">
      <div className="welcome-greet">{t(greetingForHour())}</div>
      <Composer
        input={input}
        setInput={setInput}
        onSend={onSend}
        busy={busy}
        disabled={!input.trim()}
        cwd={cwd}
        onPickWorkspace={onPickWorkspace}
        mode={mode}
        onModeChange={onModeChange}
        model={model}
        onModelClick={onModelClick}
        contextUsage={undefined}
        placeholder={cwd ? LANG === 'en-US' ? `Describe what to do in "${cwd.split('/').pop() || cwd}"…` : `在「${cwd.split('/').pop() || cwd}」项目中描述你想做的事…` : t('描述你想做的事，或先选择项目文件夹…')}
        centered
      />
      <div className="welcome-templates">
        {SESSION_TEMPLATES.map((tpl) => (
          <button key={tpl.label} className="suggestion-card" onClick={() => onPickTemplate(tpl.prompt)}>
            <span className="suggestion-icon">{tpl.icon}</span>
            <span className="suggestion-label">{t(tpl.label)}</span>
          </button>
        ))}
      </div>
      <div className="welcome-suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s.prompt} className="suggestion-card" onClick={() => onPickTemplate(s.prompt)}>
            <span className="suggestion-icon">{s.icon}</span>
            <span className="suggestion-label">{t(s.label)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------- 设置页（对标 ZCode：左侧二级导航 + 右侧分区详情） ---------- */

function SettingsView({ section, onSection, isMock, models, providers, refreshModels, refreshProviders, onUseModel, uiSettings, patchUiSettings, onOpenSession }: {
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  isMock: boolean;
  models: ModelOpt[];
  providers: ProviderInfo[];
  refreshModels: () => void;
  refreshProviders: () => void;
  onUseModel: (id: string) => void;
  uiSettings: UISettings;
  patchUiSettings: (patch: Partial<UISettings>) => void;
  onOpenSession: (sid: string) => void;
}): ReactNode {
  return (
    <div className="settings-detail">
        {section === 'general' && <GeneralSection isMock={isMock} models={models} settings={uiSettings} onSettingsChange={patchUiSettings} />}
        {section === 'models' && (
          <ModelProviderSection
            models={models}
            providers={providers}
            refreshModels={refreshModels}
            refreshProviders={refreshProviders}
            onUse={onUseModel}
          />
        )}
        {section === 'appearance' && <AppearanceSection settings={uiSettings} onSettingsChange={patchUiSettings} />}
        {section === 'browser' && <BrowserSection />}
        {section === 'agent-memory' && <AgentMemorySection />}
        {section === 'agent-plugins' && <AgentPluginsSection />}
        {section === 'agent-skills' && <SkillsView />}
        {section === 'agent-subagents' && <AgentSubagentsSection />}
        {section === 'agent-automations' && <AutomationsView onOpenSession={onOpenSession} />}
        {section === 'agent-mcp' && <AgentMcpSection />}
        {section === 'agent-commands' && <AgentCommandsSection />}
        {section === 'agent-hooks' && <AgentHooksSection />}
        {section === 'usage' && <UsageView />}
        {section === 'logs' && <LogsView />}
        {section === 'about' && <HelpView />}
      </div>
  );
}

/* ---------- 外观分区（对标 ZCode settings.appearance：浅色/深色/跟随系统） ---------- */

function AppearanceSection({ settings, onSettingsChange }: {
  settings: UISettings;
  onSettingsChange: (patch: Partial<UISettings>) => void;
}): ReactNode {
  return (
    <div className="vp-inner">
      <h2>{t('外观')} <span className="log-meta">{t('界面主题与色调')}</span></h2>
      <div className="card flat">
        <div className="settings-row">
          <span>{t('界面')}<span className="settings-desc">{t('浅色调 / 深色调 / 跟随系统，即时生效')}</span></span>
          <select
            value={settings.theme ?? 'dark'}
            onChange={(e) => onSettingsChange({ theme: e.target.value as UISettings['theme'] })}
          >
            <option value="system">{t('跟随系统')}</option>
            <option value="dark">{t('深色调')}</option>
            <option value="light">{t('浅色调')}</option>
          </select>
        </div>
      </div>
    </div>
  );
}

/* ---------- 浏览器分区（对标 ZCode settings.browser：数据维护） ---------- */

function BrowserSection(): ReactNode {
  const [msg, setMsg] = useState('');
  return (
    <div className="vp-inner">
      <h2>{t('浏览器')} <span className="log-meta">{t('内嵌网页的缓存与站点数据维护')}</span></h2>
      <div className="card flat">
        <div className="settings-row">
          <span>{t('清理缓存')}<span className="settings-desc">{t('清除图片/资源缓存，不影响登录状态')}</span></span>
          <button onClick={() => { void window.bajin.browserClearCache().then(() => setMsg(t('缓存已清理'))); }}>{t('清理缓存')}</button>
        </div>
        <div className="settings-row">
          <span>{t('清除所有站点数据')}<span className="settings-desc">{t('包含缓存、Cookie、本地存储；需要确认')}</span></span>
          <button onClick={() => { if (confirm(t('确定清除全部站点数据？'))) void window.bajin.browserClearData().then(() => setMsg(t('站点数据已清除'))); }}>{t('清除所有站点数据')}</button>
        </div>
        {msg && <div className="card-actions"><span className="form-msg">{msg}</span></div>}
      </div>
    </div>
  );
}

/* ---------- 常规分区（对标 ZCode settings.general：每一项都真实生效） ---------- */

interface UISettings {
  locale?: 'system' | 'zh-CN' | 'en-US';
  notificationEnabled?: boolean;
  notificationSoundEnabled?: boolean;
  messageStreamShowReasoning?: boolean;
  messageStreamShowTodos?: boolean;
  taskAutoArchiveEnabled?: boolean;
  taskAutoArchiveOlderThanDays?: number;
  terminalShell?: string;
  terminalFontFamily?: string;
  showArchivedTasks?: boolean;
  taskSortBy?: 'updated' | 'created';
  theme?: 'light' | 'dark' | 'system';
  proxy?: { httpProxy?: string; noProxy?: string; caCertPath?: string };
}

function GeneralSection({ isMock, models, settings, onSettingsChange }: {
  isMock: boolean;
  models: ModelOpt[];
  settings: UISettings;
  onSettingsChange: (patch: Partial<UISettings>) => void;
}): ReactNode {
  const boot = useRef<{ apiKey: string | null } | null>(null);
  const [defModel, setDefModel] = useState('');
  const [defMode, setDefMode] = useState('build');
  const [msg, setMsg] = useState('');
  const [fontDraft, setFontDraft] = useState(settings.terminalFontFamily ?? '');

  useEffect(() => {
    void window.bajin.bootstrap().then((b) => {
      boot.current = b;
      setDefModel(b.model ?? 'glm-5.3');
    });
  }, []);

  async function save(): Promise<void> {
    await window.bajin.rpc('settings/set', { model: defModel, mode: defMode });
    setMsg('已保存（重启后新会话生效）');
  }

  return (
    <div className="vp-inner">
      <h2>常规 <span className="log-meta">语言、通知与界面行为</span></h2>

      <div className="card flat">
        <div className="card-title">界面</div>
        <div className="settings-row">
          <span>界面语言<span className="settings-desc">切换后部分界面文案需重启生效</span></span>
          <select
            value={settings.locale ?? 'system'}
            onChange={(e) => onSettingsChange({ locale: e.target.value as UISettings['locale'] })}
          >
            <option value="system">跟随系统</option>
            <option value="zh-CN">简体中文</option>
            <option value="en-US">English</option>
          </select>
        </div>
        <div className="settings-row">
          <span>消息流显示思考过程<span className="settings-desc">关闭后助手回复不再显示思考块</span></span>
          <Switch checked={settings.messageStreamShowReasoning !== false} onChange={(v) => onSettingsChange({ messageStreamShowReasoning: v })} />
        </div>
        <div className="settings-row">
          <span>消息流显示待办进度<span className="settings-desc">关闭后对话中不显示 todo 进度</span></span>
          <Switch checked={settings.messageStreamShowTodos !== false} onChange={(v) => onSettingsChange({ messageStreamShowTodos: v })} />
        </div>
      </div>

      <h3>通知</h3>
      <div className="card flat">
        <div className="settings-row">
          <span>任务完成通知<span className="settings-desc">任务结束（无论成败）弹系统通知</span></span>
          <Switch checked={settings.notificationEnabled === true} onChange={(v) => onSettingsChange({ notificationEnabled: v })} />
        </div>
        <div className="settings-row">
          <span>通知声音</span>
          <Switch
            checked={settings.notificationSoundEnabled === true}
            onChange={(v) => onSettingsChange({ notificationSoundEnabled: v })}
          />
        </div>
      </div>

      <h3>任务</h3>
      <div className="card flat">
        <div className="settings-row">
          <span>自动归档旧任务<span className="settings-desc">超过 N 天未更新的任务不再显示在任务列表</span></span>
          <Switch
            checked={settings.taskAutoArchiveEnabled === true}
            onChange={(v) => onSettingsChange({ taskAutoArchiveEnabled: v })}
          />
        </div>
        {settings.taskAutoArchiveEnabled && (
          <div className="settings-row">
            <span>归档阈值</span>
            <select
              value={String(settings.taskAutoArchiveOlderThanDays ?? 14)}
              onChange={(e) => onSettingsChange({ taskAutoArchiveOlderThanDays: Number(e.target.value) })}
            >
              {[3, 7, 14, 30].map((d) => (<option key={d} value={d}>{d} 天前</option>))}
            </select>
          </div>
        )}
      </div>

      <h3>网络代理</h3>
      <ProxyCard settings={settings} onSettingsChange={onSettingsChange} />

      <h3>数据目录</h3>
      <DataDirCard />

      <h3>终端</h3>
      <div className="card flat">
        <div className="settings-row">
          <span>集成终端 Shell<span className="settings-desc">终端面板使用的 shell（重启终端面板后生效）</span></span>
          <select
            value={settings.terminalShell ?? 'auto'}
            onChange={(e) => onSettingsChange({ terminalShell: e.target.value })}
          >
            {terminalShellOptions(platformId()).map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="settings-row">
          <span>终端字体<span className="settings-desc">终端面板等宽字体，留空用默认</span></span>
          <span className="settings-inline">
            <input
              className="settings-input"
              value={fontDraft}
              placeholder="如 ui-monospace, Consolas"
              onChange={(e) => setFontDraft(e.target.value)}
            />
            <button
              className="primary"
              disabled={fontDraft.trim() === (settings.terminalFontFamily ?? '')}
              onClick={() => onSettingsChange({ terminalFontFamily: fontDraft.trim() })}
            >保存</button>
          </span>
        </div>
      </div>

      <h3>默认值（新会话继承）</h3>
      <div className="card flat">
        <div className="settings-row">
          <span>默认模型</span>
          <select value={defModel} onChange={(e) => setDefModel(e.target.value)}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.id}{m.source === 'custom' ? '（自定义）' : ''}</option>
            ))}
          </select>
        </div>
        <div className="settings-row">
          <span>默认权限模式</span>
          <select value={defMode} onChange={(e) => setDefMode(e.target.value)}>
            {MODES.map((m) => (<option key={m} value={m}>{m}</option>))}
          </select>
        </div>
        <div className="card-actions">
          <button className="primary" onClick={() => void save()}>保存</button>
          {msg && <span className="form-msg">{msg}</span>}
        </div>
      </div>

      <h3>配置作用域链</h3>
      <ConfigChainCard />

      <h3>运行状态</h3>
      <div className="card flat">
        <div className="settings-row"><span>模型接入</span><span>{isMock ? 'mock 模式（未配置 key）' : 'BIGMODEL / 自定义端点'}</span></div>
        <div className="settings-row"><span>配置文件</span><code>~/.bajin/config.json</code></div>
        <div className="settings-row"><span>会话存储</span><code>~/.bajin/sessions/</code></div>
        <div className="settings-row"><span>Rollout 日志</span><code>~/.bajin/rollout/</code></div>
        <div className="settings-row"><span>API Key</span><span>环境变量 BIGMODEL_API_KEY；供应商可在模型设置里单独配 Key</span></div>
      </div>
    </div>
  );
}

/** 网络代理卡（对标 ZCode httpProxy/noProxy/caCert；保存后 agent 子进程注入 HTTPS_PROXY，重启生效） */
/** 配置作用域链诊断卡（展示 settings 链实际发现的文件与环境覆盖层） */
function ConfigChainCard(): ReactNode {
  const [chain, setChain] = useState<{
    userFile: string; userExists: boolean;
    projectFiles: Array<{ file: string; depth: number }>;
    envKeys: string[]; hint: string;
  } | null>(null);
  useEffect(() => {
    void window.bajin.rpc<typeof chain>('config/chain').then(setChain).catch(() => setChain(null));
  }, []);
  if (!chain) return <div className="card flat"><div className="settings-row"><span>配置作用域链</span><span className="log-meta">读取失败</span></div></div>;
  return (
    <div className="card flat">
      <div className="settings-row">
        <span>用户级<span className="settings-desc">{chain.userFile}</span></span>
        <span className="log-meta">{chain.userExists ? '✓ 已加载' : '未创建'}</span>
      </div>
      {chain.projectFiles.length > 0 ? (
        chain.projectFiles.map((f) => (
          <div key={f.file} className="settings-row">
            <span>项目级<span className="settings-desc">{f.file}</span></span>
            <span className="log-meta">{f.depth === 0 ? '本级目录' : `上 ${f.depth} 级`}</span>
          </div>
        ))
      ) : (
        <div className="settings-row"><span>项目级<span className="settings-desc">未发现 bajin.json / .bajin/config.json</span></span><span className="log-meta">—</span></div>
      )}
      <div className="settings-row">
        <span>环境变量覆盖<span className="settings-desc">BAJIN_MODEL / BAJIN_MODE / BAJIN_BASE_URL / BAJIN_ALLOWED_TOOLS / BAJIN_DISALLOWED_TOOLS</span></span>
        <span className="log-meta">{chain.envKeys.length ? chain.envKeys.join(', ') : '无'}</span>
      </div>
      <div className="settings-row"><span className="log-meta">{chain.hint}（命令行旗标在 CLI 中最高）</span></div>
    </div>
  );
}

function ProxyCard({ settings, onSettingsChange }: {
  settings: UISettings;
  onSettingsChange: (patch: Partial<UISettings>) => void;
}): ReactNode {
  const proxy = settings.proxy ?? {};
  const [draft, setDraft] = useState({ httpProxy: proxy.httpProxy ?? '', noProxy: proxy.noProxy ?? '', caCertPath: proxy.caCertPath ?? '' });
  const dirty = draft.httpProxy.trim() !== (proxy.httpProxy ?? '') || draft.noProxy.trim() !== (proxy.noProxy ?? '') || draft.caCertPath.trim() !== (proxy.caCertPath ?? '');
  return (
    <div className="card flat">
      <div className="settings-row">
        <span>HTTP 代理<span className="settings-desc">如 http://127.0.0.1:7890，保存并重启后 agent 请求走代理</span></span>
        <input className="settings-input" value={draft.httpProxy} placeholder="http://host:port" onChange={(e) => setDraft({ ...draft, httpProxy: e.target.value })} />
      </div>
      <div className="settings-row">
        <span>代理排除列表<span className="settings-desc">逗号分隔的域名/主机，不走代理</span></span>
        <input className="settings-input" value={draft.noProxy} placeholder="localhost,*.internal" onChange={(e) => setDraft({ ...draft, noProxy: e.target.value })} />
      </div>
      <div className="settings-row">
        <span>CA 证书路径<span className="settings-desc">企业自签证书场景（记录配置）</span></span>
        <input className="settings-input" value={draft.caCertPath} placeholder="/path/to/ca.pem" onChange={(e) => setDraft({ ...draft, caCertPath: e.target.value })} />
      </div>
      <div className="card-actions">
        <button className="primary" disabled={!dirty} onClick={() => onSettingsChange({ proxy: { httpProxy: draft.httpProxy.trim(), noProxy: draft.noProxy.trim(), caCertPath: draft.caCertPath.trim() } })}>保存（重启后生效）</button>
      </div>
    </div>
  );
}

/** 数据目录卡（对标 ZCode dataBaseDir：迁移 sessions/rollout 到新目录，BAJIN_HOME 注入 agent） */
function DataDirCard(): ReactNode {
  const [dataDir, setDataDir] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { void window.bajin.dataDirGet().then(setDataDir).catch(() => setDataDir(null)); }, []);
  async function migrate(): Promise<void> {
    const dir = await window.bajin.pickDir();
    if (!dir) return;
    setMsg('迁移中…');
    const r = await window.bajin.dataMigrate(dir);
    if (r.ok) { setDataDir(dir); setMsg(`已迁移到 ${dir}（重启 bajin 后生效）`); }
    else setMsg(`迁移失败: ${r.error ?? '未知错误'}`);
  }
  return (
    <div className="card flat">
      <div className="settings-row">
        <span>数据目录<span className="settings-desc">会话与 rollout 日志的存储位置</span></span>
        <code>{dataDir ?? '~/.bajin（默认）'}</code>
      </div>
      <div className="card-actions">
        <button onClick={() => void migrate()}>迁移到其他目录…</button>
        {msg && <span className="form-msg">{msg}</span>}
      </div>
    </div>
  );
}

/** 开关控件（对标 ZCode 设置页 switch 行） */
/** 快捷键面板（对标 ZCode shortcut help：Ctrl+/ 弹出） */
const SHORTCUTS: Array<{ group: string; items: Array<[string, string]> }> = [
  { group: '全局', items: [
    ['Ctrl+N', '新建任务'], ['Ctrl+K', '搜索'], ['Ctrl+W', '关闭标签'],
    ['Ctrl+Shift+T', '恢复最近关闭标签'], ['Ctrl+F', '会话内搜索'],
    ['Ctrl+/', '快捷键面板'], ['Esc', '停止任务'],
  ]},
  { group: '输入', items: [
    ['Enter', '发送消息'], ['Shift+Enter', '换行'], ['/', '斜杠命令'],
    ['Ctrl+M', '语音输入开/停'], ['Ctrl+S', '编辑器保存（对比确认）'],
  ]},
  { group: '面板', items: [
    ['⌗', '终端'], ['▤', '状态面板'], ['Ctrl+E', '文件树'], ['Ctrl+G', 'Git 面板'],
    ['📈', '系统监控'],
  ]},
];

function ShortcutsPanel({ onClose }: { onClose: () => void }): ReactNode {
  return (
    <div className="ws-backdrop" onClick={onClose}>
      <div className="modal shortcuts-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>⌨ {t('快捷键')}</span>
          <button className="icon-btn" onClick={onClose}>×</button>
        </div>
        <div className="shortcuts-body">
          {SHORTCUTS.map((g) => (
            <div key={g.group} className="shortcuts-group">
              <div className="settings-nav-group-title">{t(g.group)}</div>
              {g.items.map(([key, desc]) => (
                <div key={key} className="shortcut-row">
                  <kbd>{key}</kbd>
                  <span>{t(desc)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 技术错误 → 用户可读中文（对标 ZCode 错误提示体验） */
function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) return '无法连接服务器。请确认 bajin server 正在运行（bajin server --port 4444）';
  if (msg.includes('ENOENT')) return '文件或目录不存在。请检查路径是否正确';
  if (msg.includes('EACCES') || msg.includes('permission denied')) return '没有权限执行此操作。请检查文件/目录权限';
  if (msg.includes('ETIMEDOUT') || msg.includes('timeout')) return '操作超时。请检查网络连接或稍后重试';
  if (msg.includes('401') || msg.includes('Unauthorized')) return 'API Key 无效或已过期。请到 设置→模型设置 检查 API Key';
  if (msg.includes('余额不足') || msg.includes('无可用资源包')) return '该 API Key 的账户余额不足或无资源包——请到供应商平台充值/领取资源包，或切换其他已配置模型';
  if (msg.includes('429') || msg.includes('rate limit')) return '请求频率过高。请稍后重试';
  if (msg.includes('402') || msg.includes('额度不足')) return '供应商 Token 额度不足——请充值或切换到其他已配置的模型/供应商';
  if (msg.includes('500') || msg.includes('Internal Server')) return '服务器内部错误。请稍后重试或重启 bajin';
  if (msg.includes('缺少 API') || msg.includes('API Key')) return '未配置 API Key。请到 设置→模型设置 配置';
  if (msg.includes('session 不存在') || msg.includes('会话不存在')) return '会话已关闭或不存在。请新建任务';
  if (msg.includes('app-server 已退出')) return '后端进程已退出。请重启 bajin';
  return msg; // 无法识别的错误原样返回
}

/** 上下文窗口指示器（对标 ZCode：进度条+颜色+压缩建议） */
function ContextIndicator({ usage }: { usage?: { tokens: number; maxTokens: number; percent: number; level: string; suggest: string | null } }): ReactNode {
  if (!usage) return null;
  const color = usage.level === 'danger' ? 'var(--err)' : usage.level === 'warn' ? 'var(--warn)' : 'var(--ok)';
  const label = usage.tokens > 1000 ? `${Math.round(usage.tokens / 1000)}k` : `${usage.tokens}`;
  return (
    <div className="ctx-indicator" title={`上下文用量：${usage.tokens} / ${usage.maxTokens} tokens (${usage.percent}%)`}>
      <div className="ctx-bar"><div className="ctx-fill" style={{ width: `${usage.percent}%`, background: color }} /></div>
      <span className="ctx-label" style={{ color }}>{label} / {Math.round(usage.maxTokens / 1000)}k</span>
      {usage.suggest && <span className="ctx-suggest" style={{ color: 'var(--warn)' }}>· {t(usage.suggest)}</span>}
    </div>
  );
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }): ReactNode {
  return (
    <button className={`switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)} role="switch" aria-checked={checked}>
      <span className="switch-knob" />
    </button>
  );
}

/* ---------- Agent 设置分区（对标 ZCode agentCapabilities：hooks 总开关 + 能力入口） ---------- */

interface HookGroup {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
}
interface HooksConfigShape {
  enabled?: boolean;
  timeoutMs?: number;
  events?: Record<string, HookGroup[]>;
}

const HOOK_EVENT_LABELS: Record<string, string> = {
  SessionStart: '会话启动',
  UserPromptSubmit: '用户提交消息',
  PreToolUse: '工具执行前',
  PostToolUse: '工具执行后',
  PostToolUseFailure: '工具执行失败',
  PermissionRequest: '权限请求',
  Stop: '任务停止',
};

/* ---------- Agent 能力分区（对标 ZCode agentCapabilities：8 个独立页一一对应） ---------- */

function AgentMemorySection(): ReactNode {
  return (
    <div className="vp-inner">
      <h2>记忆 <span className="log-meta">模型经 Memory 工具读写的长期偏好与事实</span></h2>
      <MemoryCard />
    </div>
  );
}

/** 插件市场（R5-8）：内置目录卡片 + 任意 git 仓库安装（clone → installPlugin） */
function PluginMarketplace({ onInstalled }: { onInstalled: () => void }): ReactNode {
  const [catalog, setCatalog] = useState<Array<{ name: string; desc: string; icon: string; repo: string; subdir: string }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [customRepo, setCustomRepo] = useState('');
  const [customName, setCustomName] = useState('');
  useEffect(() => {
    void window.bajin.rpc<{ catalog: typeof catalog }>('plugins/marketplace')
      .then((r) => setCatalog(r.catalog ?? []))
      .catch(() => setCatalog([]));
  }, []);
  async function install(item: { name: string; repo: string; subdir?: string }): Promise<void> {
    setBusy(item.name); setMsg('');
    try {
      await window.bajin.rpc('plugins/marketplace-install', { repo: item.repo, subdir: item.subdir, name: item.name });
      setMsg(`✓ ${item.name} 安装成功`);
      onInstalled();
    } catch (e) {
      setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
    setBusy(null);
  }
  return (
    <div className="card flat" style={{ marginBottom: 10 }}>
      <div className="settings-row" style={{ borderBottom: '1px solid var(--border)' }}>
        <span>🛒 {t('插件市场')}<span className="settings-desc">{t('从 git 仓库一键安装（clone 后落入 ~/.bajin/plugins/）')}</span></span>
      </div>
      {catalog.map((c) => (
        <div key={c.name} className="settings-row">
          <span>{c.icon} {c.name}<span className="settings-desc">{c.desc}</span></span>
          <button className="primary" disabled={busy !== null} onClick={() => void install(c)}>{busy === c.name ? '安装中…' : '安装'}</button>
        </div>
      ))}
      <div className="settings-row">
        <span>
          <input className="mkt-input" placeholder="git 仓库 https://..." value={customRepo} onChange={(e) => setCustomRepo(e.target.value)} />
          <input className="mkt-input" placeholder="插件名" value={customName} onChange={(e) => setCustomName(e.target.value)} />
        </span>
        <button disabled={busy !== null || !customRepo.trim() || !customName.trim()} onClick={() => void install({ name: customName.trim(), repo: customRepo.trim() })}>安装</button>
      </div>
      {msg && <div className="settings-row"><span className="log-meta">{msg}</span></div>}
    </div>
  );
}

function AgentPluginsSection(): ReactNode {
  const [plugins, setPlugins] = useState<Array<{ name: string; description: string; version: string; enabled: boolean; skills: string[]; commands: string[] }>>([]);
  const refresh = useCallback(() => {
    void window.bajin.rpc<{ plugins: typeof plugins }>('plugins/list').then((r) => setPlugins(r.plugins ?? [])).catch(() => setPlugins([]));
  }, []);
  useEffect(refresh, [refresh]);
  async function toggle(name: string, enabled: boolean): Promise<void> {
    await window.bajin.rpc('plugins/toggle', { name, enabled }).catch(() => undefined);
    refresh();
  }
  return (
    <div className="vp-inner">
      <h2>{t('插件')} <span className="log-meta">{plugins.length}</span></h2>
      <PluginMarketplace onInstalled={refresh} />
      <div className="card flat">
        {plugins.length === 0 ? (
          <div className="settings-row">
            <span>{t('暂无插件')}<span className="settings-desc">{t('把插件目录放到 ~/.bajin/plugins/ 下（含 plugin.json + skills/ 或 commands/），自动发现')}</span></span>
          </div>
        ) : (
          plugins.map((p) => (
            <div key={p.name} className="settings-row">
              <span>🧩 {p.name} <span className="log-meta">v{p.version}</span>
                <span className="settings-desc">{p.description}{p.skills.length > 0 ? ` · 技能: ${p.skills.join(', ')}` : ''}{p.commands.length > 0 ? ` · 命令: ${p.commands.join(', ')}` : ''}</span>
              </span>
              <Switch checked={p.enabled} onChange={(v) => void toggle(p.name, v)} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function AgentSubagentsSection(): ReactNode {
  return (
    <div className="vp-inner">
      <h2>子代理 <span className="log-meta">Subagents——独立上下文的子任务代理</span></h2>
      <div className="card flat">
        <div className="settings-row">
          <span>Explore<span className="settings-desc">只读调研代理（Read/Glob/Grep/Bash），返回结论不占主上下文</span></span>
          <span className="log-meta">内置</span>
        </div>
        <div className="settings-row">
          <span>general-purpose<span className="settings-desc">全能子任务代理（除子代理/计划工具外全部内置工具）</span></span>
          <span className="log-meta">内置</span>
        </div>
        <SubagentList />
      </div>
    </div>
  );
}

function AgentMcpSection(): ReactNode {
  return (
    <div className="vp-inner">
      <h2>MCP <span className="log-meta">Model Context Protocol 服务器</span></h2>
      <McpCard />
    </div>
  );
}

function AgentHooksSection(): ReactNode {
  return (
    <div className="vp-inner">
      <h2>钩子 <span className="log-meta">Hooks——会话/工具生命周期自定义命令</span></h2>
      <HooksCard />
    </div>
  );
}

/** 命令分区（对标 ZCode commands：自定义 slash 命令列表，发现自 ~/.bajin/commands 与项目 .bajin/commands） */
function AgentCommandsSection(): ReactNode {
  const [cmds, setCmds] = useState<Array<{ name: string; description?: string; source?: string }>>([]);
  useEffect(() => {
    void window.bajin.rpc<{ commands: Array<{ name: string; description?: string; source?: string }> }>('commands/list')
      .then((r) => setCmds(r.commands ?? []))
      .catch(() => setCmds([]));
  }, []);
  return (
    <div className="vp-inner">
      <h2>命令 <span className="log-meta">自定义 slash 命令（/name 触发）</span></h2>
      <div className="card flat">
        {cmds.length > 0 ? (
          cmds.map((c) => (
            <div key={c.name} className="settings-row">
              <span><code>/{c.name}</code><span className="settings-desc">{c.description ?? ''}</span></span>
              <span className="log-meta">{c.source === 'project' ? '项目级' : c.source === 'user' ? '用户级' : c.source ?? ''}</span>
            </div>
          ))
        ) : (
          <div className="settings-row">
            <span>暂无自定义命令<span className="settings-desc">在 ~/.bajin/commands/ 或项目 .bajin/commands/ 放 *.md（frontmatter: description，正文为提示词），会话输入 / 即可补全</span></span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Hooks 编辑卡：总开关 + 钩子表单（事件/matcher/命令/超时）增删，直写 config.json hooks 块 */
function HooksCard(): ReactNode {
  const [cfg, setCfg] = useState<HooksConfigShape | null>(null);
  const [form, setForm] = useState({ event: 'PreToolUse', matcher: '', command: '', timeout: '' });
  const [msg, setMsg] = useState('');

  const reload = useCallback(() => {
    void window.bajin.hooksGet<HooksConfigShape | null>().then(setCfg).catch(() => setCfg(null));
  }, []);
  useEffect(reload, [reload]);

  async function persist(next: HooksConfigShape): Promise<void> {
    setCfg(next);
    await window.bajin.hooksSave(next as unknown as Record<string, unknown>).catch(() => undefined);
  }

  async function toggle(v: boolean): Promise<void> {
    const next = { ...(cfg ?? {}), enabled: v };
    await persist(next);
  }

  async function addHook(): Promise<void> {
    if (!form.command.trim()) { setMsg('命令不能为空'); return; }
    const events = { ...(cfg?.events ?? {}) };
    const group: HookGroup = { matcher: form.matcher.trim() || undefined, hooks: [{ type: 'command', command: form.command.trim(), ...(form.timeout.trim() ? { timeout: Number(form.timeout) } : {}) }] };
    events[form.event] = [...(events[form.event] ?? []), group];
    await persist({ ...(cfg ?? {}), events });
    setForm({ event: 'PreToolUse', matcher: '', command: '', timeout: '' });
    setMsg('已添加（需 hooks 总开关开启才执行）');
  }

  async function removeHook(event: string, gi: number): Promise<void> {
    const events = { ...(cfg?.events ?? {}) };
    const groups = [...(events[event] ?? [])];
    groups.splice(gi, 1);
    if (groups.length) events[event] = groups;
    else delete events[event];
    await persist({ ...(cfg ?? {}), events });
  }

  const entries = Object.entries(cfg?.events ?? {});

  return (
    <div className="card flat">
      <div className="settings-row">
        <span>Hooks 钩子<span className="settings-desc">会话/工具生命周期的自定义命令，保存即写 ~/.bajin/config.json</span></span>
        <Switch checked={cfg?.enabled === true} onChange={(v) => void toggle(v)} />
      </div>

      {entries.length > 0 && (
        <div className="hooks-list">
          {entries.map(([event, groups]) =>
            (groups ?? []).map((g, gi) => (
              <div key={`${event}-${gi}`} className="hook-row">
                <span className="hook-event">{HOOK_EVENT_LABELS[event] ?? event}</span>
                <span className="hook-matcher">{g.matcher ? `/${g.matcher}/` : '所有'}</span>
                <code className="hook-cmd">{g.hooks?.map((h) => h.command).join(' && ') ?? ''}</code>
                <button className="ws-del" onClick={() => void removeHook(event, gi)}>删除</button>
              </div>
            )),
          )}
        </div>
      )}

      <div className="hook-form">
        <select value={form.event} onChange={(e) => setForm({ ...form, event: e.target.value })}>
          {Object.entries(HOOK_EVENT_LABELS).map(([id, label]) => (<option key={id} value={id}>{label}</option>))}
        </select>
        <input placeholder="matcher（如 Bash，留空匹配全部）" value={form.matcher} onChange={(e) => setForm({ ...form, matcher: e.target.value })} />
        <input placeholder="命令（如 echo $TOOL_NAME）*" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} />
        <input placeholder="超时秒（可选）" value={form.timeout} onChange={(e) => setForm({ ...form, timeout: e.target.value })} />
        <button className="primary" onClick={() => void addHook()}>添加</button>
        {msg && <span className="form-msg">{msg}</span>}
      </div>
    </div>
  );
}

/** MCP 服务器管理卡（对标 ZCode mcpServers：stdio/sse 配置 CRUD；agent 运行时接入下一批） */
interface McpEntry { type: 'stdio' | 'sse' | 'http'; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }
function McpCard(): ReactNode {
  const [servers, setServers] = useState<Record<string, McpEntry>>({});
  const [form, setForm] = useState<{ name: string; type: 'stdio' | 'sse' | 'http'; command: string; args: string; url: string }>({ name: '', type: 'stdio', command: '', args: '', url: '' });
  const [msg, setMsg] = useState('');

  const reload = useCallback(() => {
    void window.bajin.mcpGet<Record<string, McpEntry>>().then(setServers).catch(() => setServers({}));
  }, []);
  useEffect(reload, [reload]);

  async function saveServers(next: Record<string, McpEntry>): Promise<void> {
    setServers(next);
    await window.bajin.configPatch({ mcpServers: next }).catch(() => undefined);
  }

  async function add(): Promise<void> {
    const name = form.name.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) { setMsg('名称需匹配 ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$'); return; }
    if (form.type === 'stdio' && !form.command.trim()) { setMsg('stdio 需要 command'); return; }
    if ((form.type === 'sse' || form.type === 'http') && !form.url.trim()) { setMsg('需要 URL'); return; }
    const entry: McpEntry = form.type === 'stdio'
      ? { type: 'stdio', command: form.command.trim(), args: form.args.trim() ? form.args.trim().split(/\s+/) : undefined }
      : { type: form.type === 'http' ? 'http' : 'sse', url: form.url.trim() };
    await saveServers({ ...servers, [name]: entry });
    setForm({ name: '', type: 'stdio', command: '', args: '', url: '' });
    setMsg('已保存');
  }

  const entries = Object.entries(servers);
  return (
    <>
      <h3>MCP 服务器</h3>
      <div className="card flat">
        <div className="settings-row">
          <span>MCP 接入状态<span className="settings-desc">stdio 与 sse 均已接入：重启后 agent 连接并把工具以 mcp__server__tool 注入会话</span></span>
          <span className="log-meta">stdio + sse</span>
        </div>
        {entries.length > 0 && (
          <div className="hooks-list">
            {entries.map(([name, e]) => (
              <div key={name} className="hook-row">
                <span className="hook-event">{name}</span>
                <span className="hook-matcher">{e.type}</span>
                <code className="hook-cmd">{e.type === 'stdio' ? [e.command, ...(e.args ?? [])].join(' ') : e.url}</code>
                <button className="ws-del" onClick={() => { const next = { ...servers }; delete next[name]; void saveServers(next); }}>删除</button>
              </div>
            ))}
          </div>
        )}
        <div className="hook-form">
          <input placeholder="名称 *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as 'stdio' | 'sse' | 'http' })}>
            <option value="stdio">stdio</option>
            <option value="sse">sse</option>
            <option value="http">streamable http</option>
          </select>
          {form.type === 'stdio' ? (
            <>
              <input placeholder="command（如 npx）*" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} />
              <input placeholder="args（空格分隔）" value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} />
            </>
          ) : (
            <input placeholder="URL（sse 或 streamable http 端点）*" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          )}
          <button className="primary" onClick={() => void add()}>添加</button>
          {msg && <span className="form-msg">{msg}</span>}
        </div>
      </div>
    </>
  );
}

/** 自定义子代理列表（.bajin/agents/*.md，发现自用户级与项目级目录） */
function SubagentList(): ReactNode {
  const [defs, setDefs] = useState<Array<{ name: string; description: string; tools?: string[]; source: string }>>([]);
  useEffect(() => {
    void window.bajin.rpc<{ subagents: Array<{ name: string; description: string; tools?: string[]; source: string }> }>('subagents/list')
      .then((r) => setDefs(r.subagents ?? []))
      .catch(() => setDefs([]));
  }, []);
  return (
    <>
      {defs.map((d) => (
        <div key={d.name} className="settings-row">
          <span>{d.name}<span className="settings-desc">{d.description}{d.tools?.length ? ` · 工具：${d.tools.join('/')}` : ''}</span></span>
          <span className="log-meta">{d.source === 'project' ? '项目级' : '用户级'}</span>
        </div>
      ))}
      <div className="settings-row">
        <span>自定义子代理<span className="settings-desc">在 ~/.bajin/agents/ 或 项目 .bajin/agents/ 放 *.md（frontmatter: name/description/tools + 正文指引），重启后模型可通过 Agent 工具按名调用</span></span>
      </div>
    </>
  );
}

/** 记忆卡（对标 ZCode settings.memory：模型经 Memory 工具读写的长期记忆） */
function MemoryCard(): ReactNode {
  const [entries, setEntries] = useState<Array<{ at: string; text: string; scope: string }>>([]);
  const reload = useCallback(() => {
    void window.bajin.rpc<{ memories: Array<{ at: string; text: string; scope: string }> }>('memory/list')
      .then((r) => setEntries(r.memories ?? []))
      .catch(() => setEntries([]));
  }, []);
  useEffect(reload, [reload]);

  async function clear(scope: 'user' | 'project'): Promise<void> {
    if (!confirm(`确定清空${scope === 'user' ? '用户级' : '项目级'}记忆？`)) return;
    await window.bajin.rpc('memory/clear', { scope }).catch(() => undefined);
    reload();
  }

  return (
    <div className="card flat">
      <div className="settings-row">
        <span>长期记忆<span className="settings-desc">模型通过 Memory 工具自动记录的偏好与事实，随每次对话注入（用户级 ~/.bajin/memory/ + 项目级 .bajin/memory/）</span></span>
        <span className="log-meta">{entries.length} 条</span>
      </div>
      {entries.length > 0 && (
        <div className="hooks-list">
          {entries.map((e, i) => (
            <div key={i} className="hook-row">
              <span className="hook-event">{e.scope === 'user' ? '用户' : '项目'}</span>
              <span className="hook-matcher">{e.at}</span>
              <span className="hook-cmd">{e.text}</span>
            </div>
          ))}
        </div>
      )}
      {entries.length > 0 && (
        <div className="card-actions">
          <button onClick={() => void clear('user')}>清空用户级</button>
          <button onClick={() => void clear('project')}>清空项目级</button>
        </div>
      )}
    </div>
  );
}

/* ---------- 模型设置分区（对标 ZCode：卡片列表 + 弹窗式增改） ---------- */

/** 供应商目录预设（对标 ZCode「添加供应商」弹窗的目录页） */
/** 供应商取 Key 外链（对标 settings.modelProvider.getApiKey） */
const PROVIDER_KEY_URLS: Record<string, string> = {
  'https://open.bigmodel.cn/api/paas/v4': 'https://open.bigmodel.cn/usercenter/apikeys',
  'https://open.bigmodel.cn/api/anthropic': 'https://open.bigmodel.cn/usercenter/apikeys',
  'https://api.deepseek.com/v1': 'https://platform.deepseek.com/api_keys',
  'https://api.anthropic.com': 'https://console.anthropic.com/settings/keys',
  'anthropic': 'https://console.anthropic.com/settings/keys',
  'https://openrouter.ai/api/v1': 'https://openrouter.ai/keys',
  'https://api.moonshot.cn/v1': 'https://platform.moonshot.cn/console/api-keys',
  'https://dashscope.aliyuncs.com/compatible-mode/v1': 'https://bailian.console.aliyun.com/?apiKey=1',
};

const PROVIDER_CATALOG: Array<{ name: string; baseUrl: string; apiFormat: 'openai' | 'anthropic'; models: string[] }> = [
  { name: 'Ollama 本地', baseUrl: 'http://localhost:11434/v1', apiFormat: 'openai', models: ['llama3.2', 'qwen2.5', 'deepseek-r1'] },
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiFormat: 'openai', models: ['glm-4.7', 'glm-4.7-flash'] },
  { name: '智谱 GLM（Anthropic）', baseUrl: 'https://open.bigmodel.cn/api/anthropic', apiFormat: 'anthropic', models: ['glm-4.7', 'glm-4.7-flash'] },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiFormat: 'openai', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { name: 'Anthropic', baseUrl: 'https://api.anthropic.com', apiFormat: 'anthropic', models: ['claude-sonnet-4-5'] },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiFormat: 'openai', models: [] },
  { name: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', apiFormat: 'openai', models: ['moonshot-v1-128k'] },
  { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiFormat: 'openai', models: ['qwen-plus', 'qwen-max'] },
];

function ModelProviderSection({ models, providers, refreshModels, refreshProviders, onUse }: {
  models: ModelOpt[];
  providers: ProviderInfo[];
  refreshModels: () => void;
  refreshProviders: () => void;
  onUse: (id: string) => void;
}): ReactNode {
  const [modal, setModal] = useState<null | { editing?: ProviderInfo }>(null);
  const custom = models.filter((m) => m.source === 'custom');
  const orphans = custom.filter((m) => !m.provider);

  return (
    <div className="vp-inner">
      <div className="section-head">
        <div>
          <h2 style={{ margin: 0 }}>模型设置</h2>
          <div className="log-meta">管理自定义模型供应商，配置后可在聊天时选择使用。</div>
        </div>
        <button className="primary" onClick={() => setModal({})}>＋ 添加供应商</button>
      </div>

      <h3>自定义供应商</h3>
      {providers.length === 0 ? (
        <div className="history-empty">暂无自定义模型供应商</div>
      ) : (
        <div className="provider-cards">
          {providers.map((p) => {
            const ids = [...new Set([...(p.models ?? []), ...custom.filter((m) => m.provider === p.name).map((m) => m.id)])];
            return (
              <div key={p.name} className="provider-card">
                <div className="provider-card-main">
                  <div className="provider-name">{p.name}{p.apiKey ? ' 🔑' : ''}</div>
                  <div className="log-meta">{p.baseUrl ?? '默认端点'} · {p.apiFormat === 'anthropic' ? 'Anthropic' : 'OpenAI'} 格式 · {ids.length} 个模型</div>
                  <div className="model-chips">
                    {ids.map((id) => (
                      <button key={id} className="model-chip" onClick={() => onUse(id)}>{id}</button>
                    ))}
                  </div>
                </div>
                <div className="provider-card-actions">
                  <button onClick={() => setModal({ editing: p })}>编辑</button>
                  <button className="danger" onClick={() => { void window.bajin.rpc('providers/remove', { name: p.name }).then(() => refreshProviders()); }}>删除</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {orphans.length > 0 && (
        <>
          <h3>独立端点模型（旧数据）</h3>
          <div className="model-list">
            {orphans.map((m) => (
              <div key={m.id} className="model-row">
                <span className="model-id">{m.id}</span>
                <span className="model-base">{m.label ?? m.baseUrl ?? '默认端点'}</span>
                <button onClick={() => onUse(m.id)}>使用</button>
                <button className="danger" onClick={() => { void window.bajin.rpc('models/remove', { id: m.id }).then(() => refreshModels()); }}>删除</button>
              </div>
            ))}
          </div>
        </>
      )}

      {modal && (
        <ProviderModal
          editing={modal.editing}
          onClose={() => setModal(null)}
          onSaved={async (name) => {
            setModal(null);
            await window.bajin.rpc('providers/add', { name: `__refresh__${name}` }).catch(() => undefined);
            await window.bajin.rpc('providers/remove', { name: `__refresh__${name}` }).catch(() => undefined);
            refreshProviders();
            refreshModels();
          }}
        />
      )}
    </div>
  );
}

/** 添加/编辑供应商弹窗：供应商目录 | 自定义端点 两选一（对标 ZCode） */
function ProviderModal({ editing, onClose, onSaved }: {
  editing?: ProviderInfo;
  onClose: () => void;
  onSaved: (name: string) => void;
}): ReactNode {
  const [tab, setTab] = useState<'catalog' | 'custom'>(editing ? 'custom' : 'catalog');
  const [name, setName] = useState(editing?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? '');
  const [apiFormat, setApiFormat] = useState<'openai' | 'anthropic'>(editing?.apiFormat ?? 'openai');
  const [apiKey, setApiKey] = useState('');
  const [modelsText, setModelsText] = useState((editing?.models ?? []).join('\n'));
  const [msg, setMsg] = useState('');

  async function save(preset?: { name: string; baseUrl: string; apiFormat: 'openai' | 'anthropic'; models: string[] }): Promise<void> {
    const n = (preset?.name ?? name).trim();
    if (!n) { setMsg('名称必填'); return; }
    try {
      await window.bajin.rpc('providers/add', {
        name: n,
        ...(preset ? { baseUrl: preset.baseUrl } : baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        apiFormat: preset?.apiFormat ?? apiFormat,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        models: preset?.models ?? modelsText.split('\n').map((s) => s.trim()).filter(Boolean),
      });
      onSaved(n);
    } catch (err) {
      setMsg(`保存失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{editing ? '编辑供应商' : '添加模型供应商'}</span>
          <button className="icon-btn" onClick={onClose}>×</button>
        </div>
        {!editing && (
          <div className="modal-tabs">
            <button className={tab === 'catalog' ? 'on' : ''} onClick={() => setTab('catalog')}>供应商目录</button>
            <button className={tab === 'custom' ? 'on' : ''} onClick={() => setTab('custom')}>自定义端点</button>
          </div>
        )}
        {tab === 'catalog' && !editing ? (
          <div className="modal-body catalog-list">
            {PROVIDER_CATALOG.map((p) => (
              <div key={p.name} className="catalog-item" onClick={() => void save(p)}>
                <span className="provider-name">{p.name} <span className="log-meta">{p.apiFormat === 'anthropic' ? 'Anthropic 格式' : 'OpenAI 格式'}</span></span>
                <span className="log-meta">{p.baseUrl}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="modal-body">
            <label className="field">名称 *
              <input value={name} placeholder="如：智谱 GLM" onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">Base URL
              <input value={baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => setBaseUrl(e.target.value)} />
            </label>
            <label className="field">API 格式（两种接入端点，协议不同）
              <select value={apiFormat} onChange={(e) => setApiFormat(e.target.value === 'anthropic' ? 'anthropic' : 'openai')}>
                <option value="openai">OpenAI 格式（/chat/completions）</option>
                <option value="anthropic">Anthropic 格式（/messages）</option>
              </select>
            </label>
            <label className="field">API Key{editing?.apiKey ? '（已配置，留空保持不变）' : ''}
              <input value={apiKey} type="password" placeholder="sk-..." onChange={(e) => setApiKey(e.target.value)} />
            </label>
            {(() => {
              const keyUrl = PROVIDER_KEY_URLS[baseUrl.trim()] ?? (apiFormat === 'anthropic' ? PROVIDER_KEY_URLS['anthropic'] : undefined);
              return keyUrl ? (
                <div className="field-hint">
                  还没有 Key？<a href="#" onClick={(e) => { e.preventDefault(); void window.open(keyUrl, '_blank'); }}>获取 API Key ↗</a>
                </div>
              ) : null;
            })()}
            <label className="field">模型列表（每行一个）
              <textarea className="ta" rows={4} value={modelsText} placeholder={'glm-4.7\nglm-4.7-flash'} onChange={(e) => setModelsText(e.target.value)} />
            </label>
          </div>
        )}
        <div className="modal-foot">
          {msg && <span className="form-msg">{msg}</span>}
          <span className="spacer" />
          <button onClick={onClose}>取消</button>
          {!(tab === 'catalog' && !editing) && <button className="primary" onClick={() => void save()}>保存</button>}
        </div>
      </div>
    </div>
  );
}

/* ---------- 日志视图 ---------- */

interface LogFile {
  name: string;
  size: number;
  modifiedAt: number;
  kind: string;
}

function LogsView(): ReactNode {
  const [files, setFiles] = useState<LogFile[]>([]);
  const [tail, setTail] = useState<{ name: string; tail: string; totalLines: number } | null>(null);

  const refresh = useCallback(() => {
    void window.bajin.rpc<{ files: LogFile[] }>('logs/list').then((r) => setFiles(r.files ?? [])).catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function open(name: string): Promise<void> {
    const r = await window.bajin.rpc<{ name: string; tail: string; totalLines: number }>('logs/read', { name });
    setTail(r);
  }

  return (
    <div className="vp-inner">
      <h2>Rollout 日志（模型 IO 全量记录） <button className="mini" onClick={refresh}>⟳ 刷新</button></h2>
      <div className="logs-list">
        {files.map((f) => (
          <div key={f.name} className={`log-row ${tail?.name === f.name ? 'on' : ''}`} onClick={() => void open(f.name)}>
            <span className="log-name">{f.name}</span>
            <span className="log-meta">{(f.size / 1024).toFixed(1)} KB · {new Date(f.modifiedAt).toLocaleString()}</span>
          </div>
        ))}
        {!files.length && <div className="history-empty">暂无日志（发送过消息后生成）</div>}
      </div>
      {tail && (
        <>
          <h3>{tail.name}（尾部 {tail.tail.split('\n').length} 行 / 共 {tail.totalLines} 行）</h3>
          <pre className="log-tail">{tail.tail}</pre>
        </>
      )}
    </div>
  );
}

/* ---------- 使用统计视图（对标 ZCode「使用统计」） ---------- */

interface UsageStats {
  range: 'all' | '7d' | '30d';
  totalTokens: number;
  sessions: number;
  messages: number;
  activeDays: number;
  favoriteModel: string;
  favoriteModelShare: number;
  longestSession: number;
  currentStreak: number;
  longestStreak: number;
  peakHour: number;
  peakHourTokens: number;
  estimationHint: string;
  days: Array<{ date: string; tokens: number }>;
  models: Array<{ model: string; tokens: number; share: number }>;
}

function UsageView(): ReactNode {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [range, setRange] = useState<'all' | '7d' | '30d'>('all');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (r: 'all' | '7d' | '30d') => {
    setLoading(true);
    try {
      const res = await window.bajin.rpc<UsageStats>('usage/stats', { range: r });
      setStats(res);
    } catch {
      /* 忽略 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(range); }, [range, load]);

  if (loading && !stats) {
    return (
      <div className="vp-inner">
        <h2>使用统计</h2>
        <div className="history-empty">正在统计中…</div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="vp-inner">
        <h2>使用统计</h2>
        <div className="history-empty">暂无数据（发送过消息后生成）</div>
      </div>
    );
  }

  const maxDayTokens = Math.max(1, ...stats.days.map((d) => d.tokens));

  return (
    <div className="vp-inner">
      <h2>使用统计 <span className="log-meta">来自本地会话历史</span></h2>

      {/* 时间范围 */}
      <div className="usage-range">
        {([['all', '全部时间'], ['7d', '最近 7 天'], ['30d', '最近 30 天']] as const).map(([k, label]) => (
          <button key={k} className={range === k ? 'primary' : ''} onClick={() => setRange(k)}>{label}</button>
        ))}
      </div>

      {/* 核心指标 */}
      <div className="usage-grid">
        <StatCard label="Tokens 用量" value={fmtTokens(stats.totalTokens)} hint={stats.estimationHint} />
        <StatCard label="会话数量" value={String(stats.sessions)} hint={`最长会话 ${fmtTokens(stats.longestSession)}`} />
        <StatCard label="消息数量" value={String(stats.messages)} hint={`工具调用 ${stats.messages > 0 ? '已计入' : '—'}`} />
        <StatCard label="活跃天数" value={`${stats.activeDays} 天`} hint={`最长连续 ${stats.longestStreak} 天`} />
        <StatCard label="最常用模型" value={stats.favoriteModel} hint={`占比 ${stats.favoriteModelShare}%`} />
        <StatCard label="当前连续" value={`${stats.currentStreak} 天`} hint={`峰值时段 ${formatHour(stats.peakHour)}`} />
      </div>

      {/* 按天 Token 趋势 */}
      {stats.days.length > 0 && (
        <>
          <h3>按天 Token 趋势</h3>
          <div className="usage-barchart">
            {stats.days.slice(-30).map((d) => (
              <div key={d.date} className="bar-col" title={`${d.date}：${fmtTokens(d.tokens)}`}>
                <div className="bar" style={{ height: `${Math.max(2, (d.tokens / maxDayTokens) * 100)}%` }} />
                <span className="bar-label">{d.date.slice(5)}</span>
              </div>
            ))}
          </div>
          <div className="log-meta">共 {stats.days.length} 天</div>
        </>
      )}

      {/* 模型用量分布 */}
      {stats.models.length > 0 && (
        <>
          <h3>模型用量</h3>
          <div className="usage-models">
            {stats.models.map((m) => (
              <div key={m.model} className="usage-model-row">
                <span className="model-id">{m.model}</span>
                <div className="usage-bar-track">
                  <div className="usage-bar" style={{ width: `${m.share}%` }} />
                </div>
                <span className="log-meta">{m.share}% · {fmtTokens(m.tokens)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* 活跃热力图（近 12 周） */}
      {stats.days.length > 0 && (
        <>
          <h3>活跃热力图</h3>
          <Heatmap days={stats.days} />
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint: string }): ReactNode {
  return (
    <div className="usage-stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-hint">{hint}</div>
    </div>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatHour(h: number): string {
  return `${String(h).padStart(2, '0')}:00`;
}

type DayStat = { date: string; tokens: number };

/** 简化版 GitHub 风格热力图 */
function Heatmap({ days }: { days: DayStat[] }): ReactNode {
  const maxTokens = Math.max(1, ...days.map((d) => d.tokens));
  // 聚合到周（列）× 周日（行）
  const map = new Map<string, number>();
  for (const d of days) map.set(d.date, d.tokens);
  const today = new Date();
  const cols: Array<Array<{ date: string; level: number }>> = [];
  // 倒推 84 天 = 12 周
  for (let col = 11; col >= 0; col--) {
    const week: Array<{ date: string; level: number }> = [];
    for (let dow = 6; dow >= 0; dow--) {
      const d = new Date(today);
      d.setDate(d.getDate() - (col * 7 + dow));
      const key = d.toISOString().slice(0, 10);
      const t = map.get(key) ?? 0;
      week.push({ date: key, level: t === 0 ? 0 : Math.min(4, Math.ceil((t / maxTokens) * 4)) });
    }
    cols.push(week);
  }
  const DOW_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
  return (
    <div className="heatmap">
      {cols.map((week, ci) => (
        <div key={ci} className="heatmap-col">
          {week.map((cell, ri) => (
            <div
              key={ri}
              className={`heatmap-cell level-${cell.level}`}
              title={cell.date ? `${cell.date}：${map.get(cell.date) ?? 0} tokens` : ''}
            >
              {ri === 0 && <span className="heatmap-dow">{DOW_LABELS[6 - ri]}</span>}
            </div>
          ))}
        </div>
      ))}
      <div className="heatmap-legend">
        <span>较少</span>
        {[0, 1, 2, 3, 4].map((l) => (<span key={l} className={`heatmap-cell level-${l}`} />))}
        <span>较多</span>
      </div>
    </div>
  );
}

/* ---------- 帮助视图 ---------- */

function HelpView(): ReactNode {
  return (
    <div className="vp-inner">
      <h2>帮助</h2>
      <div className="card flat">
        <div className="card-title">快捷键</div>
        <div className="settings-row"><span>发送</span><code>Ctrl/Cmd + Enter</code></div>
        <div className="settings-row"><span>斜杠命令补全</span><code>输入 / 后 Tab</code></div>
      </div>
      <div className="card flat">
        <div className="card-title">命令</div>
        {SLASH_COMMANDS.map((c) => (
          <div key={c.cmd} className="settings-row"><code>{c.cmd}</code><span>{c.desc}</span></div>
        ))}
      </div>
      <div className="card flat">
        <div className="card-title">权限模式</div>
        <div className="settings-row"><span>plan</span><span>只读调研，产出计划（ExitPlanMode 提交审批）</span></div>
        <div className="settings-row"><span>build</span><span>默认；写文件/Bash 需逐次批准（可「始终允许」）</span></div>
        <div className="settings-row"><span>edit</span><span>文件读写放行，Bash 仍需批准</span></div>
        <div className="settings-row"><span>yolo</span><span>全自动放行</span></div>
      </div>
      <div className="card flat">
        <div className="card-title">关于</div>
        <div className="settings-row"><span>bajin</span><span>v0.1.0 · 净室复刻自研 · agent 内核 + Electron 壳分离架构</span></div>
      </div>
    </div>
  );
}

/* ---------- 搜索视图 ---------- */

/** 搜索结果高亮：按关键词（大小写不敏感）切分，匹配段包 <mark> */
function HighlightText({ text, q }: { text: string; q: string }): ReactNode {
  if (!q.trim()) return <>{text}</>;
  const parts = text.split(new RegExp(`(${q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return (
    <>
      {parts.map((seg, i) => (i % 2 === 1 ? <mark key={i} className="hit">{seg}</mark> : <span key={i}>{seg}</span>))}
    </>
  );
}

function SearchView({ onOpen }: { onOpen: (sessionId: string) => void }): ReactNode {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Array<{ sessionId: string; title: string; snippet: string; matches: number }>>([]);
  const [searched, setSearched] = useState(false);

  async function run(): Promise<void> {
    if (!query.trim()) return;
    const r = await window.bajin.rpc<{ results: typeof results }>('search/sessions', { query: query.trim() });
    setResults(r.results ?? []);
    setSearched(true);
  }

  return (
    <div className="vp-inner">
      <h2>搜索任务（跨全部会话内容）</h2>
      <div className="search-bar">
        <input
          value={query}
          placeholder="搜任务标题或对话内容…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void run()}
        />
        <button className="primary" onClick={() => void run()}>搜索</button>
      </div>
      {searched && !results.length && <div className="history-empty">无匹配</div>}
      <div className="logs-list">
        {results.map((r) => (
          <div key={r.sessionId} className="log-row" onClick={() => onOpen(r.sessionId)}>
            <div className="search-hit">
              <div className="log-name"><HighlightText text={r.title || r.sessionId.slice(0, 16)} q={query} /> <span className="log-meta">· {r.matches} 处匹配</span></div>
              {r.snippet && <div className="search-snippet"><HighlightText text={r.snippet} q={query} /></div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- 自动化（列表 + 弹窗创建，应用运行期间每分钟调度） ---------- */

interface AutomationInfo {
  id: string;
  title: string;
  cron: string;
  prompt: string;
  enabled: boolean;
  nextRunAt?: number;
  lastRunAt?: number;
  sessionId?: string;
  oneShot?: boolean;
}

function AutomationsView({ onOpenSession }: { onOpenSession: (sid: string) => void }): ReactNode {
  const [list, setList] = useState<AutomationInfo[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = useCallback(() => {
    void window.bajin.rpc<{ automations: AutomationInfo[] }>('automations/list').then((r) => setList(r.automations ?? [])).catch(() => undefined);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="vp-inner">
      <div className="section-head">
        <div>
          <h2 style={{ margin: 0 }}>自动化</h2>
          <div className="log-meta">按计划运行任务，或在需要时随时执行。</div>
        </div>
        <button className="primary" onClick={() => setShowCreate(true)}>＋ 创建定时任务</button>
      </div>

      {list.length === 0 ? (
        <div className="history-empty">暂无自动化</div>
      ) : (
        <div className="automation-cards">
          {list.map((a) => (
            <div key={a.id} className={`automation-card ${a.enabled ? '' : 'disabled'}`}>
              <div className="automation-card-head">
                <span className="automation-icon">{a.oneShot ? '⚡' : '⏰'}</span>
                <span className="automation-title">{a.title}</span>
                <span className={`automation-cron ${a.enabled ? '' : 'off'}`}>{a.oneShot ? '一次性' : a.cron}</span>
              </div>
              <div className="automation-meta">
                {a.enabled
                  ? `下次 ${a.nextRunAt ? new Date(a.nextRunAt).toLocaleString() : '—'}`
                  : t('已暂停')}
                {a.lastRunAt ? ` · 上次 ${formatTaskTime(a.lastRunAt)}前` : ''}
              </div>
              <div className="automation-prompt">{a.prompt.slice(0, 120)}</div>
              <div className="automation-actions">
                {a.sessionId && <button onClick={() => onOpenSession(a.sessionId!)}>{t('查看会话')}</button>}
                <button onClick={() => { void window.bajin.rpc('automations/toggle', { id: a.id, enabled: !a.enabled }).then(() => refresh()); }}>
                  {a.enabled ? t('暂停') : t('启用')}
                </button>
                <button className="danger" onClick={() => { void window.bajin.rpc('automations/remove', { id: a.id }).then(() => refresh()); }}>{t('删除')}</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreate && (
        <AutomationModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); refresh(); }}
        />
      )}
    </div>
  );
}

function AutomationModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }): ReactNode {
  const [title, setTitle] = useState('');
  const [cron, setCron] = useState('0 9 * * *');
  const [prompt, setPrompt] = useState('');
  const [msg, setMsg] = useState('');

  async function create(): Promise<void> {
    if (!title.trim() || !prompt.trim()) { setMsg('标题和任务指令必填'); return; }
    try {
      await window.bajin.rpc('automations/create', { title: title.trim(), cron: cron.trim(), prompt: prompt.trim() });
      onCreated();
    } catch (err) {
      setMsg(`创建失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><span>创建定时任务</span><button className="icon-btn" onClick={onClose}>×</button></div>
        <div className="modal-body">
          <label className="field">标题 *<input value={title} placeholder="每天早报" onChange={(e) => setTitle(e.target.value)} /></label>
          <label className="field">计划（cron：分 时 日 月 周）<input value={cron} placeholder="0 9 * * *" onChange={(e) => setCron(e.target.value)} /></label>
          <label className="field">任务指令 *（到点发给 agent 的完整 prompt）
            <textarea className="ta" rows={4} value={prompt} placeholder="查看 ~/project 有无新提交，汇总成 3 条要点" onChange={(e) => setPrompt(e.target.value)} />
          </label>
        </div>
        <div className="modal-foot">
          {msg && <span className="form-msg">{msg}</span>}
          <span className="spacer" />
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={() => void create()}>创建</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- 技能（列表 + 弹窗创建） ---------- */

interface SkillInfo {
  name: string;
  description: string;
  source: 'project' | 'user';
}

function SkillsView(): ReactNode {
  const [skills, setSkills] = useState<Array<SkillInfo & { enabled?: boolean; file?: string }>>([]);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [content, setContent] = useState<{ name: string; content: string } | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = useCallback(() => {
    void window.bajin.rpc<{ skills: Array<SkillInfo & { enabled?: boolean; file?: string }> }>('skills/list')
      .then((r) => setSkills(r.skills ?? []))
      .catch(() => undefined);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const q = query.trim().toLowerCase();
  const filtered = q ? skills.filter((x) => x.name.toLowerCase().includes(q) || x.description.toLowerCase().includes(q)) : skills;
  const custom = filtered.filter((x) => !BUILTIN_SKILL_NAMES.has(x.name));
  const builtin = filtered.filter((x) => BUILTIN_SKILL_NAMES.has(x.name));
  const groups: Array<{ label: string; items: typeof filtered }> = [
    { label: LANG === 'en-US' ? 'Custom skills' : '自定义技能', items: custom },
    { label: LANG === 'en-US' ? 'Built-in skills' : '内置技能', items: builtin },
  ];

  async function toggle(name: string, enabled: boolean): Promise<void> {
    await window.bajin.rpc('skills/toggle', { name, enabled }).catch(() => undefined);
    refresh();
  }

  return (
    <div className="vp-inner">
      <div className="section-head">
        <div>
          <h2 style={{ margin: 0 }}>{t('技能')} <span className="log-meta">{skills.length}</span></h2>
          <div className="log-meta">{t('SKILL.md 操作指南，agent 按需自动加载；禁用后模型不可见')}</div>
        </div>
        <button className="primary" onClick={() => setShowCreate(true)}>＋ {t('新建技能')}</button>
      </div>

      <div className="mp-search skills-search">
        <input autoFocus value={query} placeholder={t('搜索技能…')} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {filtered.length === 0 ? (
        <div className="history-empty">{t('暂无技能（在 .bajin/skills 或 ~/.bajin/skills 放 SKILL.md）')}</div>
      ) : (
        groups.map((g) => (
          <div key={g.label} className="skill-group">
            <div className="settings-nav-group-title">{g.label} · {g.items.length}</div>
            {g.items.length === 0 && (
              <div className="history-empty" style={{ padding: '8px 4px' }}>
                {g.label === t('自定义技能')
                  ? t('还没有自定义技能：点右上「＋ 新建技能」，或在 ~/.bajin/skills/<名称>/SKILL.md 手写')
                  : (q ? t('没有匹配的技能') : '')}
              </div>
            )}
            <div className="provider-cards">
              {g.items.map((sk) => (
                <div key={sk.name} className={`provider-card skill-card ${expanded === sk.name ? 'expanded' : ''}`}>
                  <div className="provider-card-main" onClick={() => setExpanded((v) => (v === sk.name ? null : sk.name))}>
                    <div className="provider-name">
                      🛠 {sk.name}
                      <span className={`skill-src ${sk.source}`}>{sk.source === 'project' ? t('项目级') : t('用户级')}</span>
                    </div>
                    <div className="model-base">{sk.description}</div>
                  </div>
                  <div className="provider-card-actions">
                    <Switch checked={sk.enabled !== false} onChange={(v) => void toggle(sk.name, v)} />
                  </div>
                  {expanded === sk.name && (
                    <div className="skill-detail">
                      <div className="settings-row">
                        <span>{t('状态')}</span>
                        <span className="log-meta">{sk.enabled !== false ? t('已启用') : t('已禁用')}</span>
                      </div>
                      <div className="settings-row">
                        <span>{t('作用域')}</span>
                        <span className="log-meta">{sk.source === 'project' ? t('项目级') : t('用户级')}</span>
                      </div>
                      <div className="settings-row">
                        <span>{t('路径')}</span>
                        <code className="skill-path">{sk.file ?? ''}</code>
                      </div>
                      <div className="card-actions">
                        <button onClick={() => { void window.bajin.rpc<{ name: string; content: string }>('skills/read', { name: sk.name }).then(setContent); }}>{t('查看正文')}</button>
                        <button onClick={() => { void window.bajin.revealPath(sk.file ?? ''); }}>{t('在文件管理器中打开')}</button>
                        {BUILTIN_SKILL_NAMES.has(sk.name) && <span className="log-meta">{t('内置技能：删除后重启可恢复')}</span>}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      {content && (
        <div className="modal-overlay" onClick={() => setContent(null)}>
          <div className="modal skill-content-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>🛠 {content.name} · SKILL.md</span>
              <button className="icon-btn" onClick={() => setContent(null)}>×</button>
            </div>
            <pre className="skill-content-body">{content.content}</pre>
          </div>
        </div>
      )}

      {showCreate && (
        <SkillModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); refresh(); }}
        />
      )}
    </div>
  );
}

function SkillModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }): ReactNode {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [msg, setMsg] = useState('');

  async function create(): Promise<void> {
    try {
      await window.bajin.rpc('skills/create', { name: name.trim(), ...(desc.trim() ? { description: desc.trim() } : {}) });
      onCreated();
    } catch (err) {
      setMsg(`创建失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><span>新建技能</span><button className="icon-btn" onClick={onClose}>×</button></div>
        <div className="modal-body">
          <label className="field">技能名 *（小写/数字/._-）<input value={name} placeholder="my-skill" onChange={(e) => setName(e.target.value)} /></label>
          <label className="field">一句话描述<input value={desc} placeholder="何时用这个技能" onChange={(e) => setDesc(e.target.value)} /></label>
        </div>
        <div className="modal-foot">
          {msg && <span className="form-msg">{msg}</span>}
          <span className="spacer" />
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={() => void create()}>创建</button>
        </div>
      </div>
    </div>
  );
}


/* ---------- 知识图谱视图（排期中，如实标注） ---------- */

function KnowledgeView(): ReactNode {
  return (
    <div className="vp-inner">
      <h2>知识图谱</h2>
      <div className="card flat">
        <div className="card-title"> repo 知识库（对标 ZCode 的 repo-wiki / 知识图谱）</div>
        <div className="settings-row"><span>状态</span><span>排期中（见 bajin/GAP-TRACKER.md P1）</span></div>
        <div className="settings-row"><span>规划</span><span>为项目目录构建可检索的知识索引（AST 符号 + 文档摘要），agent 用子代理检索而非全库 grep；回答带出处 file:line</span></div>
        <div className="settings-row"><span>当前替代</span><span>agent 已可用 Explore 子代理 + Glob/Grep 做项目调研</span></div>
      </div>
    </div>
  );
}

/** 多选提问卡（对标 ZCode multiSelect）：复选 + 确认，答案以「、」拼接 */
function AskMultiCard({ options, onSubmit }: {
  options: Array<{ label: string; description?: string }>;
  onSubmit: (answer: string) => void;
}): ReactNode {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  function toggle(i: number): void {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }
  return (
    <div className="ask-multi">
      {options.map((o, i) => (
        <button key={i} className={`ask-option multi ${picked.has(i) ? 'picked' : ''}`} onClick={() => toggle(i)}>
          <span className="ask-check">{picked.has(i) ? '☑' : '☐'}</span>
          {o.label}
          {o.description ? <span className="ask-desc"> — {o.description}</span> : null}
        </button>
      ))}
      <div className="card-actions">
        <button className="primary" disabled={picked.size === 0} onClick={() => onSubmit([...picked].sort((a, b) => a - b).map((i) => options[i]!.label).join('、'))}>
          确认{picked.size > 0 ? `（已选 ${picked.size} 项）` : ''}
        </button>
      </div>
    </div>
  );
}

function AskInput({ onSubmit, placeholder }: { onSubmit: (v: string) => void; placeholder: string }): ReactNode {
  const [v, setV] = useState('');
  return (
    <div className="ask-input-row">
      <input value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && v.trim() && onSubmit(v.trim())} />
      <button disabled={!v.trim()} onClick={() => v.trim() && onSubmit(v.trim())}>提交</button>
    </div>
  );
}

/**
 * 渲染层错误边界（R5 稳定性防线）：任何组件崩溃不再整页白屏。
 * 顶栏级骨架保留 + 错误卡片（摘要 + 完整栈可展开）+「重载界面」。
 * 此前 BrowserPanel 的 webview loadURL 崩溃若有此防线，最多丢一块面板。
 */
class ErrorBoundary extends ReactComponent<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[bajin] 渲染层崩溃:', error, info.componentStack ?? '');
  }
  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const e = this.state.error;
    return (
      <div className="crash-screen">
        <div className="crash-card">
          <div className="crash-title">⚠ 界面渲染出错</div>
          <div className="crash-text">{e.message || String(e)}</div>
          <details className="crash-stack">
            <summary>错误详情</summary>
            <pre>{e.stack ?? String(e)}</pre>
          </details>
          <div className="card-actions">
            <button className="primary" onClick={() => window.location.reload()}>重载界面</button>
            <button onClick={() => this.setState({ error: null })}>尝试恢复</button>
          </div>
          <div className="crash-meta">bajin 0.1.0 · 会话数据不受影响（已实时持久化）</div>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
