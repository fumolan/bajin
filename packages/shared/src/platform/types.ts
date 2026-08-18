/**
 * 平台适配层接口：业务层只依赖本接口，平台差异（shell、路径语义、状态目录约定）
 * 全部封装在各平台实现（win32.ts / linux.ts / darwin.ts / posix.ts）里。
 * 新增平台 = 实现 PlatformAdapter + 在 index.ts 注册，业务代码零改动。
 */

/** 平台家族（仅用于展示等粗粒度分流；能力差异一律走接口方法） */
export type PlatformFamily = 'windows' | 'posix';

/** 环境变量视图（不直接读 process.env，保证适配器可测试） */
export type EnvLike = Record<string, string | undefined>;

/** 「命令字符串」执行 shell（-c / /c 语义） */
export interface CommandShell {
  file: string;
  /** '-c'（POSIX）或 '/c'（Windows cmd） */
  flag: string;
}

/** 交互终端（集成终端）启动命令 */
export interface TerminalCommand {
  file: string;
  args: string[];
}

/** 状态根目录解析输入：root=已是状态根（BAJIN_HOME 的值）；homeDir=家目录（按约定拼 .bajin） */
export interface StateRootInput {
  root?: string;
  homeDir?: string;
}

export interface PlatformAdapter {
  /** process.platform 原始 id（win32 / darwin / linux / …） */
  readonly id: string;
  readonly family: PlatformFamily;

  /**
   * 执行命令字符串的 shell。explicit 为用户显式指定的 shell（BAJIN_SHELL / hook.shell / 配置），
   * 显式指定时按 POSIX `-c` 语义传参；缺省回落平台默认（Windows: COMSPEC /c，POSIX: /bin/bash -c）。
   */
  commandShell(explicit: string | undefined, env: EnvLike): CommandShell;

  /** 集成终端启动命令；explicit 为用户配置（'auto'/空 = 自动） */
  terminalCommand(explicit: string | undefined, env: EnvLike): TerminalCommand;

  /**
   * 状态根目录（~/.bajin 语义），优先级：root > homeDir（拼 .bajin） > env.BAJIN_HOME > 真实家目录。
   * 相对路径一律忽略并逐级回退（防止把相对路径拼进状态路径）。
   */
  stateRoot(input: StateRootInput | undefined, env: EnvLike): string;

  /** 绝对路径判定（业务层禁止用 startsWith('/')——Windows 盘符路径会被误杀） */
  isAbsolutePath(p: string): boolean;
}
