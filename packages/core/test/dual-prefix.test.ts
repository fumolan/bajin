import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { discoverSkills } from '../src/skills.js';
import { discoverCommands } from '../src/commands.js';
import { discoverSubagents } from '../src/subagents.js';

const home = await mkdtemp(path.join(tmpdir(), 'bajin-dp-home-'));
const cwd = await mkdtemp(path.join(tmpdir(), 'bajin-dp-cwd-'));
afterAll(async () => {
  await Promise.all([rm(home, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]).catch(() => undefined);
});

describe('.agents/ 双前缀兼容', () => {
  it('skills：.agents/skills/ 可发现；同名 .bajin 优先', async () => {
    await mkdir(path.join(cwd, '.agents', 'skills', 'agent-only-skill'), { recursive: true });
    await writeFile(path.join(cwd, '.agents', 'skills', 'agent-only-skill', 'SKILL.md'),
      `---\nname: agent-only-skill\ndescription: 只有 .agents 有\n---\n\nbody`, 'utf8');
    // 同名：.bajin 版
    await mkdir(path.join(cwd, '.bajin', 'skills', 'both-skill'), { recursive: true });
    await mkdir(path.join(cwd, '.agents', 'skills', 'both-skill'), { recursive: true });
    await writeFile(path.join(cwd, '.bajin', 'skills', 'both-skill', 'SKILL.md'),
      `---\nname: both-skill\ndescription: .bajin 版\n---\n\nbajin body`, 'utf8');
    await writeFile(path.join(cwd, '.agents', 'skills', 'both-skill', 'SKILL.md'),
      `---\nname: both-skill\ndescription: .agents 版\n---\n\nagents body`, 'utf8');

    const found = await discoverSkills(cwd, home);
    expect(found.some((s) => s.name === 'agent-only-skill')).toBe(true);
    const both = found.find((s) => s.name === 'both-skill')!;
    expect(both.description).toBe('.bajin 版'); // .bajin 优先
  });

  it('commands：.agents/commands/ 可发现；同名 .bajin 优先', async () => {
    await mkdir(path.join(cwd, '.agents', 'commands'), { recursive: true });
    await mkdir(path.join(cwd, '.bajin', 'commands'), { recursive: true });
    await writeFile(path.join(cwd, '.agents', 'commands', 'agent-cmd.md'), `---\ndescription: .agents only\n---\nagent body`, 'utf8');
    await writeFile(path.join(cwd, '.bajin', 'commands', 'both-cmd.md'), `---\ndescription: .bajin\n---\nbajin body`, 'utf8');
    await writeFile(path.join(cwd, '.agents', 'commands', 'both-cmd.md'), `---\ndescription: .agents\n---\nagents body`, 'utf8');

    const cmds = await discoverCommands(cwd, home);
    expect(cmds.some((c) => c.name === 'agent-cmd')).toBe(true);
    const both = cmds.find((c) => c.name === 'both-cmd')!;
    expect(both.description).toBe('.bajin');
  });

  it('subagents：.agents/agents/ 可发现', async () => {
    await mkdir(path.join(cwd, '.agents', 'agents'), { recursive: true });
    await writeFile(path.join(cwd, '.agents', 'agents', 'agent-sub.md'),
      `---\nname: agent-sub\ndescription: .agents 子代理\n---\n\nbody`, 'utf8');

    const subs = await discoverSubagents(cwd, home);
    expect(subs.some((d) => d.name === 'agent-sub')).toBe(true);
  });
});
