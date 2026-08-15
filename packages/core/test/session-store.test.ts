import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { openSessionStore, storeAppendMessage, storeLoadTranscript, storeListSessions, storeUpsertSession, migrateJsonlToStore, type SessionStore } from '../src/session-store.js';
import { loadTranscript } from '../src/session.js';

const dir = await mkdtemp(path.join(tmpdir(), 'bajin-store-'));
const persistDir = path.join(dir, 'sessions');
const dbFile = path.join(dir, 'sessions.db');
afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function seedJsonl(): Promise<void> {
  // 会话 A：普通 2 轮 + tool 消息
  await mkdir(path.join(persistDir, 'sess_aaa'), { recursive: true });
  await writeFile(path.join(persistDir, 'sess_aaa', 'meta.json'), JSON.stringify({ sessionId: 'sess_aaa', model: 'glm-5.3', cwd: '/tmp/a', createdAt: '2026-08-15T10:00:00Z', title: '任务A' }), 'utf8');
  await writeFile(
    path.join(persistDir, 'sess_aaa', 'transcript.jsonl'),
    [
      { ts: 't1', msg: { role: 'user', content: '问题1' } },
      { ts: 't2', msg: { role: 'assistant', content: '调用工具', toolCalls: [{ id: 'c1', name: 'Read', args: { file_path: '/x' } }] } },
      { ts: 't3', msg: { role: 'tool', toolCallId: 'c1', name: 'Read', content: '文件内容' } },
      { ts: 't4', msg: { role: 'assistant', content: '答1' } },
      '{broken',
      { ts: 't5', msg: { role: 'user', content: '问题2' } },
      { ts: 't6', msg: { role: 'assistant', content: '答2' } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf8',
  );
  // 会话 B：带压缩标记（旧消息应被重置）
  await mkdir(path.join(persistDir, 'sess_bbb'), { recursive: true });
  await writeFile(path.join(persistDir, 'sess_bbb', 'meta.json'), JSON.stringify({ sessionId: 'sess_bbb', model: 'glm-5.3', cwd: '/tmp/b', createdAt: '2026-08-15T11:00:00Z' }), 'utf8');
  await writeFile(
    path.join(persistDir, 'sess_bbb', 'transcript.jsonl'),
    [
      { ts: 't1', msg: { role: 'user', content: '旧问题' } },
      { ts: 't2', msg: { role: 'assistant', content: '旧回答' } },
      { ts: 't3', msg: { role: 'system', content: '<<<compacted>>> 摘要' } },
      { ts: 't4', msg: { role: 'user', content: '新问题' } },
      { ts: 't5', msg: { role: 'assistant', content: '新回答' } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf8',
  );
}

describe('SQLite 会话库', () => {
  it('迁移 JSONL → 回放与 loadTranscript 逐条一致（含压缩语义/损坏行跳过）', async () => {
    await seedJsonl();
    const store = openSessionStore(dbFile);
    try {
      const r = await migrateJsonlToStore(persistDir, store);
      expect(r.migrated).toBe(2);
      expect(r.messages).toBe(11); // 6 + 5，损坏行不入库
      const a = storeLoadTranscript(store, 'sess_aaa');
      const aJsonl = await loadTranscript(path.join(persistDir, 'sess_aaa', 'transcript.jsonl'));
      expect(a.messages).toEqual(aJsonl.messages);
      expect(a.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user', 'assistant']);
      const b = storeLoadTranscript(store, 'sess_bbb');
      expect(b.compacted).toBe(true);
      expect(b.messages.map((m) => m.content)).toEqual(['新问题', '新回答']);
    } finally {
      store.close();
    }
  });

  it('幂等重迁移跳过已入库会话；列表按时间倒序', async () => {
    const store = openSessionStore(dbFile);
    try {
      const r = await migrateJsonlToStore(persistDir, store);
      expect(r).toEqual({ migrated: 0, skipped: 2, messages: 0 });
      const list = storeListSessions(store);
      expect(list.map((s) => s.sessionId)).toEqual(['sess_bbb', 'sess_aaa']); // createdAt 11:00 > 10:00
      expect(list[1]?.title).toBe('任务A');
    } finally {
      store.close();
    }
  });

  it('storeAppendMessage 拆 part/tool_usage；新写入回放一致', async () => {
    const f = path.join(dir, 'live.db');
    const store = openSessionStore(f);
    try {
      storeUpsertSession(store, { sessionId: 'sess_new', model: 'm', cwd: '/c', createdAt: '2026-08-16T00:00:00Z' });
      storeAppendMessage(store, 'sess_new', { role: 'user', content: '问' });
      storeAppendMessage(store, 'sess_new', { role: 'assistant', content: '调', toolCalls: [{ id: 'k1', name: 'Bash', args: { command: 'ls' } }] });
      storeAppendMessage(store, 'sess_new', { role: 'tool', toolCallId: 'k1', name: 'Bash', content: 'out' });
      const parts = store.db.prepare('SELECT kind, name FROM part ORDER BY id').all() as Array<{ kind: string; name: string }>;
      expect(parts).toEqual([
        { kind: 'toolCall', name: 'Bash' },
        { kind: 'toolResult', name: 'Bash' },
      ]);
      const usage = store.db.prepare('SELECT session_id, name FROM tool_usage').all() as Array<{ session_id: string; name: string }>;
      expect(usage).toEqual([{ session_id: 'sess_new', name: 'Bash' }]);
      const replay = storeLoadTranscript(store, 'sess_new');
      expect(replay.messages).toHaveLength(3);
      expect(replay.messages[2]).toEqual({ role: 'tool', toolCallId: 'k1', name: 'Bash', content: 'out' });
    } finally {
      store.close();
    }
  });

  it('空目录/不存在目录安全返回 0', async () => {
    const store = openSessionStore(path.join(dir, 'empty.db'));
    try {
      expect(await migrateJsonlToStore(path.join(dir, 'nope'), store)).toEqual({ migrated: 0, skipped: 0, messages: 0 });
    } finally {
      store.close();
    }
  });
});
