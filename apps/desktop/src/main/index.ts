import { app, BrowserWindow, ipcMain, dialog, Notification, shell } from 'electron';
import * as path from 'node:path';
import * as os from 'node:os';
import { readFileSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { AppServerClient } from './app-server-client';

/**
 * bajin 桌面端主进程 = 窗口壳 + agent 子进程管理（对标 ZCode 的分层：
 * Electron 主进程只做系统集成，agent 能力全部在独立 CLI 子进程里）。
 * UI 与 agent 的所有交互走通用 RPC 透传，协议见 packages/cli/src/app-server.ts。
 */

interface UserConfig {
  model?: string;
  mode?: string;
  bigmodel?: { apiKey?: string; baseUrl?: string };
  providers?: Array<{ apiKey?: string; models?: string[] }>;
  remotes?: Array<{ name: string; host: string; port?: number; user?: string; path: string }>;
  /** 界面设置（对标 ZCode settings.general，全部真实生效） */
  settings?: {
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
    /** 网络代理（spawn agent 时注入 HTTPS_PROXY 等环境变量，Node24 NODE_USE_ENV_PROXY 生效） */
    proxy?: { httpProxy?: string; noProxy?: string; caCertPath?: string };
  };
  hooks?: { enabled?: boolean; timeoutMs?: number; events?: Record<string, unknown> };
  /** MCP 服务器配置（对标 ZCode mcpServers；运行时接入下一批） */
  mcpServers?: Record<string, { type: 'stdio' | 'sse'; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }>;
  /** 数据目录（会话/rollout 存储；缺省 ~/.bajin，spawn 时以 BAJIN_HOME 注入） */
  dataDir?: string;
}

/** GUI 启动不继承 shell 环境变量，key 等配置从 ~/.bajin/config.json 读取 */
function loadUserConfig(): UserConfig {
  try {
    return JSON.parse(readFileSync(path.join(os.homedir(), '.bajin', 'config.json'), 'utf8')) as UserConfig;
  } catch {
    return {};
  }
}

function writeUserConfig(uc: UserConfig): void {
  const file = path.join(os.homedir(), '.bajin', 'config.json');
  writeFileSync(file, `${JSON.stringify(uc, null, 2)}\n`, 'utf8');
}

let win: BrowserWindow | null = null;
let client: AppServerClient | null = null;

function resolveAgentEntry(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bajin', 'bajin.cjs');
  }
  return path.resolve(app.getAppPath(), '..', '..', 'packages', 'cli', 'dist', 'bundle', 'bajin.cjs');
}

function forwardEvent(event: string, params: unknown): void {
  win?.webContents.send('bajin:event', { event, params });
}

