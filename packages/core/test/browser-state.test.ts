import { describe, it, expect, afterEach } from 'vitest';
import { BrowserStateStore, setBrowserBridge, getBrowserBridge, createBrowserContentTool } from '../src/tools/browser.js';

describe('浏览器面板状态仓 + BrowserContent 回读（R6-2）', () => {
  const saved = getBrowserBridge();
  afterEach(() => setBrowserBridge(saved));
  afterEach(() => setBrowserBridge(null));

  it('状态仓：推送→读取→清空', () => {
    const st = new BrowserStateStore();
    expect(st.getUrl()).toBeNull();
    expect(st.getContent()).toBeNull();
    st.setState('https://example.com/a', '页面文本 A');
    expect(st.getUrl()).toBe('https://example.com/a');
    expect(st.getContent()).toBe('页面文本 A');
    expect(st.updatedAtMs).toBeGreaterThan(0);
    st.clear();
    expect(st.getUrl()).toBeNull();
    expect(st.getContent()).toBeNull();
  });

  it('状态仓：null 字段不覆盖（只推 URL 不清内容）', () => {
    const st = new BrowserStateStore();
    st.setState('https://example.com/a', '文本');
    st.setState('https://example.com/b', null); // 换页但文本未取到
    expect(st.getUrl()).toBe('https://example.com/b');
    expect(st.getContent()).toBe('文本'); // 保留旧值，避免闪断
  });

  it('BrowserContent 经 store 桥读到真实面板内容（不再降级）', async () => {
    const st = new BrowserStateStore();
    setBrowserBridge({
      navigate: async () => true,
      getUrl: async () => st.getUrl(),
      getContent: async () => st.getContent(),
    });
    st.setState('https://example.com/doc', '面板里的真实内容');
    const out = await createBrowserContentTool().execute({});
    expect(out.ok).toBe(true);
    expect(out.output).toContain('URL: https://example.com/doc');
    expect(out.output).toContain('面板里的真实内容');
  });

  it('状态仓为空时 BrowserContent 明确提示先导航（不误报成功）', async () => {
    const st = new BrowserStateStore();
    setBrowserBridge({
      navigate: async () => true,
      getUrl: async () => st.getUrl(),
      getContent: async () => st.getContent(),
    });
    const out = await createBrowserContentTool().execute({});
    expect(out.ok).toBe(false);
    expect(out.output).toContain('先用 BrowserNavigate');
  });
});
