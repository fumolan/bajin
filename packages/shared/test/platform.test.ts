import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { getPlatform } from '../src/platform/index.js';
import { terminalShellOptions } from '../src/platform/shell-options.js';

const win = getPlatform('win32');
const linux = getPlatform('linux');
const mac = getPlatform('darwin');

describe('平台适配层', () => {
  it('win：缺省 shell = COMSPEC + /c；显式 shell 按 -c 语义', () => {
    expect(win.commandShell(undefined, { COMSPEC: 'C:\\Windows\\system32\\cmd.exe' })).toEqual({
      file: 'C:\\Windows\\system32\\cmd.exe',
      flag: '/c',
    });
    expect(win.commandShell(undefined, {})).toEqual({ file: 'cmd.exe', flag: '/c' });
    expect(win.commandShell('bash', {})).toEqual({ file: 'bash', flag: '-c' });
  });

  it('win：集成终端无 --login 语义，缺省 COMSPEC', () => {
    expect(win.terminalCommand(undefined, { COMSPEC: 'C:\\cmd.exe' })).toEqual({ file: 'C:\\cmd.exe', args: [] });
    expect(win.terminalCommand('powershell.exe', {})).toEqual({ file: 'powershell.exe', args: [] });
  });

  it('posix：缺省 /bin/bash -c；集成终端吃 $SHELL 并带 --login', () => {
    expect(linux.commandShell(undefined, {})).toEqual({ file: '/bin/bash', flag: '-c' });
    expect(linux.commandShell('zsh', {})).toEqual({ file: 'zsh', flag: '-c' });
    expect(linux.terminalCommand(undefined, { SHELL: '/usr/bin/fish' })).toEqual({ file: '/usr/bin/fish', args: ['--login'] });
    expect(linux.terminalCommand('auto', {})).toEqual({ file: '/bin/bash', args: ['--login'] });
    expect(mac.terminalCommand(undefined, { SHELL: '/bin/zsh' })).toEqual({ file: '/bin/zsh', args: ['--login'] });
  });

  it('stateRoot 优先级：root > homeDir(拼 .bajin) > BAJIN_HOME > 家目录；相对路径逐级回退', () => {
    const env = { HOME: '/tmp/fake-home' };
    expect(linux.stateRoot({ root: '/tmp/state' }, env)).toBe('/tmp/state');
    expect(linux.stateRoot({ homeDir: '/tmp/h' }, env)).toBe(path.join('/tmp/h', '.bajin'));
    expect(linux.stateRoot(undefined, { ...env, BAJIN_HOME: '/tmp/bh' })).toBe('/tmp/bh');
    expect(linux.stateRoot(undefined, env)).toBe(path.join('/tmp/fake-home', '.bajin'));
    // 相对 root / 相对 BAJIN_HOME 均忽略
    expect(linux.stateRoot({ root: 'rel/ignored' }, env)).toBe(path.join('/tmp/fake-home', '.bajin'));
    expect(linux.stateRoot(undefined, { ...env, BAJIN_HOME: 'rel/ignored' })).toBe(path.join('/tmp/fake-home', '.bajin'));
  });

  it('isAbsolutePath：跨平台判定（startsWith(\'/\') 会误杀 Windows 盘符路径）', () => {
    expect(win.isAbsolutePath('C:\\Users\\x')).toBe(true);
    expect(win.isAbsolutePath('rel/path')).toBe(false);
    expect(linux.isAbsolutePath('/tmp/x')).toBe(true);
    expect(linux.isAbsolutePath('rel/path')).toBe(false);
  });

  it('未注册平台按 POSIX 基底兜底；注册表可取到三大平台', () => {
    expect(getPlatform('freebsd').family).toBe('posix');
    expect(getPlatform('win32').family).toBe('windows');
    expect(getPlatform('linux').id).toBe('linux');
    expect(getPlatform('darwin').id).toBe('darwin');
  });

  it('渲染层 shell 选项纯函数按平台分流（与 adapter 取值约定一致）', () => {
    expect(terminalShellOptions('win32').map((o) => o.value)).toEqual(['auto', 'powershell.exe', 'cmd.exe']);
    expect(terminalShellOptions('linux').map((o) => o.value)).toEqual(['auto', '/bin/bash', '/bin/zsh', '/bin/sh']);
    expect(terminalShellOptions('win32')[0]!.label).toContain('cmd');
    expect(terminalShellOptions('linux')[0]!.label).toContain('$SHELL');
  });
});
