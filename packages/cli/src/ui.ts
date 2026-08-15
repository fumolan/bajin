import { styleText } from 'node:util';
import type { ToolResult } from '@bajin/shared';

export const dim = (s: string) => styleText('gray', s);
export const bold = (s: string) => styleText('bold', s);
export const cyan = (s: string) => styleText('cyan', s);
export const yellow = (s: string) => styleText('yellow', s);
export const green = (s: string) => styleText('green', s);
export const red = (s: string) => styleText('red', s);

/** 工具参数的单行摘要（用于工具调用展示与审批提示） */
export function summarizeArgs(name: string, args: unknown): string {
  if (args === null || typeof args !== 'object') return String(args);
  const a = args as Record<string, unknown>;
  switch (name) {
    case 'Read':
      return String(a['file_path'] ?? '');
    case 'Write':
    case 'Edit':
      return `${a['file_path'] ?? ''}${name === 'Edit' ? `（替换 ${String(a['old_string'] ?? '').length} 字符）` : `（${String(a['content'] ?? '').length} 字符）`}`;
    case 'Bash':
      return String(a['command'] ?? '').slice(0, 120);
    case 'Glob':
      return String(a['pattern'] ?? '');
    case 'Grep':
      return `/${String(a['pattern'] ?? '')}/${a['ignore_case'] ? 'i' : ''}`;
    default:
      return JSON.stringify(args).slice(0, 120);
  }
}

export function formatToolResult(result: ToolResult & { denied?: boolean }, maxLines = 8): string {
  const lines = result.output.split('\n');
  const shown = lines.slice(0, maxLines).join('\n');
  const more = lines.length > maxLines ? dim(`\n…(+${lines.length - maxLines} 行)`) : '';
  return `${result.denied || !result.ok ? red(shown) : dim(shown)}${more}`;
}

export const BANNER = `${cyan('bajin')} ${dim('v0.1.0')} — 交互式编码代理
${dim('命令: /help 帮助 · /model <名> 切模型 · /mode <模式> 切权限 · /clear 清空会话 · /exit 退出')}`;
