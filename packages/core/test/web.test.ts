import { describe, it, expect } from 'vitest';
import { createWebFetchTool, createWebSearchTool, htmlToText, parseDuckResults } from '../src/tools/web.js';

const res = (body: string, init: ResponseInit = {}): Response =>
  new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' }, ...init });

describe('WebFetch 工具（fetchImpl 注入，不触网）', () => {
  it('HTML 转纯文本：去 script/style、块级转换行、实体解码', async () => {
    const tool = createWebFetchTool({ fetchImpl: async () => res('<script>bad()</script><h1>标题</h1><p>第一段 &amp; 更多</p><style>x{}</style><div>第二段</div>') });
    const r = await tool.execute({ url: 'https://x.test/a', format: 'text' }, { cwd: '.' } as never);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('标题');
    expect(r.output).toContain('第一段 & 更多');
    expect(r.output).toContain('第二段');
    expect(r.output).not.toContain('bad()');
    expect(r.output).not.toContain('x{}');
    expect(r.output.indexOf('标题')).toBeLessThan(r.output.indexOf('第二段'));
  });

  it('raw 模式原样返回；非 http(s) 拒绝；HTTP 错误码报错', async () => {
    const raw = createWebFetchTool({ fetchImpl: async () => res('plain text') });
    expect((await raw.execute({ url: 'https://x.test/a', format: 'raw' }, { cwd: '.' } as never)).output).toBe('plain text');
    const bad = await createWebFetchTool({ fetchImpl: async () => raw.execute({ url: 'ftp://x', format: 'text' }, { cwd: '.' } as never) } as never)
      .execute({ url: 'ftp://x.test/f', format: 'text' }, { cwd: '.' } as never);
    expect(bad.ok).toBe(false);
    const err = createWebFetchTool({ fetchImpl: async () => new Response('nope', { status: 503 }) });
    const r503 = await err.execute({ url: 'https://x.test/down', format: 'text' }, { cwd: '.' } as never);
    expect(r503.ok).toBe(false);
    expect(r503.output).toContain('503');
  });

  it('超时中断（AbortController 触发 fetchImpl 的 signal）', async () => {
    const tool = createWebFetchTool({
      timeoutMs: 100,
      fetchImpl: (_u, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))); }),
    });
    const r = await tool.execute({ url: 'https://x.test/hang', format: 'text' }, { cwd: '.' } as never);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('抓取失败');
  });
});

describe('WebSearch 工具（DuckDuckGo HTML 解析）', () => {
  const DDG_PAGE = `
  <div class="result results_links">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvitest.dev%2Fguide%2F&rut=abc">Vitest <strong>Guide</strong></a>
    <a class="result__snippet" href="#">Next generation &lt;testing&gt; framework</a>
  </div>
  <div class="result result--ad">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fad&rut=x">广告位</a>
  </div>
  <div class="no-result">没有别的</div>`;

  it('解析标题/摘要，uddg 跳转链接还原为真实 URL，去 strong 标签', () => {
    const rs = parseDuckResults(DDG_PAGE);
    expect(rs.length).toBe(2);
    expect(rs[0]?.url).toBe('https://vitest.dev/guide/');
    expect(rs[0]?.title).toBe('Vitest Guide');
    expect(rs[0]?.snippet).toContain('testing');
    expect(rs[1]?.url).toBe('https://example.com/ad');
  });

  it('搜索工具：组装编号结果；provider=off 时明确拒绝', async () => {
    const tool = createWebSearchTool({ fetchImpl: async () => res(DDG_PAGE) });
    const r = await tool.execute({ query: 'vitest guide' }, { cwd: '.' } as never);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('1. Vitest Guide');
    expect(r.output).toContain('https://vitest.dev/guide/');
    const off = createWebSearchTool({ fetchImpl: async () => res(DDG_PAGE), provider: 'off' });
    const rOff = await off.execute({ query: 'x' }, { cwd: '.' } as never);
    expect(rOff.ok).toBe(false);
    expect(rOff.output).toContain('off');
  });

  it('无结果时返回明确提示而非报错', async () => {
    const tool = createWebSearchTool({ fetchImpl: async () => res('<html><body>empty</body></html>') });
    const r = await tool.execute({ query: '不存在的词' }, { cwd: '.' } as never);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('无结果');
  });
});

describe('htmlToText 纯函数', () => {
  it('压缩空白与连续空行', () => {
    expect(htmlToText('<p>a</p>\n\n\n<div>\n b \n</div>')).toBe('a\nb');
  });
});
