#!/usr/bin/env bash
# bajin 一键打包脚本：构建 → 测试 → CLI bundle → 安装包 → 打包态冒烟
# 平台自适应：Linux 打 AppImage；Windows（Git Bash）打 NSIS 安装包 exe
# 用法：
#   ./scripts/package.sh              # 全流程（含安装包）
#   ./scripts/package.sh --fast       # 跳过安装包（只构建+测试+bundle+冒烟）
#   ./scripts/package.sh --log 20     # 开头多显示 GAP-TRACKER 最近 20 行运行日志（默认 10）
set -euo pipefail
# 输出禁用 ANSI 颜色：日志解析在 Git Bash / Rocky Linux 下行为一致（vitest/pnpm 对管道仍可能带色，解析处另做去色兜底）
export NO_COLOR=1 FORCE_COLOR=0

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 版本号直接从 apps/desktop/package.json 提取（不走 node：Git Bash 的 /e/… 路径 node.exe 解析不了）
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/apps/desktop/package.json" | head -1)"
# 平台检测：Linux → AppImage；MINGW/MSYS（Git Bash）→ NSIS exe
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) PLATFORM="win" ;;
  Darwin*)              PLATFORM="mac" ;;
  *)                    PLATFORM="linux" ;;
esac
case "$PLATFORM" in
  win)   INSTALLER_OUT="$ROOT/apps/desktop/release/bajin-${VERSION}-win-x64.exe"
         PACKAGED_CJS="$ROOT/apps/desktop/release/win-unpacked/resources/bajin/bajin.cjs" ;;
  *)     INSTALLER_OUT="$ROOT/apps/desktop/release/bajin-${VERSION}-linux-x64.AppImage"
         PACKAGED_CJS="$ROOT/apps/desktop/release/linux-unpacked/resources/bajin/bajin.cjs" ;;
esac
BUNDLED_CJS="$ROOT/packages/cli/dist/bundle/bajin.cjs"
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

# ── 1.5 类型检查 ────────────────────────────────────────────────────────
# 堵半成品提交的门：desktop 走 esbuild（只剥类型不检查）且无测试，曾因此漏进未声明引用等错误
step "类型检查（pnpm -r typecheck）"
pnpm -r typecheck > /tmp/bajin-typecheck.log 2>&1 || { fail "类型检查未过，终止打包"; tail -20 /tmp/bajin-typecheck.log; exit 1; }
ok "全部 workspace 类型检查通过"

# ── 2. 测试 ─────────────────────────────────────────────────────────────
step "测试（pnpm -r test）"
if pnpm -r test > /tmp/bajin-test.log 2>&1; then
  TEST_STATUS=0
else
  TEST_STATUS=1
fi
# 统计 passed 总数：awk 先去 ANSI 色码再累计（Rocky 最小安装无 bc；grep 直接匹配带色日志会失配，
# 失配退出码 1 在 set -e 下会静默杀掉脚本——此前 Windows 上"无声失败"的根因）
TOTALS=$(awk '{ s2=$0; gsub(/\x1b\[[0-9;]*m/, "", s2); while (match(s2, /[0-9]+ passed/)) { v=substr(s2, RSTART, RLENGTH); sub(/ passed/, "", v); s+=v; s2=substr(s2, RSTART+RLENGTH) } } END { print s+0 }' /tmp/bajin-test.log)
note "通过用例：$TOTALS"
if [[ $TEST_STATUS -ne 0 ]]; then
  fail "测试未全绿，终止打包（产物不可信）"
  sed 's/\x1b\[[0-9;]*m//g' /tmp/bajin-test.log | grep -E "FAIL|failed" | head -10 | sed 's/^/  /' || true
  exit 1
fi
ok "共 $TOTALS 项测试全部通过"

# ── 3. CLI 单文件 bundle ────────────────────────────────────────────────
step "CLI 单文件 bundle（bajin.cjs）"
pnpm --filter @bajin/cli bundle > /dev/null 2>&1
BUNDLE_KB=$(du -k "$BUNDLED_CJS" | cut -f1)
ok "bundle 生成：${BUNDLE_KB} KB（完成标准 < 1024 KB）"

# ── 4. 安装包 ───────────────────────────────────────────────────────────
if [[ $FAST -eq 1 ]]; then
  step "跳过安装包（--fast）"
