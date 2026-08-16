import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { listSessions } from '../src/session.js';

const dir = await mkdtemp(path.join(tmpdir(), 'bajin-list-'));
afterAll(async () => { await rm(dir, { recursive: true, force: true }).catch(() => undefined); });

describe('listSessions：空会话（仅有 meta.json）也列出', () => {
  it('新建未发消息的会话立即出现（title/modifiedAt 兜底）；空目录跳过', async () => {
    await mkdir(path.join(dir, 'sess_empty1'), { recursive: true });
    await writeFile(path.join(dir, 'sess_empty1', 'meta.json'), JSON.stringify({ sessionId: 'sess_empty1', model: 'm', cwd: '/proj/a', createdAt: '2026-08-16T00:00:00Z' }), 'utf8');
    await mkdir(path.join(dir, 'sess_full1'), { recursive: true });
    await writeFile(path.join(dir, 'sess_full1', 'meta.json'), JSON.stringify({ sessionId: 'sess_full1', model: 'm', cwd: '', createdAt: '2026-08-16T01:00:00Z' }), 'utf8');
    await writeFile(path.join(dir, 'sess_full1', 'transcript.jsonl'), JSON.stringify({ ts: 't', msg: { role: 'user', content: '你好世界' } }) + '\n', 'utf8');
    await mkdir(path.join(dir, 'sess_junk1'), { recursive: true });

    const list = await listSessions(dir, 10);
    const ids = list.map((s) => s.sessionId).sort();
    expect(ids).toEqual(['sess_empty1', 'sess_full1']);
    const empty = list.find((s) => s.sessionId === 'sess_empty1')!;
    expect(empty.title).toBe('(新会话)');
    expect(empty.meta?.cwd).toBe('/proj/a');
    expect(empty.modifiedAt).toBeGreaterThan(0);
    const full = list.find((s) => s.sessionId === 'sess_full1')!;
    expect(full.title).toBe('你好世界');
  });
});
