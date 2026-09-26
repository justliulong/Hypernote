#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════
#  Hypernote — Linux 启动脚本
# ═══════════════════════════════════════════════════════
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

# 关键：某些环境（VS Code / Electron 系工具链）会注入 ELECTRON_RUN_AS_NODE=1，
# 它会让 electron 退化成纯 Node 进程 —— 没有窗口、也没有 require('electron')。
# 必须在启动前清掉。
unset ELECTRON_RUN_AS_NODE
unset ELECTRON_NO_ATTACH_CONSOLE

# 找 electron：优先项目内 node_modules，其次系统安装的 electronXX
find_electron() {
  if [ -x "node_modules/electron/dist/electron" ]; then
    echo "node_modules/electron/dist/electron"; return 0
  fi
  if command -v electron >/dev/null 2>&1; then
    echo "electron"; return 0
  fi
  # 系统按版本号命名的 electronXX，取版本最高的
  local candidate
  candidate=$(ls -1 /usr/bin/electron[0-9]* 2>/dev/null | sort -V | tail -1 || true)
  if [ -n "$candidate" ]; then
    echo "$candidate"; return 0
  fi
  return 1
}

ELECTRON_BIN=$(find_electron) || {
  echo "错误：找不到 electron。" >&2
  echo "  · 安装：sudo pacman -S electron" >&2
  echo "  · 或在项目里跑 npm install" >&2
  exit 1
}

echo "使用 electron: $ELECTRON_BIN ($("$ELECTRON_BIN" --version 2>/dev/null || echo '?'))"
exec "$ELECTRON_BIN" . "$@"