else
  if [[ "$PLATFORM" == "win" ]]; then
    step "打包 Windows 安装包（electron-builder NSIS exe）"
    eb_win() { ( cd apps/desktop && \
      ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
      ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
      pnpm exec electron-builder --win nsis > /tmp/bajin-installer.log 2>&1 ); }
    # winCodeSign 工具包内的 darwin 软链（libcrypto.dylib 等）在无管理员/开发者模式权限时解不开，
    # 但对 win 打包无用。app-builder 解压成功后内容落在正式缓存名 winCodeSign-2.6.0（命中即跳过下载解压）；
    # 这里直接把 electron-builder 失败重试留下的 .7z 下载产物解到正式名（忽略 2 个软链错误），让重试必过。
    preextract_wincodesign() {
      local SEVENZ fz final
      SEVENZ="$(find "$ROOT/node_modules/.pnpm" -maxdepth 7 -path '*7zip-bin/win/x64/7za.exe' 2>/dev/null | head -1 || true)"
      local CSDIR="${LOCALAPPDATA:-}/electron-builder/Cache/winCodeSign"
      final="$CSDIR/winCodeSign-2.6.0"
      [[ -n "$SEVENZ" && -d "$CSDIR" && ! -f "$final/rcedit-x64.exe" ]] || return 0
      fz="$(ls -t "$CSDIR"/*.7z 2>/dev/null | head -1 || true)"
      [[ -n "$fz" ]] || return 0
      note "构建 winCodeSign 正式缓存（忽略 darwin 软链错误）：$(basename "$fz") → winCodeSign-2.6.0"
      "$SEVENZ" x -y -bd "$fz" "-o$final" > /dev/null 2>&1 || true
    }
    # 预清空 win-unpacked：electron-builder 重建前要删它，被占用时（IDE 索引/杀软/残留 bajin.exe）会在深处报
    # "The process cannot access the file"——这里先删，失败即给出可读原因，不在构建栈里翻错误
    if [[ -d apps/desktop/release/win-unpacked ]] && ! rm -rf apps/desktop/release/win-unpacked 2>/dev/null; then
      fail "release/win-unpacked 被占用，无法清空"
      note "常见占用者：上次打包后仍开着的 bajin.exe、IDE 对构建产物的文件索引/预览（如 ZCode/WebStorm）、杀软扫描"
      note "处理：关掉相关预览/进程后重跑；或临时换输出目录：electron-builder --win --config.directories.output=release-fresh"
      exit 1
    fi
    preextract_wincodesign
    if ! eb_win; then
      # 首次运行时 electron-builder 在构建中才下载所需版本工具包，预解压新包后重试一次
      preextract_wincodesign
      eb_win || { fail "NSIS 打包失败"; tail -20 /tmp/bajin-installer.log; exit 1; }
    fi
    OUT_MB=$(( $(stat -c%s "$INSTALLER_OUT") / 1024 / 1024 ))
    ok "安装包生成：${OUT_MB} MB"
  else
    step "打包 AppImage（electron-builder）"
    ( cd apps/desktop && \
      ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
      ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
      pnpm exec electron-builder --linux AppImage > /tmp/bajin-installer.log 2>&1 ) \
      || { fail "AppImage 打包失败"; tail -20 /tmp/bajin-installer.log; exit 1; }
    OUT_MB=$(( $(stat -c%s "$INSTALLER_OUT") / 1024 / 1024 ))
    ok "AppImage 生成：${OUT_MB} MB"
  fi
fi

# ── 5. 打包态冒烟（走真实打包产物 bajin.cjs 的 app-server RPC） ──────────
step "打包态冒烟（app-server RPC）"
SMOKE_TARGET="$BUNDLED_CJS"
[[ $FAST -eq 0 && -f "$PACKAGED_CJS" ]] && SMOKE_TARGET="$PACKAGED_CJS" && note "目标: 打包内 bajin.cjs" || note "目标: packages/cli bundle"
# Git Bash 下把 /e/… 转成 node.exe 可解析的 E:/… 混合路径（MSYS 对 `-` 后的参数不自动转换）
if [[ "$PLATFORM" == "win" ]] && command -v cygpath >/dev/null 2>&1; then
  SMOKE_TARGET="$(cygpath -m "$SMOKE_TARGET")"
fi
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
send(1, 'initialize', { cwd: require('node:os').tmpdir(), mock: true });
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
  echo "  安装包  ：$INSTALLER_OUT（${OUT_MB} MB）"
  echo ""
  echo "  直接运行检查："
  echo "    $INSTALLER_OUT"
else
  echo "  （--fast 模式未打安装包）"
fi
