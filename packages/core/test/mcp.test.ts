import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { connectMcpServers, loadMcpServerConfigs } from '../src/mcp.js';

/**
 * 假的 stdio MCP server：按行读 JSON-RPC，回应 initialize / tools/list / tools/call。
 * 协议与真实 MCP stdio server 一致（newline-delimited JSON-RPC 2.0）。
 */
const FAKE_SERVER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined) return; // notification
  let result;
  if (msg.method === 'initialize') {
    result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0' } };
  } else if (msg.method === 'tools/list') {
    result = { tools: [
      { name: 'echo', description: '回声工具', inputSchema: { type: 'object' } },
      { name: 'boom', description: '总失败', inputSchema: { type: 'object' } },
    ] };
  } else if (msg.method === 'tools/call') {
    if (msg.params.name === 'echo') result = { content: [{ type: 'text', text: 'echo:' + JSON.stringify(msg.params.arguments) }] };
    else result = { content: [{ type: 'text', text: '炸了' }], isError: true };
  } else {
    result = {};
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
});
`;

const dir = await mkdtemp(path.join(tmpdir(), 'bajin-mcp-'));
const serverJs = path.join(dir, 'fake-server.cjs');
await writeFile(serverJs, FAKE_SERVER, 'utf8');

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe('MCP 运行时（stdio）', () => {
  it('连接 → 工具以 mcp__server__tool 注入 → 调用透传参数并返回文本', async () => {
    const rt = await connectMcpServers({ fake: { type: 'stdio', command: process.execPath, args: [serverJs] } }, () => undefined);
    try {
      const names = rt.tools.map((t) => t.name).sort();
      expect(names).toEqual(['mcp__fake__boom', 'mcp__fake__echo']);
      const echo = rt.tools.find((t) => t.name === 'mcp__fake__echo')!;
      const r = await echo.execute({ hello: '世界' }, { cwd: dir } as never);
      expect(r.ok).toBe(true);
      expect(r.output).toBe('echo:{"hello":"世界"}');
      const boom = rt.tools.find((t) => t.name === 'mcp__fake__boom')!;
      const r2 = await boom.execute({}, { cwd: dir } as never);
      expect(r2.ok).toBe(false);
      expect(r2.output).toBe('炸了');
    } finally {
      rt.dispose();
    }
  });

  it('坏配置的 server 不拖垮整体（其余照常连接）', async () => {
    const logs: string[] = [];
    const rt = await connectMcpServers(
      {
        broken: { type: 'stdio', command: '/nonexistent/binary-xyz', args: [] },
        fake: { type: 'stdio', command: process.execPath, args: [serverJs] },
      },
      (m) => logs.push(m),
    );
    try {
      expect(rt.tools.some((t) => t.name.startsWith('mcp__fake__'))).toBe(true);
      expect(logs.some((m) => m.includes('broken'))).toBe(true);
    } finally {
      rt.dispose();
    }
  });

  it('loadMcpServerConfigs：无配置文件返回空对象', async () => {
    const emptyHome = await mkdtemp(path.join(tmpdir(), 'bajin-mcp-home-'));
    try {
      expect(await loadMcpServerConfigs(emptyHome)).toEqual({});
    } finally {
      await rm(emptyHome, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
