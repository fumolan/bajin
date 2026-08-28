import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { importClaudeSettings } from '../src/import-external.js';

let home: string;   // bajin 数据根
let src: string;    // 假 ~/.claude 所在父目录（.claude.json 也在这）
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'bajin-home-'));
  const parent = await mkdtemp(path.join(tmpdir(), 'claude-parent-'));
  src = path.join(parent, '.claude');
  await mkdir(path.join(src, 'commands'), { recursive: true });
  await mkdir(path.join(src, 'skills/pdf-tool'), { recursive: true });
  await mkdir(path.join(src, 'skills/broken'), { recursive: true });
  await mkdir(path.join(src, 'agents'), { recursive: true });
  await writeFile(path.join(src, 'commands', 'deploy.md'), '---\ndescription: 部署\n---\n部署流程', 'utf8');
  await writeFile(path.join(src, 'commands', 'notes.txt'), '非 md 忽略', 'utf8');
  await writeFile(path.join(src, 'skills', 'pdf-tool', 'SKILL.md'), '# PDF 技能', 'utf8');
  await writeFile(path.join(src, 'agents', 'reviewer.md'), '你是代码评审员', 'utf8');
  await writeFile(path.join(parent, '.claude.json'), JSON.stringify({ mcpServers: { fetcher: { type: 'stdio', command: 'npx', args: ['x'] } } }), 'utf8');
});

describe('外部 Agent 导入（R8-1）', () => {
  it('命令/技能/子代理/MCP 全量复制与合并', async () => {
    const r = await importClaudeSettings({ sourceDir: src, home });
    expect(r.commands).toEqual(['deploy.md']);
    expect(r.skills).toEqual(['pdf-tool']);
    expect(r.agents).toEqual(['reviewer.md']);
    expect(r.mcpServers).toEqual(['fetcher']);
    expect(r.skipped).toContainEqual({ what: 'skills/broken', reason: '缺 SKILL.md' });
    // 落盘验证
    expect(await readFile(path.join(home, '.bajin', 'commands', 'deploy.md'), 'utf8')).toContain('部署流程');
    expect(await readFile(path.join(home, '.bajin', 'skills', 'pdf-tool', 'SKILL.md'), 'utf8')).toContain('PDF 技能');
    expect(await readFile(path.join(home, '.bajin', 'agents', 'reviewer.md'), 'utf8')).toContain('评审员');
    const cfg = JSON.parse(await readFile(path.join(home, '.bajin', 'config.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(cfg.mcpServers['fetcher']).toBeTruthy();
  });

  it('dry-run 只清点不落盘', async () => {
    const r = await importClaudeSettings({ sourceDir: src, home, dryRun: true });
    expect(r.commands).toEqual(['deploy.md']);
    let threw = false;
    try { await readFile(path.join(home, '.bajin', 'commands', 'deploy.md'), 'utf8'); } catch { threw = true; }
    expect(threw).toBe(true);
  });

  it('二次导入：同名 MCP 不覆盖，已有文件照常重写（幂等复制）', async () => {
    await importClaudeSettings({ sourceDir: src, home });
    // 预置一个同名 MCP 带不同 command，二导后应保留原值
    const cfgPath = path.join(home, '.bajin', 'config.json');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as { mcpServers: Record<string, { command?: string }> };
    cfg.mcpServers['fetcher'] = { type: 'stdio', command: '原命令' };
    await writeFile(cfgPath, JSON.stringify(cfg), 'utf8');
    const r2 = await importClaudeSettings({ sourceDir: src, home });
    expect(r2.mcpServers).toEqual([]);
    expect(r2.skipped).toContainEqual({ what: 'mcp:fetcher', reason: '已存在同名，不覆盖' });
    const after = JSON.parse(await readFile(cfgPath, 'utf8')) as { mcpServers: Record<string, { command?: string }> };
    expect(after.mcpServers['fetcher']?.command).toBe('原命令');
  });

  it('源目录不存在：空报告+原因，不抛错', async () => {
    const r = await importClaudeSettings({ sourceDir: path.join(home, 'nope'), home });
    expect(r.commands).toEqual([]);
    expect(r.skipped[0]?.reason).toBe('源目录不存在');
    await rm(home, { recursive: true, force: true });
  });
});
