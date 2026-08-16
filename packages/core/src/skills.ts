import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { SkillSummary } from './prompt.js';
function stateHome(home?: string): string {
  if (home) return path.join(home, '.bajin');
  return process.env.BAJIN_HOME && process.env.BAJIN_HOME.startsWith('/') ? process.env.BAJIN_HOME : path.join(os.homedir(), '.bajin');
}

export interface DiscoveredSkill extends SkillSummary {
  /** SKILL.md 绝对路径 */
  file: string;
  /** 所在技能目录（可能带 references/ scripts/） */
  dir: string;
  source: 'project' | 'user';
}

/** 发现顺序（高 → 低）：项目 .bajin/skills → 用户 ~/.bajin/skills；同名先到先得 */
export async function discoverSkills(cwd: string, home?: string): Promise<DiscoveredSkill[]> {
  const roots: Array<{ dir: string; source: 'project' | 'user' }> = [
    { dir: path.join(cwd, '.bajin', 'skills'), source: 'project' },
    { dir: path.join(stateHome(home), 'skills'), source: 'user' },
  ];
  const seen = new Set<string>();
  const out: DiscoveredSkill[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await fs.readdir(root.dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (seen.has(name)) continue;
      const file = path.join(root.dir, name, 'SKILL.md');
      try {
        const raw = await fs.readFile(file, 'utf8');
        const fm = parseFrontmatter(raw);
        if (!fm.name || !fm.description) continue;
        seen.add(name);
        out.push({ name: fm.name, description: fm.description, file, dir: path.dirname(file), source: root.source });
      } catch {
        // 无 SKILL.md 或不可读，跳过
      }
    }
  }
  return out;
}

/** 极简 frontmatter 解析：--- 包裹块内的顶层 `key: value` */
export function parseFrontmatter(raw: string): { name?: string; description?: string } {
  if (!raw.startsWith('---')) return {};
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return {};
  const block = raw.slice(3, end);
  const out: { name?: string; description?: string } = {};
  for (const line of block.split('\n')) {
    const m = /^([a-zA-Z_]+):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === 'name') out.name = m[2]!.trim();
    if (m[1] === 'description') out.description = m[2]!.trim();
  }
  return out;
}

/** Skill 工具输出时对 SKILL.md 正文做预算截断 */
export function clipSkillBody(body: string, maxChars = 8000): string {
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}\n\n[... SKILL.md 过长已截断（${body.length} 字符），完整内容可再 Read ${''}]`;
}
