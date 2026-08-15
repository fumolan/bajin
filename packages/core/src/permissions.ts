import type { PermissionDecision, PermissionMode, ToolDefinition } from '@bajin/shared';

export interface PermissionPolicyOptions {
  mode: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
}

/**
 * 权限策略：工具执行前的准入判定。
 *
 * - disallowed 命中 → 一律拒绝（用户显式禁用）
 * - allowed 命中 → 一律放行（用户显式信任）
 * - 只读工具（readOnly: true）→ 任何模式放行
 * - 其余按模式：
 *   plan  → 拒绝（规划模式不允许副作用）
 *   edit  → 文件写入类放行，其他（Bash 等）交由用户审批
 *   build → 交由用户审批
 *   yolo  → 放行
 */
export class PermissionPolicy {
  private _mode: PermissionMode;
  private readonly allowed: Set<string>;
  private readonly disallowed: Set<string>;

  constructor(opts: PermissionPolicyOptions) {
    this._mode = opts.mode;
    this.allowed = new Set(opts.allowedTools ?? []);
    this.disallowed = new Set(opts.disallowedTools ?? []);
  }

  get mode(): PermissionMode {
    return this._mode;
  }

  /** 计划批准等场景需要动态切模式 */
  setMode(mode: PermissionMode): void {
    this._mode = mode;
  }

  /** 「始终允许」：审批时用户选择后原地生效（不重建 agent，进行中的循环也能感知） */
  allowTool(name: string): void {
    this.allowed.add(name);
    this.disallowed.delete(name);
  }

  disallowTool(name: string): void {
    this.disallowed.add(name);
    this.allowed.delete(name);
  }

  decide(tool: ToolDefinition): PermissionDecision {
    if (this.disallowed.has(tool.name)) return 'deny';
    if (this.allowed.has(tool.name)) return 'allow';
    if (tool.metadata.readOnly) return 'allow';
    switch (this.mode) {
      case 'yolo':
        return 'allow';
      case 'plan':
        return 'deny';
      case 'edit':
        return tool.name === 'Edit' || tool.name === 'Write' ? 'allow' : 'ask';
      case 'build':
        return 'ask';
    }
  }

  /** 拒绝时给模型的说明（引导其调整行为而非反复重试） */
  denyReason(tool: ToolDefinition): string {
    if (this.disallowed.has(tool.name)) return `工具 ${tool.name} 已被用户禁用（disallowedTools）`;
    return `当前为 ${this.mode} 模式，不允许执行有副作用的工具 ${tool.name}。只读分析可继续；如需修改请提示用户切换模式`;
  }
}
