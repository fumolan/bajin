/**
 * 极简 cron（5 字段：分 时 日 月 周）下一次触发时间计算。
 * 支持：星号、步进（星号/n）、单值 a、区间 a-b、区间带步进、逗号列表。周 0/7 均为周日。
 * 用于「自动化」调度（对标 ZCode 的 automations + cron_expr）。
 */

function parseField(field: string, min: number, max: number): Set<number> | null {
  if (field === '*') return null; // null = 不限制
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`非法步长: ${part}`);
    let lo = min;
    let hi = max;
    if (range !== '*' && range !== undefined) {
      const bits = range.split('-');
      if (bits.length === 1) {
        lo = hi = Number(bits[0]);
      } else {
        lo = Number(bits[0]);
        hi = Number(bits[1]);
      }
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
        throw new Error(`非法 cron 字段: ${part}`);
      }
    }
    for (let v = lo; v <= hi; v += step) out.add(v === 7 && max === 7 ? 0 : v);
  }
  return out;
}

export interface CronFields {
  minute: Set<number> | null;
  hour: Set<number> | null;
  dom: Set<number> | null;
  month: Set<number> | null;
  dow: Set<number> | null;
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron 必须是 5 个字段（分 时 日 月 周）: ${expr}`);
  return {
    minute: parseField(parts[0]!, 0, 59),
    hour: parseField(parts[1]!, 0, 23),
    dom: parseField(parts[2]!, 1, 31),
    month: parseField(parts[3]!, 1, 12),
    dow: parseField(parts[4]!, 0, 7),
  };
}

function matches(f: CronFields, d: Date): boolean {
  if (f.minute?.has(d.getMinutes()) === false) return false;
  if (f.hour?.has(d.getHours()) === false) return false;
  if (f.month?.has(d.getMonth() + 1) === false) return false;
  const dayOk = f.dom?.has(d.getDate());
  const dowOk = f.dow?.has(d.getDay());
  // 标准语义：日与周都限定时取并集，只限定其一时取交集
  if (f.dom && f.dow) {
    if (!dayOk && !dowOk) return false;
  } else if (f.dom && !dayOk) return false;
  else if (f.dow && !dowOk) return false;
  return true;
}

/** 从 from 之后的第一分钟开始找下一次触发时刻；一年内无匹配返回 null */
export function nextCronRun(expr: string, from = new Date()): Date | null {
  const fields = parseCron(expr);
  const cursor = new Date(from.getTime() + 60_000);
  cursor.setSeconds(0, 0);
  const limit = cursor.getTime() + 366 * 24 * 60 * 60_000;
  while (cursor.getTime() <= limit) {
    if (matches(fields, cursor)) return new Date(cursor.getTime());
    cursor.setTime(cursor.getTime() + 60_000);
  }
  return null;
}
