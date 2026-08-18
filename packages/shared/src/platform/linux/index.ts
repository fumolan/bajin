import { createPosixAdapter } from '../posix/base.js';

/** Linux 平台实现：沿用 POSIX 基底；出现发行版差异（默认 shell 探测等）时在本目录内覆盖 */
export const linuxAdapter = createPosixAdapter('linux');
