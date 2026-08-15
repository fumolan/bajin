import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const dist = path.join(root, 'dist');

mkdirSync(dist, { recursive: true });
mkdirSync(path.join(dist, 'renderer'), { recursive: true });

async function main() {
  // Electron 主进程与 preload：CJS，electron 保持 external
  await build({
    entryPoints: [path.join(root, 'src/main/index.ts')],
    outfile: path.join(dist, 'main.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    sourcemap: false,
    logLevel: 'info',
  });
  await build({
    entryPoints: [path.join(root, 'src/preload/index.ts')],
    outfile: path.join(dist, 'preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    sourcemap: false,
    logLevel: 'info',
  });
  // 渲染层：React SPA 单 bundle
  await build({
    entryPoints: [path.join(root, 'src/renderer/app.tsx')],
    outfile: path.join(dist, 'renderer/app.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    minify: true,
    sourcemap: false,
    logLevel: 'info',
  });
  cpSync(path.join(root, 'src/renderer/index.html'), path.join(dist, 'renderer/index.html'));
  cpSync(path.join(root, 'src/renderer/styles.css'), path.join(dist, 'renderer/styles.css'));
  console.log('desktop build done →', dist);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
