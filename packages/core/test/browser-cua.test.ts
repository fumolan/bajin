import { describe, it, expect, afterEach } from 'vitest';
import { createBrowserClickTool, createBrowserTypeTool, setBrowserBridge, getBrowserBridge, builtinTools } from '../src/index.js';
import { PermissionPolicy } from '../src/permissions.js';

describe('浏览器 CUA 工具（R6-5）', () => {
  const saved = getBrowserBridge();
  afterEach(() => setBrowserBridge(saved));

  it('BrowserClick 经 bridge 执行并回显意图', async () => {
    const calls: string[] = [];
    setBrowserBridge({
      navigate: async () => true,
      getUrl: async () => null,
      getContent: async () => null,
      click: async (sel) => { calls.push(`click:${sel}`); return true; },
    });
    const out = await createBrowserClickTool().execute({ selector: '#submit', description: '提交表单' });
    expect(out.ok).toBe(true);
    expect(calls).toEqual(['click:#submit']);
    expect(out.output).toContain('提交表单');
  });

  it('BrowserType 键入文本；选择器未命中返回失败', async () => {
    const calls: string[] = [];
    setBrowserBridge({
      navigate: async () => true,
      getUrl: async () => null,
      getContent: async () => null,
      type: async (sel, text) => { calls.push(`type:${sel}:${text}`); return sel !== '#missing'; },
    });
    const ok = await createBrowserTypeTool().execute({ selector: '#q', text: 'bajin 测试', submit: true });
    expect(ok.ok).toBe(true);
    expect(ok.output).toContain('并回车');
    expect(calls).toEqual(['type:#q:bajin 测试']);
    const miss = await createBrowserTypeTool().execute({ selector: '#missing', text: 'x' });
    expect(miss.ok).toBe(false);
    expect(miss.output).toContain('键入失败');
  });

  it('无 bridge（无面板）时明确失败，不误报成功', async () => {
    setBrowserBridge(null);
    const click = await createBrowserClickTool().execute({ selector: '#a' });
    expect(click.ok).toBe(false);
    expect(click.output).toContain('无浏览器面板');
    const type = await createBrowserTypeTool().execute({ selector: '#a', text: 'x' });
    expect(type.ok).toBe(false);
  });

  it('权限门控：默认(build)模式 CUA 动作走审批、yolo 直通、plan 拒绝', () => {
    const clickTool = builtinTools.find((t) => t.name === 'BrowserClick')!;
    expect(clickTool).toBeTruthy();
    const build = new PermissionPolicy({ mode: 'build' });
    expect(build.decide(clickTool)).toBe('ask');   // 非只读 → 审批（CUA 权限面板路径）
    const yolo = new PermissionPolicy({ mode: 'yolo' });
    expect(yolo.decide(clickTool)).toBe('allow');
    const plan = new PermissionPolicy({ mode: 'plan' });
    expect(plan.decide(clickTool)).toBe('deny');
    // 「始终允许」后不再询问
    const granted = new PermissionPolicy({ mode: 'build', allowedTools: ['BrowserClick'] });
    expect(granted.decide(clickTool)).toBe('allow');
  });
});
