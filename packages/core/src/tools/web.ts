/**
 * Web 工具（对标 ZCode WebSearch/WebFetch）：
 * - WebFetch：抓 URL → HTML 转文本（标签剥离 + 实体解码），大小/超时受限，UA 标识 bajin-WebFetch/0.1
 * - WebSearch：可插拔 provider，默认免 key 的 DuckDuckGo HTML 端点解析标题/摘要/链接
 * provider 经 ~/.bajin/config.json 的 web.provider 配置（duckduckgo | off，off 时工具报不可用）。
 * fetchImpl 可注入（测试用），生产走全局 fetch。
 */

import { z } from 'zod';
import type { ToolDefinition } from '@bajin/shared';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const USER_AGENT = 'bajin-WebFetch/0.1';
const FETCH_TIMEOUT_MS = 30_000;
const MAX_BYTES = 512 * 1024;
const MAX_OUTPUT_CHARS = 20_000;
const SEARCH_RESULTS = 8;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface WebConfig {
  provider: 'duckduckgo' | 'off';
}

export async function loadWebConfig(home = os.homedir()): Promise<WebConfig> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(home, '.bajin', 'config.json'), 'utf8')) as { web?: { provider?: string } };
    const p = raw.web?.provider;
    return { provider: p === 'off' ? 'off' : 'duckduckgo' };
  } catch {
    return { provider: 'duckduckgo' };
  }
}

async function httpGet(url: string, fetchImpl: FetchLike, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,text/plain,*/*' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new Error(`响应过大（${Math.round(buf.byteLength / 1024)}KB > 512KB），拒绝读取`);
    return new TextDecoder('utf-8').decode(buf);
  } finally {
    clearTimeout(timer);
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#?\w+);/g, (_, e: string) => ENTITIES[e] ?? (e.startsWith('#') ? String.fromCodePoint(Number(e.slice(1)) || 63) : _));
}

/** HTML → 纯文本：换行只由块级标签/br 产生（源码空白先压平，保证输出确定性） */
export function htmlToText(html: string): string {
  const marked = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');
  return decodeEntities(marked.replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
}

/** DuckDuckGo HTML 结果页解析：.result 条目内 a.result__a（标题+链接）与 .result__snippet */
export function parseDuckResults(html: string): Array<{ title: string; url: string; snippet: string }> {
  const out: Array<{ title: string; url: string; snippet: string }> = [];
  for (const block of html.split(/class="[^"]*\bresult\b[^"]*"/).slice(1)) {
    const link = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    let url = decodeEntities(link[1]!);
    // DuckDuckGo 跳转包装：/l/?uddg=<encoded>&rut=...
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]!);
    const snippetMatch = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/.exec(block);
    out.push({
      title: htmlToText(link[2]!).slice(0, 200),
      url,
      snippet: snippetMatch ? htmlToText(snippetMatch[1]!).slice(0, 300) : '',
    });
    if (out.length >= SEARCH_RESULTS) break;
  }
  return out;
}

const FetchInput = z.object({
  url: z.string().url().describe('要抓取的 http(s) 地址'),
  format: z.enum(['text', 'raw']).default('text').describe('text=HTML 转纯文本；raw=原样返回'),
});

export function createWebFetchTool(opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {}): ToolDefinition<typeof FetchInput> {
  const doFetch = opts.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  return {
    name: 'WebFetch',
    description: 'Fetch a URL and return page text (HTML stripped). 适合读取文档/博客/接口说明；超大或超时（30s）会报错。',
    inputSchema: FetchInput,
    metadata: { readOnly: true, riskLevel: 'low', timeoutMs: timeoutMs + 5_000, concurrentSafe: true },
    async execute(input) {
      if (!/^https?:\/\//.test(input.url)) return { ok: false, output: '仅支持 http(s) URL' };
      try {
        const body = await httpGet(input.url, doFetch, timeoutMs);
        const text = input.format === 'raw' ? body.slice(0, MAX_OUTPUT_CHARS) : htmlToText(body).slice(0, MAX_OUTPUT_CHARS);
        return { ok: true, output: text || '（页面无文本内容）' };
      } catch (err) {
        return { ok: false, output: `抓取失败: ${err instanceof Error ? err.message : err}` };
      }
    },
  };
}

const SearchInput = z.object({
  query: z.string().min(1).describe('搜索关键词'),
});

export function createWebSearchTool(opts: { fetchImpl?: FetchLike; provider?: WebConfig['provider']; timeoutMs?: number } = {}): ToolDefinition<typeof SearchInput> {
  const doFetch = opts.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  return {
    name: 'WebSearch',
    description: 'Search the web (DuckDuckGo, no API key) and return top results with title/url/snippet. 用于找资料、查文档、核对最新信息。',
    inputSchema: SearchInput,
    metadata: { readOnly: true, riskLevel: 'low', timeoutMs: timeoutMs + 5_000, concurrentSafe: true },
    async execute(input) {
      if ((opts.provider ?? 'duckduckgo') === 'off') return { ok: false, output: 'WebSearch 已被配置关闭（web.provider=off）' };
      try {
        const html = await httpGet(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`, doFetch, timeoutMs);
        const results = parseDuckResults(html);
        if (!results.length) return { ok: true, output: `「${input.query}」无结果（或页面结构变化）` };
        return {
          ok: true,
          output: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n'),
        };
      } catch (err) {
        return { ok: false, output: `搜索失败: ${err instanceof Error ? err.message : err}` };
      }
    },
  };
}
