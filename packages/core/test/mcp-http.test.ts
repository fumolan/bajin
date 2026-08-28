import { describe, it, expect, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connectMcpServers } from '../src/mcp.js';

/**
 * 假的 streamable HTTP MCP server（R5-7）：
 * 单端点 POST；initialize 响应带 Mcp-Session-Id 头；JSON 与 SSE 两种响应形态都覆盖
 * （initialize/tools/list 用 JSON，tools/call 用 SSE——验证双形态解析）。
 */
function startFake(): Promise<{ server: Server; port: number; sawSessionHeader: () => boolean }> {
  let session = 'sess-test-1';
  let echoed = false;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = body ? JSON.parse(body) as { id?: number; method?: string; params?: { name?: string } } : {};
      if (msg.id === undefined) { res.writeHead(202); res.end(); return; } // 通知
      // 会话头必须回带（initialize 之后）
      if (msg.method !== 'initialize' && req.headers['mcp-session-id'] !== session) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: '缺会话头' } }));
        return;
      }
      if (req.headers['mcp-session-id'] === session) echoed = true;
      let result: unknown;
      if (msg.method === 'initialize') {
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-http', version: '1.0' } };
      } else if (msg.method === 'tools/list') {
        result = { tools: [{ name: 'ping', description: 'HTTP 探针', inputSchema: { type: 'object' } }] };
      } else if (msg.method === 'tools/call') {
        result = { content: [{ type: 'text', text: 'pong:' + JSON.stringify(msg.params) }] };
      } else {
        result = {};
      }
      const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (msg.method === 'initialize') headers['Mcp-Session-Id'] = session;
      // tools/call 走 SSE 形态（验证 event-stream 解析）
      if (msg.method === 'tools/call') {
        headers['Content-Type'] = 'text/event-stream';
        res.writeHead(200, headers);
        res.write(`event: message\ndata: ${payload}\n\n`);
        res.end();
        return;
      }
      res.writeHead(200, headers);
      res.end(payload);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port, sawSessionHeader: () => echoed });
    });
  });
}

const fake = await startFake();
afterAll(() => new Promise<void>((r) => fake.server.close(() => r())));

describe('MCP streamable HTTP 传输', () => {
  it('initialize 会话头 + JSON 响应工具发现 + SSE 响应工具调用', async () => {
    const rt = await connectMcpServers({
      'http-fake': { type: 'http', url: `http://127.0.0.1:${fake.port}/mcp` },
    });
    try {
      expect(rt.tools.length).toBe(1);
      expect(rt.tools[0]!.name).toBe('mcp__http-fake__ping');
      const out = await rt.tools[0]!.execute({ x: 1 });
      expect(out.ok).toBe(true);
      expect(out.output).toContain('pong:');
      expect(fake.sawSessionHeader()).toBe(true); // 后续请求确实回带了会话头
    } finally {
      rt.dispose();
    }
  });

  it('服务器不可达时 connectMcpServers 不整体失败', async () => {
    const rt = await connectMcpServers({
      'dead': { type: 'http', url: 'http://127.0.0.1:1/mcp' },
    });
    expect(rt.tools.length).toBe(0);
    rt.dispose();
  });
});
