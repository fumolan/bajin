import * as path from 'node:path';
import type { PlatformAdapter } from '../types.js';
import { resolveStateRoot } from '../posix/base.js';

/**
 * Windows 平台实现：缺省 shell 为 COMSPEC（cmd.exe，`/c` 语义）；显式 shell 按 `-c` 语义。
 * 平台私有复杂度（路径风格转换、符号链接权限规避等）增长时在本目录内拆分文件。
 */
export const win32Adapter: PlatformAdapter = {
  id: 'win32',
  family: 'windows',
  commandShell(explicit, env) {
    return explicit ? { file: explicit, flag: '-c' } : { file: env['COMSPEC'] ?? 'cmd.exe', flag: '/c' };
  },
  terminalCommand(explicit, env) {
    const file = explicit && explicit !== 'auto' ? explicit : (env['COMSPEC'] ?? 'cmd.exe');
    return { file, args: [] };
  },
  stateRoot(input, env) {
    return resolveStateRoot(input, env);
  },
  isAbsolutePath(p) {
    // Windows 绝对路径：盘符（C:\）或 UNC（\\server\share）；在非 win32 平台上也能正确判定
    return path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
  },
};
