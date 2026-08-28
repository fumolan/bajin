import { describe, it, expect } from 'vitest';
import { planFileRevert } from '../src/revert-plan.js';

const T = ['src/a.ts', 'src/new.ts', 'src/staged.ts', 'src/mv.ts', 'src/other.ts'];

describe('本轮文件改动撤销计划（R7-5）', () => {
  it('未暂存修改 → 可安全 restore；只认本会话触碰的文件', () => {
    const p = planFileRevert([
      { xy: ' M', path: 'src/a.ts' },
      { xy: ' M', path: 'src/not-touched.ts' },
    ], T);
    expect(p.safe).toEqual([{ path: 'src/a.ts', action: 'restore' }]);
    expect(p.risky).toEqual([]);
  });

  it('本会话新建的未跟踪文件 → risky（删除需确认）', () => {
    const p = planFileRevert([{ xy: '??', path: 'src/new.ts' }], T);
    expect(p.safe).toEqual([]);
    expect(p.risky[0]).toMatchObject({ path: 'src/new.ts', action: 'delete-untracked' });
  });

  it('已暂存/重命名 → 拒绝并给原因', () => {
    const p = planFileRevert([
      { xy: 'M ', path: 'src/staged.ts' },
      { xy: 'R ', path: 'src/mv.ts' },
    ], T);
    expect(p.safe).toEqual([]);
    expect(p.risky).toHaveLength(2);
    expect(p.risky[0]).toMatchObject({ action: 'reject-staged' });
    expect(p.risky[1]).toMatchObject({ action: 'reject-renamed' });
  });

  it('本会话删除的文件（工作区 D）也在安全 restore 之列', () => {
    const p = planFileRevert([{ xy: ' D', path: 'src/other.ts' }], T);
    expect(p.safe).toEqual([{ path: 'src/other.ts', action: 'restore' }]);
  });

  it('空触碰集合 → 空计划（无事可撤）', () => {
    const p = planFileRevert([{ xy: ' M', path: 'src/a.ts' }], []);
    expect(p.safe).toEqual([]);
    expect(p.risky).toEqual([]);
  });
});
