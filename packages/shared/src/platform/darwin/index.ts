import { createPosixAdapter } from '../posix/base.js';

/** macOS 平台实现：沿用 POSIX 基底；出现 Darwin 差异（默认 shell 为 zsh 等）时在本目录内覆盖 */
export const darwinAdapter = createPosixAdapter('darwin');
