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

/**
 * 回退 N 轮（对标 ZCode rewind）：一轮 = 一条 user 消息及其后的 assistant/tool 消息块。
 * 从文件末尾往前找第 N 条 user 行，删除该行（含）之后的所有原始行；原始行原样保留不重序列化。
 * n<=0 或无轮可退为 no-op；n 超过总轮数则清空全部消息（meta.json 不动）。
 */
export async function rewindTranscript(
  file: string,
  n: number,
): Promise<{ removedTurns: number; removedLines: number; remainingTurns: number }> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return { removedTurns: 0, removedLines: 0, remainingTurns: 0 };
  }
  const lines = raw.split('\n');
  // 记录每个非空行是否 user 轮起点（行号）
  const userLineIdx: number[] = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const rec = JSON.parse(trimmed) as { msg?: { role?: string } };
      if (rec.msg?.role === 'user') userLineIdx.push(i);
    } catch {
      /* 损坏行不算轮起点 */
    }
  });
  const total = userLineIdx.length;
  const take = Math.min(Math.max(0, Math.floor(n)), total);
  if (take <= 0) return { removedTurns: 0, removedLines: 0, remainingTurns: total };
  const cutFrom = userLineIdx[total - take]!;
  const kept = lines.filter((_, i) => i < cutFrom);
  // 保留行去尾部空行后统一以单换行收尾
  while (kept.length && !kept[kept.length - 1]!.trim()) kept.pop();
  await fs.writeFile(file, kept.length ? `${kept.join('\n')}\n` : '', 'utf8');
  return { removedTurns: take, removedLines: lines.length - kept.length, remainingTurns: total - take };
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
    // 有 meta.json 即算会话（新建未发首条消息的空会话也要出现在列表/项目分组，对标 ZCode）
    const metaStat = stat?.isFile() ? null : await fs.stat(path.join(dir, 'meta.json')).catch(() => null);
    if (!stat?.isFile() && !metaStat?.isFile()) continue;
    const loaded = await loadTranscript(transcriptPath);
    const messages = loaded.messages;
    // 空会话（无 transcript）：loadTranscript 提前返回不带 meta，此处补读
    let meta = loaded.meta;
    if (!meta && metaStat?.isFile()) {
      meta = await fs.readFile(path.join(dir, 'meta.json'), 'utf8')
        .then((r) => JSON.parse(r) as SessionMeta)
        .catch(() => undefined);
    }
    const firstUser = messages.find((m) => m.role === 'user');
    out.push({
      sessionId: name,
      dir,
      transcriptPath,
      modifiedAt: stat?.mtimeMs ?? metaStat!.mtimeMs,
      title: meta?.title?.trim() || (firstUser && firstUser.role === 'user' ? firstUser.content.slice(0, 60) : '') || '(新会话)',
      meta,
    });
  }
  out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return out.slice(0, limit);
}
