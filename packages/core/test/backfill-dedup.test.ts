import { describe, it, expect } from 'vitest';
import { BrowserStateStore, shouldBackfill } from '../src/tools/browser.js';

describe('回读去重（R7-7）', () => {
  it('setContentIfChanged：相同内容返回 false 且时钟不重置（不伪造刚更新）', () => {
    const st = new BrowserStateStore();
    st.setState('https://a.com', '页面文本');
    const t0 = Date.now();
    expect(st.setContentIfChanged('页面文本')).toBe(false);
    expect(st.getContentAgeMs(t0 + 60_000)).toBeGreaterThanOrEqual(60_000 - 50); // 年龄继续涨
  });

  it('setContentIfChanged：不同内容返回 true 并重置时钟', () => {
    const st = new BrowserStateStore();
    st.setState('https://a.com', '旧文本');
    expect(st.setContentIfChanged('新文本')).toBe(true);
    expect(st.getContentAgeMs()).toBeLessThan(100);
    expect(st.getContent()).toBe('新文本');
  });

  it('shouldBackfill：同 URL TTL 内拒绝，过期/换 URL 放行', () => {
    const now = Date.now();
    expect(shouldBackfill('https://a.com', 'https://a.com', now - 5_000, now)).toBe(false);   // 5s 前
    expect(shouldBackfill('https://a.com', 'https://a.com', now - 31_000, now)).toBe(true);   // TTL 过期
    expect(shouldBackfill('https://b.com', 'https://a.com', now, now)).toBe(true);            // 换页
    expect(shouldBackfill('https://a.com', null, 0, now)).toBe(true);                          // 首次
  });
});
