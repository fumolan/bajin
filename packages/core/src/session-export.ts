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
