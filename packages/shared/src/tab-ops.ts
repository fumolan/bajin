/**
 * 标签页批量操作（R8-3，对标 ZCode 关闭其他/关闭全部/恢复最近关闭）：
 * 纯函数产出下一状态与被关列表，UI 与持久化（恢复栈）只消费结果。
 */

export interface TabLike {
  id: number;
  title: string;
  sessionId: string | null;
}

export interface TabOpResult<T extends TabLike> {
  next: T[];
  nextActive: number;
  closed: T[];
}

/** 关闭除 keepIdx 外的全部标签 */
export function closeOthers<T extends TabLike>(tabs: T[], keepIdx: number): TabOpResult<T> {
  const keep = tabs[keepIdx];
  if (!keep) return { next: tabs, nextActive: 0, closed: [] };
  return { next: [keep], nextActive: 0, closed: tabs.filter((_, i) => i !== keepIdx) };
}

/** 关闭全部（全部入恢复栈） */
export function closeAll<T extends TabLike>(tabs: T[]): TabOpResult<T> {
  return { next: [], nextActive: 0, closed: tabs };
}

/** 关闭单个（供恢复栈累积）：激活位优先留在原 index，越界则退到最后一个 */
export function closeOne<T extends TabLike>(tabs: T[], idx: number): TabOpResult<T> {
  const t = tabs[idx];
  if (!t) return { next: tabs, nextActive: 0, closed: [] };
  if (tabs.length === 1) return { next: [], nextActive: 0, closed: [t] };
  const next = tabs.filter((_, i) => i !== idx);
  const nextActive = Math.min(idx, next.length - 1);
  return { next, nextActive, closed: [t] };
}

/** 恢复最近关闭：弹栈，按 t.id（关闭时的原 index）插回；越界夹到当前末尾 */
export function reopenTab<T extends TabLike>(remaining: T[], stack: T[]): { next: T[]; nextActive: number; stack: T[] } | null {
  const t = stack[stack.length - 1];
  if (!t) return null;
  const stack2 = stack.slice(0, -1);
  const idx = Math.min(Math.max(t.id, 0), remaining.length);
  const next = [...remaining.slice(0, idx), t, ...remaining.slice(idx)];
  return { next, nextActive: idx, stack: stack2 };
}
