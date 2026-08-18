import * as path from 'node:path';
import * as os from 'node:os';
import type { EnvLike, PlatformAdapter, StateRootInput } from '../types.js';

/**
 * 状态根目录解析（各平台共用约定）：
 * root > homeDir(拼 .bajin) > BAJIN_HOME > 家目录（HOME/USERPROFILE 注入优先，便于测试）。
 */
export function resolveStateRoot(input: StateRootInput | undefined, env: EnvLike): string {
  const i = input ?? {};
  if (i.root && path.isAbsolute(i.root)) return i.root;
  if (i.homeDir && path.isAbsolute(i.homeDir)) return path.join(i.homeDir, '.bajin');
  const fromEnv = env['BAJIN_HOME'];
  if (fromEnv && path.isAbsolute(fromEnv)) return fromEnv;
  return path.join(env['HOME'] ?? env['USERPROFILE'] ?? os.homedir(), '.bajin');
}

/**
 * POSIX 基底（unix 家族平台共用）。
 * 各具体平台（linux/darwin/…）在自己的目录里组合本基底并覆盖差异点；
 * 基底自身复杂度增长时在本目录内继续拆分文件，不影响其他平台。
 */
export function createPosixAdapter(id: string): PlatformAdapter {
  return {
    id,
    family: 'posix',
    commandShell(explicit) {
      return explicit ? { file: explicit, flag: '-c' } : { file: '/bin/bash', flag: '-c' };
    },
    terminalCommand(explicit, env) {
      const file = explicit && explicit !== 'auto' ? explicit : (env['SHELL'] ?? '/bin/bash');
      return { file, args: ['--login'] };
    },
    stateRoot(input, env) {
      return resolveStateRoot(input, env);
    },
    isAbsolutePath: path.isAbsolute,
  };
}
