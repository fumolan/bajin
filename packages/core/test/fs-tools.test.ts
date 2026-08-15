import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { editTool, readTool, writeTool } from '../src/tools/fs.js';
import type { ToolContext } from '@bajin/shared';

let dir: string;
let ctx: ToolContext;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bajin-test-'));
  ctx = { cwd: dir, state: new Map(), askUser: async () => null };
});

describe('Read 工具', () => {
  it('输出带行号的内容', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'hello\nworld\n');
    const r = await readTool.execute({ file_path: 'a.txt' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('1\thello');
    expect(r.output).toContain('2\tworld');
  });

  it('offset/limit 分段', async () => {
    await fs.writeFile(path.join(dir, 'b.txt'), 'l1\nl2\nl3\n');
    const r = await readTool.execute({ file_path: 'b.txt', offset: 1, limit: 1 }, ctx);
    expect(r.output).toBe('     2\tl2');
  });

  it('文件不存在时报错', async () => {
    const r = await readTool.execute({ file_path: 'nope.txt' }, ctx);
    expect(r.ok).toBe(false);
  });
});

describe('Write 工具', () => {
  it('自动创建父目录', async () => {
    const r = await writeTool.execute({ file_path: 'src/deep/x.ts', content: 'export {}' }, ctx);
    expect(r.ok).toBe(true);
    await expect(fs.readFile(path.join(dir, 'src/deep/x.ts'), 'utf8')).resolves.toBe('export {}');
  });
});

describe('Edit 工具', () => {
  it('唯一匹配时替换成功', async () => {
    await fs.writeFile(path.join(dir, 'c.txt'), 'const a = 1;\nconst b = 2;\n');
    const r = await editTool.execute({ file_path: 'c.txt', old_string: 'const a = 1;', new_string: 'const a = 42;' }, ctx);
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(dir, 'c.txt'), 'utf8')).toContain('const a = 42;');
  });

  it('多处匹配且未 replace_all 时报错', async () => {
    await fs.writeFile(path.join(dir, 'd.txt'), 'x\nx\nx\n');
    const r = await editTool.execute({ file_path: 'd.txt', old_string: 'x', new_string: 'y' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('3 处');
  });

  it('replace_all 替换全部', async () => {
    await fs.writeFile(path.join(dir, 'e.txt'), 'x\nx\n');
    const r = await editTool.execute({ file_path: 'e.txt', old_string: 'x', new_string: 'y', replace_all: true }, ctx);
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(dir, 'e.txt'), 'utf8')).toBe('y\ny\n');
  });

  it('未找到匹配时报错且不提示改写文件', async () => {
    await fs.writeFile(path.join(dir, 'f.txt'), 'content\n');
    const r = await editTool.execute({ file_path: 'f.txt', old_string: '不存在的内容', new_string: 'z' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('未找到匹配');
  });
});
