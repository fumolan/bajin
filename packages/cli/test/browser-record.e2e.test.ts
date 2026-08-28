import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
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
        else if (Date.now() > deadline) reject(new Error('RPC 超时'));
        else setTimeout(poll, 50);
      };
      poll();
    });
  }
  close(): void { this.child.kill('SIGKILL'); }
}

let dir: string;
let server: Handle | null = null;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bajin-rec-')); });
afterEach(() => { server?.close(); server = null; });

function start(): Handle {
  const child = spawn(process.execPath, [CLI_ENTRY, 'app-server', '--stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, BAJIN_HOME: path.join(dir, 'state') },
  });
  server = new Handle(child);
  return server;
}

describe('浏览器录制存取（R6-4 e2e）', () => {
  it('保存→列表→删除 全回路，文件落在 BAJIN_HOME 沙箱内', async () => {
    const s = start();
    await s.request('initialize', { cwd: dir, mock: true });
    const payload = Buffer.from('fake-webm-chunks-0123456789').toString('base64');
    const save = await s.request('browser/record-save', { name: '演示 ../../etc/passwd', dataBase64: payload });
    expect(save.error).toBeUndefined();
    const file = String(save.result!['path']);
    expect(file.startsWith(path.join(dir, 'state', 'browser-recordings'))).toBe(true); // 不越出沙箱
    expect(fs.existsSync(file)).toBe(true);
    expect(String(save.result!['name'])).not.toContain('/'); // 名字白名单化
    const list = await s.request('browser/record-list');
    const recs = list.result!['recordings'] as Array<{ name: string; size: number }>;
    expect(recs.length).toBe(1);
    expect(recs[0]!.size).toBe(27);
    const del = await s.request('browser/record-delete', { name: String(save.result!['name']) });
    expect(del.result!['deleted']).toBeTruthy();
    const list2 = await s.request('browser/record-list');
    expect((list2.result!['recordings'] as unknown[]).length).toBe(0);
  });

  it('坏输入被拒绝：空数据 / 超 50MB / 空列表安全', async () => {
    const s = start();
    await s.request('initialize', { cwd: dir, mock: true });
    const empty = await s.request('browser/record-save', { name: 'x', dataBase64: '' });
    expect(empty.error?.message).toContain('dataBase64');
    const big = await s.request('browser/record-save', { name: 'x', dataBase64: 'A'.repeat(70 * 1024 * 1024) }); // 解码 ~52.5MB
    expect(big.error?.message).toContain('50MB');
    const none = await s.request('browser/record-list');
    expect((none.result!['recordings'] as unknown[]).length).toBe(0);
  });
});
