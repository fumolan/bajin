#!/usr/bin/env bash
# bajin 一键安装脚本
set -euo pipefail

BOLD='\033[1m'; GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
echo -e "${BOLD}bajin installer${NC}"

# 检测系统
OS="$(uname -s)"
ARCH="$(uname -m)"
if [ "$OS" != "Linux" ]; then
  echo -e "${RED}仅支持 Linux（当前: $OS）${NC}"
  exit 1
fi
case "$ARCH" in
  x86_64) ARCH="x86_64" ;;
  aarch64) ARCH="aarch64" ;;
  *) echo -e "${RED}不支持的架构: $ARCH${NC}"; exit 1 ;;
esac

# 安装目录
INSTALL_DIR="$HOME/.local/bin"
mkdir -p "$INSTALL_DIR"

# 源码安装（网页端）：clone + pnpm 构建，bajin server 起服使用
echo "安装方式已转型：bajin 现为纯网页端（无 AppImage）。"
echo "请执行："
echo "  git clone https://github.com/fumolan/bajin && cd bajin"
echo "  pnpm install && pnpm build"
echo "  node packages/cli/dist/main.js server --port 4444"
