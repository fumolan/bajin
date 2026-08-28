/**
 * Browser 工具（对标 ZCode browser 面板 + agent 浏览器控制）：
 * BrowserNavigate：让桌面浏览器面板加载 URL（无面板时降级为 WebFetch 文本抓取）
 * BrowserContent：获取浏览器面板当前页面文本（降级同上）
 * 桌面 IPC 约定：主进程转发 bajin:browser:navigate → 渲染层 webview.loadURL
 */

import { z } from 'zod';
import type { ToolDefinition } from '@bajin/shared';
import { htmlToText } from './web.js';
export { normalizeBrowserUrl } from '@bajin/shared';

/** 桌面端注入的浏览器控制桥（无面板时为 undefined → 降级 WebFetch） */
export interface BrowserBridge {
  navigate(url: string): Promise<boolean>;
  getUrl(): Promise<string | null>;
  getContent(): Promise<string | null>;
  /** R6-5 CUA：在面板页面内点击元素（CSS 选择器）。可选能力 */
  click?(selector: string): Promise<boolean>;
  /** R6-5 CUA：向输入元素键入文本（CSS 选择器）。可选能力 */
  type?(selector: string, text: string): Promise<boolean>;
  /** R7-6：内容元信息（含年龄），BrowserContent 输出标注时效用。可选能力 */
  getContentMeta?(): Promise<{ content: string | null; ageMs: number | null } | null>;
  /** R6：设置面板视口尺寸（像素）。可选能力——未实现的面板静默忽略 */
  setViewport?(width: number, height: number): Promise<boolean>;
  /** R6：设置页面缩放（0.25–5）。可选能力 */
  setZoom?(factor: number): Promise<boolean>;
}

/** 服务端页面文本抓取（httpGet + HTML→文本）：BrowserNavigate 降级与 R7-1 回读补偿共用 */
export async function fetchPageText(url: string): Promise<string> {
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

/**
 * CUA 动作结果汇聚器（R7-2）：bridge 发出 click/type 事件后等面板真实执行结果，
 * 替代"盲返 true"。支持先到结果后等待（渲染层可能快于注册）、超时、重复解决幂等。
 */
export class ActionResultHub {
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (r: { ok: boolean; reason?: string }) => void }>();
  private readonly early = new Map<number, { ok: boolean; reason?: string }>();

  nextSeq(): number {
    return ++this.seq;
  }

  /** 等待某次动作的执行结果；超时按失败返回（reason 标明超时） */
  wait(seq: number, timeoutMs: number): Promise<{ ok: boolean; reason?: string }> {
    const hit = this.early.get(seq);
    if (hit) { this.early.delete(seq); return Promise.resolve(hit); }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        resolve({ ok: false, reason: `面板执行结果超时（${timeoutMs}ms）` });
      }, timeoutMs);
      this.pending.set(seq, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
      });
    });
  }

  /** 面板回填结果：无等待者时暂存（先到结果后等待） */
  resolve(seq: number, ok: boolean, reason?: string): void {
    const p = this.pending.get(seq);
    if (p) { this.pending.delete(seq); p.resolve({ ok, reason }); return; }
    this.early.set(seq, { ok, reason });
  }
}

/**
 * 浏览器面板状态仓（R6-2 状态回读）：渲染层页面加载后经 'browser/state' RPC 推送
 * 最新 URL/文本，app-server 侧 bridge 的 getUrl/getContent 从这里取——
 * BrowserContent 工具由此摆脱「永远降级文本抓取」。跨进程单向推送，无回询。
 */
export class BrowserStateStore {
  private url: string | null = null;
  private content: string | null = null;
  private updatedAt = 0;
  /** 内容实际写入的时刻（R7-6 时效）：换 URL 不重置——旧内容年龄继续增长，提示该重新抓 */
  private contentAt = 0;

  setState(url: string | null, content: string | null): void {
    if (url !== null) this.url = url;
    if (content !== null) {
      this.content = content;
      this.contentAt = Date.now();
    }
    this.updatedAt = Date.now();
  }

  /** 内容年龄（ms）；无内容返回 null */
  getContentAgeMs(now = Date.now()): number | null {
    return this.content != null ? now - this.contentAt : null;
  }

  /** 变更写入（R7-7 去重）：内容相同返回 false 且不动 contentAt——页面没变就不伪造“刚更新”；
   * 内容不同（或原为空）返回 true 并重置内容时钟。 */
  setContentIfChanged(content: string): boolean {
    if (this.content === content) return false;
    this.content = content;
    this.contentAt = Date.now();
    this.updatedAt = Date.now();
    return true;
  }

  getUrl(): string | null {
    return this.url;
  }

  getContent(): string | null {
    return this.content;
  }

  get updatedAtMs(): number {
    return this.updatedAt;
  }

  clear(): void {
    this.url = null;
    this.content = null;
    this.updatedAt = 0;
  }
}

const NavigateInput = z.object({
  url: z.string().url().describe('要打开的 http(s) 地址'),
  viewport: z
    .object({
      width: z.number().int().min(200).max(3840).describe('视口宽（px）'),
      height: z.number().int().min(200).max(4320).describe('视口高（px）'),
    })
    .optional()
    .describe('面板视口尺寸（模拟移动端/宽屏）'),
  zoom: z.number().min(0.25).max(5).optional().describe('页面缩放倍数'),
});

