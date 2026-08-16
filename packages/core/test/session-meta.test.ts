import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  openSessionStore, storeUpsertSession, storeAppendMessage,
  storeUpdateSessionMeta, storeDeleteSession, storeReplaceTodos, storeLoadTodos, storeListSessions,
} from '../src/session-store.js';

const dir = await mkdtemp(path.join(tmpdir(), 'bajin-meta-'));
afterAll(async () => { await rm(dir, { recursive: true, force: true }).catch(() => undefined); });

describe('session 元数据/todo/删除（meta RPC 与 live 写入后端）', () => {
  it('storeUpdateSessionMeta：只动提供的键；group=null 清除；pinned 布尔映射', async () => {
    const store = openSessionStore(path.join(dir, 'a.db'));
    try {
      storeUpsertSession(store, { sessionId: 's1', model: 'm', cwd: '/c', createdAt: '2026-08-16T00:00:00Z', title: '原名', group: 'A组', pinned: false });
      storeUpdateSessionMeta(store, 's1', { title: '新名' });
      let row = storeListSessions(store)[0]!;
      expect([row.title, row.group, row.pinned]).toEqual(['新名', 'A组', 0]);

      storeUpdateSessionMeta(store, 's1', { pinned: true, group: null });
      row = storeListSessions(store)[0]!;
      expect([row.pinned, row.group]).toEqual([1, null]);

      storeUpdateSessionMeta(store, 's1', {}); // 空补丁 no-op
      row = storeListSessions(store)[0]!;
      expect(row.title).toBe('新名');
    } finally {
      store.close();
    }
  });

  it('storeReplaceTodos 整表替换；storeLoadTodos 还原快照', async () => {
    const store = openSessionStore(path.join(dir, 'b.db'));
    try {
      storeUpsertSession(store, { sessionId: 's2', model: 'm', cwd: '/c', createdAt: '2026-08-16T00:00:00Z' });
      storeReplaceTodos(store, 's2', [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }]);
      expect(storeLoadTodos(store, 's2')).toEqual([{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }]);
      storeReplaceTodos(store, 's2', [{ content: 'c', status: 'pending' }]);
      expect(storeLoadTodos(store, 's2')).toEqual([{ content: 'c', status: 'pending' }]);
    } finally {
      store.close();
    }
  });

  it('storeDeleteSession 级联清消息/todo/usage', async () => {
    const store = openSessionStore(path.join(dir, 'c.db'));
    try {
      storeUpsertSession(store, { sessionId: 's3', model: 'm', cwd: '/c', createdAt: '2026-08-16T00:00:00Z' });
      storeAppendMessage(store, 's3', { role: 'user', content: 'x' });
      storeAppendMessage(store, 's3', { role: 'tool', toolCallId: 'k', name: 'Read', content: 'o' });
      storeReplaceTodos(store, 's3', [{ content: 't', status: 'pending' }]);
      storeDeleteSession(store, 's3');
      expect(storeListSessions(store)).toEqual([]);
      expect(store.db.prepare('SELECT COUNT(*) c FROM message').get()).toEqual({ c: 0 });
      expect(store.db.prepare('SELECT COUNT(*) c FROM todo').get()).toEqual({ c: 0 });
      expect(store.db.prepare('SELECT COUNT(*) c FROM tool_usage').get()).toEqual({ c: 0 });
    } finally {
      store.close();
    }
  });
});
