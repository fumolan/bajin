import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { execSync } from 'node:child_process';
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
let sid: string;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bajin-rv-'));
  execSync('git init -q && git config user.email t@t && git config user.name t && echo base > base.txt && git add . && git commit -qm base', { cwd: dir });
});
afterEach(() => { server?.close(); server = null; });

async function start(): Promise<void> {
  const child = spawn(process.execPath, [CLI_ENTRY, 'app-server', '--stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, BAJIN_HOME: path.join(dir, 'state') },
    cwd: dir,
  });
  server = new Handle(child);
  const res = await server.request('initialize', { cwd: dir, mock: true });
  sid = String(res.result!['sessionId']);
}

describe('撤销本轮文件改动（R7-5 e2e）', () => {
  it('无触碰 → 空计划', async () => {
    await start();
    const t = await server.request('session/touched-files', { sessionId: sid });
    expect(t.result!['files']).toEqual([]);
    const d = await server.request('session/revert-files', { sessionId: sid, dryRun: true });
    expect(d.result!['safe']).toEqual([]);
    expect(d.result!['risky']).toEqual([]);
  });

  it('非 git 目录安全返回空（不炸）', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'bajin-rv-nogit-'));
    const child = spawn(process.execPath, [CLI_ENTRY, 'app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, BAJIN_HOME: path.join(plain, 'state') },
      cwd: plain,
    });
    const h = new Handle(child);
    const res = await h.request('initialize', { cwd: plain, mock: true });
    const sid2 = String(res.result!['sessionId']);
    const d = await h.request('session/revert-files', { sessionId: sid2, dryRun: true });
    expect(d.error).toBeUndefined();
    expect(d.result!['safe']).toEqual([]);
    h.close();
  });
});
