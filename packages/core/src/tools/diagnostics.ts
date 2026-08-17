/**
 * 诊断工具（对标 ZCode LSP Diagnostics，最小切片用 tsc --noEmit）：
 * 查询 TypeScript 编译错误/警告；无 tsconfig 时回退 node --check 单文件语法检查。
 */

import { z } from 'zod';
import type { ToolDefinition } from '@bajin/shared';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';

const exec = promisify(execFile);

const DiagnosticsInput = z.object({
  file: z.string().optional().describe('只检查该文件（相对路径）；缺省检查整个项目'),
});

export interface DiagnosticItem {
  file: string;
  line: number;
  col: number;
  severity: 'error' | 'warning';
  message: string;
  code: string;
}

/** 解析 tsc 输出（file(line,col): error TS1234: message） */
export function parseTscOutput(stdout: string): DiagnosticItem[] {
  const out: DiagnosticItem[] = [];
  const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    out.push({
      file: m[1]!,
      line: Number(m[2]),
      col: Number(m[3]),
      severity: m[4] as 'error' | 'warning',
      code: m[5]!,
      message: m[6]!,
    });
  }
  return out;
}

export function createDiagnosticsTool(): ToolDefinition<typeof DiagnosticsInput> {
  return {
    name: 'Diagnostics',
    description:
      'Get TypeScript/JavaScript compiler diagnostics for the current project or a specific file. 修改代码后用它验证类型是否正确。',
    inputSchema: DiagnosticsInput,
    metadata: { readOnly: true, riskLevel: 'low', timeoutMs: 60_000, concurrentSafe: true },
    async execute(input, ctx) {
      const cwd = ctx.cwd;
      const hasTsconfig = fs.existsSync(path.join(cwd, 'tsconfig.json'));

      // 有 tsconfig → tsc --noEmit
      if (hasTsconfig) {
        try {
          const args = ['--noEmit', '--pretty', 'false', '--skipLibCheck'];
          if (input.file) args.push(input.file);
          const { stdout, stderr } = await exec('npx', ['tsc', ...args], { cwd, timeout: 50_000 });
          const diags = parseTscOutput(stdout + stderr);
          if (diags.length === 0) return { ok: true, output: '✓ 无编译错误' };
          return {
            ok: true,
            output: formatDiagnostics(diags),
          };
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; message?: string };
          const raw = (e.stdout ?? '') + (e.stderr ?? '');
          const diags = parseTscOutput(raw);
          if (diags.length > 0) return { ok: true, output: formatDiagnostics(diags) };
          return { ok: false, output: `tsc 执行失败: ${e.message ?? raw.slice(0, 200)}` };
        }
      }

      // 无 tsconfig → 单文件 node --check（仅语法）
      if (input.file?.endsWith('.ts') || input.file?.endsWith('.tsx')) {
        return { ok: false, output: '项目无 tsconfig.json，无法运行 tsc 类型检查；可用 Read 手动审查' };
      }
      if (input.file) {
        try {
          await exec('node', ['--check', input.file], { cwd, timeout: 10_000 });
          return { ok: true, output: `✓ ${input.file} 语法正确` };
        } catch (err) {
          const e = err as { stderr?: string };
          return { ok: true, output: `✗ ${input.file}:\n${(e.stderr ?? '').trim().slice(0, 500)}` };
        }
      }
      return { ok: false, output: '项目无 tsconfig.json 且未指定文件，无法诊断' };
    },
  };
}

function formatDiagnostics(diags: DiagnosticItem[]): string {
  const errors = diags.filter((d) => d.severity === 'error');
  const warnings = diags.filter((d) => d.severity === 'warning');
  const lines = [
    `${errors.length} 个错误，${warnings.length} 个警告`,
    '',
    ...diags.slice(0, 30).map((d) =>
      `${d.severity === 'error' ? '✗' : '⚠'} ${d.file}:${d.line}:${d.col} [${d.code}] ${d.message}`
    ),
  ];
  if (diags.length > 30) lines.push(`... 还有 ${diags.length - 30} 条`);
  return lines.join('\n');
}
