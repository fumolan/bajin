/**
 * SQLite 会话库（对标 ZCode 的 SQLite session store）——node:sqlite 实现。
 * 本模块为独立切片：建库/写入/回放/列表 + 存量 JSONL 迁移，API 与 session.ts 的
 * loadTranscript/listSessions 语义对齐；Agent/app-server 的接线在下一切片切换。
 *
 * 表结构（backlog 约定）：
 *   session(id, model, cwd, created_at, title)
 *   message(id, session_id, ts, role, content)          content=完整 ChatMessage JSON
 *   part(id, message_id, kind, name, text)              assistant.toolCalls / tool 结果的结构化拆分
 *   todo(id, session_id, content, created_at)           todo 快照（live 写入切片填充）
 *   tool_usage(id, session_id, name, ok, created_at)    工具调用统计（迁移时从 tool 消息派生）
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import type { ChatMessage } from '@bajin/shared';
import type { SessionMeta } from './session.js';

/** 惰性加载 node:sqlite：vitest/vite 无法静态解析该前缀；CJS bundle 的 import.meta.url shim 失效时回退 execPath；Electron 内置 Node 缺模块不拖垮 core（调用才报错） */
let nodeRequire: ReturnType<typeof createRequire> | null = null;
let dbCtor: (new (file: string) => DatabaseSync) | null = null;
function sqliteDbCtor(): new (file: string) => DatabaseSync {
  if (!dbCtor) {
    if (!nodeRequire) {
      try {
        nodeRequire = createRequire(import.meta.url);
      } catch {
        // esbuild CJS 输出里 import.meta.url 不可用——内置模块解析与路径无关，任意真实路径即可
        nodeRequire = createRequire(process.execPath);
      }
    }
    try {
      dbCtor = nodeRequire('node:sqlite').DatabaseSync as new (file: string) => DatabaseSync;
    } catch {
      throw new Error('当前运行时不支持 node:sqlite（需 Node ≥ 22.5 / Electron 对应版本）');
    }
  }
  return dbCtor;
}

export interface SessionStore {
  db: DatabaseSync;
  close(): void;
}

export function openSessionStore(file: string): SessionStore {
  const db = new (sqliteDbCtor())(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      model TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '',
      title TEXT
    );
    CREATE TABLE IF NOT EXISTS message (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
      ts TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,
      content TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_message_session ON message(session_id, id);
    CREATE TABLE IF NOT EXISTS part (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS todo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS tool_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      ok INTEGER,
      created_at TEXT NOT NULL DEFAULT ''
    );
  `);
  return { db, close: () => db.close() };
}

/** 确保会话行存在（meta 缺省字段兜底） */
export function storeUpsertSession(store: SessionStore, meta: SessionMeta): void {
  store.db
    .prepare(
      `INSERT INTO session (id, model, cwd, created_at, title) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET model=excluded.model, cwd=excluded.cwd, title=excluded.title`,
    )
    .run(meta.sessionId, meta.model ?? '', meta.cwd ?? '', meta.createdAt ?? '', meta.title ?? null);
}

/** 写一条消息 + 结构化 part/tool_usage 拆分 */
export function storeAppendMessage(store: SessionStore, sessionId: string, msg: ChatMessage, ts = new Date().toISOString()): void {
  const tx = store.db.prepare('BEGIN');
  try {
    tx.run();
    const r = store.db
      .prepare('INSERT INTO message (session_id, ts, role, content) VALUES (?, ?, ?, ?)')
      .run(sessionId, ts, msg.role, JSON.stringify(msg)) as { lastInsertRowid: number | bigint };
    const messageId = Number(r.lastInsertRowid);
    const insertPart = store.db.prepare('INSERT INTO part (message_id, kind, name, text) VALUES (?, ?, ?, ?)');
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      for (const c of msg.toolCalls) insertPart.run(messageId, 'toolCall', c.name ?? '', c.arguments ?? '{}');
    }
    if (msg.role === 'tool') {
      insertPart.run(messageId, 'toolResult', msg.name ?? '', msg.content);
      store.db.prepare('INSERT INTO tool_usage (session_id, name, ok, created_at) VALUES (?, ?, NULL, ?)').run(sessionId, msg.name ?? '', ts);
    }
    store.db.prepare('COMMIT').run();
  } catch {
    store.db.prepare('ROLLBACK').run();
    throw new Error(`写入消息失败（session=${sessionId}）`);
  }
}

/** 回放会话消息——与 session.ts loadTranscript 同语义（压缩标记重置历史） */
export function storeLoadTranscript(store: SessionStore, sessionId: string): { messages: ChatMessage[]; compacted: boolean } {
  const rows = store.db
    .prepare('SELECT role, content FROM message WHERE session_id = ? ORDER BY id')
    .all(sessionId) as Array<{ role: string; content: string }>;
  const messages: ChatMessage[] = [];
  let compacted = false;
  for (const row of rows) {
    let msg: ChatMessage;
    try {
      msg = JSON.parse(row.content) as ChatMessage;
    } catch {
      continue;
    }
    if (msg.role === 'system' && msg.content.startsWith('<<<compacted')) {
      messages.length = 0;
      compacted = true;
      continue;
    }
    messages.push(msg);
  }
  return { messages, compacted };
}

export interface StoreSessionItem {
  sessionId: string;
  title: string | null;
  model: string;
  cwd: string;
  createdAt: string;
}

export function storeListSessions(store: SessionStore): StoreSessionItem[] {
  return store.db
    .prepare('SELECT id AS sessionId, title, model, cwd, created_at AS createdAt FROM session ORDER BY created_at DESC')
    .all() as unknown as StoreSessionItem[];
}

/**
 * 迁移存量 JSONL 会话目录到 SQLite：遍历 <persistDir>/<sessionId>/transcript.jsonl，
 * 会话行取 meta.json（缺失时以目录名兜底），消息逐行入库（含压缩标记，保持回放语义）。
 * 幂等：已存在的 session 跳过整目录。返回 { migrated, skipped, messages }。
 */
export async function migrateJsonlToStore(
  persistDir: string,
  store: SessionStore,
): Promise<{ migrated: number; skipped: number; messages: number }> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(persistDir);
  } catch {
    return { migrated: 0, skipped: 0, messages: 0 };
  }
  let migrated = 0;
  let skipped = 0;
  let messages = 0;
  const exists = store.db.prepare('SELECT 1 FROM session WHERE id = ?');
  for (const sessionId of entries) {
    const transcript = path.join(persistDir, sessionId, 'transcript.jsonl');
    let raw: string;
    try {
      raw = await fs.readFile(transcript, 'utf8');
    } catch {
      continue; // 无 transcript 的目录不是会话
    }
    if (exists.get(sessionId)) {
      skipped++;
      continue;
    }
    let meta: SessionMeta | undefined;
    try {
      meta = JSON.parse(await fs.readFile(path.join(persistDir, sessionId, 'meta.json'), 'utf8')) as SessionMeta;
    } catch {
      meta = undefined;
    }
    storeUpsertSession(store, {
      sessionId,
      model: meta?.model ?? '',
      cwd: meta?.cwd ?? '',
      createdAt: meta?.createdAt ?? new Date().toISOString(),
      title: meta?.title,
    });
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as { ts?: string; msg?: ChatMessage };
        if (!rec.msg?.role) continue;
        storeAppendMessage(store, sessionId, rec.msg, rec.ts ?? '');
        messages++;
      } catch {
        /* 损坏行跳过（与 loadTranscript 一致） */
      }
    }
    migrated++;
  }
  return { migrated, skipped, messages };
}
