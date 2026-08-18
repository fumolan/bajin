/**
 * bajin Notebook Server —— 浏览器平台（类似 Jupyter）：
 * `bajin server --port 4444` 启动 HTTP + SSE 服务，在浏览器中以 Cell 为单位与 Agent 交互。
 *
 * 路由：
 *   GET  /               → Notebook HTML 页面
 *   GET  /api/stream     → SSE 事件流（text-delta / tool-call / tool-result / done / error）
 *   POST /api/send       → 执行一个 Cell（触发 Agent.run）
 *   POST /api/interrupt   → 中断当前任务
 *   GET  /api/status      → 会话/模型/模式状态
 *   POST /api/mode        → 切换权限模式
 *   POST /api/model       → 切换模型
 */

import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { Agent, PermissionPolicy, createGlmProvider, createMockProvider as createCoreMockProvider } from '@bajin/core';
import type { PermissionMode, ModelProvider } from '@bajin/shared';

export interface NotebookServerOptions {
  port?: number;
  cwd?: string;
  model?: string;
  mode?: PermissionMode;
  mock?: boolean;
  apiKey?: string;
  baseUrl?: string;
}

interface SseClient {
  id: number;
  res: http.ServerResponse;
}

export function startNotebookServer(opts: NotebookServerOptions): http.Server {
  const port = opts.port ?? 4444;
  const cwd = opts.cwd ?? process.cwd();
  let model = opts.model ?? 'glm-4.7';
  let mode: PermissionMode = opts.mode ?? 'build';

  // SSE 客户端池
  const sseClients = new Set<SseClient>();
  let sseSeq = 0;

  // Agent 状态
  let agent: Agent | null = null;
  let busy = false;

  function broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of sseClients) {
      try { c.res.write(payload); } catch { sseClients.delete(c); }
    }
  }

  function createAgent(): Agent {
    const callbacks = {
      onText: (delta: string) => broadcast('text-delta', { delta }),
      onReasoning: (delta: string) => broadcast('reasoning-delta', { delta }),
      onToolCall: (name: string, args: unknown) => broadcast('tool-call', { name, args }),
      onToolResult: (name: string, result: { ok: boolean; output: string; denied?: boolean }) =>
        broadcast('tool-result', { name, ok: result.ok, output: result.output.slice(0, 2000), denied: result.denied }),
      onUsage: (usage: { inputTokens?: number; outputTokens?: number }) =>
        broadcast('usage', usage),
      onApproval: async () => true, // notebook 模式默认放行（简化；后续可加审批 UI）
    };
    const a = new Agent({
      provider: opts.mock ? createCoreMockProvider([{ text: '[mock]' }]) : createProviderFromEnv(model, opts),
      model,
      cwd,
      mode,
      policy: new PermissionPolicy({ mode, allowedTools: [], disallowedTools: [] }),
      callbacks,
    });
    return a;
  }

  function ensureAgent(): Agent {
    if (!agent) agent = createAgent();
    return agent;
  }

  // HTTP 路由
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── GET / → Notebook HTML ──
    if (req.method === 'GET' && url.pathname === '/') {
      const htmlPath = path.join(__dirname, 'notebook.html');
      try {
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('notebook.html not found');
      }
      return;
    }

    // ── GET /api/stream → SSE ──
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      const client: SseClient = { id: ++sseSeq, res };
      sseClients.add(client);
      // 心跳防止连接断开
      const heartbeat = setInterval(() => {
        try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
      }, 15000);
      req.on('close', () => { clearInterval(heartbeat); sseClients.delete(client); });
      return;
    }

    // ── GET /api/status ──
    if (req.method === 'GET' && url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        busy,
        model,
        mode,
        cwd,
        sessionId: agent?.sessionId ?? null,
        tokens: agent?.contextTokens() ?? 0,
        tools: agent ? agent.toolset().map((t) => t.name) : [],
      }));
      return;
    }

    // ── POST 路由（读 body）──
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(body) as Record<string, unknown>; } catch { /* 空 body */ }

      // POST /api/send
      if (url.pathname === '/api/send') {
        const prompt = String(json['prompt'] ?? '').trim();
        if (!prompt) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'prompt 不能为空' }));
          return;
        }
        if (busy) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '任务执行中，请等待或先中断' }));
          return;
        }
        busy = true;
        broadcast('start', { prompt });
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted: true }));

        try {
          const a = ensureAgent();
          await a.ready;
          const result = await a.run(prompt);
          broadcast('done', {
            text: result.text,
            iterations: result.iterations,
            toolCalls: result.toolCalls,
            tokens: a.contextTokens(),
          });
        } catch (err) {
          broadcast('error', { message: err instanceof Error ? err.message : String(err) });
        } finally {
          busy = false;
        }
        return;
      }

      // POST /api/interrupt
      if (url.pathname === '/api/interrupt') {
        if (agent) agent.abort();
        busy = false;
        broadcast('interrupted', {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST /api/mode
      if (url.pathname === '/api/mode') {
        const m = String(json['mode'] ?? '');
        if (['plan', 'build', 'edit', 'yolo'].includes(m)) {
          mode = m as PermissionMode;
          if (agent) agent.setMode(mode);
          broadcast('mode-changed', { mode });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mode }));
        return;
      }

      // POST /api/model
      if (url.pathname === '/api/model') {
        model = String(json['model'] ?? model);
        broadcast('model-changed', { model });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model }));
        return;
      }

      // POST /api/reset
      if (url.pathname === '/api/reset') {
        agent = null;
        busy = false;
        broadcast('reset', {});
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

  server.listen(port, () => {
    process.stdout.write(`\n  bajin notebook 运行中: http://localhost:${port}\n\n`);
  });

  return server;
}

// ── Provider 工厂（从环境/选项构建）──
function createProviderFromEnv(model: string, opts: NotebookServerOptions): ModelProvider {
  const apiKey = opts.apiKey ?? process.env['BIGMODEL_API_KEY'] ?? '';
  if (!apiKey) {
    process.stderr.write('警告：未检测到 API Key（BIGMODEL_API_KEY），将使用 mock 模式\n');
    return createCoreMockProvider([{ text: `[notebook mock] 模型=${model}，收到指令。` }]);
  }
  return createGlmProvider({ apiKey, baseUrl: opts.baseUrl, model });
}
