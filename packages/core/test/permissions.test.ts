import { describe, expect, it } from 'vitest';
import { PermissionPolicy } from '../src/permissions.js';
import { bashTool, editTool, globTool, readTool, writeTool } from '../src/tools/index.js';

describe('权限矩阵', () => {
  const plan = new PermissionPolicy({ mode: 'plan' });
  const build = new PermissionPolicy({ mode: 'build' });
  const edit = new PermissionPolicy({ mode: 'edit' });
  const yolo = new PermissionPolicy({ mode: 'yolo' });

  it('只读工具任何模式都放行', () => {
    for (const p of [plan, build, edit, yolo]) {
      expect(p.decide(readTool)).toBe('allow');
      expect(p.decide(globTool)).toBe('allow');
    }
  });

  it('plan 模式拒绝所有写操作', () => {
    expect(plan.decide(writeTool)).toBe('deny');
    expect(plan.decide(editTool)).toBe('deny');
    expect(plan.decide(bashTool)).toBe('deny');
  });

  it('build 模式：文件写和 Bash 都要审批', () => {
    expect(build.decide(writeTool)).toBe('ask');
    expect(build.decide(editTool)).toBe('ask');
    expect(build.decide(bashTool)).toBe('ask');
  });

  it('edit 模式：文件写放行，Bash 仍需审批', () => {
    expect(edit.decide(writeTool)).toBe('allow');
    expect(edit.decide(editTool)).toBe('allow');
    expect(edit.decide(bashTool)).toBe('ask');
  });

  it('yolo 模式全放行', () => {
    expect(yolo.decide(writeTool)).toBe('allow');
    expect(yolo.decide(bashTool)).toBe('allow');
  });

  it('显式 allowed/disallowed 优先于模式', () => {
    const p = new PermissionPolicy({ mode: 'plan', allowedTools: ['Bash'] });
    expect(p.decide(bashTool)).toBe('allow');
    const q = new PermissionPolicy({ mode: 'yolo', disallowedTools: ['Bash'] });
    expect(q.decide(bashTool)).toBe('deny');
    expect(q.denyReason(bashTool)).toContain('禁用');
  });
});
