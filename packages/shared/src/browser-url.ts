/**
 * 地址栏输入规范化（浏览器面板/工具共用，纯函数无平台依赖）：
 * 补协议（缺省按 https）、仅接受 http(s)、限长。
 * "example.com" 这类裸域名不补协议会被 webview 当相对路径。
 */
export function normalizeBrowserUrl(input: string): { ok: true; url: string } | { ok: false; reason: string } {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: '地址为空' };
  if (raw.length > 2048) return { ok: false, reason: '地址过长（>2048）' };
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: '仅支持 http(s)' };
    if (!u.hostname || !u.hostname.includes('.')) return { ok: false, reason: '主机名不完整' };
    return { ok: true, url: u.toString() };
  } catch {
    return { ok: false, reason: '无法解析地址' };
  }
}
