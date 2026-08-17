import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { parseTscOutput, createDiagnosticsTool } from '../src/tools/diagnostics.js';

const dir = await mkdtemp(path.join(tmpdir(), 'bajin-diag-'));
afterAll(async () => { await rm(dir, { recursive: true, force: true }).catch(() => undefined); });

describe('parseTscOutput', () => {
  it('标准 tsc 输出解析', () => {
    const raw = `src/a.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.
src/b.ts(3,1): warning TS6133: 'x' is declared but its value is never read.`;
    const diags = parseTscOutput(raw);
    expect(diags).toHaveLength(2);
    expect(diags[0]).toEqual({
      file: 'src/a.ts', line: 10, col: 5, severity: 'error', code: 'TS2322',
      message: "Type 'string' is not assignable to type 'number'.",
    });
    expect(diags[1]!.severity).toBe('warning');
  });

  it('空/非诊断输出返回空数组', () => {
    expect(parseTscOutput('')).toEqual([]);
    expect(parseTscOutput('some random text\nno diagnostics here')).toEqual([]);
  });
});

describe('Diagnostics 工具', () => {
  it('无 tsconfig + 指定 .js 文件：node --check 语法检查', async () => {
    await writeFile(path.join(dir, 'good.js'), 'const x = 1;', 'utf8');
    await writeFile(path.join(dir, 'bad.js'), 'const x = ;', 'utf8');
    const tool = createDiagnosticsTool();
    const r1 = await tool.execute({ file: 'good.js' }, { cwd: dir } as never);
    expect(r1.ok).toBe(true);
    expect(r1.output).toContain('✓');
    const r2 = await tool.execute({ file: 'bad.js' }, { cwd: dir } as never);
    expect(r2.output).toContain('✗');
  });

  it('无 tsconfig + .ts 文件：提示需要 tsconfig', async () => {
    const tool = createDiagnosticsTool();
    const r = await tool.execute({ file: 'a.ts' }, { cwd: dir } as never);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('tsconfig');
  });

  it('无 tsconfig + 未指定文件：报错', async () => {
    const tool = createDiagnosticsTool();
    const r = await tool.execute({}, { cwd: dir } as never);
    expect(r.ok).toBe(false);
  });
});
