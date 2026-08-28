/**
 * 外部 Agent 设置导入·续（R8-2）：Codex（~/.codex）与 Cursor（~/.cursor）。
 * - Codex：prompts/*.md → 命令；config.toml 的 [mcp_servers.<name>] → MCP 合并
 *   （TOML 只手写解析 mcp_servers 所需的字符串/数组/内联表，不引依赖）
 * - Cursor：rules/*.mdc → 技能（frontmatter description/globs 转写为 SKILL.md）；
 *   mcp.json 的 mcpServers → MCP 合并
 * 复用 import-external 的报告结构与「同名不覆盖」约定。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { platform } from '@bajin/shared';
import type { ImportOptions, ImportReport } from './import-external.js';

async function exists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}
async function listFiles(dir: string): Promise<string[]> {
  try { return (await fs.readdir(dir)).filter((f) => !f.startsWith('.')); } catch { return []; }
}

/** 合并 mcpServers 到 config.json（同名跳过；dry-run 只清点） */
async function mergeMcp(defs: Record<string, unknown>, stateRoot: string, report: ImportReport, dryRun?: boolean): Promise<void> {
  if (!Object.keys(defs).length) return;
  const cfgPath = path.join(stateRoot, 'config.json');
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as Record<string, unknown>; } catch { /* 新建 */ }
  const existing = (cfg['mcpServers'] as Record<string, unknown> | undefined) ?? {};
  for (const [name, def] of Object.entries(defs)) {
    if (existing[name]) { report.skipped.push({ what: `mcp:${name}`, reason: '已存在同名，不覆盖' }); continue; }
    existing[name] = def;
    report.mcpServers.push(name);
  }
  if (!dryRun) {
    cfg['mcpServers'] = existing;
    await fs.mkdir(stateRoot, { recursive: true });
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  }
}

/**
 * 最小 TOML 解析：只取 [mcp_servers.<name>] 段内的字符串 / 字符串数组 / 内联表。
 * 覆盖 Codex config.toml 的 mcp_servers 写法；其余段与键一概忽略。
 */
export function parseCodexMcpServers(toml: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  let current: { name: string; body: string[] } | null = null;
  const flush = (): void => {
    if (!current) return;
    const entry: Record<string, unknown> = {};
    for (const raw of current.body) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const valRaw = line.slice(eq + 1).trim();
      if (valRaw.startsWith('"')) {
        entry[key] = valRaw.slice(1, valRaw.indexOf('"', 1));
      } else if (valRaw.startsWith('[')) {
        const inner = valRaw.slice(1, valRaw.lastIndexOf(']'));
        entry[key] = inner.split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/^"|"$/g, ''));
      } else if (valRaw.startsWith('{')) {
        const inner = valRaw.slice(1, valRaw.lastIndexOf('}'));
        const obj: Record<string, string> = {};
        for (const pair of inner.split(',')) {
          const [k, v] = pair.split('=').map((x) => x.trim());
          if (k && v) obj[k.replace(/^"|"$/g, '')] = v.replace(/^"|"$/g, '');
        }
        entry[key] = obj;
      }
    }
    if (Object.keys(entry).length) out[current.name] = entry;
  };
  for (const line of toml.split('\n')) {
    const sec = /^\[\s*mcp_servers\.([\w-]+)\s*\]/.exec(line.trim());
    if (sec) { flush(); current = { name: sec[1]!, body: [] }; continue; }
    if (/^\[/.test(line.trim())) { flush(); current = null; continue; } // 其他段：结束收集
    if (current) current.body.push(line);
  }
  flush();
  return out;
}

/** Codex 导入 */
export async function importCodexSettings(opts: ImportOptions = {}): Promise<ImportReport> {
  const report: ImportReport = { commands: [], skills: [], agents: [], mcpServers: [], skipped: [] };
  const src = opts.sourceDir ?? path.join(os.homedir(), '.codex');
  const stateRoot = platform.stateRoot({ homeDir: opts.home }, process.env);
  if (!(await exists(src))) {
    report.skipped.push({ what: src, reason: '源目录不存在' });
    return report;
  }
  for (const f of await listFiles(path.join(src, 'prompts'))) {
    if (!f.endsWith('.md')) continue;
    if (!opts.dryRun) {
      await fs.mkdir(path.join(stateRoot, 'commands'), { recursive: true });
      await fs.copyFile(path.join(src, 'prompts', f), path.join(stateRoot, 'commands', f));
    }
    report.commands.push(f);
  }
  try {
    const toml = await fs.readFile(path.join(src, 'config.toml'), 'utf8');
    await mergeMcp(parseCodexMcpServers(toml), stateRoot, report, opts.dryRun);
  } catch {
    report.skipped.push({ what: path.join(src, 'config.toml'), reason: '不可读或不存在' });
  }
  return report;
}

/** .mdc 规则 → SKILL.md 文本（description 进 frontmatter，globs/alwaysApply 写进正文说明） */
export function mdcToSkillMd(mdc: string): string {
  const fm: Record<string, string> = {};
  let body = mdc;
  if (mdc.startsWith('---')) {
    const end = mdc.indexOf('\n---', 3);
    if (end > 0) {
      for (const line of mdc.slice(4, end).split('\n')) {
        const i = line.indexOf(':');
        if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
      }
      body = mdc.slice(end + 4);
    }
  }
  const notes: string[] = [];
  if (fm['globs']) notes.push(`适用文件：${fm['globs']}`);
  if (fm['alwaysApply'] === 'true') notes.push('（原规则为始终应用）');
  const head = `---\ndescription: ${fm['description'] || fm['globs'] || 'Cursor 规则导入'}\n---\n`;
  return head + (notes.length ? `> ${notes.join('；')}\n\n` : '') + body.trimStart();
}

/** Cursor 导入 */
export async function importCursorSettings(opts: ImportOptions = {}): Promise<ImportReport> {
  const report: ImportReport = { commands: [], skills: [], agents: [], mcpServers: [], skipped: [] };
  const src = opts.sourceDir ?? path.join(os.homedir(), '.cursor');
  const stateRoot = platform.stateRoot({ homeDir: opts.home }, process.env);
  if (!(await exists(src))) {
    report.skipped.push({ what: src, reason: '源目录不存在' });
    return report;
  }
  for (const f of await listFiles(path.join(src, 'rules'))) {
    if (!f.endsWith('.mdc')) continue;
    const name = f.replace(/\.mdc$/, '');
    const md = mdcToSkillMd(await fs.readFile(path.join(src, 'rules', f), 'utf8'));
    if (!opts.dryRun) {
      const dir = path.join(stateRoot, 'skills', name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'SKILL.md'), md, 'utf8');
    }
    report.skills.push(name);
  }
  try {
    const raw = JSON.parse(await fs.readFile(path.join(src, 'mcp.json'), 'utf8')) as { mcpServers?: Record<string, unknown> };
    await mergeMcp(raw.mcpServers ?? {}, stateRoot, report, opts.dryRun);
  } catch {
    report.skipped.push({ what: path.join(src, 'mcp.json'), reason: '无 mcpServers 或不可读' });
  }
  return report;
}
