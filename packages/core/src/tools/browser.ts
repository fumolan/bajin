/**
 * Browser 工具（对标 ZCode browser 面板 + agent 浏览器控制）：
 * BrowserNavigate：让桌面浏览器面板加载 URL（无面板时降级为 WebFetch 文本抓取）
 * BrowserContent：获取浏览器面板当前页面文本（降级同上）
 * 桌面 IPC 约定：主进程转发 bajin:browser:navigate → 渲染层 webview.loadURL
 */

import { z } from 'zod';
import type { ToolDefinition } from '@bajin/shared';
import { htmlToText } from './web.js';

/** 桌面端注入的浏览器控制桥（无面板时为 undefined → 降级 WebFetch） */
export interface BrowserBridge {
  navigate(url: string): Promise<boolean>;
  getUrl(): Promise<string | null>;
  getContent(): Promise<string | null>;
}

/** 默认页面抓取（httpGet + HTML→文本；测试可注入 mock） */
async function defaultFetchPage(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': 'bajin-Browser/0.1' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > 512 * 1024) throw new Error('页面过大（>512KB）');
  return htmlToText(new TextDecoder().decode(buf));
}

let bridge: BrowserBridge | null = null;
export function setBrowserBridge(b: BrowserBridge | null): void {
  bridge = b;
}
export function getBrowserBridge(): BrowserBridge | null {
  return bridge;
}

const NavigateInput = z.object({
  url: z.string().url().describe('要打开的 http(s) 地址'),
});

export function createBrowserNavigateTool(fetchPage: (url: string) => Promise<string> = defaultFetchPage): ToolDefinition<typeof NavigateInput> {
  return {
    name: 'BrowserNavigate',
    description:
      'Open a URL in the built-in browser panel (desktop). 无面板环境降级为文本抓取。适合浏览文档/网页并让用户看到。',
    inputSchema: NavigateInput,
    metadata: { readOnly: true, riskLevel: 'low', timeoutMs: 35_000, concurrentSafe: false },
    async execute(input) {
      if (!/^https?:\/\//.test(input.url)) return { ok: false, output: '仅支持 http(s) URL' };
      const b = getBrowserBridge();
      if (b) {
        const ok = await b.navigate(input.url).catch(() => false);
        if (ok) return { ok: true, output: `浏览器面板已打开：${input.url}\n用 BrowserContent 获取页面文本。` };
      }
      // 降级：WebFetch 文本
      try {
        const text = await fetchPage(input.url);
        return { ok: true, output: `（无浏览器面板，文本模式）\n${text.slice(0, 8000)}` };
      } catch (err) {
        return { ok: false, output: `打开失败: ${err instanceof Error ? err.message : err}` };
      }
    },
  };
}

const ContentInput = z.object({});

export function createBrowserContentTool(fetchPage: (url: string) => Promise<string> = defaultFetchPage): ToolDefinition<typeof ContentInput> {
  return {
    name: 'BrowserContent',
    description: 'Get the text content of the current page in the browser panel. 无面板时降级为 WebFetch。',
    inputSchema: ContentInput,
    metadata: { readOnly: true, riskLevel: 'low', timeoutMs: 35_000, concurrentSafe: true },
    async execute() {
      const b = getBrowserBridge();
      if (b) {
        const content = await b.getContent().catch(() => null);
        const url = await b.getUrl().catch(() => null);
        if (content) return { ok: true, output: `URL: ${url ?? '?'}\n\n${content.slice(0, 12_000)}` };
        return { ok: false, output: `浏览器面板无页面（URL: ${url ?? '未打开'}），先用 BrowserNavigate` };
      }
      return { ok: false, output: '无浏览器面板可用（桌面端未注入桥接）' };
    },
  };
}
