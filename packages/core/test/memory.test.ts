import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { readMemories, saveMemory, clearMemories, memoryPromptBlock, parseMemoryFile } from '../src/memory.js';

const home = await mkdtemp(path.join(tmpdir(), 'bajin-mem-home-'));
const cwd = await mkdtemp(path.join(tmpdir(), 'bajin-mem-cwd-'));
process.env.BAJIN_HOME = home;

afterAll(async () => {
  delete process.env.BAJIN_HOME;
  await Promise.all([rm(home, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]).catch(() => undefined);
});

describe('记忆系统', () => {
  it('save → 追加条目；read 聚合用户级+项目级；recall 语义由调用方过滤', async () => {
    await saveMemory(cwd, 'user', '用户偏好用 pnpm');
    await saveMemory(cwd, 'user', '回复要简洁');
    await mkdir(path.join(cwd, '.bajin', 'memory'), { recursive: true });
    await writeFile(path.join(cwd, '.bajin', 'memory', 'MEMORY.md'), '- [2026-08-15 10:00] 项目用 vitest\n', 'utf8');

    const all = await readMemories(cwd);
    expect(all.filter((e) => e.scope === 'user').length).toBe(2);
    expect(all.find((e) => e.scope === 'project')?.text).toBe('项目用 vitest');
    const hit = all.filter((e) => e.text.includes('pnpm'));
    expect(hit.length).toBe(1);
  });

  it('memoryPromptBlock 生成注入块；clear 清空对应 scope', async () => {
    const entries = await readMemories(cwd);
    const block = memoryPromptBlock(entries);
    expect(block).toContain('# 用户长期记忆');
    expect(block).toContain('# 项目记忆');
    expect(block).toContain('pnpm');

    const n = await clearMemories(cwd, 'user');
    expect(n).toBe(2);
    const after = await readMemories(cwd);
    expect(after.every((e) => e.scope === 'project')).toBe(true);
  });

  it('parseMemoryFile 容错：跳过空行与非条目行', () => {
    const entries = parseMemoryFile('# 标题\n\n- [2026-01-01 09:00] 有条目\n普通行\n', 'user');
    expect(entries.length).toBe(1);
    expect(entries[0]?.text).toBe('有条目');
  });
});
