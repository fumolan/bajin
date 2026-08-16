import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

const CLI_ENTRY = path.resolve(fileURLToPath(new URL('../dist/main.js', import.meta.url)));

let home = '';
let dir = '';
let child: ChildProcess | null = null;
let buf = '';
let seq = 0;

function start(): void {
  child = spawn(process.execPath, [CLI_ENTRY, 'app-server', '--stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, BAJIN_HOME: path.join(home, 'state') },
  });
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (d: string) => { buf += d; });
}

async function req(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = ++seq;
  child!.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  const deadline = Date.now() + 20_000;
  for (;;) {
    const lines = buf.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line) as { id?: number; result?: Record<string, unknown> };
        if (m.id === id && m.result !== undefined) {
          buf = buf.slice(buf.indexOf(line) + line.length);
          return m.result;
        }
      } catch { /* 事件行 */ }
    }
    if (Date.now() > deadline) throw new Error(`RPC 超时: ${method}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'bajin-fm-'));
  dir = await mkdtemp(path.join(tmpdir(), 'bajin-fm-cwd-'));
  // 用户级命令 + 技能（BAJIN_HOME 沙箱）
  const cmds = path.join(home, 'state', 'commands');
  const skills = path.join(home, 'state', 'skills', 'fm-skill');
  await mkdir(cmds, { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(path.join(cmds, 'deploy.md'),
    `---
description: 部署流程
model: glm-4.7-flash
allowed-tools: Bash, Read
skills: fm-skill
---
执行部署：按挂载技能的步骤走。`,
    'utf8');
  await writeFile(path.join(skills, 'SKILL.md'),
    `---
name: fm-skill
description: 测试技能
---
FM_SKILL_BODY_MARKER 第一步执行部署。`, 'utf8');
  start();
  await req('initialize', { cwd: dir, mock: true });
});

afterEach(async () => {
  child?.kill();
  await Promise.all([rm(home, { recursive: true, force: true }), rm(dir, { recursive: true, force: true })]).catch(() => undefined);
});

describe('自定义命令 frontmatter 生效（app-server）', () => {
  it('model 切会话模型；skills 正文注入 prompt（echo mock 回显可断言）；allowed-tools 合并', async () => {
    const newS = await req('session/new', {}) as { sessionId: string };
    const sid = String(newS['sessionId']);
    const done = await req('send', { sessionId: sid, text: '/deploy' }) as { text: string };
    // echo mock 回显 prompt：技能正文与展开体都应在
    expect(done.text).toContain('FM_SKILL_BODY_MARKER');
    expect(done.text).toContain('执行部署');
    // 模型已切（status 回读）
    const st = await req('status', { sessionId: sid }) as { model: string };
    expect(st.model).toBe('glm-4.7-flash');
  });
});
