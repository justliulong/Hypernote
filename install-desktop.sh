#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════
#  把 Hypernote 装进应用菜单（不需要打包）
#
#  这不是安装程序 —— 只是在应用菜单里放一个快捷方式，
#  指向你当前的 start.sh。项目目录可以随便移动，
#  搬走之后重新跑一次这个脚本即可。
#
#  卸载：./install-desktop.sh --uninstall
# ═══════════════════════════════════════════════════════
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
APP_ID="app.hypernote"
ICON_NAME="hypernote"          # 必须与 .desktop 里的 Icon= 一致
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"
DESKTOP_FILE="$DESKTOP_DIR/$APP_ID.desktop"
ICON_FILE="$ICON_DIR/$ICON_NAME.svg"

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$DESKTOP_FILE" "$ICON_FILE"
  update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
  gtk-update-icon-cache -f -t "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor" 2>/dev/null || true
  echo "已从应用菜单移除。"
  exit 0
fi

if [ ! -x "$ROOT/start.sh" ]; then
  chmod +x "$ROOT/start.sh"
fi

mkdir -p "$DESKTOP_DIR" "$ICON_DIR"
install -m 644 "$ROOT/build/icon.svg" "$ICON_FILE"

# %U 让「用 Hypernote 打开」在文件管理器里也能用（对应 package.json 里的文件关联）
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Hypernote
Comment=Notes in HTML with live preview
Exec=$ROOT/start.sh %U
Icon=hypernote
Terminal=false
Categories=Utility;TextEditor;
Keywords=notes;html;markdown;editor;笔记;
MimeType=text/html;
StartupNotify=true
StartupWMClass=Hypernote
EOF

update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
gtk-update-icon-cache -f -t "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor" 2>/dev/null || true

echo "已装进应用菜单："
echo "  $DESKTOP_FILE"
echo "  $ICON_FILE"
echo
echo "现在可以在应用菜单里搜「Hypernote」，或者："
echo "  gtk-launch $APP_ID"
echo
echo "卸载：$0 --uninstall"
