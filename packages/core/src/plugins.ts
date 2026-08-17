/**
 * 插件系统（对标 ZCode plugins）：~/.bajin/plugins/<name>/plugin.json 清单，
 * 插件可提供 skills/（SKILL.md）与 commands/（*.md），与用户级/项目级同名冲突时插件优先级最低。
 * 启停写回 plugin.json 的 enabled 字段（默认 true）。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface PluginManifest {
  name: string;
  description?: string;
  version?: string;
  enabled: boolean;
}

export interface DiscoveredPlugin {
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  /** 插件根目录 */
  dir: string;
  /** 提供的技能名列表（发现自 skills/ 子目录） */
  skills: string[];
  /** 提供的命令名列表（发现自 commands/ 子目录） */
  commands: string[];
}

function stateHome(home?: string): string {
  if (home) return path.join(home, '.bajin');
  return process.env.BAJIN_HOME && process.env.BAJIN_HOME.startsWith('/') ? process.env.BAJIN_HOME : path.join(os.homedir(), '.bajin');
}

export function pluginsRoot(home?: string): string {
  return path.join(stateHome(home), 'plugins');
}

/** 发现全部插件（读 plugin.json + 扫描子目录） */
export async function discoverPlugins(home?: string): Promise<DiscoveredPlugin[]> {
  const root = pluginsRoot(home);
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  const out: DiscoveredPlugin[] = [];
  for (const name of entries) {
    const dir = path.join(root, name);
    const manifestFile = path.join(dir, 'plugin.json');
    try {
      const raw = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as Partial<PluginManifest>;
      const skills = await fs.readdir(path.join(dir, 'skills')).catch(() => [] as string[]);
      const commands = await fs.readdir(path.join(dir, 'commands')).catch(() => [] as string[]);
      out.push({
        name: String(raw.name ?? name),
        description: String(raw.description ?? ''),
        version: String(raw.version ?? '0.0.0'),
        enabled: raw.enabled !== false,
        dir,
        skills: skills.filter((s) => !s.startsWith('.')),
        commands: commands.filter((f) => f.endsWith('.md')).map((f) => f.replace('.md', '')),
      });
    } catch {
      // 无 plugin.json 或损坏：跳过
    }
  }
  return out;
}

/** 切换插件启停：写回 plugin.json 的 enabled */
export async function togglePlugin(name: string, enabled: boolean, home?: string): Promise<DiscoveredPlugin | null> {
  const root = pluginsRoot(home);
  const dir = path.join(root, name);
  const manifestFile = path.join(dir, 'plugin.json');
  try {
    const raw = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as Record<string, unknown>;
    raw['enabled'] = enabled;
    await fs.writeFile(manifestFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  } catch {
    return null;
  }
  const all = await discoverPlugins(home);
  return all.find((p) => p.name === name) ?? null;
}

/** 从本地目录安装插件：复制 skills/commands + 生成 plugin.json */
export async function installPlugin(sourceDir: string, name: string, home?: string): Promise<DiscoveredPlugin> {
  const root = pluginsRoot(home);
  const dest = path.join(root, name);
  await fs.mkdir(dest, { recursive: true });
  // 递归复制
  await copyDir(sourceDir, dest);
  // 确保有 plugin.json
  const manifestFile = path.join(dest, 'plugin.json');
  const has = await fs.access(manifestFile).then(() => true, () => false);
  if (!has) {
    await fs.writeFile(manifestFile, `${JSON.stringify({ name, description: `${name} 插件`, version: '0.0.0', enabled: true }, null, 2)}\n`, 'utf8');
  }
  const all = await discoverPlugins(home);
  const hit = all.find((p) => p.name === name);
  if (!hit) throw new Error(`安装后未发现插件 ${name}`);
  return hit;
}

async function copyDir(from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(src, dst);
    else await fs.copyFile(src, dst);
  }
}

/** 插件提供的额外技能根目录（enabled 的插件）——供 discoverSkills 追加扫描 */
export async function pluginSkillDirs(home?: string): Promise<Array<{ dir: string; plugin: string }>> {
  const plugins = await discoverPlugins(home);
  return plugins
    .filter((p) => p.enabled)
    .map((p) => ({ dir: path.join(p.dir, 'skills'), plugin: p.name }));
}

/** 插件提供的额外命令根目录（enabled 的插件）——供 discoverCommands 追加扫描 */
export async function pluginCommandDirs(home?: string): Promise<Array<{ dir: string; plugin: string }>> {
  const plugins = await discoverPlugins(home);
  return plugins
    .filter((p) => p.enabled)
    .map((p) => ({ dir: path.join(p.dir, 'commands'), plugin: p.name }));
}
