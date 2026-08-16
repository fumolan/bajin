import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createEnterWorktreeTool, createExitWorktreeTool } from '../src/tools/worktree.js';

const exec = promisify(execFile);
const git = (cwd: string, ...a: string[]) => exec('git', ['-C', cwd, ...a]);

const dir = await mkdtemp(path.join(tmpdir(), 'bajin-wt-'));
afterAll(async () => { await rm(dir, { recursive: true, force: true }).catch(() => undefined); });

function makeHost(cwd: string) {
  const h = { _cwd: cwd, origin: cwd, setCwd(d: string) { this._cwd = d; }, cwd() { return this._cwd; }, initialCwd() { return this.origin; } };
  return h;
}

describe('EnterWorktree / ExitWorktree', () => {
  it('进入：建分支+目录并切 cwd；主工作区文件隔离；退出切回；remove 清理', async () => {
    // 建最小 git 仓库
    await writeFile(path.join(dir, 'base.txt'), 'v1', 'utf8');
    await git(dir, 'init', '-q');
    await git(dir, 'add', '.');
    await git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');

    const host = makeHost(dir);
    const enter = createEnterWorktreeTool(() => host);
    const r = await enter.execute({ name: 'exp1' }, { cwd: host.cwd() } as never);
    expect(r.ok).toBe(true);
    const wtDir = path.join(dir, '.bajin-worktrees', 'exp1');
    expect(host.cwd()).toBe(wtDir);
    // worktree 里能看到基线文件
    expect(await readFile(path.join(wtDir, 'base.txt'), 'utf8')).toBe('v1');
    // 隔离：在 worktree 写新文件，主目录看不到
    await writeFile(path.join(wtDir, 'only-in-wt.txt'), 'x', 'utf8');
    await expect(access(path.join(dir, 'only-in-wt.txt'))).rejects.toThrow();
    // 分支存在
    const branches = (await git(dir, 'branch', '--list', 'bajin/exp1')).stdout;
    expect(branches).toContain('bajin/exp1');

    // 不带 remove 退出
    const exit = createExitWorktreeTool(() => host);
    const r2 = await exit.execute({}, { cwd: host.cwd() } as never);
    expect(r2.ok).toBe(true);
    expect(host.cwd()).toBe(dir);
    await expect(access(wtDir)).resolves.toBeUndefined(); // 目录仍在

    // 再进同名失败（已存在）
    const dup = await enter.execute({ name: 'exp1' }, { cwd: host.cwd() } as never);
    expect(dup.ok).toBe(false);

    // 带 remove 退出清理
    await enter.execute({ name: 'exp2' }, { cwd: host.cwd() } as never);
    const r3 = await exit.execute({ remove: true }, { cwd: host.cwd() } as never);
    expect(r3.ok).toBe(true);
    expect(r3.output).toContain('已删除');
    await expect(access(path.join(dir, '.bajin-worktrees', 'exp2'))).rejects.toThrow();
  });

  it('非 git 目录：明确报错不炸', async () => {
    const plain = await mkdtemp(path.join(tmpdir(), 'bajin-wt-plain-'));
    try {
      const host = makeHost(plain);
      const r = await createEnterWorktreeTool(() => host).execute({ name: 'x' }, { cwd: plain } as never);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('git 仓库');
      const r2 = await createExitWorktreeTool(() => host).execute({}, { cwd: plain } as never);
      expect(r2.ok).toBe(false);
    } finally {
      await rm(plain, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
