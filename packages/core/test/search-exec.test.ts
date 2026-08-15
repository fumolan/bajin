import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { globTool, grepTool, globToRegExp } from '../src/tools/search.js';
import { bashTool } from '../src/tools/exec.js';
import type { ToolContext } from '@bajin/shared';

let dir: string;
let ctx: ToolContext;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bajin-search-'));
  ctx = { cwd: dir, state: new Map(), askUser: async () => null };
  await fs.writeFile(path.join(dir, 'a.ts'), 'const x = 1;\nconst y = 2;\n');
  await fs.writeFile(path.join(dir, 'b.js'), 'const x = 3;\n');
  await fs.mkdir(path.join(dir, 'sub'), { recursive: true });
  await fs.writeFile(path.join(dir, 'sub', 'c.ts'), 'deep const x = 4;\n');
  await fs.mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(dir, 'node_modules', 'pkg', 'd.ts'), 'should be skipped\n');
});

describe('globToRegExp', () => {
  it('* 不跨目录，** 跨目录', () => {
    expect(globToRegExp('*.ts').test('a.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('sub/a.ts')).toBe(false);
    expect(globToRegExp('**/*.ts').test('sub/a.ts')).toBe(true);
    expect(globToRegExp('**/*.ts').test('a.ts')).toBe(true);
  });

  it('{a,b} 与 ? 通配', () => {
    expect(globToRegExp('{a,b}.ts').test('a.ts')).toBe(true);
    expect(globToRegExp('{a,b}.ts').test('c.ts')).toBe(false);
    expect(globToRegExp('?.ts').test('a.ts')).toBe(true);
    expect(globToRegExp('?.ts').test('ab.ts')).toBe(false);
  });

  it('特殊字符被转义', () => {
    expect(globToRegExp('a.b+ts').test('a.b+ts')).toBe(true);
    expect(globToRegExp('a.b+ts').test('axbcts')).toBe(false);
  });
});

describe('Glob 工具', () => {
  it('**/*.ts 找到嵌套文件且跳过 node_modules', async () => {
    const r = await globTool.execute({ pattern: '**/*.ts' }, ctx);
    expect(r.output).toContain('a.ts');
    expect(r.output).toContain(path.join('sub', 'c.ts'));
    expect(r.output).not.toContain('node_modules');
  });

  it('固定前导目录限定范围', async () => {
    const r = await globTool.execute({ pattern: 'sub/*.ts' }, ctx);
    expect(r.output).toContain('c.ts');
    expect(r.output).not.toContain('a.ts');
  });
});

describe('Grep 工具', () => {
  it('按正则搜内容，输出 文件:行号:行', async () => {
    const r = await grepTool.execute({ pattern: 'const x' }, ctx);
    expect(r.output).toContain('a.ts:1:');
    expect(r.output).toContain('b.js:1:');
    expect(r.output).toContain('deep const x');
  });

  it('glob 过滤文件类型', async () => {
    const r = await grepTool.execute({ pattern: 'const x', glob: '*.ts' }, ctx);
    expect(r.output).toContain('a.ts');
    expect(r.output).not.toContain('b.js');
  });

  it('ignore_case 生效', async () => {
    await fs.writeFile(path.join(dir, 'case.txt'), 'HELLO world\n');
    const r = await grepTool.execute({ pattern: 'hello', ignore_case: true }, ctx);
    expect(r.output).toContain('case.txt:1:');
  });
});

describe('Bash 工具', () => {
  it('执行命令并报告退出码', async () => {
    const r = await bashTool.execute({ command: 'echo hi && echo err >&2; true' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('hi');
    expect(r.output).toContain('退出码 0');
  });

  it('非零退出码 → ok=false', async () => {
    const r = await bashTool.execute({ command: 'exit 3' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('退出码 3');
  });

  it('超时被终止', async () => {
    const r = await bashTool.execute({ command: 'sleep 5', timeout_ms: 300 }, ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('超时');
  }, 5000);
});
