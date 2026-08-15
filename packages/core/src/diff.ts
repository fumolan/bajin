/**
 * 轻量 unified diff（LCS 行级比对）。
 * 超 1500 行的输入退化为粗粒度替换摘要，避免 O(n·m) 内存爆炸。
 */

const MAX_LCS_LINES = 1500;

export function unifiedDiff(oldText: string, newText: string, contextLines = 3): string {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
    return coarseDiff(a, b);
  }

  // LCS 长度矩阵（复用一维滚动数组求回溯矩阵太大，直接建二维）
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  // 回溯得到编辑脚本
  type Op = { t: ' ' | '-' | '+'; line: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: ' ', line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ t: '-', line: a[i]! });
      i++;
    } else {
      ops.push({ t: '+', line: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ t: '-', line: a[i++]! });
  while (j < m) ops.push({ t: '+', line: b[j++]! });

  // 折叠未变更区段为上下文窗口
  const out: string[] = [];
  let k = 0;
  let prevStop = -1;
  while (k < ops.length) {
    if (ops[k]!.t === ' ') {
      k++;
      continue;
    }
    // 变更区 [k, end)，展示窗口 [start, stop)，窗口间不重叠
    let end = k;
    while (end < ops.length && ops[end]!.t !== ' ') end++;
    const start = Math.max(prevStop + 1, k - contextLines);
    const stop = Math.min(ops.length, end + contextLines);
    if (prevStop >= 0 && start > prevStop) out.push(' ...');
    for (let x = start; x < stop; x++) out.push(`${ops[x]!.t} ${ops[x]!.line}`);
    prevStop = stop;
    k = stop;
  }
  if (!out.length) return '(no changes)';
  return out.join('\n');
}

function coarseDiff(a: string[], b: string[]): string {
  const removed = a.length;
  const added = b.length;
  const head = b.slice(0, 40).map((l) => `+ ${l}`).join('\n');
  return `(文件过大，整体替换：删除 ${removed} 行，新增 ${added} 行；新内容前 40 行：)\n${head}${added > 40 ? '\n...' : ''}`;
}
