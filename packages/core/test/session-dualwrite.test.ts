import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Agent } from '../src/agent.js';
import { createMockProvider, type MockStep } from '../src/providers/mock.js';
import { openSessionStore, storeUpsertSession, storeAppendMessage, storeListSessions, storeLoadTranscript, type SessionStore } from '../src/session-store.js';
import { loadTranscript } from '../src/session.js';

const dir = await mkdtemp(path.join(tmpdir(), 'bajin-dual-'));
const dbFile = path.join(dir, 'sessions.db');
const persistDir = path.join(dir, 'sessions');
afterAll(async () => { await rm(dir, { recursive: true, force: true }).catch(() => undefined); });

const steps: MockStep[] = [
  { type: 'text', text: '你好' },
];
// mock 末轮后自然结束

describe('Agent 持久化双写（JSONL + SQLite）', () => {
  it('跑一轮对话：store 回放与 JSONL 回放一致；modified_at 更新', async () => {
    const store: SessionStore = openSessionStore(dbFile);
    try {
      const agent = new Agent({
        provider: createMockProvider(steps),
        model: 'mock-1',
        cwd: dir,
        mode: 'yolo',
        persistDir,
        callbacks: { onApproval: async () => true },
        storeSink: (msg) => {
          storeAppendMessage(store, agent.sessionId, msg);
          store.db.prepare('UPDATE session SET modified_at = ? WHERE id = ?').run(new Date().toISOString(), agent.sessionId);
        },
      });
      // 构造后 holder 生效（测试直接闭包 agent，等价于 app-server 的 sidHolder 模式）
      await agent.ready;
      storeUpsertSession(store, { sessionId: agent.sessionId, model: 'mock-1', cwd: dir, createdAt: new Date().toISOString(), title: '双写测试' });
      await agent.run('说你好');

      const jsonl = await loadTranscript(path.join(persistDir, agent.sessionId, 'transcript.jsonl'));
      const sqlite = storeLoadTranscript(store, agent.sessionId);
      expect(sqlite.messages).toEqual(jsonl.messages);
      expect(sqlite.messages.length).toBeGreaterThanOrEqual(2); // user + assistant

      const meta = storeListSessions(store).find((s) => s.sessionId === agent.sessionId);
      expect(meta?.title).toBe('双写测试');
      expect(meta?.modifiedAt).not.toBe('');
    } finally {
      store.close();
    }
  });

  it('session 新列：group/pinned upsert 语义（显式才覆盖）', async () => {
    const store = openSessionStore(path.join(dir, 'cols.db'));
    try {
      storeUpsertSession(store, { sessionId: 's1', model: 'm', cwd: '/c', createdAt: '2026-08-16T00:00:00Z', group: '工作', pinned: true, modifiedAt: '2026-08-16T01:00:00Z' });
      // 不带 group/pinned 的第二次 upsert：不应清掉
      storeUpsertSession(store, { sessionId: 's1', model: 'm2', cwd: '/c2', createdAt: '2026-08-16T00:00:00Z', title: '改名' });
      const row = storeListSessions(store)[0]!;
      expect(row.group).toBe('工作');
      expect(row.pinned).toBe(1);
      expect(row.title).toBe('改名');
      expect(row.modifiedAt).toBe('2026-08-16T01:00:00Z');
    } finally {
      store.close();
    }
  });

  it('旧五列库（切片2 schema）打开时自动补列', async () => {
    const legacy = openSessionStore(path.join(dir, 'legacy.db'));
    legacy.db.exec('DROP TABLE session'); // 模拟旧表结构
    legacy.db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, model TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '', title TEXT)`);
    legacy.close();
    const reopened = openSessionStore(path.join(dir, 'legacy.db')); // ALTER 补列
    try {
      storeUpsertSession(reopened, { sessionId: 'old', model: 'm', cwd: '/c', createdAt: '2026-01-01T00:00:00Z', group: '旧组', pinned: false, modifiedAt: '2026-01-02T00:00:00Z' });
      const row = storeListSessions(reopened)[0]!;
      expect(row.group).toBe('旧组');
      expect(row.pinned).toBe(0);
    } finally {
      reopened.close();
    }
  });
});
