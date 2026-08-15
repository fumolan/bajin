import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * 模型目录体系（对标 ZCode 的 models catalog + 自定义模型）：
 * - 内置：GLM 全系（z.ai/bigmodel 官方模型族）
 * - 自定义：~/.bajin/config.json 的 models: [{id, label?, baseUrl?, apiKey?}]
 *   任意 openai 兼容端点都可接入（id 即 model 参数）
 */

export interface CustomModel {
  id: string;
  label?: string;
  baseUrl?: string;
  apiKey?: string;
  /** 挂到哪个供应商（供应商提供 baseUrl/apiKey） */
  provider?: string;
}

/** 供应商（对标 ZCode 的「添加供应商，指定 key」）：一个端点 + 一把钥匙 + 名下模型 */
export type ApiFormat = 'openai' | 'anthropic';

export interface ProviderEntry {
  name: string;
  baseUrl?: string;
  apiKey?: string;
  /** 接入端点协议：openai（/chat/completions）| anthropic（/messages），默认 openai */
  apiFormat?: ApiFormat;
  /** 该供应商下可用的模型 id（未注册进 models[] 的也能凭此直接选用） */
  models?: string[];
  note?: string;
}

export interface ModelOption {
  id: string;
  label?: string;
  source: 'builtin' | 'custom';
  baseUrl?: string;
  provider?: string;
}

/** 内置 GLM 模型族（与 open.bigmodel.cn 目录对齐） */
export const BUILTIN_MODEL_IDS: readonly string[] = [
  'glm-5.3',
  'glm-5.3-highspeed',
  'glm-5.2',
  'glm-5.1',
  'glm-5.1-highspeed',
  'glm-5.1-fast',
  'glm-5.1-free',
  'glm-5.1-precision',
  'glm-5',
  'glm-5-turbo',
  'glm-5v-turbo',
  'glm-4.7',
  'glm-4.7-flash',
  'glm-4.7-flashx',
  'glm-4.6',
  'glm-4.6v',
  'glm-4.6v-flash',
  'glm-4.5',
  'glm-4.5-air',
  'glm-4.5-airx',
  'glm-4.5-flash',
  'glm-4.5v',
  'glm-z1-airx',
  'glm-4-32b',
];

export function configFilePath(home = os.homedir()): string {
  return path.join(home, '.bajin', 'config.json');
}

export async function readCustomModels(home = os.homedir()): Promise<CustomModel[]> {
  try {
    const raw = JSON.parse(await fs.readFile(configFilePath(home), 'utf8')) as { models?: unknown };
    if (!Array.isArray(raw.models)) return [];
    return raw.models.filter(
      (m): m is CustomModel =>
        typeof m === 'object' && m !== null && typeof (m as CustomModel).id === 'string' && (m as CustomModel).id.length > 0,
    );
  } catch {
    return [];
  }
}

/** 写回自定义模型，保留 config.json 里的其他键 */
export async function writeCustomModels(models: CustomModel[], home = os.homedir()): Promise<void> {
  const file = configFilePath(home);
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    // 首次创建
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ ...config, models }, null, 2)}\n`, 'utf8');
}

/** 合并后的可选清单：自定义优先于内置（同名覆盖） */
export function mergeModelOptions(custom: CustomModel[], providers: ProviderEntry[] = []): ModelOption[] {
  const customIds = new Set(custom.map((m) => m.id));
  const builtin: ModelOption[] = BUILTIN_MODEL_IDS.filter((id) => !customIds.has(id)).map((id) => ({ id, source: 'builtin' }));
  const customOpts: ModelOption[] = custom.map((m) => ({
    id: m.id,
    label: m.label ?? m.provider ?? m.baseUrl,
    source: 'custom',
    ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
    ...(m.provider ? { provider: m.provider } : {}),
  }));
  // 供应商名下模型：没单独注册进 models[] 的也直接可选用（挂到该供应商的端点）
  const providerOpts: ModelOption[] = providers.flatMap((p) =>
    (p.models ?? [])
      .filter((id) => !customIds.has(id) && !BUILTIN_MODEL_IDS.includes(id))
      .map((id) => ({ id, label: p.name, source: 'custom' as const, provider: p.name })),
  );
  const seen = new Set<string>();
  return [...customOpts, ...providerOpts.filter((o) => !seen.has(o.id) && seen.add(o.id)), ...builtin];
}

/** 查 id 对应的自定义模型 */
export function findCustomModel(id: string, custom: CustomModel[]): CustomModel | undefined {
  return custom.find((m) => m.id === id);
}

/* ---------- 供应商读写（~/.bajin/config.json 的 providers[]，保留其他键） ---------- */

export async function readProviders(home = os.homedir()): Promise<ProviderEntry[]> {
  try {
    const raw = JSON.parse(await fs.readFile(configFilePath(home), 'utf8')) as { providers?: unknown };
    if (!Array.isArray(raw.providers)) return [];
    return raw.providers.filter(
      (p): p is ProviderEntry => typeof p === 'object' && p !== null && typeof (p as ProviderEntry).name === 'string',
    );
  } catch {
    return [];
  }
}

export async function writeProviders(providers: ProviderEntry[], home = os.homedir()): Promise<void> {
  const file = configFilePath(home);
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    // 首次创建
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ ...config, providers }, null, 2)}\n`, 'utf8');
}

/**
 * 解析某模型 id 的实际端点与密钥（provider 工厂用）：
 * 1) 自定义模型自带 baseUrl/apiKey → 直接用
 * 2) 自定义模型挂了供应商 → 用供应商的 baseUrl/apiKey
 * 3) 内置（glm-*）→ 走默认 bigmodel（返回空）
 */
export function resolveModelEndpoint(
  modelId: string,
  custom: CustomModel[],
  providers: ProviderEntry[],
): { baseUrl?: string; apiKey?: string; provider?: string; apiFormat?: ApiFormat } {
  const m = custom.find((x) => x.id === modelId);
  if (!m) {
    // 未注册进 models[]：查它是不是某供应商名下模型，是则直接用该供应商端点
    const owner = providers.find((p) => (p.models ?? []).includes(modelId));
    if (owner) return { baseUrl: owner.baseUrl, apiKey: owner.apiKey, provider: owner.name, ...(owner.apiFormat ? { apiFormat: owner.apiFormat } : {}) };
    return {};
  }
  if (m.baseUrl || m.apiKey) return { baseUrl: m.baseUrl, apiKey: m.apiKey, provider: m.provider };
  if (m.provider) {
    const p = providers.find((x) => x.name === m.provider);
    if (p) return { baseUrl: p.baseUrl, apiKey: p.apiKey, provider: p.name, ...(p.apiFormat ? { apiFormat: p.apiFormat } : {}) };
  }
  return { provider: m.provider };
}
