import { z } from 'zod';
import type { ToolDefinition } from '@bajin/shared';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.cache', 'coverage']);

/** glob → RegExp：支持 * ** ? {a,b} 与字符类 */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** 匹配任意层级（含 /）
        re += '.*';
        i += 2;
        if (pattern[i] === '/') i++;
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end > i) {
        const alts = pattern
          .slice(i + 1, end)
          .split(',')
          .map((a) => a.replace(/[.+^$()|[\]\\]/g, '\\$&'))
          .join('|');
        re += `(?:${alts})`;
        i = end + 1;
      } else {
        re += '\\{';
        i++;
      }
    } else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end > i) {
        re += pattern.slice(i, end + 1);
        i = end + 1;
      } else {
        re += '\\[';
        i++;
      }
    } else if ('.+^$()|[]\\'.includes(c)) {
      re += `\\${c}`;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

export interface WalkOptions {
  regex: RegExp;
  maxResults: number;
}

/** 从 base 递归收集匹配 regex 的文件相对路径 */
export async function walkFiles(base: string, opts: WalkOptions): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (out.length >= opts.maxResults) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= opts.maxResults) return;
      if (e.name.startsWith('.') && e.name !== '.github') {
        if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
      }
      const rel = path.relative(base, path.join(dir, e.name));
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(path.join(dir, e.name));
      } else if (opts.regex.test(rel)) {
        out.push(rel);
      }
    }
  }
  await walk(base);
  return out;
}

const GlobInput = z.object({
  pattern: z.string().describe('glob 模式，如 "**/*.ts"、"src/*.test.ts"、"{src,test}/**"'),
  path: z.string().optional().describe('搜索起始目录，默认 cwd'),
});

export const globTool: ToolDefinition<typeof GlobInput> = {
  name: 'Glob',
  description: '按 glob 模式列出匹配的文件路径（不读内容）。自动跳过 node_modules/.git/dist 等目录。',
  inputSchema: GlobInput,
  metadata: { readOnly: true, riskLevel: 'low', concurrentSafe: true },
  async execute(input, ctx) {
    const base = path.resolve(ctx.cwd, input.path ?? '.');
    // 把模式里固定的前导目录段并入 base，减少遍历范围：src/** → base/src + **
    const segs = input.pattern.split('/');
    let rest: string[] = [];
    for (const seg of segs) {
      if (/[*?{]/.test(seg)) break;
      if (seg === '.' || seg === '') continue;
      rest.push(seg);
    }
    const fixedDir = rest.length ? path.join(base, ...rest) : base;
    const remaining = segs.slice(rest.length).join('/');
    try {
      const stat = await fs.stat(fixedDir);
      if (!stat.isDirectory()) throw new Error('not dir');
    } catch {
      return { ok: false, output: `目录不存在: ${fixedDir}` };
    }
    const files = await walkFiles(fixedDir, {
      regex: globToRegExp(remaining || '**'),
      maxResults: 500,
    });
    if (!files.length) return { ok: true, output: '(无匹配文件)' };
    return { ok: true, output: files.map((f) => (rest.length ? [...rest, f].join('/') : f)).join('\n') };
  },
};

const GrepInput = z.object({
  pattern: z.string().describe('正则表达式（JavaScript 语法）'),
  path: z.string().optional().describe('搜索目录或单个文件，默认 cwd'),
  glob: z.string().optional().describe('文件名过滤 glob，如 "*.ts"'),
  ignore_case: z.boolean().optional().describe('忽略大小写'),
  max_results: z.number().int().positive().optional().describe('最大匹配行数，默认 100'),
});

export const grepTool: ToolDefinition<typeof GrepInput> = {
  name: 'Grep',
  description: '在文件内容中按正则搜索，输出 "文件:行号:该行内容"。只输出匹配行，适合快速定位代码位置。',
  inputSchema: GrepInput,
  metadata: { readOnly: true, riskLevel: 'low', concurrentSafe: true },
  async execute(input, ctx) {
    const target = path.resolve(ctx.cwd, input.path ?? '.');
    const regex = new RegExp(input.pattern, input.ignore_case ? 'i' : '');
    const fileFilter = input.glob ? globToRegExp(input.glob) : null;
    const maxResults = input.max_results ?? 100;

    const stat = await fs.stat(target).catch(() => null);
    if (!stat) return { ok: false, output: `路径不存在: ${target}` };

    let files: Array<{ abs: string; rel: string }>;
    if (stat.isFile()) {
      files = [{ abs: target, rel: path.basename(target) }];
    } else {
      const rels = await walkFiles(target, { regex: fileFilter ?? globToRegExp('**'), maxResults: 5000 });
      files = rels.map((rel) => ({ abs: path.join(target, rel), rel }));
    }

    const hits: string[] = [];
    for (const f of files) {
      if (hits.length >= maxResults) break;
      let content: string;
      try {
        const buf = await fs.readFile(f.abs);
        if (buf.includes(0)) continue; // 跳过二进制
        content = buf.toString('utf8');
      } catch {
        continue;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
        if (regex.test(lines[i])) hits.push(`${f.rel}:${i + 1}:${lines[i].trim().slice(0, 300)}`);
      }
    }
    if (!hits.length) return { ok: true, output: '(无匹配)' };
    return { ok: true, output: hits.join('\n') + `\n(${hits.length} 行匹配)` };
  },
};
