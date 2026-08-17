import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
function stateHome(home?: string): string {
  if (home) return path.join(home, '.bajin');
  return process.env.BAJIN_HOME && process.env.BAJIN_HOME.startsWith('/') ? process.env.BAJIN_HOME : path.join(os.homedir(), '.bajin');
}

/**
 * 自定义 slash 命令（对标 ZCode 的 commands 体系，净室实现）：
 *   命令 = 一个 .md 文件，文件名即命令名；嵌套目录用冒号拼接（review/code.md → /review:code）
 *   发现顺序（高 → 低，同名先到先得）：
 *     1. 用户 ~/.bajin/commands
 *     2. 工作区 .bajin/commands（从 cwd 向上到仓库根，每级都算，靠近 cwd 优先）
 *   frontmatter 为扁平解析（只认顶层单行 key:value，缩进行忽略），支持
 *     description / argument-hint / allowed-tools / model / skills / disable-noninteractive
 *   正文占位符：$ARGUMENTS=完整参数串，$1..$9=按空白切分的第 N 个；
 *   有参数但正文无占位符时，参数追加在「User arguments:」标题下。
 */

export interface SlashCommand {
  /** 规范名（相对路径去 .md、分隔符转冒号、小写），如 review:code */
  name: string;
  description: string;
  argumentHint?: string;
  allowedTools?: string[];
  model?: string;
  skills?: string[];
  /** frontmatter 剥离后的正文 */
  body: string;
  /** .md 绝对路径 */
  file: string;
  source: 'user' | 'project' | 'plugin';
}

const NAME_RE = /^[a-z0-9][a-z0-9_:-]{0,63}$/;
const KNOWN_KEYS = new Set(['description', 'argument-hint', 'allowed-tools', 'model', 'skills', 'disable-noninteractive']);

/** 发现全部自定义命令（按优先级顺序返回，已去重） */
export async function discoverCommands(cwd: string, home?: string): Promise<SlashCommand[]> {
  const roots = await commandRoots(cwd, home);
  const seen = new Set<string>();
  const out: SlashCommand[] = [];
  for (const root of roots) {
    const files = await listMarkdown(root.dir);
    for (const file of files) {
      const rel = path.relative(root.dir, file).replace(/\.md$/i, '');
      if (!NAME_RE.test(rel.split(path.sep).join(':'))) continue; // 按原始文件名校验，大写/点/空格即丢弃
      const name = rel.split(path.sep).join(':').toLowerCase();
      if (seen.has(name)) continue; // 高优先级同名命令已收录
      let cmd: SlashCommand | null;
      try {
        cmd = await parseCommandFile(file, name, root.source);
      } catch {
        cmd = null;
      }
      if (cmd) {
        seen.add(name);
        out.push(cmd);
      }
    }
  }
  return out;
}

/** 命令根目录列表（高 → 低）：用户级在前；工作区从 cwd 向上到 git 根每级收集 */
async function commandRoots(cwd: string, home?: string): Promise<Array<{ dir: string; source: 'user' | 'project' | 'plugin' }>> {
  const roots: Array<{ dir: string; source: 'user' | 'project' | 'plugin' }> = [
    { dir: path.join(stateHome(home), 'commands'), source: 'user' },
  ];
  // 插件命令（enabled 的插件追加在最后，优先级最低）
  try {
    const { pluginCommandDirs } = await import('./plugins.js');
    for (const pd of await pluginCommandDirs(home)) roots.push({ dir: pd.dir, source: 'plugin' as const });
  } catch { /* plugins 模块不可用时跳过 */ }
  let dir = path.resolve(cwd);
  for (;;) {
    roots.push({ dir: path.join(dir, '.bajin', 'commands'), source: 'project' });
    if (await exists(path.join(dir, '.git'))) break; // 仓库根（含本级）为止
    const parent = path.dirname(dir);
    if (parent === dir) break; // 文件系统根
    dir = parent;
  }
  return roots;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 递归收集一个根下全部 .md 文件 */
async function listMarkdown(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(p);
    }
  }
  await walk(root);
  return out.sort();
}

/** 解析单个命令文件；description 与正文全空 → 返回 null（命令被丢弃） */
export async function parseCommandFile(file: string, name: string, source: 'user' | 'project' | 'plugin'): Promise<SlashCommand | null> {
  const raw = await fs.readFile(file, 'utf8');
  return parseCommandRaw(raw, name, source, file);
}

/** 从原文解析（便于测试）：frontmatter + 正文 */
export function parseCommandRaw(raw: string, name: string, source: 'user' | 'project' | 'plugin', file = ''): SlashCommand | null {
  let fm: Record<string, string> = {};
  let body = raw;
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3);
    if (end >= 0) {
      fm = parseFlatFrontmatter(raw.slice(3, end));
      body = raw.slice(end + 4).replace(/^\s*\n/, '');
    }
  }
  body = body.trim();
  let description = fm['description']?.trim() ?? '';
  if (!description) {
    // 回退：正文第一个非空行
    const firstLine = body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    description = firstLine ?? '';
  }
  if (!description && !body) return null; // 无 description 且正文为空 → 丢弃
  const cmd: SlashCommand = {
    name,
    description,
    body,
    file,
    source,
    ...(fm['argument-hint'] ? { argumentHint: fm['argument-hint'].trim() } : {}),
    ...(fm['model'] ? { model: fm['model'].trim() } : {}),
    ...(fm['allowed-tools']
      ? { allowedTools: fm['allowed-tools'].split(',').map((s) => s.trim()).filter(Boolean) }
      : {}),
    ...(fm['skills'] ? { skills: fm['skills'].split(',').map((s) => s.trim()).filter(Boolean) } : {}),
  };
  return cmd;
}

/** 扁平 frontmatter：只认顶层单行 `key: value`，缩进行与未知 key 忽略 */
export function parseFlatFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    if (/^\s/.test(line)) continue; // 缩进行（多行数组等）忽略
    const m = /^([a-zA-Z-]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    if (!KNOWN_KEYS.has(key)) continue;
    out[key] = m[2] ?? '';
  }
  return out;
}

/** 按名字查找（输入可带或不带前导 /） */
export function findCommand(commands: SlashCommand[], input: string): SlashCommand | undefined {
  const name = input.replace(/^\//, '').trim().toLowerCase();
  return commands.find((c) => c.name === name);
}

/** 把命令展开成发给模型的完整 prompt */
export function expandCommand(cmd: SlashCommand, args: string): string {
  if (/!`/.test(cmd.body) || /(^|\n)```!/.test(cmd.body)) {
    throw new Error(`命令 /${cmd.name} 含动态 shell 展开（!），不支持`);
  }
  const argv = args.split(/\s+/).filter(Boolean);
  let out = cmd.body;
  let substituted = false;
  if (out.includes('$ARGUMENTS')) {
    out = out.replaceAll('$ARGUMENTS', args);
    substituted = true;
  }
  for (let i = 1; i <= 9; i++) {
    const tok = `$${i}`;
    if (out.includes(tok)) {
      out = out.replaceAll(tok, argv[i - 1] ?? '');
      substituted = true;
    }
  }
  if (args && !substituted) out += `\n\nUser arguments: ${args}`;
  return out.trim();
}
