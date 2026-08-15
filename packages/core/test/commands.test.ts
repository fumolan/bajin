import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { discoverCommands, findCommand, expandCommand, parseCommandRaw, parseFlatFrontmatter } from '../src/commands.js';

let home: string;
let proj: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bajin-home-'));
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'bajin-proj-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

function write(dir: string, rel: string, content: string): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

describe('自定义 slash 命令', () => {
  it('发现用户级与项目级命令，嵌套目录用冒号命名', async () => {
    write(home, '.bajin/commands/review/code.md', '---\ndescription: 审查代码\n---\n审查 $ARGUMENTS');
    write(proj, '.bajin/commands/deploy.md', '---\ndescription: 部署\n---\n执行部署');
    const cmds = await discoverCommands(proj, home);
    const names = cmds.map((c) => c.name);
    expect(names).toContain('review:code');
    expect(names).toContain('deploy');
    expect(cmds.find((c) => c.name === 'review:code')!.source).toBe('user');
    expect(cmds.find((c) => c.name === 'deploy')!.source).toBe('project');
  });

  it('用户级同名命令覆盖项目级（先到先得）', async () => {
    write(home, '.bajin/commands/check.md', '---\ndescription: 用户版\n---\n用户版正文');
    write(proj, '.bajin/commands/check.md', '---\ndescription: 项目版\n---\n项目版正文');
    const cmds = await discoverCommands(proj, home);
    expect(cmds.filter((c) => c.name === 'check')).toHaveLength(1);
    expect(cmds[0]!.source).toBe('user');
    expect(cmds[0]!.description).toBe('用户版');
  });

  it('工作区向上扫描：子目录命令优先于仓库根，扫到 .git 为止', async () => {
    // proj 是仓库根（放 .git），proj/sub/deep 是 cwd
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    write(proj, '.bajin/commands/root.md', '---\ndescription: 根\n---\n根命令');
    write(proj, 'sub/.bajin/commands/deep.md', '---\ndescription: 深\n---\n深命令');
    const cmds = await discoverCommands(path.join(proj, 'sub'), home);
    const deep = cmds.find((c) => c.name === 'deep');
    expect(deep?.source).toBe('project');
    expect(cmds.find((c) => c.name === 'root')).toBeTruthy();
    // 同名时靠近 cwd 的赢
    write(proj, 'sub/.bajin/commands/root.md', '---\ndescription: 子级覆盖\n---\nx');
    const cmds2 = await discoverCommands(path.join(proj, 'sub'), home);
    expect(cmds2.find((c) => c.name === 'root')!.description).toBe('子级覆盖');
    // .git 之上不再扫描：proj 的父目录放命令不应被发现
    const above = path.dirname(proj);
    write(above, '.bajin/commands/outside.md', '---\ndescription: 外部\n---\nx');
    const cmds3 = await discoverCommands(path.join(proj, 'sub'), home);
    expect(cmds3.find((c) => c.name === 'outside')).toBeUndefined();
    fs.rmSync(path.join(above, '.bajin'), { recursive: true, force: true });
  });

  it('非法文件名被丢弃（大写/点/空格）', async () => {
    write(home, '.bajin/commands/MyCmd.md', '---\ndescription: x\n---\nx');
    write(home, '.bajin/commands/my.cmd.md', '---\ndescription: x\n---\nx');
    write(home, '.bajin/commands/ok_name.md', '---\ndescription: x\n---\nx');
    const cmds = await discoverCommands(proj, home);
    expect(cmds.map((c) => c.name)).toEqual(['ok_name']);
  });

  it('frontmatter：扁平解析，缩进行与未知 key 忽略，连字符 key 生效', () => {
    const fm = parseFlatFrontmatter(`
description: 一句话说明
argument-hint: [文件] 说明
allowed-tools: Read, Grep
model: glm-5.3
misspelled_key: 无效
  indented: 缩进忽略
`);
    expect(fm['description']).toBe('一句话说明');
    expect(fm['argument-hint']).toBe('[文件] 说明');
    expect(fm['allowed-tools']).toBe('Read, Grep');
    expect(fm['model']).toBe('glm-5.3');
    expect(fm['misspelled_key']).toBeUndefined();
    expect(fm['indented']).toBeUndefined();
  });

  it('description 缺省时取正文第一个非空行；全空命令被丢弃', () => {
    const fallback = parseCommandRaw('第一行就是说明\n正文继续', 'x', 'user');
    expect(fallback?.description).toBe('第一行就是说明');
    expect(parseCommandRaw('', 'x', 'user')).toBeNull();
    expect(parseCommandRaw('---\ndescription: 只有描述\n---\n', 'x', 'user')?.body).toBe('');
  });

  it('$ARGUMENTS 与 $1/$2 替换；越界为空；无占位符时参数追加', () => {
    const cmd = { name: 't', description: '', body: '查 $1 和 $2，全部：$ARGUMENTS', file: '', source: 'user' as const };
    expect(expandCommand(cmd, 'a b c')).toBe('查 a 和 b，全部：a b c');
    const only1 = { ...cmd, body: '只 $1' };
    expect(expandCommand(only1, 'x')).toBe('只 x');
    expect(expandCommand(only1, '')).toBe('只'); // 尾部空白被 trim
    const noSub = { ...cmd, body: '没有占位符的正文' };
    expect(expandCommand(noSub, 'abc')).toBe('没有占位符的正文\n\nUser arguments: abc');
    expect(expandCommand(noSub, '')).toBe('没有占位符的正文');
  });

  it('动态 shell（!`cmd`）被拒绝', () => {
    const cmd = { name: 't', description: '', body: '执行 !`ls` 看看', file: '', source: 'user' as const };
    expect(() => expandCommand(cmd, '')).toThrow(/动态 shell/);
  });

  it('findCommand 支持带/不带前导斜杠', async () => {
    write(home, '.bajin/commands/review/code.md', '---\ndescription: 审查\n---\n审查');
    const cmds = await discoverCommands(proj, home);
    expect(findCommand(cmds, '/review:code')?.name).toBe('review:code');
    expect(findCommand(cmds, 'review:code')?.name).toBe('review:code');
    expect(findCommand(cmds, '/nope')).toBeUndefined();
  });
});
