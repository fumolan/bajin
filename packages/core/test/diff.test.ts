import { describe, expect, it } from 'vitest';
import { unifiedDiff } from '../src/diff.js';

describe('unifiedDiff', () => {
  it('单行修改输出 -/+ 对', () => {
    const d = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n');
    expect(d).toContain('- b');
    expect(d).toContain('+ B');
    expect(d).toContain(' a');
    expect(d).not.toContain('- a');
  });

  it('上下文折叠：远处变更用 ... 连接', () => {
    const old = Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n');
    const next = old.replace('line5', 'CHANGED').replace('line35', 'CHANGED2');
    const d = unifiedDiff(old, next, 2);
    expect(d).toContain('...');
    expect(d).toContain('+ CHANGED');
    expect(d).toContain('+ CHANGED2');
  });

  it('新增/删除文件场景', () => {
    expect(unifiedDiff('', 'new\ncontent\n')).toContain('+ new');
    const del = unifiedDiff('old\n', '');
    expect(del).toContain('- old');
  });

  it('无变化', () => {
    expect(unifiedDiff('same\n', 'same\n')).toBe('(no changes)');
  });

  it('超大输入退化为粗粒度摘要', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `l${i}`).join('\n');
    const d = unifiedDiff(big, `${big}\nextra`);
    expect(d).toContain('整体替换');
  });
});
