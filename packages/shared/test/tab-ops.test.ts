import { describe, it, expect } from 'vitest';
import { closeOthers, closeAll, closeOne, reopenTab, type TabLike } from '../src/tab-ops.js';

const mk = (id: number, title = `t${id}`): TabLike => ({ id, title, sessionId: id % 2 ? `s${id}` : null });
const five = (): TabLike[] => [mk(0), mk(1), mk(2), mk(3), mk(4)];

describe('标签批量操作（R8-3）', () => {
  it('closeOthers：只留指定，其余入 closed', () => {
    const r = closeOthers(five(), 2);
    expect(r.next.map((t) => t.id)).toEqual([2]);
    expect(r.nextActive).toBe(0);
    expect(r.closed.map((t) => t.id)).toEqual([0, 1, 3, 4]);
  });

  it('closeOthers：非法 keepIdx 原样返回', () => {
    const tabs = five();
    expect(closeOthers(tabs, 99)).toEqual({ next: tabs, nextActive: 0, closed: [] });
  });

  it('closeAll：全入 closed', () => {
    const r = closeAll(five());
    expect(r.next).toEqual([]);
    expect(r.closed).toHaveLength(5);
  });

  it('closeOne：移除并保持相邻激活位', () => {
    const r = closeOne(five(), 1);
    expect(r.next.map((t) => t.id)).toEqual([0, 2, 3, 4]);
    expect(r.closed.map((t) => t.id)).toEqual([1]);
    const last = closeOne(five(), 4);
    expect(last.nextActive).toBe(3); // 关最后一个，激活退一位
  });

  it('closeOne：仅剩一个时也允许关闭（交由 UI 落空白标签）', () => {
    const r = closeOne([mk(0)], 0);
    expect(r.next).toEqual([]);
    expect(r.closed).toHaveLength(1);
  });

  it('reopenTab：按 id 恢复到原位置（夹末尾），弹栈', () => {
    const remaining = [mk(0), mk(4)];
    const stack = [mk(1), mk(2)];
    const r = reopenTab(remaining, stack);
    expect(r!.next.map((t) => t.id)).toEqual([0, 4, 2]); // min(2, len=2)=2 → 插到 index 2
    expect(r!.nextActive).toBe(2);
    expect(r!.stack).toEqual([mk(1)]);
  });

  it('reopenTab：空栈返回 null', () => {
    expect(reopenTab(five(), [])).toBeNull();
  });
});
