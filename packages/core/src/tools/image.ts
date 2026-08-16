/**
 * 图片头解析（对标 ZCode Read 图片：尺寸/占位描述，为多模态输入留接口）。
 * 支持 PNG / GIF / JPEG / WEBP；只读头部字节，不解码像素。
 */

export interface ImageMeta {
  format: 'png' | 'gif' | 'jpeg' | 'webp';
  width: number;
  height: number;
}

/** 解析图片头部（buf 只需前 ~64KB，JPEG 扫 SOF 段足够） */
export function parseImageSize(buf: Buffer): ImageMeta | null {
  // PNG：8B 签名 + IHDR（width@16 BE32 / height@20 BE32）
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF：'GIF8'，width@6 LE16 / height@8 LE16
  if (buf.length >= 10 && buf.toString('ascii', 0, 4) === 'GIF8') {
    return { format: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // WEBP：'RIFF'+len+'WEBP'，chunk 四选一
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fourcc = buf.toString('ascii', 12, 16);
    if (fourcc === 'VP8X') {
      // canvas 尺寸 24bit -1，width@24 height@27
      return {
        format: 'webp',
        width: 1 + ((buf[24]! | (buf[25]! << 8) | (buf[26]! << 16)) & 0xffffff),
        height: 1 + ((buf[27]! | (buf[28]! << 8) | (buf[29]! << 16)) & 0xffffff),
      };
    }
    if (fourcc === 'VP8 ') {
      // lossy：frame tag 3B + sync 3B + 16bit 尺寸（14bit 有效）
      const w = buf.readUInt16LE(26) & 0x3fff;
      const h = buf.readUInt16LE(28) & 0x3fff;
      if (w && h) return { format: 'webp', width: w, height: h };
    }
    if (fourcc === 'VP8L') {
      // lossless：signature 1B 后 14bit 尺寸打包
      const b = buf.subarray(21, 26);
      if (b.length >= 5) {
        const w = 1 + (((b[0]! | (b[1]! << 8) | (b[2]! << 16)) >>> 0) & 0x3fff);
        const h = 1 + ((((b[2]! >>> 6) | (b[3]! << 2) | (b[4]! << 10)) >>> 0) & 0x3fff);
        return { format: 'webp', width: w, height: h };
      }
    }
    return null;
  }
  // JPEG：扫 SOF0-SOF15（跳过 0xD8 段结构）
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < Math.min(buf.length, 64 * 1024)) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
      const len = buf.readUInt16BE(off + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: 'jpeg', height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      off += 2 + len;
    }
  }
  return null;
}

export const IMAGE_EXTS = new Set(['.png', '.gif', '.jpg', '.jpeg', '.webp']);

export function formatImageDescription(file: string, meta: ImageMeta | null, sizeBytes: number): string {
  const kb = sizeBytes >= 1024 * 1024 ? `${(sizeBytes / 1024 / 1024).toFixed(1)} MB` : `${(sizeBytes / 1024).toFixed(1)} KB`;
  if (!meta) return `[图片] ${file}\n无法解析尺寸（可能损坏或格式不支持），大小 ${kb}`;
  return `[图片] ${file}\n${meta.format.toUpperCase()} · ${meta.width}×${meta.height} · ${kb}\n（当前模型以文本描述呈现；多模态输入接入后可直接查看图像）`;
}
