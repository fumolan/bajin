import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { mergeSettingsLayers, discoverProjectConfigFiles, loadSettingsChain, envSettingsOverlay } from '../src/settings.js';

const root = await mkdtemp(path.join(tmpdir(), 'bajin-settings-'));
const home = path.join(root, 'home');
const proj = path.join(root, 'proj');        // .git 根
const deep = path.join(proj, 'a', 'b');       // cwd
afterAll(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });

async function seed(): Promise<void> {
  await mkdir(path.join(home, '.bajin'), { recursive: true });
  await mkdir(deep, { recursive: true });
  await mkdir(path.join(proj, 'a'), { recursive: true });

  await mkdir(path.join(proj, '.git'), { recursive: true });
  await writeFile(path.join(home, '.bajin', 'config.json'), JSON.stringify({ model: 'user-model', bigmodel: { apiKey: 'user-key', baseUrl: 'https://user' } }), 'utf8');
  // 远项目级（.git 根）
  await writeFile(path.join(proj, 'bajin.json'), JSON.stringify({ model: 'proj-far', mode: 'plan' }), 'utf8');
  // 近项目级 .git 根的 .bajin/config.json（同级双文件：后者晚注册，覆盖前者）
  await mkdir(path.join(proj, '.bajin'), { recursive: true });
  await writeFile(path.join(proj, '.bajin', 'config.json'), JSON.stringify({ model: 'proj-far-dotbajin', allowedTools: ['Read'] }), 'utf8');
  // 中间级 a/
  await writeFile(path.join(proj, 'a', 'bajin.json'), '{corrupted!!!', 'utf8'); // 损坏跳过
  await mkdir(path.join(proj, 'a', '.bajin'), { recursive: true });
  await writeFile(path.join(proj, 'a', '.bajin', 'config.json'), JSON.stringify({ model: 'proj-mid', bigmodel: { baseUrl: 'https://mid' } }), 'utf8');
  // cwd 本级
  await writeFile(path.join(deep, 'bajin.json'), JSON.stringify({ model: 'proj-near', disallowedTools: ['Bash'] }), 'utf8');
  // .git 根之上：不应被发现
  await writeFile(path.join(root, 'bajin.json'), JSON.stringify({ model: 'outside' }), 'utf8');
}

describe('settings 作用域链', () => {
  it('优先级矩阵：System < User < Project(远→近) ；Env/Cli 由调用方叠加最右', async () => {
    await seed();
    const chain = await loadSettingsChain(deep, {
      home,
      system: { model: 'sys-model', mode: 'build', bigmodel: { apiKey: 'sys-key' } },
    });
    // 项目文件发现顺序：远（.git 根两个）→ mid → near，且 .git 根之上不收集
    const files = chain.projectFiles.map((f) => path.relative(proj, f.file));
    expect(files).toEqual([
      path.join('.', 'bajin.json'),
      path.join('.bajin', 'config.json'),
      path.join('a', 'bajin.json'), // 存在即发现（内容损坏在读取层跳过）
      path.join('a', '.bajin', 'config.json'),
      path.join('a', 'b', 'bajin.json'),
    ]);

    const m = chain.merged as Record<string, Record<string, unknown> | string | string[]>;
    expect(m['model']).toBe('proj-near'); // near 覆盖全部
    expect(m['mode']).toBe('plan'); // 仅远级设置，保留
    expect(m['allowedTools']).toEqual(['Read']); // .git 根 .bajin/config.json
    expect(m['disallowedTools']).toEqual(['Bash']);
    expect((m['bigmodel'] as Record<string, unknown>)['apiKey']).toBe('user-key'); // 用户级，项目未设
    expect((m['bigmodel'] as Record<string, unknown>)['baseUrl']).toBe('https://mid'); // mid 深合并覆盖 baseUrl

    // Env 层覆盖 model；Cli 层再覆盖 mode
    const env = envSettingsOverlay({ BAJIN_MODEL: 'env-model', BAJIN_ALLOWED_TOOLS: 'Bash,Grep' });
    const cli = { mode: 'yolo' };
    const final = mergeSettingsLayers([chain.merged, env, cli]);
    expect(final['model']).toBe('env-model');
    expect(final['mode']).toBe('yolo');
    expect(final['allowedTools']).toEqual(['Bash', 'Grep']);
  });

  it('无 .git 时只发现 cwd 本级；envSettingsOverlay 忽略空值', async () => {
    const lone = await mkdtemp(path.join(tmpdir(), 'bajin-lone-'));
    try {
      await writeFile(path.join(lone, 'bajin.json'), JSON.stringify({ model: 'only-cwd' }), 'utf8');
      const files = await discoverProjectConfigFiles(lone);
      expect(files.map((f) => f.file)).toEqual([path.join(lone, 'bajin.json')]);
      expect(envSettingsOverlay({ BAJIN_MODEL: '  ', BAJIN_MODE: '' })).toEqual({});
    } finally {
      await rm(lone, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('mergeSettingsLayers：undefined 跳过、嵌套深合并、数组整体覆盖', () => {
    const m = mergeSettingsLayers([
      { a: { x: 1, y: 2 }, list: [1, 2], keep: 'k' },
      { a: { y: 9, z: 3 }, list: [3], skip: undefined },
    ]);
    expect(m).toEqual({ a: { x: 1, y: 9, z: 3 }, list: [3], keep: 'k' });
  });
});
