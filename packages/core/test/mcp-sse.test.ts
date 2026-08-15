import { describe, it, expect, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connectMcpServers } from '../src/mcp.js';

/**
 * 假的 SSE MCP server（legacy HTTP+SSE 协议）：
 * GET /sse 建立事件流并先推 endpoint；POST /messages 收 JSON-RPC，
 * 响应通过事件流以 event: message 推回。
 */
const sessions = new Map<string, { res: import('node:http').ServerResponse }>();
let seq = 0;
const server: Server = createServer((req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/sse')) {
    const id = String(++seq);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(`event: endpoint\ndata: /messages?sid=${id}\n\n`);
    sessions.set(id, { res });
    return;
  }
  if (req.method === 'POST' && req.url?.startsWith('/messages')) {
    const sid = new URL(req.url!, 'http://x').searchParams.get('sid')!;
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(202);
      res.end();
      const msg = JSON.parse(body);
      if (msg.id === undefined) return;
      let result: unknown;
      if (msg.method === 'initialize') {
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'sse-fake', version: '1' } };
      } else if (msg.method === 'tools/list') {
        result = { tools: [{ name: 'now', description: '当前时间', inputSchema: { type: 'object' } }] };
      } else if (msg.method === 'tools/call') {
        result = { content: [{ type: 'text', text: 'now:' + JSON.stringify(msg.params.arguments) }] };
      } else {
        result = {};
      }
      sessions.get(sid)?.res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
    });
    return;
  }
  res.writeHead(404).end();
});

await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;

afterAll(async () => {
  for (const [, s] of sessions) s.res.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('MCP 运行时（sse 传输）', () => {
  it('GET /sse 拿 endpoint → initialize 握手 → 工具注入 → 调用经 POST 回流', async () => {
    const rt = await connectMcpServers(
      { clock: { type: 'sse', url: `http://127.0.0.1:${port}/sse` } },
      () => undefined,
    );
    try {
      expect(rt.tools.map((t) => t.name)).toEqual(['mcp__clock__now']);
      const r = await rt.tools[0]!.execute({ tz: 'UTC' }, { cwd: '.' } as never);
      expect(r.ok).toBe(true);
      expect(r.output).toBe('now:{"tz":"UTC"}');
    } finally {
      rt.dispose();
    }
  });

  it('连接不可达的 sse 地址：报错不拖垮整体', async () => {
    const logs: string[] = [];
    const rt = await connectMcpServers(
      { dead: { type: 'sse', url: 'http://127.0.0.1:1/sse' } },
      (m) => logs.push(m),
    );
    try {
      expect(rt.tools).toEqual([]);
      expect(logs.some((m) => m.includes('dead'))).toBe(true);
    } finally {
      rt.dispose();
    }
  });
});
