import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { importCodexSettings, importCursorSettings, parseCodexMcpServers, mdcToSkillMd } from '../src/import-more.js';

let home: string;
beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), 'bajin-im-')); });

describe('Codex TOML mcp_servers 解析（R8-2）', () => {
  it('字符串/数组/内联表 + 多段 + 忽略其他段', () => {
    const toml = `
model = "gpt-5"
[profiles.x]
temperature = 0.7
[mcp_servers.fetcher]
command = "npx"
args = ["-y", "fetch-mcp"]
env = { HTTP_PROXY = "http://p:1", DEBUG = "1" }
[mcp_servers.search]
command = "uvx"
args = ["mcp-search"]
`;
    const out = parseCodexMcpServers(toml);
    expect(Object.keys(out).sort()).toEqual(['fetcher', 'search']);
    expect(out['fetcher']).toEqual({ command: 'npx', args: ['-y', 'fetch-mcp'], env: { HTTP_PROXY: 'http://p:1', DEBUG: '1' } });
    expect(out['search']).toEqual({ command: 'uvx', args: ['mcp-search'] });
  });
});

describe('Codex 导入', () => {
  it('prompts → 命令；config.toml MCP 合并；dry-run 不落盘', async () => {
    const src = await mkdtemp(path.join(tmpdir(), 'codex-'));
    await mkdir(path.join(src, 'prompts'), { recursive: true });
    await writeFile(path.join(src, 'prompts', 'review.md'), '# 评审\n评审这段代码', 'utf8');
    await writeFile(path.join(src, 'config.toml'), '[mcp_servers.fetcher]\ncommand = "npx"\nargs = ["a"]\n', 'utf8');
    const r = await importCodexSettings({ sourceDir: src, home });
    expect(r.commands).toEqual(['review.md']);
    expect(r.mcpServers).toEqual(['fetcher']);
    expect(await readFile(path.join(home, '.bajin', 'commands', 'review.md'), 'utf8')).toContain('评审');
    const cfg = JSON.parse(await readFile(path.join(home, '.bajin', 'config.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(cfg.mcpServers['fetcher']).toEqual({ command: 'npx', args: ['a'] });
    const d = await importCodexSettings({ sourceDir: src, home: (await mkdtemp(path.join(tmpdir(), 'h2-'))), dryRun: true });
    expect(d.mcpServers).toEqual(['fetcher']);
  });
});

describe('Cursor .mdc → SKILL.md 转换与导入', () => {
  it('frontmatter description/globs 转写', () => {
    const md = mdcToSkillMd('---\ndescription: 前端规范\nglobs: ["src/**/*.tsx"]\nalwaysApply: false\n---\n\n用 React 函数组件。');
    expect(md).toContain('description: 前端规范');
    expect(md).toContain('适用文件：["src/**/*.tsx"]');
    expect(md).toContain('用 React 函数组件。');
    expect(md).not.toContain('alwaysApply');
  });

  it('rules → 技能目录；mcp.json 合并', async () => {
    const src = await mkdtemp(path.join(tmpdir(), 'cursor-'));
    await mkdir(path.join(src, 'rules'), { recursive: true });
    await writeFile(path.join(src, 'rules', 'frontend.mdc'), '---\ndescription: 前端规范\n---\n\n用 TSX。', 'utf8');
    await writeFile(path.join(src, 'mcp.json'), JSON.stringify({ mcpServers: { db: { type: 'stdio', command: 'x' } } }), 'utf8');
    const r = await importCursorSettings({ sourceDir: src, home });
    expect(r.skills).toEqual(['frontend']);
    expect(r.mcpServers).toEqual(['db']);
    const sk = await readFile(path.join(home, '.bajin', 'skills', 'frontend', 'SKILL.md'), 'utf8');
    expect(sk).toContain('前端规范');
  });
});
