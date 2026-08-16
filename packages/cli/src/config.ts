import type { PermissionMode } from '@bajin/shared';
import { DEFAULT_GLM_MODEL, loadSettingsChain, envSettingsOverlay, mergeSettingsLayers } from '@bajin/core';

export interface BajinConfig {
  provider: 'glm' | 'mock';
  model: string;
  mode: PermissionMode;
  allowedTools: string[];
  disallowedTools: string[];
  bigmodel: {
    baseUrl?: string;
    apiKey?: string;
  };
}

export const DEFAULT_CONFIG: BajinConfig = {
  provider: 'glm',
  model: DEFAULT_GLM_MODEL,
  mode: 'build',
  allowedTools: [],
  disallowedTools: [],
  bigmodel: {},
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 配置加载（settings 作用域链，对标 ZCode precedence）：
 *   System(默认) < User(~/.bajin/config.json) < Project(bajin.json / .bajin/config.json，
 *   自 cwd 向上到 .git 根，近的覆盖远的) < Env(BAJIN_*) < Cli(旗标，main.ts 处)。
 * 项目发现/合并/Env 层复用 @bajin/core 的 loadSettingsChain/envSettingsOverlay。
 */
export async function loadConfig(cwd: string): Promise<BajinConfig> {
  const chain = await loadSettingsChain(cwd, { system: DEFAULT_CONFIG as unknown as Record<string, unknown> });
  const merged = mergeSettingsLayers([chain.merged, envSettingsOverlay()]);
  return sanitizeConfig(merged);
}

function sanitizeConfig(raw: Record<string, unknown>): BajinConfig {
  const modes = ['plan', 'build', 'edit', 'yolo'];
  return {
    provider: raw['provider'] === 'mock' ? 'mock' : 'glm',
    model: typeof raw['model'] === 'string' && raw['model'] ? raw['model'] : DEFAULT_GLM_MODEL,
    mode: modes.includes(raw['mode'] as string) ? (raw['mode'] as PermissionMode) : 'build',
    allowedTools: Array.isArray(raw['allowedTools']) ? (raw['allowedTools'] as string[]).filter((x) => typeof x === 'string') : [],
    disallowedTools: Array.isArray(raw['disallowedTools']) ? (raw['disallowedTools'] as string[]).filter((x) => typeof x === 'string') : [],
    bigmodel: {
      ...(isPlainObject(raw['bigmodel']) && typeof raw['bigmodel']['baseUrl'] === 'string'
        ? { baseUrl: raw['bigmodel']['baseUrl'] }
        : {}),
      ...(isPlainObject(raw['bigmodel']) && typeof raw['bigmodel']['apiKey'] === 'string'
        ? { apiKey: raw['bigmodel']['apiKey'] }
        : {}),
    },
  };
}
