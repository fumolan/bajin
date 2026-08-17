import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { discoverPlugins, togglePlugin, installPlugin, pluginSkillDirs, pluginCommandDirs } from '../src/plugins.js';
import { discoverSkills } from '../src/skills.js';
import { discoverCommands } from '../src/commands.js';

const home = await mkdtemp(path.join(tmpdir(), 'bajin-plugin-'));
const pluginRoot = path.join(home, '.bajin', 'plugins');

afterAll(async () => { await rm(home, { recursive: true, force: true }).catch(() => undefined); });

async function seedPlugin(name: string, enabled = true): Promise<void> {
  const dir = path.join(pluginRoot, name);
  await mkdir(path.join(dir, 'skills', `${name}-skill`), { recursive: true });
  await mkdir(path.join(dir, 'commands'), { recursive: true });
  await writeFile(path.join(dir, 'plugin.json'), JSON.stringify({ name, description: `${name} 测试插件`, version: '1.0.0', enabled }), 'utf8');
  await writeFile(path.join(dir, 'skills', `${name}-skill`, 'SKILL.md'), `---\nname: ${name}-skill\ndescription: ${name} 的技能\n---\n\n${name} skill body`, 'utf8');
  await writeFile(path.join(dir, 'commands', `${name}-cmd.md`), `---\ndescription: ${name} 命令\n---\n执行 ${name} 操作`, 'utf8');
}

beforeEach(async () => { await rm(pluginRoot, { recursive: true, force: true }).catch(() => undefined); });

describe('插件系统', () => {
  it('发现：manifest + skills + commands 均列出', async () => {
    await seedPlugin('alpha');
    await seedPlugin('beta', false);
    const list = await discoverPlugins(home);
    expect(list).toHaveLength(2);
    const a = list.find((p) => p.name === 'alpha')!;
    expect(a.description).toBe('alpha 测试插件');
    expect(a.version).toBe('1.0.0');
    expect(a.enabled).toBe(true);
    expect(a.skills).toEqual(['alpha-skill']);
    expect(a.commands).toEqual(['alpha-cmd']);
    const b = list.find((p) => p.name === 'beta')!;
    expect(b.enabled).toBe(false);
  });

  it('启停：toggle 写回 plugin.json；禁用后技能/命令不再出现', async () => {
    await seedPlugin('gamma');
    // 启用时技能可发现
    let skills = await discoverSkills('/nonexistent', home);
    expect(skills.some((s) => s.name === 'gamma-skill' && s.source === 'plugin')).toBe(true);
    let cmds = await discoverCommands('/nonexistent', home);
    expect(cmds.some((c) => c.name === 'gamma-cmd' && c.source === 'plugin')).toBe(true);
    // 禁用
    const off = await togglePlugin('gamma', false, home);
    expect(off?.enabled).toBe(false);
    skills = await discoverSkills('/nonexistent', home);
    expect(skills.some((s) => s.name === 'gamma-skill')).toBe(false);
    cmds = await discoverCommands('/nonexistent', home);
    expect(cmds.some((c) => c.name === 'gamma-cmd')).toBe(false);
    // 重新启用
    const on = await togglePlugin('gamma', true, home);
    expect(on?.enabled).toBe(true);
    skills = await discoverSkills('/nonexistent', home);
    expect(skills.some((s) => s.name === 'gamma-skill')).toBe(true);
  });

  it('安装：从本地目录复制 + 自动生成 manifest', async () => {
    const src = await mkdtemp(path.join(tmpdir(), 'bajin-plugin-src-'));
    try {
      await mkdir(path.join(src, 'skills', 'installed-skill'), { recursive: true });
      await writeFile(path.join(src, 'skills', 'installed-skill', 'SKILL.md'), `---\nname: installed-skill\ndescription: 安装的技能\n---\n\nbody`, 'utf8');
      const p = await installPlugin(src, 'my-plugin', home);
      expect(p.name).toBe('my-plugin');
      expect(p.enabled).toBe(true);
      expect(p.skills).toEqual(['installed-skill']);
      // 发现链可用
      const skills = await discoverSkills('/nonexistent', home);
      expect(skills.some((s) => s.name === 'installed-skill')).toBe(true);
    } finally {
      await rm(src, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('空目录/无 manifest 安全返回', async () => {
    await mkdir(path.join(pluginRoot, 'broken'), { recursive: true });
    const list = await discoverPlugins(home);
    expect(list).toHaveLength(0);
  });
});