export function createBrowserNavigateTool(fetchPage: (url: string) => Promise<string> = fetchPageText): ToolDefinition<typeof NavigateInput> {
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
        if (ok) {
          const extras: string[] = [];
          if (input.viewport && b.setViewport) {
            const vOk = await b.setViewport(input.viewport.width, input.viewport.height).catch(() => false);
            if (vOk) extras.push(`视口 ${input.viewport.width}×${input.viewport.height}`);
          }
          if (input.zoom != null && b.setZoom) {
            const zOk = await b.setZoom(input.zoom).catch(() => false);
            if (zOk) extras.push(`缩放 ${input.zoom}×`);
          }
          return { ok: true, output: `浏览器面板已打开：${input.url}${extras.length ? `\n已应用：${extras.join('，')}` : ''}\n用 BrowserContent 获取页面文本。` };
        }
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

export function createBrowserContentTool(fetchPage: (url: string) => Promise<string> = fetchPageText): ToolDefinition<typeof ContentInput> {
  return {
    name: 'BrowserContent',
    description: 'Get the text content of the current page in the browser panel. 无面板时降级为 WebFetch。',
    inputSchema: ContentInput,
    metadata: { readOnly: true, riskLevel: 'low', timeoutMs: 35_000, concurrentSafe: true },
    async execute() {
      const b = getBrowserBridge();
      if (b) {
        // 时效优先（R7-6）：有 meta 就带内容年龄，模型可判断要不要重抓
        const meta = await b.getContentMeta?.().catch(() => null);
        const content = meta ? meta.content : await b.getContent().catch(() => null);
        const url = await b.getUrl().catch(() => null);
        if (content) {
          const age = meta?.ageMs;
          const stale = age != null && age > 120_000 ? '（⚠ 内容较旧，建议 BrowserNavigate 重开刷新）' : age != null ? `（内容更新于 ${Math.round(age / 1000)} 秒前）` : '';
          return { ok: true, output: `URL: ${url ?? '?'}${stale}\n\n${content.slice(0, 12_000)}` };
        }
        return { ok: false, output: `浏览器面板无页面（URL: ${url ?? '未打开'}），先用 BrowserNavigate` };
      }
      return { ok: false, output: '无浏览器面板可用（桌面端未注入桥接）' };
    },
  };
}


const ClickInput = z.object({
  selector: z.string().min(1).max(300).describe('CSS 选择器（如 #submit、a[href="/docs"]）'),
  description: z.string().max(200).optional().describe('本次点击的意图（审批卡展示给人看）'),
});

/** 浏览器点击（R6-5 CUA）：非只读 → 默认模式走审批（approval 卡带 CUA 提示） */
export function createBrowserClickTool(): ToolDefinition<typeof ClickInput> {
  return {
    name: 'BrowserClick',
    description:
      'Click an element in the built-in browser panel (CUA). 需要用户批准；请同时给 description 说明意图。',
    inputSchema: ClickInput,
    metadata: { readOnly: false, riskLevel: 'medium', timeoutMs: 15_000, concurrentSafe: false },
    async execute(input) {
      const b = getBrowserBridge();
      if (!b?.click) return { ok: false, output: '无浏览器面板可用（桌面/Web 打开面板后重试）' };
      const ok = await b.click(input.selector).catch(() => false);
      return ok
        ? { ok: true, output: `已点击：${input.selector}${input.description ? `（${input.description}）` : ''}\n用 BrowserContent 读取页面变化。` }
        : { ok: false, output: `点击失败：${input.selector}（选择器可能未命中）` };
    },
  };
}

const TypeInput = z.object({
  selector: z.string().min(1).max(300).describe('目标输入框的 CSS 选择器'),
  text: z.string().max(2000).describe('要键入的文本'),
  submit: z.boolean().optional().describe('键入后按 Enter 提交'),
});

/** 浏览器键入（R6-5 CUA）：非只读 → 默认模式走审批 */
export function createBrowserTypeTool(): ToolDefinition<typeof TypeInput> {
  return {
    name: 'BrowserType',
    description: 'Type text into an input in the built-in browser panel (CUA). 需要用户批准。',
    inputSchema: TypeInput,
    metadata: { readOnly: false, riskLevel: 'medium', timeoutMs: 15_000, concurrentSafe: false },
    async execute(input) {
      const b = getBrowserBridge();
      if (!b?.type) return { ok: false, output: '无浏览器面板可用（桌面/Web 打开面板后重试）' };
      const ok = await b.type(input.selector, input.text).catch(() => false);
      return ok
        ? { ok: true, output: `已键入 ${input.text.length} 字符到 ${input.selector}${input.submit ? ' 并回车' : ''}` }
        : { ok: false, output: `键入失败：${input.selector}（元素可能不是输入框）` };
    },
  };
}

/**
 * 服务端代抓去重判定（R7-7）：同一 URL 在 TTL 内不重复代抓（面板 iframe 重载/重复上报防抖）。
 * 换 URL 立即放行；TTL 过期放行（页面可能已更新）。
 */
export function shouldBackfill(url: string, lastUrl: string | null, lastAt: number, now = Date.now(), ttlMs = 30_000): boolean {
  if (url !== lastUrl) return true;
  return now - lastAt >= ttlMs;
}
