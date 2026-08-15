import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';

export interface RpcMessage {
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
  event?: string;
  params?: unknown;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/**
 * bajin app-server 的宿主端客户端：
 * - 以 ELECTRON_RUN_AS_NODE=1 把 Electron 自带的 node 当运行时，
 *   拉起 CLI 单文件 bundle 的 `app-server --stdio`（对标 ZCode 拉起 zcode.cjs 的方式）
 * - 按行 JSON-RPC：请求带自增 id，事件通过 onEvent 推给渲染层
 */
export class AppServerClient {
  private child: ChildProcess | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private rl: readline.Interface | null = null;
  onEvent: ((event: string, params: unknown) => void) | null = null;
  onExit: ((code: number | null) => void) | null = null;
  /** 注入 agent 子进程的额外环境变量（代理 / 数据目录等，start 前设置） */
  extraEnv: Record<string, string> = {};

  constructor(
    private readonly command: string,
    private readonly args: string[],
  ) {}

  start(): void {
    if (this.child) return;
    this.child = spawn(this.command, this.args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...this.extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.rl = readline.createInterface({ input: this.child.stdout!, terminal: false });
    this.rl.on('line', (line) => this.handleLine(line));
    this.child.stderr?.on('data', (d: Buffer) => {
      const text = d.toString('utf8').trim();
      if (text) console.log(`[bajin-agent] ${text}`);
    });
    this.child.on('exit', (code) => {
      for (const [, p] of this.pending) p.reject(new Error(`app-server 已退出（code=${code}）`));
      this.pending.clear();
      this.onExit?.(code);
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(trimmed) as RpcMessage;
    } catch {
      return;
    }
    if (msg.event) {
      this.onEvent?.(msg.event, msg.params);
      return;
    }
    if (msg.id !== undefined) {
      const pending = this.pending.get(Number(msg.id));
      if (!pending) return;
      this.pending.delete(Number(msg.id));
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
    }
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 600_000): Promise<T> {
    if (!this.child?.stdin) return Promise.reject(new Error('app-server 未启动'));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child!.stdin!.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  kill(): void {
    this.rl?.close();
    this.child?.kill();
    this.child = null;
  }
}
