/**
 * 记忆系统（对标 ZCode Memory）：跨会话的长期偏好与事实。
 * 两级存储：
 *   用户级  <BAJIN_HOME|~/.bajin>/memory/MEMORY.md   —— 全局偏好（常用命令、沟通风格）
 *   项目级  <cwd>/.bajin/memory/MEMORY.md            —— 项目事实（构建命令、架构决定）
 * 条目格式：`- [YYYY-MM-DD HH:mm] 文本`（追加式，一条一行）。
 * systemPrompt 注入两份全文；Memory 工具提供 save/recall/list。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { platform, type ToolDefinition } from '@bajin/shared';

export interface MemoryEntry {
  at: string;
  text: string;
  scope: 'user' | 'project';
}

export function memoryFilePath(cwd: string, scope: 'user' | 'project'): string {
  return scope === 'user'
    ? path.join(platform.stateRoot(undefined, process.env), 'memory', 'MEMORY.md')
    : path.join(cwd, '.bajin', 'memory', 'MEMORY.md');
}

export function parseMemoryFile(raw: string, scope: 'user' | 'project'): MemoryEntry[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- ['))
    .map((l) => {
      const m = /^- \[([^\]]+)\]\s*(.*)$/.exec(l);
      return { at: m?.[1] ?? '', text: (m?.[2] ?? l).trim(), scope };
    })
    .filter((e) => e.text);
}

export async function readMemories(cwd: string): Promise<MemoryEntry[]> {
  const read = (p: string) => fs.readFile(p, 'utf8').catch(() => '');
  const [user, project] = await Promise.all([read(memoryFilePath(cwd, 'user')), read(memoryFilePath(cwd, 'project'))]);
  return [...parseMemoryFile(user, 'user'), ...parseMemoryFile(project, 'project')];
}

export async function saveMemory(cwd: string, scope: 'user' | 'project', text: string): Promise<MemoryEntry> {
  const file = memoryFilePath(cwd, scope);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const at = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const entry: MemoryEntry = { at, text: text.trim(), scope };
  await fs.appendFile(file, `- [${at}] ${entry.text}\n`, 'utf8');
  return entry;
}

export async function clearMemories(cwd: string, scope: 'user' | 'project'): Promise<number> {
  const file = memoryFilePath(cwd, scope);
  try {
    const n = parseMemoryFile(await fs.readFile(file, 'utf8'), scope).length;
    await fs.writeFile(file, '', 'utf8');
    return n;
  } catch {
    return 0;
  }
}

/** systemPrompt 注入块 */
export function memoryPromptBlock(entries: MemoryEntry[]): string {
  if (!entries.length) return '';
  const fmt = (scope: 'user' | 'project') => {
    const list = entries.filter((e) => e.scope === scope);
    if (!list.length) return '';
    return `# ${scope === 'user' ? '用户长期记忆' : '项目记忆'}\n${list.map((e) => `- ${e.text}（${e.at}）`).join('\n')}\n`;
  };
  return fmt('user') + fmt('project');
}

const MemoryInput = z.object({
  action: z.enum(['save', 'recall', 'list']).describe('save=记一条；recall=按关键词检索；list=全部列出'),
  text: z.string().optional().describe('save 时必填：要记住的事实/偏好（一句话）'),
  query: z.string().optional().describe('recall 时的关键词'),
  scope: z.enum(['user', 'project']).default('user').describe('user=全局偏好；project=当前项目事实'),
});

/** Memory 工具：模型在会话中自主读写的长期记忆 */
export function createMemoryTool(cwd: () => string, onSaved?: () => void): ToolDefinition<typeof MemoryInput> {
  return {
    name: 'Memory',
    description:
      'Long-term memory across sessions. 用户表达了稳定偏好/事实（常用命令、代码风格、项目约定）时主动 save（一次一条、一句话）；需要历史偏好时 recall/list。',
    inputSchema: MemoryInput,
    metadata: { readOnly: false, riskLevel: 'low', timeoutMs: 10_000, concurrentSafe: false },
    async execute(input) {
      const dir = cwd();
      if (input.action === 'save') {
        if (!input.text?.trim()) return { ok: false, output: 'save 需要 text' };
        const e = await saveMemory(dir, input.scope, input.text);
        onSaved?.();
        return { ok: true, output: `已记住（${e.scope}）：${e.text}` };
      }
      const all = await readMemories(dir);
      if (input.action === 'list') {
        return { ok: true, output: all.length ? all.map((e) => `[${e.scope}] ${e.at} ${e.text}`).join('\n') : '（暂无记忆）' };
      }
      const q = (input.query ?? '').toLowerCase();
      const hits = q ? all.filter((e) => e.text.toLowerCase().includes(q) || e.at.includes(q)) : all;
      return { ok: true, output: hits.length ? hits.map((e) => `[${e.scope}] ${e.at} ${e.text}`).join('\n') : `没有匹配「${input.query}」的记忆` };
    },
  };
}
