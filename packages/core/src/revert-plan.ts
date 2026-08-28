/**
 * 本轮文件改动撤销计划（R7-5，对标 ZCode「可安全撤销 N/不能安全撤销 N」语义）：
 * 输入 git status porcelain 条目 + 本会话触碰过的文件集合，产出分级计划——
 * modified（未暂存）→ 可安全 restore；untracked（本会话新建）→ 需确认删除；
 * staged/renamed → 拒绝（涉及索引操作，交给人工 git）。纯函数可测，执行在 app-server。
 */

export interface GitStatusEntry {
  /** porcelain XY 两字母，如 ' M'、'??'、'MM'、'R ' */
  xy: string;
  path: string;
}

export interface RevertPlan {
  safe: Array<{ path: string; action: 'restore' }>;
  risky: Array<{ path: string; action: 'delete-untracked' | 'reject-staged' | 'reject-renamed'; reason: string }>;
}

export function planFileRevert(entries: GitStatusEntry[], touched: Iterable<string>): RevertPlan {
  const touchedSet = new Set(touched);
  const plan: RevertPlan = { safe: [], risky: [] };
  for (const e of entries) {
    if (!touchedSet.has(e.path)) continue; // 只撤本会话碰过的文件
    const x = e.xy[0] ?? ' ';
    const y = e.xy[1] ?? ' ';
    if (x === 'R' || y === 'R') {
      plan.risky.push({ path: e.path, action: 'reject-renamed', reason: '重命名涉及索引，请人工 git 处理' });
    } else if (x === '?' ) {
      plan.risky.push({ path: e.path, action: 'delete-untracked', reason: '本会话新建的未跟踪文件，删除需确认' });
    } else if (x !== ' ' ) {
      plan.risky.push({ path: e.path, action: 'reject-staged', reason: '已暂存（staged）改动，请人工 git 处理' });
    } else if (y === 'M' || y === 'D') {
      plan.safe.push({ path: e.path, action: 'restore' });
    }
    // 其余状态（如 y==? 不存在于 porcelain 二列）忽略
  }
  return plan;
}
