import { describe, expect, it } from 'vitest';
import { nextCronRun, parseCron } from '../src/cron.js';

/** 比较本地墙上时刻（cron 语义就是本地时间） */
function fmt(d: Date | null): string {
  if (!d) return 'null';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

describe('cron 解析与下次触发', () => {
  const at = (s: string) => new Date(s);

  it('固定时刻', () => {
    expect(fmt(nextCronRun('30 2 * * *', at('2026-08-14T10:00:00')))).toBe('2026-08-15 02:30');
  });

  it('*/n 步进', () => {
    expect(fmt(nextCronRun('*/15 * * * *', at('2026-08-14T10:07:00')))).toBe('2026-08-14 10:15');
  });

  it('区间与列表', () => {
    expect(fmt(nextCronRun('0 9-18 * * 1-5', at('2026-08-14T10:00:00')))).toBe('2026-08-14 11:00'); // 2026-08-14 是周五
    expect(fmt(nextCronRun('0 8,20 * * *', at('2026-08-14T10:00:00')))).toBe('2026-08-14 20:00');
  });

  it('分钟级恰好下一分钟', () => {
    expect(fmt(nextCronRun('* * * * *', at('2026-08-14T10:00:30')))).toBe('2026-08-14 10:01');
  });

  it('周日 0 与 7 等价', () => {
    expect(parseCron('0 0 * * 0').dow?.has(0)).toBe(true);
    expect(parseCron('0 0 * * 7').dow?.has(0)).toBe(true);
    const next = nextCronRun('0 6 * * 0', at('2026-08-14T10:00:00'));
    expect(next?.getDay()).toBe(0);
    expect(fmt(next)).toBe('2026-08-16 06:00');
  });

  it('非法表达式报错', () => {
    expect(() => parseCron('* * * *')).toThrow();
    expect(() => parseCron('99 * * * *')).toThrow();
    expect(() => parseCron('a * * * *')).toThrow();
  });

  it('永不触发的表达式返回 null', () => {
    expect(nextCronRun('0 0 31 2 *', at('2026-08-14T10:00:00'))).toBeNull();
  });
});
