import { z } from 'zod';
import { parseImageSize, formatImageDescription, IMAGE_EXTS } from './image.js';
import type { ToolDefinition } from '@bajin/shared';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { unifiedDiff } from '../diff.js';

const MAX_READ_BYTES = 2 * 1024 * 1024;

function resolveWithin(cwd: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

function formatWithLineNumbers(content: string, offset: number, limit?: number): string {
  const lines = content.split('\n');
  const start = Math.min(offset, Math.max(lines.length - 1, 0));
  const end = limit != null ? Math.min(start + limit, lines.length) : lines.length;
  const out: string[] = [];
  for (let i = start; i < end; i++) {
    out.push(`${String(i + 1).padStart(6)}\t${lines[i]}`);
  }
  return out.join('\n') || '(空文件)';
}

const ReadInput = z.object({
  file_path: z.string().describe('要读取的文件路径（绝对或相对 cwd）'),
  offset: z.number().int().min(0).optional().describe('起始行号（从 0 开始计）'),
  limit: z.number().int().positive().optional().describe('读取的行数'),
});

export const readTool: ToolDefinition<typeof ReadInput> = {
  name: 'Read',
  description:
    '读取本地文件内容，输出带行号的文本（cat -n 格式）。可用 offset/limit 分段读取大文件。不支持二进制文件。',
  inputSchema: ReadInput,
  metadata: { readOnly: true, riskLevel: 'low', concurrentSafe: true },
  async execute(input, ctx) {
    const file = resolveWithin(ctx.cwd, input.file_path);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) return { ok: false, output: `文件不存在或不是普通文件: ${file}` };
    // 图片：解析头部返回尺寸/占位描述（文本模型友好，多模态接口预留）
    if (IMAGE_EXTS.has(path.extname(file).toLowerCase())) {
      const head = await fs.readFile(file).then((b) => b.subarray(0, 64 * 1024)).catch(() => null);
      return { ok: true, output: formatImageDescription(file, head ? parseImageSize(head) : null, stat.size) };
    }
    if (stat.size > MAX_READ_BYTES) {
      return { ok: false, output: `文件过大（${stat.size} 字节，上限 ${MAX_READ_BYTES}），请用 offset/limit 或 Grep 定位后分段读取` };
    }
    const content = await fs.readFile(file, 'utf8');
    if (content.includes('\u0000')) return { ok: false, output: `二进制文件，无法以文本读取: ${file}` };
    return { ok: true, output: formatWithLineNumbers(content, input.offset ?? 0, input.limit) };
  },
};

const WriteInput = z.object({
  file_path: z.string().describe('目标文件路径'),
  content: z.string().describe('完整写入的文件内容'),
});

export const writeTool: ToolDefinition<typeof WriteInput> = {
  name: 'Write',
  description: '创建或整体覆盖一个文件（父目录自动创建）。如需修改现有文件的一小部分，优先用 Edit。',
  inputSchema: WriteInput,
  metadata: { readOnly: false, riskLevel: 'medium' },
  async execute(input, ctx) {
    const file = resolveWithin(ctx.cwd, input.file_path);
    const existed = await fs.readFile(file, 'utf8').catch(() => null);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, input.content, 'utf8');
    const rel = path.relative(ctx.cwd, file);
    // 覆盖已有文件时返回 diff；新建文件给内容预览
    if (existed !== null) {
      return { ok: true, output: `已覆盖 ${rel}（${existed.length} → ${input.content.length} 字符）\n${unifiedDiff(existed, input.content)}`.slice(0, 8000) };
    }
    const preview = input.content.split('\n').slice(0, 30).join('\n');
    return { ok: true, output: `已创建 ${rel}（${Buffer.byteLength(input.content)} 字节，前 30 行预览）:\n${preview}` };
  },
};

const EditInput = z.object({
  file_path: z.string().describe('目标文件路径'),
  old_string: z.string().describe('要被替换的精确文本（含缩进，必须在文件中唯一，除非 replace_all）'),
  new_string: z.string().describe('替换后的文本'),
  replace_all: z.boolean().optional().describe('为 true 时替换所有出现，否则多处匹配会报错'),
});

export const editTool: ToolDefinition<typeof EditInput> = {
  name: 'Edit',
  description:
    '对文件做精确字符串替换。old_string 必须与文件内容逐字匹配（含空白与缩进）；默认要求唯一匹配，多处匹配时设置 replace_all 或扩大上下文。',
  inputSchema: EditInput,
  metadata: { readOnly: false, riskLevel: 'medium' },
  async execute(input, ctx) {
    const file = resolveWithin(ctx.cwd, input.file_path);
    let content: string;
    try {
      content = await fs.readFile(file, 'utf8');
    } catch {
      return { ok: false, output: `无法读取文件: ${file}` };
    }
    if (input.old_string === input.new_string) {
      return { ok: false, output: 'old_string 与 new_string 相同，无需替换' };
    }
    const count = content.split(input.old_string).length - 1;
    if (count === 0) {
      return { ok: false, output: `未找到匹配文本。请检查缩进/空白后重试（可先 Read 该文件确认实际内容）` };
    }
    if (count > 1 && !input.replace_all) {
      return { ok: false, output: `匹配到 ${count} 处。请提供更长、更具唯一性的 old_string，或设置 replace_all: true` };
    }
    const updated = input.replace_all
      ? content.split(input.old_string).join(input.new_string)
      : content.replace(input.old_string, input.new_string);
    await fs.writeFile(file, updated, 'utf8');
    const rel = path.relative(ctx.cwd, file);
    const diff = unifiedDiff(content, updated);
    return { ok: true, output: `已编辑 ${rel}：替换 ${input.replace_all ? count : 1} 处\n${diff}`.slice(0, 8000) };
  },
};
