import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PermissionMode } from '@bajin/shared';
import { DEFAULT_GLM_MODEL } from '@bajin/core';

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

/** 深合并（数组与标量直接覆盖），非法键忽略 */
function mergeDeep(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = mergeDeep(out[k] as Record<string, unknown>, v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 配置加载与合并：用户级 ~/.bajin/config.json ← 项目级 <cwd>/bajin.json
 *（项目覆盖用户，默认值兜底；敏感的 apiKey 建议走 BIGMODEL_API_KEY 环境变量）
 */
export async function loadConfig(cwd: string): Promise<BajinConfig> {
  const sources: Array<Record<string, unknown>> = [];
  for (const file of [path.join(os.homedir(), '.bajin', 'config.json'), path.join(cwd, 'bajin.json')]) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      sources.push(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      // 配置文件不存在或损坏时静默跳过，使用默认值
    }
  }
  const merged = sources.reduce((acc, s) => mergeDeep(acc, s), DEFAULT_CONFIG as unknown as Record<string, unknown>);
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
