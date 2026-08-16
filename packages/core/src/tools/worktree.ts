/**
 * Git worktree 隔离（对标 ZCode EnterWorktree/ExitWorktree）：
 * 在 <repo>/.bajin-worktrees/<name> 建独立工作树+分支，实验性修改不污染主工作区；
 * ExitWorktree 切回原目录（可选删除工作树与分支）。
 */

import { z } from 'zod';
import type { ToolDefinition } from '@bajin/shared';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';

const exec = promisify(execFile);

function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return exec('git', ['-C', cwd, ...args], { timeout: 30_000 });
}

/** 找主仓库根（worktree 内 --show-toplevel 返回 worktree 自身，须走 --git-common-dir）；非 git 返回 null */
async function repoRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const common = stdout.trim();
    if (!common) return null;
    const root = path.dirname(common);
    return root && root !== '/' ? root : null;
  } catch {
    return null;
  }
}

const EnterInput = z.object({
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/).optional().describe('worktree 名（缺省 experiment-<随机>；分支名 bajin/<name>）'),
  base: z.string().optional().describe('基线（分支名/提交，缺省当前 HEAD）'),
});

export function createEnterWorktreeTool(agentHost: () => { setCwd(cwd: string): void; cwd(): string }): ToolDefinition<typeof EnterInput> {
  return {
    name: 'EnterWorktree',
    description:
      'Create an isolated git worktree (.bajin-worktrees/<name> + 分支 bajin/<name>) and switch this session into it. 适合试验性/大改动：主工作区不受影响，满意后再合并。需要 git 仓库。',
    inputSchema: EnterInput,
    metadata: { readOnly: false, riskLevel: 'medium', timeoutMs: 60_000 },
    async execute(input) {
      const cur = agentHost().cwd();
      const root = await repoRoot(cur);
      if (!root) return { ok: false, output: '当前目录不是 git 仓库（无 .git），无法创建 worktree' };
      const name = input.name ?? `experiment-${Math.random().toString(36).slice(2, 7)}`;
      const branch = `bajin/${name}`;
      const wtDir = path.join(root, '.bajin-worktrees', name);
      try {
        await git(root, 'worktree', 'add', '-b', branch, wtDir, input.base ?? 'HEAD');
      } catch (err) {
        return { ok: false, output: `创建失败: ${err instanceof Error ? err.message : err}（分支或目录已存在时换个 name）` };
      }
      agentHost().setCwd(wtDir);
      return { ok: true, output: `已进入 worktree：${wtDir}\n分支：${branch}（基线 ${input.base ?? 'HEAD'}）\n本会话的文件操作都在此目录进行；完成后 ExitWorktree 返回主工作区。` };
    },
  };
}

const ExitInput = z.object({
  remove: z.boolean().optional().describe('true=同时删除 worktree 目录与分支（未合并改动会被拒绝，需先合并或强制）'),
});

export function createExitWorktreeTool(agentHost: () => { setCwd(cwd: string): void; cwd(): string; initialCwd(): string }): ToolDefinition<typeof ExitInput> {
  return {
    name: 'ExitWorktree',
    description: 'Leave the current worktree and return to the original working directory. remove=true 时顺带清理 worktree 与分支。',
    inputSchema: ExitInput,
    metadata: { readOnly: false, riskLevel: 'medium', timeoutMs: 60_000 },
    async execute(input) {
      const host = agentHost();
      const cur = host.cwd();
      const root = await repoRoot(cur);
      const origin = host.initialCwd();
      if (!root || !cur.startsWith(path.join(root, '.bajin-worktrees'))) {
        return { ok: false, output: '当前不在 worktree 中（无需退出）' };
      }
      let extra = '';
      if (input.remove) {
        try {
          await git(root, 'worktree', 'remove', cur);
          // 当前 worktree 分支：从目录名推（与 Enter 命名一致）
          const name = path.basename(cur);
          await git(root, 'branch', '-D', `bajin/${name}`).catch(() => undefined);
          extra = `\n已删除 worktree 与分支 bajin/${name}`;
        } catch (err) {
          extra = `\n清理失败（可能有未提交改动）: ${err instanceof Error ? err.message : err}`;
        }
      }
      host.setCwd(origin);
      return { ok: true, output: `已退出 worktree，回到：${origin}${extra}` };
    },
  };
}
