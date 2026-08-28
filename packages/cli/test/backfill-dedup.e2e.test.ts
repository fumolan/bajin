import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const CLI_ENTRY = path.resolve(fileURLToPath(new URL('../dist/main.js', import.meta.url)));
interface RpcMessage { id?: number; result?: Record<string, unknown>; error?: { message: string }; }

class Handle {
  private seq = 0; private buf = ''; private lines: RpcMessage[] = [];
  constructor(readonly child: ChildProcess) {
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const l = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
        if (l) this.lines.push(JSON.parse(l) as RpcMessage);
      }
    });
  }
  request(method: string, params?: unknown): Promise<RpcMessage> {
    const id = ++this.seq;
    this.child.stdin!.write(`${JSON.stringify({ id, method, params })}\n`);
    const deadline = Date.now() + 15_000;
    return new Promise((resolve, reject) => {
      const poll = (): void => {
        const hit = this.lines.find((m) => m.id === id && (m.result !== undefined || m.error !== undefined));
        if (hit) resolve(hit);
        else if (Date.now() > deadline) reject(new Error(`RPC 超时: ${method}`));
        else setTimeout(poll, 50);
      };
      poll();
    });
  }
  close(): void { this.child.kill('SIGKILL'); }
}

let dir: string;
let server: Handle | null = null;
let http: Server | null = null;
let hits = 0;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bajin-dd-')); hits = 0; });
afterEach(() => { server?.close(); server = null; void http?.close(); http = null; });

describe('代抓去重（R7-7 e2e）', () => {
  it('同 URL 连续上报两次只代抓一次（30s TTL 防抖）', async () => {
    http = createServer((_q, res) => { hits += 1; res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<html><body>去重验证页</body></html>'); });
    await new Promise<void>((r) => http!.listen(0, '127.0.0.1', r));
    const port = (http.address() as { port: number }).port;
    const child = spawn(process.execPath, [CLI_ENTRY, 'app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, BAJIN_HOME: path.join(dir, 'state') },
    });
    server = new Handle(child);
    await server.request('initialize', { cwd: dir, mock: true });
    await server.request('browser/state', { url: `http://127.0.0.1:${port}/a` });
    // 等第一次代抓落地
    for (let i = 0; i < 40 && hits === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(hits).toBe(1);
    // 立刻重复上报同一 URL —— 不应再抓
    await server.request('browser/state', { url: `http://127.0.0.1:${port}/a` });
    await new Promise((r) => setTimeout(r, 400));
    expect(hits).toBe(1);
    // 换 URL 立即放行
    await server.request('browser/state', { url: `http://127.0.0.1:${port}/b` });
    for (let i = 0; i < 40 && hits < 2; i++) await new Promise((r) => setTimeout(r, 50));
    expect(hits).toBe(2);
  });
});
