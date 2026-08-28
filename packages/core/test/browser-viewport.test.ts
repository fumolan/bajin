import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBrowserNavigateTool, setBrowserBridge, getBrowserBridge, type BrowserBridge } from '../src/tools/browser.js';

/** 录制型假 bridge：记录 navigate/setViewport/setZoom 调用 */
function recordingBridge(withOptional: boolean): BrowserBridge & { calls: string[] } {
  const rec: BrowserBridge & { calls: string[] } = {
    calls: [],
    async navigate(url) { rec.calls.push(`navigate:${url}`); return true; },
    async getUrl() { return 'https://example.com/page'; },
    async getContent() { return '页面文本'; },
    ...(withOptional
      ? {
          async setViewport(width: number, height: number) { rec.calls.push(`viewport:${width}x${height}`); return true; },
          async setZoom(factor: number) { rec.calls.push(`zoom:${factor}`); return true; },
        }
      : {}),
  };
  return rec;
}

describe('BrowserNavigate 视口/缩放（R6）', () => {
  const savedBridge = getBrowserBridge();
  afterEach(() => setBrowserBridge(savedBridge));
  beforeEach(() => setBrowserBridge(null));

  it('带 viewport+zoom 时经 bridge 依序应用并在输出确认', async () => {
    const rec = recordingBridge(true);
    setBrowserBridge(rec);
    const tool = createBrowserNavigateTool();
    const out = await tool.execute({ url: 'https://example.com/', viewport: { width: 390, height: 844 }, zoom: 1.5 });
    expect(out.ok).toBe(true);
    expect(rec.calls).toEqual(['navigate:https://example.com/', 'viewport:390x844', 'zoom:1.5']);
    expect(out.output).toContain('视口 390×844');
    expect(out.output).toContain('缩放 1.5×');
  });

  it('旧 bridge（无可选方法）不受影响：只导航，不报错', async () => {
    const rec = recordingBridge(false);
    setBrowserBridge(rec);
    const tool = createBrowserNavigateTool();
    const out = await tool.execute({ url: 'https://example.com/', viewport: { width: 800, height: 600 }, zoom: 2 });
    expect(out.ok).toBe(true);
    expect(rec.calls).toEqual(['navigate:https://example.com/']);
    expect(out.output).not.toContain('已应用'); // 无可选能力时不虚报
  });

  it('无 bridge 时仍走文本降级（行为不变）', async () => {
    setBrowserBridge(null);
    const tool = createBrowserNavigateTool(async () => '降级文本');
    const out = await tool.execute({ url: 'https://example.com/', viewport: { width: 390, height: 844 } });
    expect(out.ok).toBe(true);
    expect(out.output).toContain('文本模式');
    expect(out.output).toContain('降级文本');
  });
});
