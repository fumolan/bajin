import { describe, it, expect } from 'vitest';
import { RestartSupervisor } from '../src/agent-backoff.js';

describe('子进程重启监管（R7-4）', () => {
  it('指数退避序列并封顶', () => {
    const s = new RestartSupervisor({ baseDelayMs: 1000, maxDelayMs: 30000, maxAttempts: 5 });
    expect(s.nextDelayMs()).toBe(1000);
    expect(s.nextDelayMs()).toBe(2000);
    expect(s.nextDelayMs()).toBe(4000);
    expect(s.nextDelayMs()).toBe(8000);
    expect(s.nextDelayMs()).toBe(16000);
    expect(s.nextDelayMs()).toBe(30000); // 封顶
  });

  it('超过 maxAttempts 后 shouldRestart 为 false', () => {
    const s = new RestartSupervisor({ maxAttempts: 3 });
    expect(s.shouldRestart()).toBe(true);
    s.nextDelayMs(); s.nextDelayMs(); s.nextDelayMs();
    expect(s.shouldRestart()).toBe(false); // 已试 3 次
  });

  it('稳定运行超 stableMs 后计数清零，重新从 baseDelay 开始', () => {
    const s = new RestartSupervisor({ baseDelayMs: 1000, stableMs: 60_000 });
    s.nextDelayMs(); s.nextDelayMs();
    expect(s.nextDelayMs()).toBe(4000);
    // 模拟稳定运行 61 秒后再次崩溃
    s.noteHealthy(Date.now() + 61_000);
    expect(s.nextDelayMs()).toBe(1000);
  });

  it('未到稳定时长不清零', () => {
    const s = new RestartSupervisor({ baseDelayMs: 1000, stableMs: 60_000 });
    s.nextDelayMs(); s.nextDelayMs();
    s.noteHealthy(Date.now() + 10_000); // 只稳定了 10 秒
    expect(s.nextDelayMs()).toBe(4000);
  });
});
