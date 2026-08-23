/**
 * bajin Web Server —— 把完整桌面 UI 放到浏览器：
 * `bajin server --port 4444` 启动 HTTP 服务，浏览器打开即见与 Electron 桌面端一致的界面。
 *
 * 架构：
 *   浏览器 ←HTTP/SSE→ web-server ←stdio JSON-RPC→ CLI app-server ←→ Agent
 *
 * 路由：
 *   GET  /               → 渲染层 HTML（web.html，加载 web-bridge.js + app-web.js + styles.css）
 *   GET  /styles.css     → 主题 CSS（与桌面端同一份）
 *   GET  /app-web.js     → 编译后的 React 渲染层
 *   GET  /web-bridge.js  → 浏览器版 window.bajin API（HTTP/SSE 实现）
 *   POST /api/rpc        → 通用 RPC（转发到 app-server 子进程）
 *   GET  /api/events     → SSE 事件流（text-delta/tool-call/done/...）
 *   GET  /api/bootstrap  → 启动引导信息
 *   POST /api/terminal   → 终端输入
 *   GET  /api/terminal/stream → 终端输出 SSE
 *   GET/POST /api/settings → 设置读写
 */

import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import * as os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── AppServer 子进程管理（与 Electron main 同逻辑）──

interface RpcPending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

class AppServerProc {
  private child: ChildProcess | null = null;
  private seq = 0;
  private buffer = '';
  private readonly pending = new Map<number, RpcPending>();
  private eventHandlers: Array<(event: string, params: unknown) => void> = [];

  start(cwd: string, model: string, mode: string, mock: boolean, apiKey?: string): void {
    if (this.child) return;
    const entry = path.resolve(__dirname, '..', '..', 'node_modules', '.bin', 'bajin');
    // 直接用编译后的 main.js
    const mainJs = path.resolve(__dirname, 'main.js');
    const args = [mainJs, 'app-server', '--stdio'];
    if (mock) args.push('--mock');

    this.child = spawn(process.execPath, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(apiKey ? { BIGMODEL_API_KEY: apiKey } : {}),
        BAJIN_HOME: process.env['BAJIN_HOME'] ?? path.join(os.homedir(), '.bajin'),
      },
    });

    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (d: string) => this.onData(d));
    this.child.stderr!.setEncoding('utf8');
    this.child.stderr!.on('data', (d: string) => {
      process.stderr.write(`[agent] ${d}`);
    });
    this.child.on('exit', (code) => {
      for (const [, p] of this.pending) p.reject(new Error(`app-server 已退出（code=${code}）`));
      this.pending.clear();
      this.child = null;
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as {
          id?: number | string; result?: unknown; error?: { message: string };
          event?: string; params?: unknown;
        };
        if (msg.id !== undefined) {
          const p = this.pending.get(Number(msg.id));
          if (p) {
            this.pending.delete(Number(msg.id));
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
        } else if (msg.event) {
          for (const h of this.eventHandlers) h(msg.event, msg.params);
        }
      } catch { /* 忽略非 JSON 行 */ }
    }
  }

  rpc<T = Record<string, unknown>>(method: string, params?: unknown): Promise<T> {
    if (!this.child?.stdin) return Promise.reject(new Error('app-server 未启动'));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.child!.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  onEvent(handler: (event: string, params: unknown) => void): () => void {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
    };
  }

  kill(): void {
    this.child?.kill();
    this.child = null;
  }
}

// ── 设置读写（与 Electron main 同逻辑）──

function stateHome(): string {
  return process.env['BAJIN_HOME']?.startsWith('/')
    ? process.env['BAJIN_HOME']
    : path.join(os.homedir(), '.bajin');
}

function readSettings(): Record<string, unknown> {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(stateHome(), 'config.json'), 'utf8')) as { settings?: Record<string, unknown> };
    return cfg.settings ?? {};
  } catch {
    return {};
  }
}

