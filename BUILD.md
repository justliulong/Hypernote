# 打包

给维护者看的。普通用户请直接看 [README](README.md) 的安装章节。

## 准备

需要 Node.js 18+ 和 npm：

```bash
sudo pacman -S nodejs npm     # Arch
sudo apt install nodejs npm   # Debian / Ubuntu
```

然后装依赖：

```bash
npm install
```

### 两个 npm 12 的坑

**1. 安装脚本默认被拦截。** npm 12 起出于安全考虑不再自动执行依赖的安装脚本，
而 electron 正是靠 `postinstall` 下载它的二进制。放行：

```bash
npm install-scripts approve electron
npm install-scripts approve electron-winstaller
```

**2. `.npmrc` 里的自定义键不再被传给子进程。** npm 12 会警告
`Unknown project config "electron_mirror"` —— 意思是 electron 的下载脚本读不到镜像地址了。
改在命令行显式传环境变量（下面的构建命令都带了）。

### 验证 electron 二进制到位

```bash
./node_modules/electron/dist/electron --version    # 应输出 v39.x.x
```

如果没有 `dist/`，说明 `postinstall` 没跑成功。手动补一次：

```bash
cd node_modules/electron
node install.js                    # 正常情况会自己下载
cd ../..
```

要是它静默失败（`dist/` 只解出个别文件），可以直接从缓存解压：

```bash
cd node_modules/electron
ZIP=$(find ~/.cache/electron -name 'electron-v*-linux-x64.zip' | head -1)
rm -rf dist && mkdir dist && unzip -q "$ZIP" -d dist
printf 'v39.8.10' > dist/version      # 版本号与 package.json 里声明的一致
printf 'electron'  > path.txt
cd ../..
```

---

## 构建 Linux 安装包

```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"

npm run build:linux          # 全部三种
npm run build:linux:appimage # 只出 AppImage
npm run build:linux:deb      # 只出 deb
npm run build:linux:pacman   # 只出 pacman
```

产物在 `dist/`：

| 文件 | 说明 |
|------|------|
| `Hypernote-1.0.0-x86_64.AppImage` | 免安装，`chmod +x` 后直接运行 |
| `Hypernote-1.0.0-amd64.deb` | `sudo dpkg -i` |
| `Hypernote-1.0.0-x86_64.pkg.tar.zst` | `sudo pacman -U` |

同时会生成 `dist/linux-unpacked/`，那是未压缩的目录版，**排查问题先跑它**：

```bash
dist/linux-unpacked/hypernote
```

### 只想快速验证改动

不想每次都等几分钟打包，可以直接跑未打包的目录版（`npm run pack` 生成），
或者干脆用源码跑 `./start.sh`。

---

## 构建 Windows / macOS 安装包

```bash
npm run build:win            # NSIS 安装包
npm run build:mac            # dmg
```

**在 Linux 上打 Windows 包需要额外装 wine**，而且容易出各种问题：

```bash
sudo pacman -S wine
```

更省事的做法是**在真正的 Windows 上打包**，或者用 CI（见下）。macOS 的 dmg
必须在 macOS 上打，没有别的办法。

---

## 用 GitHub Actions 自动构建

如果不想在自己机器上折腾跨平台打包，可以让 CI 在对应系统的 runner 上原生构建 —— 
Windows 包就在真实的 Windows 上打出来，不需要 wine。

思路：在 `.github/workflows/release.yml` 里配一个 matrix（`ubuntu-latest` +
`windows-latest`），各自跑 `npm ci && npm run build:<platform>`，然后把 `dist/` 里的
安装包上传到 Release。打 tag 时触发。

> 这个工作流我还没有实际跑过（本地只验证了 Linux 构建），所以先不写死一份配置在这里。
> 需要的话我可以补上。

---

## 仓库地址 / 作者信息在哪里

`package.json` 里这几处决定了 deb/rpm 的元数据和软件中心里显示的链接，换仓库或换
维护者时要一起改（`build.appId` 如果和别人的应用冲突也可以改）：

| 字段 | 当前值 |
|------|--------|
| `homepage` | `https://github.com/justliulong/Hypernote` |
| `repository.url` | `https://github.com/justliulong/Hypernote.git` |
| `bugs.url` | `https://github.com/justliulong/Hypernote/issues` |
| `author` | `justliulong <justliulong@users.noreply.github.com>` |
| `build.appId` | `app.hypernote` |

**`homepage` 是打包硬性要求** —— 不填 deb/rpm 会直接报
`Please specify project homepage` 然后中断。

`author` 会被 deb 写进 `Maintainer:` 字段，必须是 `名字 <邮箱>` 格式。
现在用的是 GitHub 的 noreply 地址（不会泄露真实邮箱）。

> 改了这些之后 deb 的哈希会变，AUR 包的校验和要跟着更新：
> `cd packaging/aur && updpkgsums && makepkg --printsrcinfo > .SRCINFO`

---

## 打包配置说明

配置都在 `package.json` 的 `build` 字段里，几个容易踩的点：

- **`build.pacman.depends` 必须显式声明，别删。** electron-builder 自动给 pacman
  目标生成的依赖列表是**错的** —— 那是 Electron 自己的构建期依赖
  （`c-ares`、`ffmpeg`、`http-parser`、`re2`、`snappy`、`libappindicator-gtk3` 等），
  其中 **`http-parser` 和 `libappindicator-gtk3` 只存在于 AUR**。结果就是用户跑
  `sudo pacman -U` 会因为依赖不满足直接失败：

  ```
  error: 无法准备事务处理 (无法满足依赖)
  :: hypernote: 要求 http-parser
  ```

  现在配置里那份列表是从二进制的 `DT_NEEDED` 加上运行时才加载的库（`libxss`、
  `libxtst`、`libnotify`、`xdg-utils` 等）推导出来的，并逐项确认过都在官方仓库里。

  改完记得**实际装一次**验证：`sudo pacman -U dist/Hypernote-*.pacman`。

- **`build.files`** 只收 `node_modules/monaco-editor/min/**/*`。Monaco 整个包很大
  （含 `dev/`、`esm/` 等用不到的目录），只打 `min/` 能省不少体积。如果你新增了前端依赖，
  记得同步这个白名单，否则打包出来的应用会缺文件。
- **`asarUnpack`** 里的 monaco 是必须的 —— Monaco 的 worker 要用 `file://` 路径加载，
  不能待在 asar 归档里。
- **`linux.category`** 用 `Utility;TextEditor;`。electron-builder 26 起
  `linux.desktop` 的对象写法（`Name` / `Comment` / `Categories`）**已废弃** ——
  那个字段现在只接受函数，得写在 JS 配置里。所以桌面项的名称、描述由
  `productName` / `linux.description` / `linux.synopsis` 自动推导。
- **`executableName: hypernote`** 决定可执行文件名和 `.desktop` 里的 `Exec`。

---

## 打包后的自检

```bash
# 1) 目录版能跑
dist/linux-unpacked/hypernote

# 2) AppImage 能跑（无 FUSE 时加 --appimage-extract-and-run）
./dist/Hypernote-1.0.0-x86_64.AppImage

# 3) 装完之后 .desktop 合法
desktop-file-validate /usr/share/applications/app.hypernote.desktop

# 4) 打开一篇带图表的笔记，确认预览正常
```

第 4 条最重要 —— 前三条只能说明程序启动了，预览才是这个应用的核心功能。
