import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const exec = promisify(execFile);
const require_ = createRequire(import.meta.url);
const { openSessionStore, storeListSessions, storeLoadTranscript } = require_('@bajin/core') as typeof import('@bajin/core');
const CLI_ENTRY = path.resolve(fileURLToPath(new URL('../dist/main.js', import.meta.url)));

const home = await mkdtemp(path.join(tmpdir(), 'bajin-mig-home-'));
const db = path.join(home, 'sessions.db');
const sid = 'sess_mig1';

afterAll(async () => { await rm(home, { recursive: true, force: true }).catch(() => undefined); });

async function runMigrate(): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await exec(process.execPath, [CLI_ENTRY, 'migrate', '--db', db], { env: { ...process.env, BAJIN_HOME: home } });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; code?: number };
    return { stdout: e.stdout ?? '', code: e.code ?? 1 };
  }
}

describe('bajin migrate 子命令', () => {
  it('迁移 JSONL → SQLite：报告计数、库可回放；重复执行幂等', async () => {
    await mkdir(path.join(home, 'sessions', sid), { recursive: true });
    await writeFile(path.join(home, 'sessions', sid, 'meta.json'), JSON.stringify({ sessionId: sid, model: 'glm-5.3', cwd: '/tmp/x', createdAt: '2026-08-16T00:00:00Z', title: '迁移测试' }), 'utf8');
    await writeFile(
      path.join(home, 'sessions', sid, 'transcript.jsonl'),
      [
        { ts: 't1', msg: { role: 'user', content: '问' } },
        { ts: 't2', msg: { role: 'assistant', content: '答' } },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n',
      'utf8',
    );

    const r1 = await runMigrate();
    expect(r1.code).toBe(0);
    expect(r1.stdout).toContain('新迁入 1 个会话 / 2 条消息');
    await expect(stat(db)).resolves.toBeTruthy();

    const store = openSessionStore(db);
    try {
      expect(storeListSessions(store).map((s) => s.sessionId)).toEqual([sid]);
      expect(storeLoadTranscript(store, sid).messages.map((m) => m.content)).toEqual(['问', '答']);
    } finally {
      store.close();
    }

    const r2 = await runMigrate();
    expect(r2.code).toBe(0);
    expect(r2.stdout).toContain('跳过已入库 1 个');
    expect(r2.stdout).toContain('新迁入 0 个会话 / 0 条消息');
  });

  it('空会话目录（BAJIN_HOME 指向新目录）安全成功', async () => {
    const emptyHome = await mkdtemp(path.join(tmpdir(), 'bajin-mig-empty-'));
    try {
      const { stdout } = await exec(process.execPath, [CLI_ENTRY, 'migrate', '--db', path.join(emptyHome, 's.db')], { env: { ...process.env, BAJIN_HOME: emptyHome } });
      expect(stdout).toContain('新迁入 0 个会话');
    } finally {
      await rm(emptyHome, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
