# 发布到 AUR

这里放的是 AUR 包 `hypernote-bin` 的 `PKGBUILD`。**源码副本放在主仓库里是为了让改动
能和代码一起被 review**，但 AUR 要求每个包是独立的 git 仓库，所以还要额外推一份。

## 为什么是 `-bin` 而不是源码包

这是 Electron 应用。源码构建意味着在打包时跑 `npm install` + `electron-builder`：
要下载几百 MB 的 electron 二进制和构建工具，还得联网，编译时间长且脆弱。

AUR 里同类包都是这个路子 —— 你机器上就装着 `visual-studio-code-bin` 和
`microsoft-edge-stable-bin`。

它复用 electron-builder 已打好的 **deb**（而不是 AppImage）：deb 的文件布局本来就是
对的（`/opt/Hypernote/` + `.desktop` + hicolor 图标），搬过来就行。

## 首次发布

1. **先确认 GitHub Release 存在。** `PKGBUILD` 的 `source` 指向
   `releases/download/v1.0.0/Hypernote-1.0.0-amd64.deb`，Release 没上传之前构建必然失败。

2. **确认 `Maintainer:` 那行是你的名字和邮箱。** 现在填的是
   `justliulong <justliulong@users.noreply.github.com>` —— AUR 要求这一行是真实的
   维护者身份且会公开展示，想换成别的邮箱就改掉。

3. **重算校验和**。你如果重新打过包（比如改了 `package.json` 里的占位信息），
   deb 的哈希会变：

   ```bash
   cd packaging/aur
   updpkgsums                      # 自动更新 PKGBUILD 里的 sha256sums
   makepkg --printsrcinfo > .SRCINFO
   ```

4. **本地验证一遍**再推：

   ```bash
   makepkg -f                      # 构建
   namcap hypernote-bin-*.pkg.tar.zst
   makepkg -si                     # 装到系统上试（要 sudo）
   ```

   `namcap` 会报一条 `E: ELF files outside of a valid path ('opt/')` —— **这是误报**，
   `/opt` 正是第三方自包含应用的 FHS 正确位置，所有 `-bin` 类 Electron 包都会报。
   其余警告（`unstripped`、`Unused shared library libpthread/libdl`）也是预期内的。

5. **推到 AUR**：

   ```bash
   git clone ssh://aur@aur.archlinux.org/hypernote-bin.git
   cd hypernote-bin
   cp /path/to/主仓库/packaging/aur/{PKGBUILD,.SRCINFO,LICENSE} .
   git add PKGBUILD .SRCINFO LICENSE
   git commit -m "Initial import: hypernote-bin 1.0.0"
   git push
   ```

   AUR 上必须先有账号并把 SSH 公钥传上去。`.SRCINFO` 必须和 `PKGBUILD` 同步，
   AUR 会拒绝不一致的推送。

## 发新版本

```bash
cd packaging/aur
# 1. 改 PKGBUILD 里的 pkgver，pkgrel 重置为 1
# 2. 重新计算校验和
updpkgsums
# 3. 同步 .SRCINFO
makepkg --printsrcinfo > .SRCINFO
# 4. 构建验证
makepkg -f
# 5. 推到 AUR 仓库
```

## 用户怎么装

```bash
yay -S hypernote-bin      # 或 paru -S hypernote-bin
```

`provides=('hypernote')` 是为了将来万一有源码包，两者能互相满足依赖；
`conflicts=('hypernote')` 防止同时装两个。

## 已知的取舍

- **`chrome-sandbox` 保持 755，没设 setuid。** Chromium 优先走非特权 user namespace，
  Arch 默认开启，所以能用。如果你的系统关掉了 user namespace
  （`sysctl kernel.unprivileged_userns_clone=0`），启动会报沙箱错误，那时要么开启它，
  要么把 `chrome-sandbox` 改成 4755（代价是引入一个 setuid root 二进制）。
  上游的 deb 也是 755，这里保持一致。

- **装完约 377 MB。** Electron 应用的正常体积，`!strip` 之后更大 —— 剥符号会破坏二进制。
