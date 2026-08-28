import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { sendStatic } from '../src/web-server.js';

/** 最小假 req/res（不拉起 http server 与 app-server 子进程） */
type Captured = { status: number; headers: Record<string, string | number>; body: Buffer };
function fakePair(headers: Record<string, string> = {}): { req: object; res: object; cap: Promise<Captured> } {
  const cap = new Promise<Captured>((resolve) => {
    const res = {
      statusCode: 0,
      _headers: {} as Record<string, string | number>,
      _chunks: [] as Buffer[],
      writeHead(status: number, h?: Record<string, string | number>) {
        this.statusCode = status;
        Object.assign(this._headers, h ?? {});
        return this;
      },
      end(data?: Buffer | string) {
        if (data) this._chunks.push(typeof data === 'string' ? Buffer.from(data) : data);
        resolve({ status: this.statusCode, headers: this._headers, body: Buffer.concat(this._chunks) });
      },
    };
    (globalThis as Record<string, unknown>).__pendingRes = res;
  });
  const req = { headers };
  return { req, res: (globalThis as Record<string, unknown>).__pendingRes, cap };
}

describe('web 静态资源 gzip + ETag（R5-10）', () => {
  const bigJs = `// app-web.js 模拟——重复行撑大体积，验证压缩收益\n${'const x = "bajin web renderer line for gzip test";\n'.repeat(80)}`;

  it('支持 gzip 时 >1KB 响应被压缩且可解压还原', async () => {
    const { req, res, cap } = fakePair({ 'accept-encoding': 'gzip, br' });
    sendStatic(req as never, res as never, bigJs, 'application/javascript; charset=utf-8');
    const out = await cap;
    expect(out.status).toBe(200);
    expect(out.headers['Content-Encoding']).toBe('gzip');
    expect(out.headers['Vary']).toBe('Accept-Encoding');
    expect(typeof out.headers['ETag']).toBe('string');
    expect(gunzipSync(out.body).toString()).toBe(bigJs);
    // 压缩收益：minified JS gzip 后 < 60%
    expect(out.body.length).toBeLessThan(bigJs.length * 0.6);
  });

  it('If-None-Match 命中 → 304 空体（二次进入走浏览器缓存）', async () => {
    const first = fakePair({ 'accept-encoding': 'gzip' });
    sendStatic(first.req as never, first.res as never, bigJs, 'application/javascript; charset=utf-8');
    const r1 = await first.cap;
    const etag = String(r1.headers['ETag']);
    const second = fakePair({ 'accept-encoding': 'gzip', 'if-none-match': etag });
    sendStatic(second.req as never, second.res as never, bigJs, 'application/javascript; charset=utf-8');
    const r2 = await second.cap;
    expect(r2.status).toBe(304);
    expect(r2.body.length).toBe(0);
  });

  it('内容变化 → ETag 变化，不误命中 304', async () => {
    const a = fakePair({});
    sendStatic(a.req as never, a.res as never, 'body-a', 'text/html; charset=utf-8');
    const etagA = String((await a.cap).headers['ETag']);
    const b = fakePair({ 'if-none-match': etagA });
    sendStatic(b.req as never, b.res as never, 'body-b', 'text/html; charset=utf-8');
    const rb = await b.cap;
    expect(rb.status).toBe(200); // 旧 ETag 对新内容不命中
    expect(rb.body.toString()).toBe('body-b');
  });

  it('小响应（≤1KB）或不支持 gzip → 明文返回', async () => {
    const small = fakePair({ 'accept-encoding': 'gzip' });
    sendStatic(small.req as never, small.res as never, 'tiny', 'text/html; charset=utf-8');
    const r = await small.cap;
    expect(r.headers['Content-Encoding']).toBeUndefined();
    expect(r.body.toString()).toBe('tiny');

    const noGz = fakePair({ 'accept-encoding': 'identity' });
    sendStatic(noGz.req as never, noGz.res as never, bigJs, 'application/javascript; charset=utf-8');
    const r2 = await noGz.cap;
    expect(r2.headers['Content-Encoding']).toBeUndefined();
    expect(r2.body.length).toBe(Buffer.byteLength(bigJs));
  });
});
