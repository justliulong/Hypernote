@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 某些环境（VS Code / Electron 系工具链）会注入 ELECTRON_RUN_AS_NODE=1，
rem 它会让 electron 退化成纯 Node 进程 —— 没有窗口，也没有 require('electron')。
set ELECTRON_RUN_AS_NODE=
set ELECTRON_NO_ATTACH_CONSOLE=

echo 正在启动 Hypernote...

if exist "node_modules\electron\dist\electron.exe" (
    "node_modules\electron\dist\electron.exe" . %*
    goto :done
)

where npx >nul 2>nul
if %errorlevel%==0 (
    npx --no-install electron . %*
    goto :done
)

echo 错误：找不到 electron。
echo   · 在项目里执行 npm install，或
echo   · 全局安装：npm install -g electron
pause

:done
