import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { rewindTranscript, loadTranscript } from '../src/session.js';

const dir = await mkdtemp(path.join(tmpdir(), 'bajin-rewind-'));
const file = path.join(dir, 'transcript.jsonl');
afterAll(async () => { await rm(dir, { recursive: true, force: true }).catch(() => undefined); });

/** 3 轮：每轮 user + assistant + tool 行，中间夹损坏行（不应算轮起点） */
const ROUND = (i: number) =>
  `${JSON.stringify({ ts: `t${i}`, msg: { role: 'user', content: `问题${i}` } })}\n` +
  `${JSON.stringify({ ts: `t${i}`, msg: { role: 'assistant', content: `回答${i}`, toolCalls: [] } })}\n` +
  `${JSON.stringify({ ts: `t${i}`, msg: { role: 'tool', toolCallId: `c${i}`, name: 'Read', content: `out${i}` } })}\n`;

async function writeRounds(n: number): Promise<void> {
  let raw = '';
  for (let i = 1; i <= n; i++) raw += ROUND(i);
  await writeFile(file, raw + '{broken json\n', 'utf8');
}

describe('rewindTranscript（回退 N 轮）', () => {
  it('rewind 1：删除最后一轮（user+assistant+tool），保留前两轮与损坏行之前内容', async () => {
    await writeRounds(3);
    const r = await rewindTranscript(file, 1);
    expect(r).toEqual({ removedTurns: 1, removedLines: 5, remainingTurns: 2 }); // 3 行轮内容 + 尾部损坏行 + 末尾换行 split 空元素
    const { messages } = await loadTranscript(file);
    expect(messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['问题1', '问题2']);
    expect(messages.some((m) => m.content === '回答3')).toBe(false);
  });

  it('rewind 超过总轮数：清空全部消息，文件可再加载为空', async () => {
    await writeRounds(2);
    const r = await rewindTranscript(file, 5);
    expect(r.removedTurns).toBe(2);
    expect(r.remainingTurns).toBe(0);
    const { messages } = await loadTranscript(file);
    expect(messages).toEqual([]);
  });

  it('rewind 0 / 负数：no-op 原样返回', async () => {
    await writeRounds(2);
    const before = await loadTranscript(file);
    expect((await rewindTranscript(file, 0)).removedTurns).toBe(0);
    expect((await rewindTranscript(file, -3)).removedTurns).toBe(0);
    const after = await loadTranscript(file);
    expect(after.messages).toEqual(before.messages);
  });

  it('文件不存在：安全返回 0；损坏行不误判为轮起点', async () => {
    const r = await rewindTranscript(path.join(dir, 'nope.jsonl'), 1);
    expect(r).toEqual({ removedTurns: 0, removedLines: 0, remainingTurns: 0 });
  });
});
