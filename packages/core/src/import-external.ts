/**
 * 外部 Agent 设置导入（R8-1，对标 ZCode「从外部 Agent 导入命令/技能/插件/MCP」）：
 * 现支持 Claude Code（~/.claude）——命令 md、技能目录（SKILL.md）、子代理 md 复制入
 * bajin 用户级目录；~/.claude.json 的 mcpServers 合并入 config.json（同名不覆盖）。
 * 源目录可注入（测试夹具）；dry-run 只清点不落盘。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { platform } from '@bajin/shared';

export interface ImportOptions {
  /** 外部 Agent 根（默认 ~/.claude） */
  sourceDir?: string;
  /** bajin 数据根（默认 stateRoot） */
  home?: string;
  dryRun?: boolean;
}

export interface ImportReport {
  commands: string[];
  skills: string[];
  agents: string[];
  mcpServers: string[];
  skipped: Array<{ what: string; reason: string }>;
}

async function exists(p: string): Promise<boolean> {
  await fs.access(p).catch(() => undefined);
  try { await fs.stat(p); return true; } catch { return false; }
}

/** 列目录文件（不存在返回空） */
async function listFiles(dir: string): Promise<string[]> {
  try { return (await fs.readdir(dir)).filter((f) => !f.startsWith('.')); } catch { return []; }
}

export async function importClaudeSettings(opts: ImportOptions = {}): Promise<ImportReport> {
  const report: ImportReport = { commands: [], skills: [], agents: [], mcpServers: [], skipped: [] };
  const src = opts.sourceDir ?? path.join(os.homedir(), '.claude');
  const stateRoot = platform.stateRoot({ homeDir: opts.home }, process.env);
  if (!(await exists(src))) {
    report.skipped.push({ what: src, reason: '源目录不存在' });
    return report;
  }
  const write = async (from: string, to: string): Promise<void> => {
    if (opts.dryRun) return;
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
  };

  // 1. 命令：~/.claude/commands/*.md → <stateRoot>/commands/*.md（frontmatter 兼容 bajin）
  for (const f of await listFiles(path.join(src, 'commands'))) {
    if (!f.endsWith('.md')) continue;
    await write(path.join(src, 'commands', f), path.join(stateRoot, 'commands', f));
    report.commands.push(f);
  }

  // 2. 技能：~/.claude/skills/<name>/SKILL.md → <stateRoot>/skills/<name>/（整目录复制）
  for (const d of await listFiles(path.join(src, 'skills'))) {
    const skillMd = path.join(src, 'skills', d, 'SKILL.md');
    if (!(await exists(skillMd))) { report.skipped.push({ what: `skills/${d}`, reason: '缺 SKILL.md' }); continue; }
    if (!opts.dryRun) {
      await fs.cp(path.join(src, 'skills', d), path.join(stateRoot, 'skills', d), { recursive: true });
    }
    report.skills.push(d);
  }

  // 3. 子代理：~/.claude/agents/*.md → <stateRoot>/agents/*.md
  for (const f of await listFiles(path.join(src, 'agents'))) {
    if (!f.endsWith('.md')) continue;
    await write(path.join(src, 'agents', f), path.join(stateRoot, 'agents', f));
    report.agents.push(f);
  }

  // 4. MCP：~/.claude.json 顶层 mcpServers → config.json 合并（同名跳过不覆盖）
  const claudeJson = path.join(path.dirname(src), '.claude.json');
  try {
    const raw = JSON.parse(await fs.readFile(claudeJson, 'utf8')) as { mcpServers?: Record<string, unknown> };
    const incoming = raw.mcpServers ?? {};
    const cfgPath = path.join(stateRoot, 'config.json');
    let cfg: Record<string, unknown> = {};
    try { cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as Record<string, unknown>; } catch { /* 新建 */ }
    const existing = (cfg['mcpServers'] as Record<string, unknown> | undefined) ?? {};
    for (const [name, def] of Object.entries(incoming)) {
      if (existing[name]) { report.skipped.push({ what: `mcp:${name}`, reason: '已存在同名，不覆盖' }); continue; }
      existing[name] = def;
      report.mcpServers.push(name);
    }
    if (!opts.dryRun) {
      cfg['mcpServers'] = existing;
      await fs.mkdir(stateRoot, { recursive: true });
      await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    }
  } catch {
    report.skipped.push({ what: claudeJson, reason: '无 mcpServers 或不可读' });
  }

  return report;
}
