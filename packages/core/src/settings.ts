/**
 * 设置作用域链（对标 ZCode settings precedence）：
 *   System（内置默认） < User（~/.bajin/config.json） < Project（bajin.json / .bajin/config.json，
 *   自 cwd 逐级向上到 .git 根，近的覆盖远的） < Session（调用方传入） < Env（BAJIN_* 变量） < Cli（显式旗标）。
 *
 * 本模块提供：项目配置文件发现、有序深合并、Env 覆盖层；Session/Cli 层由调用方作为追加 overlay 传入。
 * 合并语义：嵌套对象深合并，数组与标量整体覆盖（与 cli/config.ts 一致）。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 深合并（数组与标量直接覆盖），undefined 跳过 */
export function mergeSettingsLayers(layers: Array<Record<string, unknown>>): Record<string, unknown> {
  return layers.reduce((acc, cur) => {
    const out: Record<string, unknown> = { ...acc };
    for (const [k, v] of Object.entries(cur)) {
      if (isPlainObject(v) && isPlainObject(out[k])) out[k] = mergeSettingsLayers([out[k] as Record<string, unknown>, v]);
      else if (v !== undefined) out[k] = v;
    }
    return out;
  }, {});
}

export interface DiscoveredConfigFile {
  file: string;
  /** 0=cwd 本级，1=上一级…（越大越远、优先级越低） */
  depth: number;
}

/** 自 cwd 逐级向上收集配置目录，直到（含）首个含 .git 的目录；无 .git 则只取 cwd 本级 */
async function configDirs(cwd: string): Promise<string[]> {
  const dirs = [path.resolve(cwd)];
  let cur = dirs[0]!;
  for (;;) {
    const parent = path.dirname(cur);
    const hasGit = await fs.stat(path.join(cur, '.git')).then(() => true, () => false);
    if (hasGit || parent === cur) break;
    cur = parent;
    dirs.push(cur);
  }
  return dirs; // index 0 最近 → 优先级最高，合并时放最后
}

/**
 * 发现项目级配置文件：每级目录的 bajin.json 与 .bajin/config.json。
 * 返回顺序：远 → 近（调用方按序 reduce 即"近的覆盖远的"）。
 */
export async function discoverProjectConfigFiles(cwd: string): Promise<DiscoveredConfigFile[]> {
  const dirs = await configDirs(cwd);
  const out: DiscoveredConfigFile[] = [];
  for (let depth = dirs.length - 1; depth >= 0; depth--) {
    for (const name of ['bajin.json', path.join('.bajin', 'config.json')]) {
      const file = path.join(dirs[depth]!, name);
      try {
        await fs.access(file);
        out.push({ file, depth });
      } catch {
        /* 该级无此文件 */
      }
    }
  }
  return out;
}

export interface SettingsChain {
  merged: Record<string, unknown>;
  userFile: string | null;
  projectFiles: DiscoveredConfigFile[];
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null; // 不存在/损坏/非对象：跳过
  }
}

/**
 * 组装 System < User < Project 链（不含 Session/Env/Cli——由调用方叠加）。
 * system 为内置默认层；userFile 缺省 ~/.bajin/config.json。
 */
export async function loadSettingsChain(
  cwd: string,
  opts: { system?: Record<string, unknown>; home?: string } = {},
): Promise<SettingsChain> {
  const home = opts.home ?? os.homedir();
  const userFile = path.join(home, '.bajin', 'config.json');
  const layers: Array<Record<string, unknown>> = [];
  if (opts.system) layers.push(opts.system);
  const user = await readJson(userFile);
  if (user) layers.push(user);
  const projectFiles = await discoverProjectConfigFiles(cwd);
  for (const { file } of projectFiles) {
    const proj = await readJson(file);
    if (proj) layers.push(proj);
  }
  return { merged: mergeSettingsLayers(layers), userFile: user ? userFile : null, projectFiles };
}

/**
 * Env 覆盖层：BAJIN_MODEL / BAJIN_MODE / BAJIN_BASE_URL / BAJIN_ALLOWED_TOOLS（逗号分隔）/ BAJIN_DISALLOWED_TOOLS。
 * 返回 overlay 对象（不修改原 merged；调用方 mergeSettingsLayers([merged, overlay])）。
 */
export function envSettingsOverlay(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const overlay: Record<string, unknown> = {};
  const s = (k: string): string | undefined => {
    const v = env[k];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  const model = s('BAJIN_MODEL');
  if (model) overlay['model'] = model;
  const mode = s('BAJIN_MODE');
  if (mode) overlay['mode'] = mode;
  const baseUrl = s('BAJIN_BASE_URL');
  if (baseUrl) overlay['bigmodel'] = { baseUrl };
  const allowed = s('BAJIN_ALLOWED_TOOLS');
  if (allowed) overlay['allowedTools'] = allowed.split(',').map((x) => x.trim()).filter(Boolean);
  const disallowed = s('BAJIN_DISALLOWED_TOOLS');
  if (disallowed) overlay['disallowedTools'] = disallowed.split(',').map((x) => x.trim()).filter(Boolean);
  return overlay;
}
