import { win32Adapter } from './win32/index.js';
import { linuxAdapter } from './linux/index.js';
import { darwinAdapter } from './darwin/index.js';
import { createPosixAdapter } from './posix/base.js';
import type { PlatformAdapter } from './types.js';

/**
 * 平台注册表：新增平台 = 在 platform/ 下建自己的目录实现 PlatformAdapter + 在此注册，
 * 业务代码零改动。目录结构：
 *   win32/  linux/  darwin/  — 各平台实现（复杂度增长在各自目录内拆分）
 *   posix/  — unix 家族共享基底
 */
const REGISTRY: Record<string, PlatformAdapter> = {
  win32: win32Adapter,
  linux: linuxAdapter,
  darwin: darwinAdapter,
};

/** 按平台 id 取适配器；未注册平台按 POSIX 基底兜底 */
export function getPlatform(id: string): PlatformAdapter {
  return REGISTRY[id] ?? createPosixAdapter(id);
}

/** 当前进程平台适配器（业务层主要入口） */
export const platform: PlatformAdapter = getPlatform(process.platform);

export * from './types.js';
