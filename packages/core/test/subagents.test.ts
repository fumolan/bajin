import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { discoverSubagents } from '../src/subagents.js';

const home = await mkdtemp(path.join(tmpdir(), 'bajin-sub-home-'));
const cwd = await mkdtemp(path.join(tmpdir(), 'bajin-sub-cwd-'));

afterAll(async () => {
  await Promise.all([rm(home, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]).catch(() => undefined);
});

describe('自定义子代理发现（.bajin/agents/*.md）', () => {
  it('解析 frontmatter（name/description/tools）与正文；项目级覆盖用户级同名', async () => {
    await mkdir(path.join(home, '.bajin', 'agents'), { recursive: true });
    await mkdir(path.join(cwd, '.bajin', 'agents'), { recursive: true });

    await writeFile(
      path.join(home, '.bajin', 'agents', 'reviewer.md'),
      `---
name: reviewer
description: 代码评审专用
tools: Read, Grep, Glob
---

评审要点：正确性、边界、可读性。`,
      'utf8',
    );
    await writeFile(
      path.join(home, '.bajin', 'agents', 'skipped.md'),
      `无 frontmatter 的普通文件也应按文件名生效`,
      'utf8',
    );
    await writeFile(
      path.join(cwd, '.bajin', 'agents', 'reviewer.md'),
      `---
name: reviewer
description: 项目级评审员（覆盖用户级）
---

项目内评审规则。`,
      'utf8',
    );

    const defs = await discoverSubagents(cwd, home);
    const reviewer = defs.find((d) => d.name === 'reviewer');
    expect(reviewer?.source).toBe('project');
    expect(reviewer?.description).toBe('项目级评审员（覆盖用户级）');
    expect(reviewer?.body).toContain('项目内评审规则');
    const skipped = defs.find((d) => d.name === 'skipped');
    expect(skipped?.source).toBe('user');
    expect(skipped?.description).toContain('skipped');
    expect(reviewer?.tools).toBeUndefined();
  });

  it('目录不存在时返回空数组', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'bajin-sub-empty-'));
    try {
      expect(await discoverSubagents(empty, empty)).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
