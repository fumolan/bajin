import { z } from 'zod';
import type { ToolDefinition } from '@bajin/shared';
import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 20_000;

const BashInput = z.object({
  command: z.string().describe('要执行的 shell 命令（经 bash -c）'),
  timeout_ms: z.number().int().positive().optional().describe('超时毫秒数，默认 120000'),
});

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n...(输出已截断，共 ${text.length} 字符)`;
}

export const bashTool: ToolDefinition<typeof BashInput> = {
  name: 'Bash',
  description:
    '执行 shell 命令（cwd 为当前工作区；Linux/macOS 走 bash -c，Windows 走 cmd /c，可用 BAJIN_SHELL 覆盖）。适合 git、构建、包管理等；文件内容的查看/修改优先用 Read/Edit 工具。',
  inputSchema: BashInput,
  metadata: { readOnly: false, riskLevel: 'high', timeoutMs: DEFAULT_TIMEOUT_MS },
  async execute(input, ctx) {
    const isWin = process.platform === 'win32';
    const configured = ctx.env?.['BAJIN_SHELL'] ?? process.env['BAJIN_SHELL'];
    const shell = configured ?? (isWin ? (process.env['COMSPEC'] ?? 'cmd.exe') : '/bin/bash');
    const shellArgs = isWin && !configured ? ['/c', input.command] : ['-c', input.command];
    const timeout = Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT_MS, 600_000);
    return await new Promise((resolve) => {
      const child = spawn(shell, shellArgs, {
        cwd: ctx.cwd,
        shell: false,
        env: { ...process.env, ...(ctx.env ?? {}), pwd: ctx.cwd },
      });
      let stdout = '';
      let stderr = '';
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, timeout);

      child.stdout.on('data', (d: Buffer) => {
        if (stdout.length < MAX_OUTPUT_CHARS * 2) stdout += d.toString('utf8');
      });
      child.stderr.on('data', (d: Buffer) => {
        if (stderr.length < MAX_OUTPUT_CHARS * 2) stderr += d.toString('utf8');
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, output: `启动失败: ${err.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const parts: string[] = [];
        if (stdout.trim()) parts.push(truncate(stdout.trimEnd()));
        if (stderr.trim()) parts.push(`[stderr]\n${truncate(stderr.trimEnd())}`);
        if (killed) parts.push(`[超时] 命令在 ${timeout}ms 后被强制终止`);
        parts.push(`[退出码 ${code ?? 'null'}]`);
        resolve({ ok: code === 0 && !killed, output: parts.join('\n') || '(无输出)' });
      });
    });
  },
};
