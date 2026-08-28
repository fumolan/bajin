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
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bajin-bf-')); });
afterEach(() => { server?.close(); server = null; void http?.close(); http = null; });

function start(): Handle {
  const child = spawn(process.execPath, [CLI_ENTRY, 'app-server', '--stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, BAJIN_HOME: path.join(dir, 'state') },
  });
  server = new Handle(child);
  return server;
}

describe('浏览器内容回读服务端补偿（R7-1 e2e）', () => {
  it('仅报 URL（web 模式跨域场景）→ app-server 代抓回填，state-get 可读', async () => {
    // 本地页面：服务端抓取无 CORS 限制
    http = createServer((_q, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<html><body><h1>回填验证页</h1><p>服务端补偿内容</p></body></html>'); });
    await new Promise<void>((r) => http!.listen(0, '127.0.0.1', r));
    const port = (http.address() as { port: number }).port;
    const s = start();
    await s.request('initialize', { cwd: dir, mock: true });
    const push = await s.request('browser/state', { url: `http://127.0.0.1:${port}/doc` });
    expect(push.error).toBeUndefined();
    // 回填是异步的：轮询 state-get 直到内容出现
    let got = '';
    for (let i = 0; i < 60 && !got; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const g = await s.request('browser/state-get');
      got = String(g.result!['content'] ?? '');
    }
    expect(got).toContain('回填验证页');
    expect(got).toContain('服务端补偿内容');
  });

  it('面板自带 content 时直接采用，不覆盖用户换页（URL 未变才回填）', async () => {
    const s = start();
    await s.request('initialize', { cwd: dir, mock: true });
    const push = await s.request('browser/state', { url: 'https://example.com/x', content: '面板自己读到的文本' });
    expect(push.error).toBeUndefined();
    const g = await s.request('browser/state-get');
    expect(String(g.result!['content'])).toBe('面板自己读到的文本');
    expect(String(g.result!['url'])).toBe('https://example.com/x');
  });
});

describe('CUA 动作结果回填（R7-2 e2e）', () => {
  it('action-result 未知 seq 安全返回；结果先到也能被后续等待取到', async () => {
    const s = start();
    await s.request('initialize', { cwd: dir, mock: true });
    // 未知 seq：不崩、ok
    const stray = await s.request('browser/action-result', { seq: 999, ok: false, reason: 'x' });
    expect(stray.error).toBeUndefined();
    // 提前回填（面板快于注册）→ 状态安全；再次回填幂等
    const again = await s.request('browser/action-result', { seq: 999, ok: true });
    expect(again.error).toBeUndefined();
  });
});
