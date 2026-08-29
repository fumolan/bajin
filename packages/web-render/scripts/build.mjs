/** web 渲染层构建：React SPA 单 IIFE bundle（原 apps/desktop build.mjs 渲染段平移） */
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const dist = path.join(root, 'dist', 'renderer');

mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [path.join(root, 'src', 'app.tsx')],
  outfile: path.join(dist, 'app.js'),
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
cpSync(path.join(root, 'src', 'styles.css'), path.join(dist, 'styles.css'));
console.log('web-render build done →', dist);
