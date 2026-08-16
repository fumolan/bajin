import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { parseImageSize, formatImageDescription } from '../src/tools/image.js';
import { readTool } from '../src/tools/fs.js';

const dir = await mkdtemp(path.join(tmpdir(), 'bajin-img-'));
afterAll(async () => { await rm(dir, { recursive: true, force: true }).catch(() => undefined); });

/** 构造最小合法头（不编码像素） */
function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function gif(w: number, h: number): Buffer {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}
function jpeg(w: number, h: number): Buffer {
  const b = Buffer.alloc(64);
  b[0] = 0xff; b[1] = 0xd8;          // SOI
  b[2] = 0xff; b[3] = 0xe0;          // APP0 段（len=16 → 数据区 6..19）
  b.writeUInt16BE(16, 4);            // len（含自身 2B）
  b[20] = 0xff; b[21] = 0xc0;        // SOF0
  b.writeUInt16BE(17, 22);           // len
  b[24] = 8;                         // 精度
  b.writeUInt16BE(h, 25);
  b.writeUInt16BE(w, 27);
  return b;
}
function webpVp8x(w: number, h: number): Buffer {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(28, 4);
  b.write('WEBPVP8X', 8, 'ascii');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

describe('图片头解析 parseImageSize', () => {
  it('PNG/GIF/JPEG/WEBP(VP8X) 四格式', () => {
    expect(parseImageSize(png(1920, 1080))).toEqual({ format: 'png', width: 1920, height: 1080 });
    expect(parseImageSize(gif(320, 240))).toEqual({ format: 'gif', width: 320, height: 240 });
    expect(parseImageSize(jpeg(800, 600))).toEqual({ format: 'jpeg', width: 800, height: 600 });
    expect(parseImageSize(webpVp8x(640, 480))).toEqual({ format: 'webp', width: 640, height: 480 });
  });

  it('非图片/损坏数据返回 null；描述函数两态', () => {
    expect(parseImageSize(Buffer.from('hello world!!'))).toBeNull();
    expect(parseImageSize(png(1, 1).subarray(0, 10))).toBeNull();
    const ok = formatImageDescription('/x/a.png', { format: 'png', width: 10, height: 20 }, 2048);
    expect(ok).toContain('PNG · 10×20 · 2.0 KB');
    expect(formatImageDescription('/x/a.png', null, 100)).toContain('无法解析尺寸');
  });
});

describe('Read 工具图片分支', () => {
  it('.png 返回占位描述而非二进制报错；.txt 正常文本', async () => {
    await writeFile(path.join(dir, 'a.png'), png(640, 480));
    await writeFile(path.join(dir, 'a.txt'), 'plain text');
    const r = await readTool.execute({ file_path: 'a.png' }, { cwd: dir } as never);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('[图片]');
    expect(r.output).toContain('640×480');
    const t = await readTool.execute({ file_path: 'a.txt' }, { cwd: dir } as never);
    expect(t.output).toContain('plain text');
  });
});