function writeSettings(patch: Record<string, unknown>): Record<string, unknown> {
  const file = path.join(stateHome(), 'config.json');
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { /* 首次 */ }
  cfg['settings'] = { ...(cfg['settings'] as Record<string, unknown> ?? {}), ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return cfg['settings'] as Record<string, unknown>;
}

// ── 终端进程管理 ──

let termProc: ChildProcess | null = null;
let termClients = new Set<http.ServerResponse>();

function startTerminal(cwd?: string): { ok: boolean; error?: string } {
  if (termProc) return { ok: true };
  const shell = process.env['SHELL'] ?? '/bin/bash';
  try {
    termProc = spawn(shell, ['--login'], {
      cwd: cwd?.startsWith('/') ? cwd : process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    termProc.stdout!.setEncoding('utf8');
    termProc.stdout!.on('data', (d: string) => {
      for (const res of termClients) {
        try { res.write(`event: term-data\ndata: ${JSON.stringify({ data: d })}\n\n`); } catch { termClients.delete(res); }
      }
    });
    termProc.stderr!.setEncoding('utf8');
    termProc.stderr!.on('data', (d: string) => {
      for (const res of termClients) {
        try { res.write(`event: term-data\ndata: ${JSON.stringify({ data: d })}\n\n`); } catch { termClients.delete(res); }
      }
    });
    termProc.on('exit', (code) => {
      for (const res of termClients) {
        try { res.write(`event: term-exit\ndata: ${JSON.stringify({ code })}\n\n`); } catch { /* */ }
      }
      termProc = null;
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ── Web Server ──

export interface WebServerOptions {
  port?: number;
  cwd?: string;
  model?: string;
  mock?: boolean;
  apiKey?: string;
  baseUrl?: string;
}

export function startWebServer(opts: WebServerOptions): http.Server {
  const port = opts.port ?? 4444;
  const cwd = opts.cwd ?? process.cwd();
  const proc = new AppServerProc();

  // SSE 客户端池（事件流）
  const eventClients = new Set<http.ServerResponse>();
  let eventSeq = 0;

  function broadcastEvent(event: string, params: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(params)}\n\n`;
    for (const res of eventClients) {
      try { res.write(payload); } catch { eventClients.delete(res); }
    }
  }

  // 事件转发：app-server → SSE
  proc.onEvent((event, params) => broadcastEvent(event, params));

  // HTTP 服务器
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── 静态文件 ──
    // HEAD 请求：与 GET 同路由但不返回 body
    if (req.method === 'HEAD') {
      const getCurl = await new Promise<string>((resolve) => {
        const proxy = http.request(url, { method: 'GET', host: 'localhost', port }, (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
          proxyRes.resume();
          proxyRes.on('end', () => resolve(''));
        });
        proxy.end();
      });
      void getCurl;
      return;
    }

    if (req.method === 'GET') {
      // 主页
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = getWebHtml();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      // styles.css
      if (url.pathname === '/styles.css') {
        const cssPath = findFile('styles.css', 'apps/desktop/src/renderer/styles.css');
        if (cssPath) {
          res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
          res.end(fs.readFileSync(cssPath, 'utf8'));
        } else { res.writeHead(404); res.end('styles.css not found'); }
        return;
      }
      // web-bridge.js
      if (url.pathname === '/web-bridge.js') {
        const bridge = getWebBridge();
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(bridge);
        return;
      }
      // app-web.js（编译后的 React 渲染层）
      if (url.pathname === '/app-web.js') {
        const jsPath = findFile('app-web.js', 'apps/desktop/dist/renderer/app.js');
        if (jsPath) {
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
          res.end(fs.readFileSync(jsPath));
        } else { res.writeHead(404); res.end('app-web.js not found'); }
        return;
      }

      // ── SSE 事件流 ──
      if (url.pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        res.write('retry: 3000\n\n');
        const id = ++eventSeq;
        eventClients.add(res);
        const hb = setInterval(() => {
          try { res.write(': hb\n\n'); } catch { clearInterval(hb); eventClients.delete(res); }
        }, 15000);
        req.on('close', () => { clearInterval(hb); eventClients.delete(res); });
        return;
      }

      // 终端输出流
      if (url.pathname === '/api/terminal/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        termClients.add(res);
        req.on('close', () => termClients.delete(res));
        return;
      }

      // bootstrap
      if (url.pathname === '/api/bootstrap') {
        const settings = readSettings();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          mock: opts.mock ?? false,
          apiKey: null,
          model: opts.model ?? null,
          mode: (settings['mode'] as string) ?? null,
          baseUrl: null,
          home: os.homedir(),
        }));
        return;
      }

      // settings 读取
      if (url.pathname === '/api/settings') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(readSettings()));
        return;
      }

      // hooks 读取
      if (url.pathname === '/api/hooks') {
        try {
          const cfg = JSON.parse(fs.readFileSync(path.join(stateHome(), 'config.json'), 'utf8')) as { hooks?: unknown };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(cfg.hooks ?? null));
        } catch {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('null');
        }
        return;
      }

      // MCP 配置读取
      if (url.pathname === '/api/mcp') {
        try {
          const cfg = JSON.parse(fs.readFileSync(path.join(stateHome(), 'config.json'), 'utf8')) as { mcpServers?: unknown };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(cfg.mcpServers ?? {}));
        } catch {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
        }
        return;
      }

      // 数据目录
      if (url.pathname === '/api/data-dir') {
        try {
          const cfg = JSON.parse(fs.readFileSync(path.join(stateHome(), 'config.json'), 'utf8')) as { dataDir?: string };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(cfg.dataDir ?? null));
        } catch {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('null');
        }
        return;
      }
    }

    // ── POST 路由 ──
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(body) as Record<string, unknown>; } catch { /* 空 body */ }

      // 通用 RPC 转发
      if (url.pathname === '/api/rpc') {
        const method = String(json['method'] ?? '');
        const params = json['params'];
        if (!method) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'method 不能为空' }));
          return;
        }
        try {
          const result = await proc.rpc(method, params);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result ?? {}));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      // 设置写入
      if (url.pathname === '/api/settings') {
        const result = writeSettings(json);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      // hooks 保存
      if (url.pathname === '/api/hooks/save') {
        const file = path.join(stateHome(), 'config.json');
        let cfg: Record<string, unknown> = {};
        try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { /* */ }
        cfg['hooks'] = json;
        fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(cfg['hooks']));
        return;
      }

      // 终端
      if (url.pathname === '/api/terminal/start') {
        const result = startTerminal(String(json['cwd'] ?? ''));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      if (url.pathname === '/api/terminal/input') {
        if (termProc?.stdin) {
          termProc.stdin.write(String(json['input'] ?? ''));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false }));
        }
        return;
      }
      if (url.pathname === '/api/terminal/stop') {
        termProc?.kill();
        termProc = null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // config patch（顶层键）
      if (url.pathname === '/api/config') {
        const file = path.join(stateHome(), 'config.json');
        let cfg: Record<string, unknown> = {};
        try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { /* */ }
        for (const [k, v] of Object.entries(json)) cfg[k] = v;
        fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未知 POST 路由' }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  // 启动 app-server 子进程
  proc.start(cwd, opts.model ?? 'glm-4.7', 'build', opts.mock ?? false, opts.apiKey);

  server.listen(port, () => {
    process.stdout.write(`\n  bajin web 运行中: http://localhost:${port}\n\n`);
  });

  // 优雅退出
  process.on('SIGINT', () => { proc.kill(); server.close(); process.exit(0); });
  process.on('SIGTERM', () => { proc.kill(); server.close(); process.exit(0); });

  return server;
}

// ── 工具函数 ──

function findFile(...candidates: string[]): string | null {
  // 搜索根：dist 目录 → 包目录 → 项目根
  const roots = [
    __dirname,                                           // packages/cli/dist/
    path.resolve(__dirname, '..'),                       // packages/cli/
    path.resolve(__dirname, '..', '..'),                 // packages/
    path.resolve(__dirname, '..', '..', '..'),           // 项目根（bajin/）
  ];
  for (const c of candidates) {
    for (const root of roots) {
      const p = path.resolve(root, c);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function getWebHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>bajin</title>
<link rel="stylesheet" href="/styles.css">
<style>
html, body, #root { height: 100%; margin: 0; }
.topbar { -webkit-app-region: no-drag !important; }
#err-overlay {
  position: fixed; inset: 0; z-index: 9999;
  background: #1a1b1e; color: #dd6873;
  padding: 40px; font: 14px/1.6 monospace;
  display: none; white-space: pre-wrap; overflow-y: auto;
}
</style>
</head>
<body>
<div id="root"></div>
<div id="err-overlay"></div>
<script>
// 捕获所有 JS 错误并显示（调试用）
window.onerror = function(msg, src, line, col, err) {
  var el = document.getElementById('err-overlay');
  if (el) {
    el.style.display = 'block';
    el.textContent += 'ERROR: ' + msg + '\n' +
      '  at ' + (src || '?') + ':' + line + ':' + col + '\n' +
      (err && err.stack ? err.stack.split('\n').slice(0,5).join('\n') : '') + '\n\n';
  }
};
window.addEventListener('unhandledrejection', function(e) {
  var el = document.getElementById('err-overlay');
  if (el) {
    el.style.display = 'block';
    el.textContent += 'PROMISE REJECT: ' + (e.reason && e.reason.message || e.reason) + '\n\n';
  }
});
</script>
<script src="/web-bridge.js"></script>
<script src="/app-web.js"></script>
</body>
</html>`;
}

function getWebBridge(): string {
  return `
// bajin web-bridge：在浏览器中实现与 Electron preload 相同的 window.bajin API
(function() {
  'use strict';

  // SSE 事件
  let eventHandlers = [];
  let es = null;

  function connectEvents() {
    if (es) return;
    es = new EventSource('/api/events');
    // 通用事件（text-delta/reasoning-delta/tool-call/tool-result/done/...）
    // SSE 只支持 named events，我们用一个自定义事件名接所有
    const knownEvents = [
      'text-delta', 'reasoning-delta', 'tool-call', 'tool-result',
      'usage', 'done', 'error', 'agent-error', 'todo-updated',
      'approval-request', 'ask-user', 'session-resumed', 'server-exit',
      'automation-ran', 'mode-changed', 'model-changed', 'interrupted',
      'term-data', 'term-exit'
    ];
    for (const ev of knownEvents) {
      es.addEventListener(ev, function(e) {
        try {
          const params = JSON.parse(e.data);
          for (const h of eventHandlers) h({ event: ev, params });
        } catch(err) {}
      });
    }
  }

  async function post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return res.json();
  }

  async function get(path) {
    const res = await fetch(path);
    return res.json();
  }

  window.bajin = {
    // 通用 RPC
    async rpc(method, params) {
      const r = await post('/api/rpc', { method, params });
      if (r.error) throw new Error(r.error);
      return r;
    },

    // 启动引导
    async bootstrap() {
      return get('/api/bootstrap');
    },

    // 目录选择（Web 环境用 prompt 降级）
    async pickDir() {
      // Web 环境无法弹原生目录选择，返回 null 让 UI 走手动输入
      return null;
    },

    // SSH 远程（Web 暂不支持，返回空）
    async remotesList() { return []; },
    async remotesAdd() { return []; },
    async remotesRemove() { return []; },
    async connectRemote() { return { ok: false, error: 'Web 模式暂不支持 SSH 远程' }; },

    // 终端
    async termStart(cwd) { return post('/api/terminal/start', { cwd }); },
    async termInput(input) { return post('/api/terminal/input', { input }); },
    async termStop() { return post('/api/terminal/stop'); },

    // 设置
    async configGetSettings() { return get('/api/settings'); },
    async configSetSettings(patch) { return post('/api/settings', patch); },
    async configPatch(patch) { return post('/api/config', patch); },
    async mcpGet() { return get('/api/mcp'); },
    async dataDirGet() { return get('/api/data-dir'); },
    async dataMigrate(target) { return post('/api/config', { dataDir: target }); },

    // 通知（Web Notifications API）
    async notify(title, body) {
      if ('Notification' in window) {
        if (Notification.permission === 'granted') {
          new Notification(title, { body });
          return true;
        } else if (Notification.permission !== 'denied') {
          const perm = await Notification.requestPermission();
          if (perm === 'granted') { new Notification(title, { body }); return true; }
        }
      }
      return false;
    },

    // 文件管理器（Web 无法打开，忽略）
    async revealPath() { return false; },
    async openExternal(url) {
      window.open(url, '_blank');
      return true;
    },

    // 浏览器面板（Web 内嵌 iframe）
    async browserNavigate(url) {
      // 通过自定义事件通知渲染层
      window.dispatchEvent(new CustomEvent('bajin:browser-navigate', { detail: url }));
      return true;
    },
    onBrowserNavigate(cb) {
      const handler = (e) => cb(e.detail);
      window.addEventListener('bajin:browser-navigate', handler);
      return () => window.removeEventListener('bajin:browser-navigate', handler);
    },

    // 浏览器数据维护（Web 环境 no-op）
    async browserClearCache() { return true; },
    async browserClearData() { return true; },

    // Hooks
    async hooksGet() { return get('/api/hooks'); },
    async hooksSetEnabled(enabled) { return post('/api/hooks/save', { enabled }); },
    async hooksSave(hooks) { return post('/api/hooks/save', hooks); },

    // 事件监听
    onEvent(cb) {
      connectEvents();
      eventHandlers.push(cb);
      return () => { eventHandlers = eventHandlers.filter(h => h !== cb); };
    },
  };
})();
`;
}