function createWindow(): void {
  win = new BrowserWindow({
    titleBarStyle: 'hidden', // 对标 ZCode：隐藏原生标题栏（顶部白条），由渲染层 topbar 承担
    titleBarOverlay: { color: '#1d1f24', symbolColor: '#9aa0aa' }, // 系统窗口按钮 overlay 融入深色主题（去白底）
    autoHideMenuBar: true, // 对标 ZCode：隐藏系统菜单栏（File/Edit/View），Alt 可唤出
    width: 1180,
    height: 800,
    minWidth: 820,
    minHeight: 520,
    title: 'bajin',
    backgroundColor: '#18191d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.on('closed', () => {
    win = null;
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

/** agent 子进程环境变量：数据目录（BAJIN_HOME）与网络代理（Node24 NODE_USE_ENV_PROXY） */
function agentExtraEnv(): Record<string, string> {
  const uc = loadUserConfig();
  const env: Record<string, string> = {};
  if (uc.dataDir && uc.dataDir.startsWith('/')) env['BAJIN_HOME'] = uc.dataDir;
  const proxy = uc.settings?.proxy?.httpProxy?.trim();
  if (proxy) {
    env['HTTPS_PROXY'] = proxy;
    env['HTTP_PROXY'] = proxy;
    env['NODE_USE_ENV_PROXY'] = '1';
    const noProxy = uc.settings?.proxy?.noProxy?.trim();
    if (noProxy) env['NO_PROXY'] = noProxy;
  }
  return env;
}

function startAgent(): void {
  const entry = resolveAgentEntry();
  client = new AppServerClient(process.execPath, [entry, 'app-server', '--stdio']);
  client.extraEnv = agentExtraEnv();
  client.onEvent = forwardEvent;
  client.onExit = (code) => forwardEvent('server-exit', { code });
  client.start();
}

app.whenReady().then(() => {
  createWindow();
  startAgent();

  // 渲染层启动引导：key/默认模型/模式由主进程从环境与配置文件判定
  ipcMain.handle('bajin:bootstrap', () => {
    const uc = loadUserConfig();
    const apiKey = process.env['BIGMODEL_API_KEY'] ?? uc.bigmodel?.apiKey;
    // 已给任意供应商配置 Key 即视为有可用凭据（该供应商名下模型可直接用），不再降级 mock
    const providers = Array.isArray(uc.providers) ? uc.providers : [];
    const providerKeyed = providers.some((p) => p?.apiKey);
    // 默认模型：用户显式配置 > 第一个配了 Key 且有名下模型的供应商模型 > 内置默认
    const firstProviderModel = providers.find((p) => p?.apiKey && p.models?.length)?.models?.[0];
    return {
      mock: !apiKey && !providerKeyed,
      apiKey: apiKey ?? null,
      model: uc.model ?? firstProviderModel ?? null,
      mode: uc.mode ?? null,
      baseUrl: uc.bigmodel?.baseUrl ?? null,
      home: os.homedir(),
    };
  });

  // —— 远程工作区（SSH，对标 ZCode workspaceSidebar.sshConnection*）：Alias/Host/Path ——
  ipcMain.handle('bajin:remotes:list', () => (loadUserConfig().remotes ?? []));
  ipcMain.handle('bajin:remotes:add', (_e, r: { name: string; host: string; port?: number; user?: string; path: string }) => {
    const uc = loadUserConfig();
    const remotes = (uc.remotes ?? []).filter((x) => x.name !== r.name.trim());
    remotes.push({ name: r.name.trim(), host: r.host.trim(), ...(r.port ? { port: r.port } : {}), ...(r.user?.trim() ? { user: r.user.trim() } : {}), path: r.path.trim() });
    uc.remotes = remotes;
    writeUserConfig(uc);
    return remotes;
  });
  ipcMain.handle('bajin:remotes:remove', (_e, name: string) => {
    const uc = loadUserConfig();
    uc.remotes = (uc.remotes ?? []).filter((x) => x.name !== name);
    writeUserConfig(uc);
    return uc.remotes ?? [];
  });
  /** 把 agent 切到远程主机跑：ssh <host> node ~/bajin/bajin.cjs app-server --stdio（协议与本地一致） */
  ipcMain.handle('bajin:connect-remote', (_e, name: string) => {
    const r = (loadUserConfig().remotes ?? []).find((x) => x.name === name);
    if (!r) return { ok: false, error: `远程工作区不存在: ${name}` };
    client?.kill();
    const dest = r.user ? `${r.user}@${r.host}` : r.host;
    client = new AppServerClient(
      'ssh',
      [
        ...(r.port ? ['-p', String(r.port)] : []),
        dest,
        'node',
        `${r.path}/bajin/bajin.cjs`,
        'app-server',
        '--stdio',
      ],
    );
    return { ok: true, remote: r };
  });

  // 其余一切走通用 RPC 透传（send/session/status/... 见 app-server 协议）
  ipcMain.handle('bajin:rpc', (_e, method: string, params?: unknown) => client!.request(method, params));

  // 项目页「选择目录」原生对话框
  ipcMain.handle('bajin:pick-dir', async () => {
    const res = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0]!;
  });

  // 界面设置读写（对标 ZCode settings.general，存 ~/.bajin/config.json settings 字段）
  ipcMain.handle('bajin:config:get-settings', () => loadUserConfig().settings ?? {});
  ipcMain.handle('bajin:config:set-settings', (_e, patch: Record<string, unknown>) => {
    const uc = loadUserConfig();
    uc.settings = { ...uc.settings, ...patch };
    writeUserConfig(uc);
    // 主题切换：系统窗口按钮 overlay 颜色同步（对标 ZCode 标题栏随主题）
    if (patch['theme'] === 'light') win?.setTitleBarOverlay({ color: '#ffffff', symbolColor: '#5a6070' });
    else if (patch['theme'] === 'dark') win?.setTitleBarOverlay({ color: '#1d1f24', symbolColor: '#9aa0aa' });
    return uc.settings;
  });

  // 浏览器数据维护（对标 ZCode settings.browser.clearCache/clearAll：Electron session 真实清理）
  ipcMain.handle('bajin:browser:clear-cache', async () => {
    await win?.webContents.session.clearCache();
    return true;
  });
  ipcMain.handle('bajin:browser:clear-data', async () => {
    await win?.webContents.session.clearStorageData();
    await win?.webContents.session.clearCache();
    return true;
  });

  // 在系统文件管理器中定位（任务菜单「在文件管理器中打开」）
  ipcMain.handle('bajin:reveal-path', (_e, p: string) => {
    if (typeof p !== 'string' || !p.startsWith('/')) return false;
    shell.showItemInFolder(p);
    return true;
  });

  // 外部浏览器打开（反馈问题等外链）
  ipcMain.handle('bajin:open-external', (_e, url: string) => {
    if (!/^https:\/\//.test(url)) return false;
    void shell.openExternal(url);
    return true;
  });

  // 系统通知（任务完成时由渲染层触发）
  ipcMain.handle('bajin:notify', (_e, title: string, body: string) => {
    if (!Notification.isSupported()) return false;
    new Notification({ title, body }).show();
    return true;
  });

  // Hooks 配置读写（Agent 设置页；hooks 块结构见 packages/core/src/hooks.ts）
  ipcMain.handle('bajin:hooks:get', () => loadUserConfig().hooks ?? null);
  ipcMain.handle('bajin:hooks:set-enabled', (_e, enabled: boolean) => {
    const uc = loadUserConfig();
    uc.hooks = { ...(uc.hooks ?? {}), enabled };
    writeUserConfig(uc);
    return uc.hooks;
  });
  ipcMain.handle('bajin:hooks:save', (_e, hooks: Record<string, unknown>) => {
    const uc = loadUserConfig();
    uc.hooks = hooks as UserConfig['hooks'];
    writeUserConfig(uc);
    return uc.hooks;
  });

  // 顶层配置块读写（MCP servers / dataDir 等）
  ipcMain.handle('bajin:config:patch', (_e, patch: Record<string, unknown>) => {
    const uc = loadUserConfig();
    for (const [k, v] of Object.entries(patch)) (uc as Record<string, unknown>)[k] = v;
    writeUserConfig(uc);
    return { dataDir: uc.dataDir ?? null, mcpCount: Object.keys(uc.mcpServers ?? {}).length };
  });
  ipcMain.handle('bajin:config:mcp', () => loadUserConfig().mcpServers ?? {});
  ipcMain.handle('bajin:config:data-dir', () => loadUserConfig().dataDir ?? null);

  // 数据目录迁移：复制 sessions/ 与 rollout/ 到新目录并记录 dataDir（重启后 agent 以 BAJIN_HOME 指向新目录）
  ipcMain.handle('bajin:data:migrate', async (_e, target: string) => {
    if (!target.startsWith('/')) return { ok: false, error: '路径无效' };
    const src = path.join(os.homedir(), '.bajin');
    const copyDir = (from: string, to: string): void => {
      if (!existsSync(from)) return;
      cpSync(from, to, { recursive: true });
    };
    try {
      copyDir(path.join(src, 'sessions'), path.join(target, 'sessions'));
      copyDir(path.join(src, 'rollout'), path.join(target, 'rollout'));
      const uc = loadUserConfig();
      uc.dataDir = target;
      writeUserConfig(uc);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerTerminalIpc();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/* ---------- 集成终端（对标 ZCode 终端面板：主进程起 bash，IPC 流式回传）---------- */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

let term: ChildProcessWithoutNullStreams | null = null;

function registerTerminalIpc(): void {
  ipcMain.handle('bajin:term:start', (_e, cwd?: string) => {
    if (term) return { ok: true };
    const cfgShell = loadUserConfig().settings?.terminalShell;
    const shell = (cfgShell && cfgShell !== 'auto' ? cfgShell : process.env.SHELL) || '/bin/bash';
    try {
      term = spawn(shell, ['--login'], {
        cwd: cwd && cwd.startsWith('/') ? cwd : os.homedir(),
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      return { ok: false, error: String(err) };
    }
    const onData = (d: Buffer): void => forwardEvent('term-data', { data: d.toString('utf8') });
    term.stdout.on('data', onData);
    term.stderr.on('data', onData);
    term.on('exit', (code) => {
      forwardEvent('term-exit', { code });
      term = null;
    });
    return { ok: true };
  });
  ipcMain.handle('bajin:term:input', (_e, input: string) => {
    if (!term?.stdin.writable) return { ok: false };
    term.stdin.write(input);
    return { ok: true };
  });
  ipcMain.handle('bajin:term:stop', () => {
    term?.kill();
    term = null;
    return { ok: true };
  });
}

app.on('window-all-closed', () => {
  client?.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => client?.kill());
