import { describe, it, expect } from 'vitest';
import { ActionResultHub } from '../src/tools/browser.js';

describe('CUA 动作结果汇聚器（R7-2）', () => {
  it('正常回路：wait 后 resolve 唤醒', async () => {
    const hub = new ActionResultHub();
    const seq = hub.nextSeq();
    const p = hub.wait(seq, 1000);
    setTimeout(() => hub.resolve(seq, true), 20);
    expect((await p).ok).toBe(true);
  });

  it('超时按失败返回并标明原因', async () => {
    const hub = new ActionResultHub();
    const seq = hub.nextSeq();
    const r = await hub.wait(seq, 30);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('超时');
  });

  it('结果先到：early 暂存，随后的 wait 立即拿到', async () => {
    const hub = new ActionResultHub();
    const seq = hub.nextSeq();
    hub.resolve(seq, false, 'CUA 跨域受限（web 模式 iframe 同源策略）');
    const r = await hub.wait(seq, 1000);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('跨域受限');
  });

  it('seq 单调递增，不同动作互不串扰', async () => {
    const hub = new ActionResultHub();
    const a = hub.nextSeq();
    const b = hub.nextSeq();
    expect(b).toBeGreaterThan(a);
    const pa = hub.wait(a, 1000);
    const pb = hub.wait(b, 1000);
    hub.resolve(b, true);
    hub.resolve(a, false, '未命中');
    expect((await pb).ok).toBe(true);
    expect((await pa).ok).toBe(false);
  });
});
