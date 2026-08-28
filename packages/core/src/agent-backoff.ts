/**
 * 子进程重启监管（R7-4 崩溃自动恢复）：指数退避 + 上限 + 稳定清零。
 * 纯策略类不碰进程——桌面主进程（app-server）与 web-server（AppServerProc）共用。
 */
export class RestartSupervisor {
  private attempt = 0;
  private lastStartAt = 0;

  constructor(
    private readonly opts: {
      baseDelayMs?: number;
      maxDelayMs?: number;
      maxAttempts?: number;
      /** 连续运行超过该时长视为稳定，重试计数清零 */
      stableMs?: number;
    } = {},
  ) {}

  /** 进程即将重启时调用：递增计数并返回本次应等待的毫秒 */
  nextDelayMs(): number {
    this.attempt += 1;
    this.lastStartAt = Date.now();
    const base = this.opts.baseDelayMs ?? 1000;
    const max = this.opts.maxDelayMs ?? 30_000;
    return Math.min(max, base * 2 ** (this.attempt - 1));
  }

  /** 是否还应该继续重启（超过 maxAttempts 放弃，交人工） */
  shouldRestart(): boolean {
    return this.attempt < (this.opts.maxAttempts ?? 5);
  }

  get attempts(): number {
    return this.attempt;
  }

  /** 进程运行稳定（超过 stableMs）后调用：清零计数，下次崩溃重新从 baseDelay 开始 */
  noteHealthy(now = Date.now()): void {
    if (now - this.lastStartAt > (this.opts.stableMs ?? 60_000)) this.attempt = 0;
  }

  /** 测试/复位 */
  reset(): void {
    this.attempt = 0;
  }
}
