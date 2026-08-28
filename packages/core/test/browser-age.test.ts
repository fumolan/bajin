import { describe, it, expect, afterEach } from 'vitest';
import { BrowserStateStore, setBrowserBridge, getBrowserBridge, createBrowserContentTool } from '../src/tools/browser.js';

describe('内容时效（R7-6）', () => {
  const saved = getBrowserBridge();
  afterEach(() => setBrowserBridge(saved));

  it('内容写入后年龄随时间增长；换 URL 不重置内容时钟（旧内容继续变旧）', () => {
    const st = new BrowserStateStore();
    expect(st.getContentAgeMs()).toBeNull(); // 无内容
    st.setState('https://a.com', '文本');
    const t0 = Date.now();
    const a1 = st.getContentAgeMs(t0) ?? -1;
    expect(a1).toBeGreaterThanOrEqual(0);
    expect(a1).toBeLessThan(100); // 刚写入 ≈ 0
    st.setState('https://b.com', null); // 只换 URL
    const a2 = st.getContentAgeMs(t0 + 120_000) ?? -1;
    expect(a2).toBeGreaterThanOrEqual(120_000 - 50); // 内容时钟未重置（容忍写入时刻的毫秒差）
  });

  it('BrowserContent 带 meta 时输出内容年龄；>2 分钟提示建议刷新', async () => {
    const st = new BrowserStateStore();
    st.setState('https://a.com/doc', '面板内容');
    const t0 = Date.now();
    setBrowserBridge({
      navigate: async () => true,
      getUrl: async () => st.getUrl(),
      getContent: async () => st.getContent(),
      getContentMeta: async () => ({ content: st.getContent(), ageMs: st.getContentAgeMs(t0) }),
    });
    const fresh = await createBrowserContentTool().execute({});
    expect(fresh.ok).toBe(true);
    expect(fresh.output).toContain('内容更新于 0 秒前');
    // 模拟 3 分钟后读取
    setBrowserBridge({
      navigate: async () => true,
      getUrl: async () => st.getUrl(),
      getContent: async () => st.getContent(),
      getContentMeta: async () => ({ content: st.getContent(), ageMs: st.getContentAgeMs(t0 + 180_000) }),
    });
    const stale = await createBrowserContentTool().execute({});
    expect(stale.output).toContain('内容较旧');
    expect(stale.output).toContain('BrowserNavigate');
  });

  it('无 meta 的旧 bridge 行为不变（不标注时效）', async () => {
    setBrowserBridge({
      navigate: async () => true,
      getUrl: async () => 'https://a.com',
      getContent: async () => '旧桥内容',
    });
    const out = await createBrowserContentTool().execute({});
    expect(out.ok).toBe(true);
    expect(out.output).not.toContain('秒前');
    expect(out.output).toContain('旧桥内容');
  });
});
