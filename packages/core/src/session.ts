import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ChatMessage } from '@bajin/shared';

/**
 * 会话持久化（对标 ZCode 的 session/transcript 体系，先用 JSONL 落盘）：
 *   <persistDir>/<sessionId>/meta.json        会话元信息
 *   <persistDir>/<sessionId>/transcript.jsonl 消息事件流（含压缩标记）
 */

export interface SessionMeta {
  sessionId: string;
  model: string;
  cwd: string;
  createdAt: string;
  title?: string;
}

export async function appendMessage(file: string, msg: ChatMessage): Promise<void> {
  const line = `${JSON.stringify({ ts: new Date().toISOString(), msg })}\n`;
  await fs.appendFile(file, line, 'utf8').catch(() => undefined);
}

export async function loadTranscript(file: string): Promise<{ meta?: SessionMeta; messages: ChatMessage[]; compacted: boolean }> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return { messages: [], compacted: false };
  }
  const messages: ChatMessage[] = [];
  let compacted = false;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as { msg?: ChatMessage };
      if (!rec.msg || !rec.msg.role) continue;
      // 压缩标记之后的旧消息不再回放（历史已被摘要替代）
      if (rec.msg.role === 'system' && rec.msg.content.startsWith('<<<compacted')) {
        messages.length = 0;
        compacted = true;
        continue;
      }
      messages.push(rec.msg);
    } catch {
      // 损坏行跳过
    }
  }
  let meta: SessionMeta | undefined;
  try {
    meta = JSON.parse(await fs.readFile(path.join(path.dirname(file), 'meta.json'), 'utf8')) as SessionMeta;
  } catch {
    // 无 meta 也允许加载
  }
  return { meta, messages, compacted };
}

export interface SessionListItem {
  sessionId: string;
  dir: string;
  transcriptPath: string;
  modifiedAt: number;
  title: string;
  meta?: SessionMeta;
}

/** 列出会话（按最近修改排序）；title 取第一条用户消息 */
export async function listSessions(persistDir: string, limit = 30): Promise<SessionListItem[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(persistDir);
  } catch {
    return [];
  }
  const out: SessionListItem[] = [];
  for (const name of entries) {
    if (!name.startsWith('sess_')) continue;
    const dir = path.join(persistDir, name);
    const transcriptPath = path.join(dir, 'transcript.jsonl');
    const stat = await fs.stat(transcriptPath).catch(() => null);
    if (!stat?.isFile()) continue;
    const { messages, meta } = await loadTranscript(transcriptPath);
    const firstUser = messages.find((m) => m.role === 'user');
    out.push({
      sessionId: name,
      dir,
      transcriptPath,
      modifiedAt: stat.mtimeMs,
      title: firstUser && firstUser.role === 'user' ? firstUser.content.slice(0, 60) : '(无标题)',
      meta,
    });
  }
  out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return out.slice(0, limit);
}
