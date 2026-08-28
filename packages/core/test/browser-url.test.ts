import { describe, it, expect } from 'vitest';
import { normalizeBrowserUrl } from '../src/tools/browser.js';

describe('地址栏输入规范化（R6-3）', () => {
  it('裸域名补 https 并规范成完整 URL', () => {
    expect(normalizeBrowserUrl('example.com')).toEqual({ ok: true, url: 'https://example.com/' });
    expect(normalizeBrowserUrl('  Example.COM/docs  ')).toEqual({ ok: true, url: 'https://example.com/docs' });
  });
  it('已有 http(s) 协议保持原样（http 不强升 https）', () => {
    expect(normalizeBrowserUrl('http://a.com')).toEqual({ ok: true, url: 'http://a.com/' });
    expect(normalizeBrowserUrl('https://a.com/x?y=1')).toEqual({ ok: true, url: 'https://a.com/x?y=1' });
  });
  it('拒绝非 http 协议与坏输入', () => {
    expect(normalizeBrowserUrl('javascript:alert(1)').ok).toBe(false);
    expect(normalizeBrowserUrl('file:///etc/passwd').ok).toBe(false);
    expect(normalizeBrowserUrl('localhost').ok).toBe(false);       // 无点主机名
    expect(normalizeBrowserUrl('').ok).toBe(false);
    expect(normalizeBrowserUrl('x'.repeat(2049)).ok).toBe(false);
  });
});
