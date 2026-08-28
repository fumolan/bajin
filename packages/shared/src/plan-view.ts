/**
 * 计划展示策略（R6-6）：计划审批卡的折叠判定。
 * 行数 > 28 或字符 > 1800 视为长计划——折叠预览 +「查看完整计划」展开；
 * 状态面板等次级展示不在此判定（各自用更小截断）。
 */
export function shouldCollapsePlan(plan: string): boolean {
  if (!plan) return false;
  return plan.split('\n').length > 28 || plan.length > 1800;
}
