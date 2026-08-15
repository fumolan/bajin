/**
 * 自定义子代理定义（对标 ZCode subagents）：
 * ~/.bajin/agents/*.md（用户级）与 <cwd>/.bajin/agents/*.md（项目级），
 * flat frontmatter：name / description / tools（逗号分隔，可选，缺省=全部内置工具），
 * 正文为该子代理的系统级作业指引。项目级同名覆盖用户级。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface SubagentDef {
  name: string;
  description: string;
  /** 允许使用的内置工具名（缺省 = general-purpose 全集） */
  tools?: string[];
  /** 正文指引，作为子代理的 promptSuffix */
  body: string;
  source: 'user' | 'project';
  file: string;
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function parseDef(raw: string, file: string, source: 'user' | 'project'): SubagentDef | null {
  let name = path.basename(file, '.md');
  let description = '';
  let tools: string[] | undefined;
  let body = raw;
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3);
    if (end >= 0) {
      body = raw.slice(end + 4).trim();
      for (const line of raw.slice(3, end).split('\n')) {
        const m = /^([a-zA-Z_]+):\s*(.*)$/.exec(line.trim());
        if (!m) continue;
        const [, key, val] = m;
        if (key === 'name') name = val.trim();
        else if (key === 'description') description = val.trim();
        else if (key === 'tools') tools = val.split(',').map((s) => s.trim()).filter(Boolean);
      }
    }
  }
  if (!NAME_RE.test(name)) return null;
  return { name, description: description || `${name} 子代理`, tools, body: body.trim(), source, file };
}

/** 发现顺序：用户级 → 项目级（近的覆盖远的，同 skills/commands 约定） */
export async function discoverSubagents(cwd: string, home = os.homedir()): Promise<SubagentDef[]> {
  const out = new Map<string, SubagentDef>();
  for (const [dir, source] of [
    [path.join(home, '.bajin', 'agents'), 'user'],
    [path.join(cwd, '.bajin', 'agents'), 'project'],
  ] as const) {
    let files: string[] = [];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }
    for (const f of files) {
      const raw = await fs.readFile(path.join(dir, f), 'utf8').catch(() => '');
      const def = parseDef(raw, f, source);
      if (def) out.set(def.name, def);
    }
  }
  return [...out.values()];
}
