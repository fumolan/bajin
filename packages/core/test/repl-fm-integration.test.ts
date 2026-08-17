import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { discoverCommands, findCommand, expandCommand, discoverSkills } from '../src/index.js';

const home = await mkdtemp(path.join(tmpdir(), 'bajin-rfm-'));
const cwd = await mkdtemp(path.join(tmpdir(), 'bajin-rfm-cwd-'));
afterAll(async () => { await Promise.all([rm(home, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]).catch(() => undefined); });

describe('REPL frontmatter 集成（命令发现→frontmatter 字段→技能挂载→展开）', () => {
  it('带 skills frontmatter 的命令：字段可达 + 技能正文可注入 + 展开链完整', async () => {
    const cmds = path.join(home, '.bajin', 'commands');
    const skills = path.join(home, '.bajin', 'skills', 'fm-skill');
    await mkdir(cmds, { recursive: true });
    await mkdir(skills, { recursive: true });
    await writeFile(path.join(cmds, 'deploy.md'),
      `---
description: 部署
model: glm-4.7-flash
allowed-tools: Bash, Read
skills: fm-skill
---
执行部署流程。`, 'utf8');
    await writeFile(path.join(skills, 'SKILL.md'),
      `---
name: fm-skill
description: 部署技能
---
DEPLOY_SKILL_MARKER 按以下步骤部署。`, 'utf8');

    // 1) 命令发现 + frontmatter 字段
    const list = await discoverCommands(cwd, home);
    const cmd = findCommand(list, 'deploy')!;
    expect(cmd).toBeDefined();
    expect(cmd.model).toBe('glm-4.7-flash');
    expect(cmd.allowedTools).toEqual(['Bash', 'Read']);
    expect(cmd.skills).toEqual(['fm-skill']);

    // 2) 技能发现 + 正文读取
    const allSkills = await discoverSkills(cwd, home);
    const hit = allSkills.find((s) => s.name === 'fm-skill')!;
    expect(hit).toBeDefined();
    const body = await readFile(hit.file, 'utf8');
    expect(body).toContain('DEPLOY_SKILL_MARKER');

    // 3) 展开 + 注入（模拟 REPL 的 mounted 逻辑）
    const expanded = expandCommand(cmd, '');
    const mounted = `[挂载技能 fm-skill]\n${body.slice(0, 6000)}\n\n`;
    const final = `${mounted}---\n${expanded}`;
    expect(final).toContain('DEPLOY_SKILL_MARKER');
    expect(final).toContain('执行部署流程');
    expect(final).toContain('[挂载技能 fm-skill]');
  });
});
