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

# 下载 URL
VERSION="0.1.0"
URL="https://github.com/fumolan/bajin/releases/latest/download/bajin-${VERSION}-linux-${ARCH}.AppImage"
TARGET="$INSTALL_DIR/bajin"

echo "下载 bajin ${VERSION} (${ARCH})..."
if command -v curl &>/dev/null; then
  curl -fSL "$URL" -o "$TARGET"
elif command -v wget &>/dev/null; then
  wget -q "$URL" -O "$TARGET"
else
  echo -e "${RED}需要 curl 或 wget${NC}"; exit 1
fi

chmod +x "$TARGET"
echo -e "${GREEN}✓ 已安装到 $TARGET${NC}"

# 桌面快捷方式
DESKTOP_DIR="$HOME/.local/share/applications"
mkdir -p "$DESKTOP_DIR"
cat > "$DESKTOP_DIR/bajin.desktop" << DESKTOP
[Desktop Entry]
Name=bajin
Comment=净室复刻的编码代理
Exec=$TARGET
Type=Application
Categories=Development;
DESKTOP

echo -e "${GREEN}✓ 桌面快捷方式已创建${NC}"
echo ""
echo -e "运行: ${BOLD}bajin${NC}（或从应用菜单启动）"
echo -e "Web 模式: ${BOLD}bajin server${NC} 然后打开 http://localhost:4444"
