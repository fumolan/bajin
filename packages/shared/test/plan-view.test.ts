import { describe, it, expect } from 'vitest';
import { shouldCollapsePlan } from '../src/plan-view.js';

describe('计划折叠判定（R6-6）', () => {
  it('短计划不折叠', () => {
    expect(shouldCollapsePlan('1. 读文件\n2. 改代码\n3. 跑测试')).toBe(false);
  });
  it('行数超 28 折叠', () => {
    expect(shouldCollapsePlan(Array.from({ length: 29 }, (_, i) => `${i + 1}. 步`).join('\n'))).toBe(true);
    expect(shouldCollapsePlan(Array.from({ length: 28 }, (_, i) => `${i + 1}. 步`).join('\n'))).toBe(false);
  });
  it('单行超长（>1800 字符）折叠', () => {
    expect(shouldCollapsePlan('一'.repeat(1801))).toBe(true);
    expect(shouldCollapsePlan('一'.repeat(1800))).toBe(false);
  });
  it('空计划安全不折叠', () => {
    expect(shouldCollapsePlan('')).toBe(false);
  });
});
