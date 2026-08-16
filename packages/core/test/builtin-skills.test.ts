import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { seedBuiltinSkills, BUILTIN_SKILLS, discoverSkills } from '../src/skills.js';

const home = await mkdtemp(path.join(tmpdir(), 'bajin-skill-home-'));
afterAll(async () => { await rm(home, { recursive: true, force: true }).catch(() => undefined); });

describe('内置默认技能', () => {
  it('种入 5 个技能且可被发现（frontmatter 解析出 name/description）', async () => {
    const n = await seedBuiltinSkills(home);
    expect(n).toBe(BUILTIN_SKILLS.length);
    expect(BUILTIN_SKILLS.map((s) => s.name)).toEqual(['skill-creator', 'docx', 'pptx', 'pdf', 'self-check']);
    const found = await discoverSkills('/nonexistent-cwd', home);
    expect(found.map((s) => s.name).sort()).toEqual([...BUILTIN_SKILLS.map((s) => s.name)].sort());
    expect(found.every((s) => s.description.length > 5)).toBe(true);
  });

  it('幂等且不覆盖：二次种入 0；用户改过的内容保留', async () => {
    expect(await seedBuiltinSkills(home)).toBe(0);
    const file = path.join(home, '.bajin', 'skills', 'docx', 'SKILL.md');
    await writeFile(file, '---\nname: docx\ndescription: 用户改过的\n---\n\n自定义正文', 'utf8');
    expect(await seedBuiltinSkills(home)).toBe(0);
    expect(await readFile(file, 'utf8')).toContain('用户改过的');
  });

  it('删除后可重新种入（自愈）', async () => {
    await rm(path.join(home, '.bajin', 'skills', 'pdf'), { recursive: true, force: true });
    expect(await seedBuiltinSkills(home)).toBe(1);
    expect((await discoverSkills('/x', home)).some((s) => s.name === 'pdf')).toBe(true);
  });
});
