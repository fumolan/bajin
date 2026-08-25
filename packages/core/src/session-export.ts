/**
 * 会话导出 Markdown（对标 ZCode 会话导出）：ChatMessage[] → 可读 .md 文档。
 * 用户消息 👤、助手 🤖、工具调用折叠为链接式、系统消息省略。
 */

import type { ChatMessage } from '@bajin/shared';
import type { SessionMeta } from './session.js';

/** 单条 ChatMessage → Markdown 段 */
function msgToMd(m: ChatMessage, idx: number): string {
  switch (m.role) {
    case 'user':
      return `## 👤 用户\n\n${m.content}\n`;
    case 'assistant': {
      let out = '';
      if (m.content?.trim()) out += `## 🤖 助手\n\n${m.content}\n`;
      if (m.toolCalls?.length) {
        out += `\n<details>\n<summary>🔧 工具调用（${m.toolCalls.length} 个）</summary>\n\n`;
        for (const c of m.toolCalls) {
          out += `- **${c.name}**\n  \`\`\`json\n  ${c.arguments.slice(0, 500)}\n  \`\`\`\n`;
        }
        out += `</details>\n`;
      }
      return out || '';
    }
    case 'tool':
      return ''; // 工具结果已在 assistant 的 toolCalls 中摘要；单独的 tool 消息不重复输出
    case 'system':
      return ''; // 系统消息不导出
    default:
      return '';
  }
}

/** 导出完整会话为 Markdown 文档 */
export function exportSessionMarkdown(
  messages: ChatMessage[],
  meta?: Partial<SessionMeta> & { tokens?: number },
): string {
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const lines: string[] = [
    `# ${meta?.title ?? '会话导出'}`,
    '',
    `> 导出时间：${now}`,
    `> 模型：${meta?.model ?? '—'} · 会话 ID：${meta?.sessionId ?? '—'}`,
    meta?.cwd ? `> 工作目录：\`${meta.cwd}\`` : '',
    '',
    '---',
    '',
  ];
  for (let i = 0; i < messages.length; i++) {
    const seg = msgToMd(messages[i]!, i);
    if (seg) lines.push(seg);
  }
  if (meta?.tokens) {
    lines.push('', `---`, `*约 ${meta.tokens} tokens*`);
  }
  return lines.join('\n');
}

/* ---------- HTML 导出（独立页面，内嵌样式，可直接分享） ---------- */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 单条消息 → HTML 块（工具调用折叠为 <details>） */
function msgToHtml(m: ChatMessage): string {
  switch (m.role) {
    case 'user':
      return `<section class="msg user"><div class="who">👤 用户</div><div class="body">${escapeHtml(m.content)}</div></section>`;
    case 'assistant': {
      let out = '<section class="msg assistant">';
      if (m.content?.trim()) out += `<div class="who">🤖 助手</div><div class="body">${escapeHtml(m.content)}</div>`;
      if (m.toolCalls?.length) {
        out += `<details class="tools"><summary>🔧 工具调用（${m.toolCalls.length}）</summary>`;
        for (const c of m.toolCalls) {
          out += `<div class="tool"><code>${escapeHtml(c.name)}</code><pre>${escapeHtml(c.arguments.slice(0, 600))}</pre></div>`;
        }
        out += '</details>';
      }
      return out + '</section>';
    }
    default:
      return ''; // system/tool 不重复输出
  }
}

/** 导出会话为独立 HTML 页面（深色主题，无外部依赖，浏览器直开） */
export function exportSessionHtml(
  messages: ChatMessage[],
  meta?: Partial<SessionMeta> & { tokens?: number },
): string {
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const body = messages.map(msgToHtml).filter(Boolean).join('\n');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta?.title ?? 'bajin 会话导出')}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px 64px;
    background: #15171c; color: #d7dae0;
    font: 14px/1.7 -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  }
  .wrap { max-width: 820px; margin: 0 auto; }
  header { border-bottom: 1px solid #2a2d35; padding-bottom: 12px; margin-bottom: 20px; }
  h1 { font-size: 18px; margin: 0 0 6px; color: #e8eaee; }
  .meta { color: #7c818c; font-size: 12.5px; }
  .msg { margin-bottom: 18px; padding: 12px 14px; border-radius: 10px; }
  .msg.user { background: #232732; border: 1px solid #2e3340; }
  .msg.assistant { background: #1a1d24; border: 1px solid #262a34; }
  .who { font-size: 12px; color: #8b909b; margin-bottom: 6px; }
  .body { white-space: pre-wrap; word-break: break-word; }
  details.tools { margin-top: 8px; font-size: 12.5px; }
  details.tools summary { cursor: pointer; color: #8b909b; }
  .tool { margin: 6px 0 10px; }
  .tool code { color: #7fb2ff; }
  .tool pre {
    background: #101218; border: 1px solid #262a34; border-radius: 6px;
    padding: 8px 10px; overflow-x: auto; font-size: 12px; margin: 4px 0 0;
  }
  footer { margin-top: 28px; color: #585d68; font-size: 12px; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${escapeHtml(meta?.title ?? '会话导出')}</h1>
    <div class="meta">导出时间 ${now} · 模型 ${escapeHtml(meta?.model ?? '—')} · 会话 ${escapeHtml(meta?.sessionId ?? '—')}${meta?.cwd ? ` · 目录 ${escapeHtml(meta.cwd)}` : ''}</div>
  </header>
  ${body}
  <footer>bajin export --format html${meta?.tokens ? ` · 约 ${meta.tokens} tokens` : ''}</footer>
</div>
</body>
</html>
`;
}
