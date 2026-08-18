/**
 * 渲染层可用的纯数据辅助（无 node 依赖，浏览器 bundle 可直接 import）。
 * 平台 id 由主进程经 preload 注入（window.bajin 平台是唯一事实源），navigator 仅作回退。
 */

export interface ShellOption {
  value: string;
  label: string;
}

export function isWindowsFamily(platformId: string): boolean {
  return platformId === 'win32';
}

/** 集成终端 Shell 设置下拉选项（按平台分流；与 PlatformAdapter.terminalCommand 的取值约定一致） */
export function terminalShellOptions(platformId: string): ShellOption[] {
  return isWindowsFamily(platformId)
    ? [
        { value: 'auto', label: '自动（cmd）' },
        { value: 'powershell.exe', label: 'PowerShell' },
        { value: 'cmd.exe', label: 'cmd' },
      ]
    : [
        { value: 'auto', label: '自动（$SHELL）' },
        { value: '/bin/bash', label: 'bash' },
        { value: '/bin/zsh', label: 'zsh' },
        { value: '/bin/sh', label: 'sh' },
      ];
}
