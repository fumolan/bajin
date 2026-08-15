#!/usr/bin/env bash
# bajin 一键打包脚本：构建 → 测试 → CLI bundle → AppImage → 打包态冒烟
# 用法：
#   ./scripts/package.sh              # 全流程（含 AppImage）
#   ./scripts/package.sh --fast       # 跳过 AppImage（只构建+测试+bundle+冒烟）
#   ./scripts/package.sh --log 20     # 开头多显示 GAP-TRACKER 最近 20 行运行日志（默认 10）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPIMAGE_OUT="$ROOT/apps/desktop/release/bajin-0.1.0-linux-x86_64.AppImage"
BUNDLED_CJS="$ROOT/packages/cli/dist/bundle/bajin.cjs"
PACKAGED_CJS="$ROOT/apps/desktop/release/linux-unpacked/resources/bajin/bajin.cjs"
LOG_LINES=10
FAST=0

for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1 ;;
    --log)  : ;; # 值在下一轮循环取
    *)      [[ "${PREV:-}" == "--log" ]] && LOG_LINES="$arg" ;;
  esac
  PREV="$arg"
done

step() { printf '\n\033[1;36m━━ %s ━━\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*"; }
note() { printf '\033[2m  %s\033[0m\n' "$*"; }

START_TS=$(date +%s)
cd "$ROOT"

# ── 0. 夜间成果速览（GAP-TRACKER 运行日志尾部） ─────────────────────────
step "夜间运行成果（GAP-TRACKER 运行日志最近 $LOG_LINES 条）"
if [[ -f GAP-TRACKER.md ]]; then
  awk '/^## 运行日志/{flag=1; next} flag && /^\|/' GAP-TRACKER.md | tail -n "$LOG_LINES" \
    | awk -F'|' '{ gsub(/^ +| +$/, "", $2); gsub(/^ +| +$/, "", $3); if ($2 != "" && $2 != "时间" && $2 != "---") printf "  %s │ %s\n", $2, substr($3, 1, 90) }'
  note "完整账本: $ROOT/GAP-TRACKER.md"
else
  note "未找到 GAP-TRACKER.md"
fi

# ── 1. 构建 ─────────────────────────────────────────────────────────────
step "构建（pnpm -r build）"
pnpm -r build > /tmp/bajin-build.log 2>&1 || { fail "构建失败"; tail -30 /tmp/bajin-build.log; exit 1; }
ok "全部 workspace 构建通过"

# ── 2. 测试 ─────────────────────────────────────────────────────────────
step "测试（pnpm -r test）"
if pnpm -r test > /tmp/bajin-test.log 2>&1; then
  TEST_STATUS=0
else
  TEST_STATUS=1
fi
grep -E "Tests  " /tmp/bajin-test.log | sed 's/^/  /'
if [[ $TEST_STATUS -ne 0 ]]; then
  fail "测试未全绿，终止打包（产物不可信）"
  grep -E "FAIL|failed" /tmp/bajin-test.log | head -10 | sed 's/^/  /'
  exit 1
fi
TOTALS=$(grep -E "Tests  " /tmp/bajin-test.log | grep -oE "[0-9]+ passed \([0-9]+\)" | grep -oE "^[0-9]+" | paste -sd+ | bc)
ok "共 $TOTALS 项测试全部通过"

# ── 3. CLI 单文件 bundle ────────────────────────────────────────────────
step "CLI 单文件 bundle（bajin.cjs）"
pnpm --filter @bajin/cli bundle > /dev/null 2>&1
BUNDLE_KB=$(du -k "$BUNDLED_CJS" | cut -f1)
ok "bundle 生成：${BUNDLE_KB} KB（完成标准 < 1024 KB）"

# ── 4. AppImage ─────────────────────────────────────────────────────────
if [[ $FAST -eq 1 ]]; then
  step "跳过 AppImage（--fast）"
else
  step "打包 AppImage（electron-builder）"
  ( cd apps/desktop && \
    ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
    ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
    pnpm exec electron-builder --linux AppImage > /tmp/bajin-appimage.log 2>&1 ) \
    || { fail "AppImage 打包失败"; tail -20 /tmp/bajin-appimage.log; exit 1; }
  APPIMAGE_MB=$(( $(stat -c%s "$APPIMAGE_OUT") / 1024 / 1024 ))
  ok "AppImage 生成：${APPIMAGE_MB} MB"
fi

# ── 5. 打包态冒烟（走真实打包产物 bajin.cjs 的 app-server RPC） ──────────
step "打包态冒烟（app-server RPC）"
SMOKE_TARGET="$BUNDLED_CJS"
[[ $FAST -eq 0 && -f "$PACKAGED_CJS" ]] && SMOKE_TARGET="$PACKAGED_CJS" && note "目标: 打包内 bajin.cjs" || note "目标: packages/cli bundle"
SMOKE_RESULT=$(mktemp)
node - "$SMOKE_TARGET" << 'NODE' | tee "$SMOKE_RESULT"
const [, , cjs] = process.argv;
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, [cjs, 'app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const send = (id, method, params) => child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
const checks = [];
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.id === 1 && m.result) { checks.push(['initialize', !!m.result.sessionId]); send(2, 'models/list'); }
    if (m.id === 2 && m.result) { checks.push(['models/list', Array.isArray(m.result.models) && m.result.models.length > 0]); send(3, 'commands/list'); }
    if (m.id === 3 && m.result) { checks.push(['commands/list', Array.isArray(m.result.commands)]); send(4, 'usage/stats'); }
    if (m.id === 4 && m.result) {
      checks.push(['usage/stats', typeof m.result.totalTokens === 'number']);
      send(5, 'shutdown');
      setTimeout(() => {
        const bad = checks.filter(([, v]) => !v);
        for (const [name, v] of checks) console.log(`  ${v ? '✓' : '✗'} ${name}`);
        if (bad.length) { console.log('SMOKE_FAIL'); process.exit(1); }
        console.log('SMOKE_OK');
        process.exit(0);
      }, 300);
    }
  }
});
send(1, 'initialize', { cwd: '/tmp', mock: true });
setTimeout(() => { console.log('  ✗ 冒烟超时'); process.exit(1); }, 20000);
NODE
grep -q SMOKE_OK "$SMOKE_RESULT" && ok "打包态 RPC 冒烟通过（initialize/models/commands/usage）" || { fail "冒烟未通过"; rm -f "$SMOKE_RESULT"; exit 1; }
rm -f "$SMOKE_RESULT"

# ── 6. 汇总 ─────────────────────────────────────────────────────────────
ELAPSED=$(( $(date +%s) - START_TS ))
step "完成（耗时 ${ELAPSED}s）"
echo "  测试    ：$TOTALS/全部通过"
echo "  CLI     ：$BUNDLED_CJS（${BUNDLE_KB} KB）"
if [[ $FAST -eq 0 ]]; then
  echo "  AppImage：$APPIMAGE_OUT（${APPIMAGE_MB} MB）"
  echo ""
  echo "  直接运行检查："
  echo "    $APPIMAGE_OUT"
else
  echo "  （--fast 模式未打 AppImage）"
fi
