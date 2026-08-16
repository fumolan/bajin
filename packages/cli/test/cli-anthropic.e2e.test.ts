import { describe, it, expect, afterAll } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const CLI = path.resolve(fileURLToPath(new URL('../dist/main.js', import.meta.url)));

const home = await mkdtemp(path.join(tmpdir(), 'bajin-cli-anth-'));
afterAll(async () => { await rm(home, { recursive: true, force: true }).catch(() => undefined); });

describe('CLI 直跑：anthropic 格式供应商解析', () => {
  it('供应商 apiFormat=anthropic 时走 /v1/messages + x-api-key + anthropic-version', { timeout: 30_000 }, async () => {
    const hitsFile = path.join(home, 'hits.json');
    const serverFile = path.join(home, 'mock-server.cjs');
    await writeFile(serverFile, `
      const http = require('node:http');
      const fs = require('node:fs');
      const hits = [];
      const srv = http.createServer((req, res) => {
        let raw = '';
        req.on('data', c => raw += c);
        req.on('end', () => {
          hits.push(req.method + ' ' + req.url + ' key=' + (req.headers['x-api-key'] ?? 'none') + ' ver=' + (req.headers['anthropic-version'] ?? 'none'));
          fs.writeFileSync(${JSON.stringify(hitsFile)}, JSON.stringify(hits));
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          const events = [
            { type: 'message_start', message: { id: 'msg_1', role: 'assistant', model: 'glm-4.7', usage: { input_tokens: 1 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'anth-ok' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
            { type: 'message_stop' },
          ];
          const NL = String.fromCharCode(10);\n          res.end(events.map((e) => 'data: ' + JSON.stringify(e) + NL + NL).join(''));
        });
      });
      srv.listen(0, '127.0.0.1', () => process.stdout.write(String(srv.address().port)));
    `, 'utf8');
    const srv = spawn(process.execPath, [serverFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stderr!.setEncoding('utf8');
    srv.stderr!.on('data', (d: string) => console.error('[mock-anth]', d.trim()));
    let port = '';
    await new Promise<void>((resolve) => {
      srv.stdout!.setEncoding('utf8');
      srv.stdout!.on('data', (d: string) => {
        const m = /^\d+/.exec(d.trim());
        if (m && !port) { port = m[0]!; resolve(); }
      });
      srv.on('exit', () => resolve());
      setTimeout(() => resolve(), 8000);
    });
    expect(port).toBeTruthy();

    const state = path.join(home, 'state');
    await mkdir(state, { recursive: true });
    await writeFile(path.join(state, 'config.json'), JSON.stringify({
      providers: [{ name: 'anth-mock', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-test', apiFormat: 'anthropic', models: ['glm-4.7'] }],
      model: 'glm-4.7',
    }), 'utf8');

    try {
      const { stdout } = await exec(process.execPath, [CLI, '-p', '你好'], { env: { ...process.env, BAJIN_HOME: state }, cwd: home });
      expect(stdout).toContain('anth-ok');
      const hits = JSON.parse(await readFile(hitsFile, 'utf8').catch(() => '[]')) as string[];
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]).toContain('POST /v1/messages');
      expect(hits[0]).toContain('key=sk-test');
      expect(hits[0]).toContain('ver=2023-06-01');
    } finally {
      srv.kill();
    }
  });
});
