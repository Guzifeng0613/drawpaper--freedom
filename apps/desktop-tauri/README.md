# drawpaper · Windows 桌面壳（Tauri 2）

本目录是 drawpaper 的 Windows 桌面外壳。**前端完全复用 `packages/web`**（同一个 Vite
应用、同一套 React store），这里只放 Rust 壳：原生菜单、文件对话框、`.kbnote` 双击关联、
窗口状态、日志、原生通知、手动更新器、诊断导出、便携模式，以及打包配置。

> 选型依据：规划文档 §12 — Tauri 2（MIT/Apache-2.0）+ WebView2，安装包 ~5MB 量级
> （NSIS 基线 x64 ≈ 4.6MB，实测见 `../../docs/wave15/webview2-offline.md`），原生菜单 / 系统打印 /
> 真实文件系统完整。不选 Electron（体积大）。

## 目录结构

```
apps/desktop-tauri/
├─ package.json             # 独立 package.json，故意不进根 pnpm workspace
├─ .gitignore               # node_modules/、dist/、src-tauri/target/、src-tauri/gen/
├─ README.md                 # 本文件
├─ ci/
│  └─ smoke-portable.ps1    # 便携模式手动冒烟（独立运行，未接入 CI workflow）
└─ src-tauri/
   ├─ Cargo.toml            # Rust 依赖（tauri 2.1 + dialog/fs/opener/single-instance/
   │                         #   notification/window-state/log/updater/zip）
   ├─ build.rs
   ├─ tauri.conf.json        # productName/identifier/windows/bundle/nsis/wix/
   │                         #   fileAssociations/plugins.updater
   ├─ capabilities/
   │  └─ default.json       # 最小权限：core/dialog/opener/menu/event/notification/log/updater
   │                        #   （不授权 fs 插件：前端零 plugin-fs 引用，文件 IO 全走自定义 Rust invoke）
   ├─ icons/                 # 已提交的完整图标集（icon.ico / Square*.png / installer-*.bmp）
   └─ src/
      ├─ main.rs             # 薄入口，调 lib::run()
      ├─ lib.rs              # 菜单、commands、文件关联、单实例、手动更新器、关闭守卫
      ├─ portable.rs         # 便携模式判定（纯函数 + exe 旁 data/ 重定向）
      └─ diagnostics.rs     # 诊断 zip 导出（system.json / 日志尾 / 清单 / README）
```

## 前置依赖（Windows 10/11，x64 或 ARM64）

| 组件 | 版本 | 说明 |
|---|---|---|
| Rust 工具链 | stable ≥ 1.77 | `winget install Rustlang.Rustup`；x64 默认 `stable-x86_64-pc-windows-msvc`，ARM64 加 `rustup target add aarch64-pc-windows-msvc` |
| Visual Studio Build Tools | 2022 | 安装「使用 C++ 的桌面开发」工作包（MSVC + Windows SDK） |
| Node.js | ≥ 20（CI 锁定 22） | 与根仓库 `engines.node` 一致；`.github/workflows/*` 用 `actions/setup-node@v4` 装 Node 22 |
| pnpm | 11.7.0 | 根 `package.json` 的 `packageManager` 字段锁定；workflow 用 `pnpm/action-setup@v4` 装同一版本 |
| WebView2 Runtime | Evergreen | Win11 系统自带；Win10 首次安装时由 NSIS 引导联网下载（`downloadBootstrapper`，不内嵌） |

> 本项目目标平台是 Windows。Linux / macOS 仅作 Rust 纯函数（portable 判定、diagnostics 隐私）
> 的 `cargo test` 宿主，不产出桌面安装包。

## 包管理模型（务必先理解）

- 根 `pnpm-workspace.yaml` **只 glob `packages/*`**，所以 `apps/desktop-tauri` 在 pnpm workspace
  **之外**。根目录的 `pnpm -r` / `pnpm --filter` 不会触达本目录。
- 前端（`packages/web`、`packages/core`）在根 workspace 里装；Tauri CLI（`@tauri-apps/cli`）
  在本目录单独装，避免污染根 workspace。
- CI（`.github/workflows/release-windows.yml` 的「Install Tauri CLI」步骤）就是这么做的：
  根目录 `pnpm install --frozen-lockfile` 装前端，再 `cd apps/desktop-tauri && pnpm install
  --ignore-workspace` 装 CLI。

## 开发运行

```powershell
# 1. 仓库根：装前端依赖
cd <repo-root>
pnpm install

# 2. 本目录：单独装 Tauri CLI（不进根 workspace）
cd apps/desktop-tauri
pnpm install --ignore-workspace

# 3. 启动桌面壳（beforeDevCommand 会自动拉起 packages/web 的 vite）
pnpm dev
```

`pnpm dev` 即 `tauri dev`。它读 `src-tauri/tauri.conf.json`：

- `build.beforeDevCommand`: `pnpm --dir ../../packages/web dev`
- `build.devUrl`: `http://localhost:5173`
- `build.beforeBuildCommand`: `pnpm --dir ../../packages/web build`
- `build.frontendDist`: `../../../packages/web/dist`（相对 `src-tauri/` 三级回到仓库根）

只想先验证前端：根目录 `pnpm dev`（=`pnpm --filter @drawpaper/web dev`）开
`http://localhost:5173`。

## 出包（NSIS + WiX MSI，双架构）

```powershell
# 1. 仓库根：先把前端构建到 packages/web/dist（等价于 tauri.conf 的 beforeBuildCommand）
cd <repo-root>
pnpm -r build

# 2. 回到本目录出包（bundle.targets = ["nsis", "msi"]，一次打两个格式）
cd apps/desktop-tauri
pnpm build                 # = tauri build，同时出 NSIS + MSI（默认 x64）
pnpm build:nsis            # 只出 NSIS
pnpm build:msi             # 只出 MSI
```

产物在 `src-tauri/target/release/bundle/{nsis,msi}/`。

**Windows 双架构**（与 CI 矩阵一致）：

```powershell
# x64（默认，无需 --target）
pnpm build

# ARM64：先加 Rust target，再显式 --target
rustup target add aarch64-pc-windows-msvc
cd apps/desktop-tauri
./node_modules/.bin/tauri build --ci --bundles nsis,msi --target aarch64-pc-windows-msvc
```

> 注意 `--bundles` 接的是**逗号分隔、不带空格**的 `nsis,msi`（CI 用的就是这种写法）。
> 本目录的 npm script `build` / `build:nsis` / `build:msi` 已经把参数封好，日常直接用脚本即可。

## 安装包矩阵（6 个产物）

一次 `release-windows` 构建（x64 + arm64 矩阵）产出六个安装包（NSIS×2 + MSI×4：MSI 按
en-US / zh-CN 两种 UI culture 各出一份），publish job 把它们挂到同一个
GitHub Release，并生成 `SHA256SUMS.txt` 与（配好签名私钥后）`latest.json`。详见
`../../docs/wave15/msi-bundle.md` 与 `../../docs/wave18/msi-bilingual.md`。

| 架构 | NSIS（推荐，个人用户） | WiX MSI（企业批量部署） |
|---|---|---|
| x64 | `drawpaper_<ver>_x64-setup.exe` | `drawpaper_<ver>_x64_en-US.msi` + `drawpaper_<ver>_x64_zh-CN.msi` |
| arm64 | `drawpaper_<ver>_arm64-setup.exe` | `drawpaper_<ver>_arm64_en-US.msi` + `drawpaper_<ver>_arm64_zh-CN.msi` |

**NSIS**（`bundle.windows.nsis`）：

- `installMode: "both"`：向导默认「仅当前用户」（装 `%LOCALAPPDATA%\Programs\drawpaper`，不弹 UAC），
  高级选项可切「为所有用户」（弹 UAC，装 `%ProgramFiles%\drawpaper`）。
- `displayLanguageSelector: true` + `languages: [SimpChinese, English]`：安装向导带中 / 英语言选择。
- `headerImage` / `sidebarImage`：`icons/installer-header.bmp`、`icons/installer-sidebar.bmp` 品牌位图。
- 静默安装（CI 冒烟用）：`*-setup.exe /S /CURRENTUSER`（`both` 模式下显式 `/CURRENTUSER` 走
  免 UAC 的当前用户路径）。

**WiX MSI**（`bundle.windows.wix`）：

- 固定**按机器安装**到 `C:\Program Files\drawpaper`（`InstallScope=perMachine`，需要管理员）。
- 安装界面 culture 双语：`wix.language: ["en-US", "zh-CN"]` 时每个架构各出两个 MSI，
  文件名后缀分别带 `_en-US` / `_zh-CN`（WixUIExtension 内置 zh-CN 本地化，无需自定义
  fragment；两种 culture 同 ProductCode，同机二选一部署，不能并存）。详见
  `../../docs/wave18/msi-bilingual.md`。
- `wix.version: "0.1.0.10"` 是**数字版本号覆盖**：MSI `ProductVersion` 必须是
  `major.minor.patch.build` 纯数字，不接受 semver 的 `rc.` 段（`0.1.0-rc.10` → MSI `0.1.0.10`）；
  app 对外版本仍是 `0.1.0-rc.10`，改 rc 号时要同步把这里 build 段 +1。原因见
  `../../docs/wave15/msi-bundle.md` §3.0。
- 企业静默部署 / 卸载（按 UI culture 二选一）：
  ```powershell
  # en-US（英文向导）
  msiexec /i drawpaper_<ver>_x64_en-US.msi /qn /norestart /lv* install.log   # 部署（0 或 3010 都算成功）
  msiexec /x drawpaper_<ver>_x64_en-US.msi /qn /norestart                  # 卸载
  # zh-CN（中文向导）：同 ProductCode，同机与 en-US 包二选一
  msiexec /i drawpaper_<ver>_x64_zh-CN.msi /qn /norestart /lv* install.log
  msiexec /x drawpaper_<ver>_x64_zh-CN.msi /qn /norestart
  ```

**`SHA256SUMS.txt`**：publish job 对六个包（NSIS×2 + MSI×4）各算一行 `<sha256>  <basename>`，用户把六个安装包
和它放同一目录，`sha256sum -c SHA256SUMS.txt` 即可校验（Windows 下也可以用
`Get-FileHash` 逐个人比对）。

## CI 定位（三条 workflow）

| workflow | 触发 | 做什么 |
|---|---|---|
| `.github/workflows/release-windows.yml` | push tag `v*`；外加一个分支白名单（发版时的 `develop` 与各 `feat/*`/`chore/*` 功能分支）；以及 `workflow_dispatch` 手动 | x64/arm64 矩阵跑 `tauri build --ci --bundles nsis,msi`，跑 NSIS 7 步冒烟 + MSI 5 步冒烟 + 冷启动/欢迎文档/诊断隐私金丝雀；build job 只上传 artifact，**publish job 仅在 tag push 时**创建 GitHub Release（产 `SHA256SUMS.txt`、配好签名后产 `latest.json`） |
| `.github/workflows/web-ci.yml` | push 到 `develop` / `feat/**` / `fix/**`，以及向 `develop` 发 PR | Ubuntu 上 `pnpm -r build` / typecheck / lint / 单测 / Playwright e2e（含离线 PWA 回归） |
| `.github/workflows/android-debug.yml` | 仅 `workflow_dispatch` 手动 + push tag `v*` | 从 Capacitor 壳（`apps/mobile-capacitor`）出一个未签名 debug APK，仅供手动安装测试 |

> **本仓库的 `chore/**` 分支不在 `web-ci` 的 push 白名单里，也不在 `release-windows` 的分支
> 白名单里**——所以纯文档 chore 分支 push 后没有 CI run 是预期行为，不要去改白名单。
> 本地验证文档 claims 的方式就是逐条 grep / 读源码（本分支不改代码，跑 `pnpm -r build`
> 预期无影响）。
>
> 本地手动冒烟：NSIS `/S /CURRENTUSER`、MSI `msiexec /i ... /qn` 的用法见上表；便携模式
> 有独立脚本 `apps/desktop-tauri/ci/smoke-portable.ps1 -ExePath <drawpaper.exe>`（**手动跑，
> 未接入 CI**）。

## WebView2

- **现状**：`nsis.webviewInstallMode` 保持默认 `downloadBootstrapper`——安装包**不内置**运行时，
  Win10 首次安装时引导联网下载 Evergreen Runtime；Win11 系统自带，装完即跑。
- **首装 SmartScreen**：安装包**尚未做 Authenticode 代码签名**（§9 `../../docs/RELEASE.md`），首次在
  Win10/11 双击时 SmartScreen 会拦一道「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」
  即可。这是 RC 阶段未签名开源软件的常态，不是病毒。
- **离线 / 内网隔离机器**：当前安装包不内置运行时，需先在能上网的机器下载
  **WebView2 Evergreen Standalone Installer**（按机型选 x64 / x86 / ARM64），拷到内网先装好，
  再装 drawpaper。官方入口：<https://developer.microsoft.com/microsoft-edge/webview2/>
  （选 *Evergreen Standalone Installer*，不是 Bootstrapper）。
  - 为什么不内嵌：实测完整 Evergreen Standalone 运行时约 **202MB**（x86 实测），塞进安装包会让
    安装包从 ~4.6MB 暴涨到 ~200MB+，超出 180MB 预算；`embedBootstrapper` 只内嵌 ~1.7MB 引导
    stub、安装时仍要联网，不算真离线。完整取数与结论见 `../../docs/wave15/webview2-offline.md`
    （本文不重复内嵌那份数据表）。

## 原生菜单

菜单在 `src-tauri/src/lib.rs::build_menu` 中构建（窗口 accelerator 已绑定到原生菜单项）：

- **文件**：新建画布 / 打开…（Ctrl+O）/ 保存（Ctrl+S）/ 另存为…（Ctrl+Shift+S）/ 分隔 /
  **打开最近**（动态子菜单，随 recents 重建）+ **清空最近**
- **编辑**：撤销（Ctrl+Z）/ 重做（Ctrl+Shift+Z）/ 分隔 / 剪切 / 复制 / 粘贴 / 全选
  （原生剪贴板角色，WebView2 对聚焦的可编辑元素自动生效）
- **导出**：打印 / 另存为 PDF（Ctrl+P）/ 直接下载 PDF / 导出 PNG / 导出 SVG / 导出 Markdown
- **视图**：适应屏幕（Ctrl+0）/ 放大（Ctrl+=）/ 缩小（Ctrl+-）/ 分隔 / 深色模式 / 大纲面板 /
  搜索…（Ctrl+F）
- **同步**：同步设置…（emit 给前端打开同步设置对话框，同步通道见 `../../docs/sync.md`）
- **帮助**：关于 drawpaper（原生 About 框）/ **检查更新…（纯手动）** / **打开数据目录** /
  **导出诊断信息…** / 分隔 / 项目主页

菜单事件分两类：

- **绝大多数菜单项**：Rust 不直接做副作用，而是 `app.emit("app:menu", {id})` 推给前端，
  前端在 React 侧把 id 映射到 zustand action（undo/redo/fit/print-mode/export-* 等）。业务逻辑
  仍在 `packages/web`，Rust 只负责「菜单存在」和原生 accelerator。
- **帮助菜单三项是纯 Rust 动作**（不绕前端、零后台网络）：
  - `帮助 → 检查更新…`：见下文「更新器配置」。
  - `帮助 → 打开数据目录`：在资源管理器里 reveal 当前 `app_data_dir`。
  - `帮助 → 导出诊断信息…`：见下文「诊断导出」。

## `.kbnote` 双击关联与单实例

`tauri.conf.json` → `bundle.fileAssociations` 把 `.kbnote` 后缀注册给本应用（安装器写注册表：
当前用户模式写 `HKCU\Software\Classes\.kbnote`，整机模式写 `HKLM`）。启动时
`lib.rs::maybe_seed_startup_file` 读 `argv[1]`，若指向一个存在的 `.kbnote` 就校验、读入、
绑定 `current_path`、推入 recents 并 `emit("app:open-file", {path})`。

单实例插件（`tauri-plugin-single-instance`，在 Builder 里最先注册）保证：应用已在跑时第二次
双击 `.kbnote` 会把路径经 `second-instance` 事件转发给已运行窗口，而不是再起一个进程（CI
冒烟断言二次启动后 `drawpaper.exe` 进程数仍为 1）。

## HostAdapter 命令清单（前端 `packages/web/src/host/tauri-host.ts` 对应）

Rust 侧 `invoke_handler` 注册的命令（即 web `invoke()` 的 seam）：

| Tauri command | 语义 |
|---|---|
| `open_kbnote` | 原生打开对话框（过滤 `.kbnote`/`.json`）→ 返回 `{name, text, path}`，命中即推入 recents |
| `save_kbnote(filename, text, force_pick?)` | 已有绑定路径原地覆盖；`force_pick=true` 走「另存为」原生对话框 |
| `save_export(suggested_name, ext, bytes_base64)` | pdf/png/svg/md 四类导出统一走这里：原生保存对话框 + Rust base64 解码写盘；取消 resolve `{status:"cancelled"}` 不报错 |
| `print` | emit `app:menu{id:"export:print"}`，前端切打印态再 `window.print()` |
| `list_recents` / `clear_recents` | 最近文件列表（原生「打开最近」子菜单与前端文档列表共享同一来源） |
| `get_startup_file` | 启动时返回双击关联的 `.kbnote` 路径或 null |
| `choose_auto_save_dir` / `auto_save_doc` | 真实文件夹自动保存的骨架命令（已注册；文档同步通道另见 `../../docs/sync.md`） |
| `notify(title, body)` | 原生通知（Windows 操作中心，保存成功 / 失败 / 迁移提示） |
| `backup_doc(title, text)` | 在 `app_data_dir/backups/` 写时间戳备份 `<标题>_备份_<ts>.kbnote`，每次启动最多留 20 份、旧的最先删 |
| `set_window_title` / `bind_native_file` / `set_native_dirty` / `force_quit` | 动态标题、关闭守卫（绑定的 `.kbnote` 有未保存改动时拦截关闭并问前端）、跨进程退出的桥接 |

## 数据目录

Tauri 按 identifier `com.drawpaper.app` 决定目录名。Windows 上对应两类根，**实际落到
Roaming 还是 Local 取决于 Tauri 版本**（CI 冒烟对 `%APPDATA%` 与 `%LOCALAPPDATA%` 下
`com.drawpaper.app` 双根搜索，不要在文档里写死单根）：

| 用途 | 位置（安装版） |
|---|---|
| 配置 / 最近文件 / 自动保存元数据（`drawpaper-recents.json`、`drawpaper-autosave.json`、窗口状态） | `app_config_dir`（通常 `%APPDATA%\com.drawpaper.app\`） |
| 时间戳备份 `backups\*.kbnote` | `app_data_dir`（同根下 `backups\`） |
| 日志 `logs\drawpaper.log` | `app_log_dir`（同根下 `logs\`） |
| WebView2 网页用户数据（IndexedDB / EBWebView） | `app_local_data_dir`（通常 `%LOCALAPPDATA%\com.drawpaper.app\EBWebView`） |

**便携版**（见下文）：数据全部重定向到 `drawpaper.exe` 旁的 `data\`，与安装版互不干扰。

卸载会删程序本体目录，但保留上述用户数据（误装 / 重装不丢文档）；要彻底清干净再手动删
`com.drawpaper.app` 目录。最终用户视角的完整说明见 `../../docs/windows-user-guide.md` §2。

## 便携模式（U盘运行）

`src-tauri/src/portable.rs` 实现。在 `drawpaper.exe` 同目录满足**任一**触发条件（且为 Windows、
`data\` 可写）即进入便携模式：

1. 放一个空标记文件 `drawpaper.portable`（内容留空即可）；**或**
2. 预先建好一个 `data\` 目录。

进入后，Tauri 路径解析器整体被重定向到 `<exe_dir>\data`：最近文件、窗口状态、自动保存元数据、
`backups\`、`logs\drawpaper.log`，以及 WebView2 的 `EBWebView` 用户数据全部落到 exe 旁的
`data\`，与安装版写 `%APPDATA%` / `%LOCALAPPDATA%` 的数据**各一份、互不干扰**。

特点与边界：

- **零注册**：便携版不写注册表、不注册 `.kbnote` 双击关联、不建桌面 / 开始菜单快捷方式
  （文件关联与快捷方式只有安装器会写）。双击 `.kbnote` 仍唤起已安装的版本或弹「打开方式」。
- 升级时用新 `drawpaper.exe` 覆盖旧 exe，`data\` 整个保留。
- `data\` 所在盘只读 / 不可写（CD-ROM、锁死的 U盘）时自动回退系统目录，并在启动 stderr / 日志
  说明原因，不崩溃。
- WebView2 **运行时本身**仍是系统共享组件（不在 `data\` 里）。
- 设计细节见 `../../docs/wave16/portable-mode.md`；手动冒烟脚本 `ci/smoke-portable.ps1`（未接 CI）。

## 诊断导出

两条入口，共用同一个纯 Rust 核心 `diagnostics::write_diagnostic_zip`：

- **菜单**：帮助 → 导出诊断信息…（原生保存对话框，取消不报错，完成后原生消息框反馈）。
- **隐藏无头 CLI**：`drawpaper.exe --diag-export <out.zip>`（在构建任何 Tauri 插件前拦截，
  不弹窗、不开 webview、直接写 zip 后以进程码退出；CI 隐私金丝雀与排障直接用它）。

zip 内容（固定四项）：

| 条目 | 内容 |
|---|---|
| `system.json` | app 版本 / OS 版本与架构 / WebView2 Runtime 版本 / 收集时间戳 |
| `logs/drawpaper.log` | 日志尾部（上限约 **256KB**，`LOG_TAIL_BYTES = 256*1024`，日志是唯一被打包字节的文件） |
| `files-manifest.json` | 数据目录递归清单，**每个条目恰好只有 `name` / `size` / `mtime` 三项元数据** |
| `README.txt` | 本包内容与隐私边界说明 |

**隐私红线**：zip 里**绝不包含任何 `.kbnote` 文档正文，也不包含 `assets/` 图片 / 附件字节**；
清单仍会按名字列出这些文件（仅元数据），但字节不打包。CI 用唯一密文金丝雀断言「包内无
`.kbnote` 条目、无 `assets/` 条目、全包零密文命中」。设计见 `../../docs/wave15/diagnostics.md`。

## 更新器配置（发版维护者视角）

「帮助 → 检查更新…」接入了官方 `tauri-plugin-updater`，但**纯手动、零后台**：整个 crate 里
只有这一处触发 updater 网络请求——没有启动检查、没有定时器、没有轮询、不自动下载。

行为：

- 点一下才 `check()` 一次配置的 endpoint；有更新的**已签名**版本 → 原生对话框显示当前 / 最新
  版本与更新说明，用户点「是」才 `download_and_install`（NSIS 自更新并重启），点「否」什么都不做。
- 无更新 / 离线 / endpoint 未就绪（还没有 `latest.json`）/ 签名或解析错误 / 任意失败 →
  **透明回退为在系统浏览器打开 Releases 网页**（`.../releases/latest`），不弹吓人的错误框。

配置链路（一次性运维动作，详见 `../../docs/RELEASE.md` §9 / §10 与 `../../docs/wave15/updater.md`）：

1. **生成密钥对**：`tauri signer generate`。公钥（minisign，ID `F4E906AB9D83F130`）已写入
   `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`；endpoint 指向
   `https://github.com/guzifeng123/drawpaper--freedom/releases/latest/download/latest.json`。
   私钥**不入库**，保存在仓库外。
2. **私钥入 GitHub Secret**：仓库 Settings → Secrets and variables → Actions，新建 secret
   **`TAURI_SIGNING_KEY`**，值为私钥文件全部内容。本路密钥**无口令**，因此**不需要**
   `TAURI_SIGNING_KEY_PASSWORD` 这个 secret。
3. **tag 发布产产物**：配好 secret 后，build job 检测到 `TAURI_SIGNING_KEY` 就给每个 NSIS 产物
   旁写 `<installer>.exe.sig`；publish job（仅 tag push）据此生成 `latest.json`（含 x64 / arm64
   NSIS 的 url 与 signature）并挂到 Release。此后旧版应用点「检查更新…」才能原生发现新版。
4. **未配 secret 时不失败**：build job 检测不到私钥就**跳过签名、安装包照常产出**（只是没有
   `.sig`）；publish job 发现缺 `.sig` 就跳过 `latest.json`（安装包仍发布）；应用内检查会
   404 回退到 Releases 网页。这是预期降级，不是 CI 失败。

> 注意区分两套密钥：上面的 `TAURI_SIGNING_KEY` 是 **updater 签名**（验证「更新包有没有被篡改」）；
> §9 的 `CERTIFICATE_BASE64` / `CERTIFICATE_PASSWORD` 才是 **Authenticode 代码签名**（让
> SmartScreen 信任安装包本体）。后者当前未启用，二者不要混用。

## 相关文档

- `../../docs/windows-user-guide.md` — 最终用户视角：选哪个安装包、安装 / 卸载、数据目录、便携版、
  `.kbnote` 关联、WebView2、检查更新、日志与诊断反馈（**本文与该指南互为交叉引用**）。
- `../../docs/RELEASE.md` — 发版操作手册：打 tag、三条 workflow 各做什么、产物清单、版本号文件、
  §9 代码签名 / §10 更新器清单。
- `../../docs/wave15/webview2-offline.md` — WebView2 三种安装策略的包体积实测与「不内嵌 ~202MB
  运行时」结论。
- `../../docs/wave15/msi-bundle.md` — WiX MSI 安装包矩阵、`wix.version` 数字覆盖原因、MSI 5 步冒烟。
- `../../docs/wave15/updater.md` — 手动更新器与签名密钥引导、CI 签名链路。
- `../../docs/wave15/diagnostics.md` — 诊断 zip 内容与隐私红线。
- `../../docs/wave15/desktop-gap-audit.md` — 原生差距审计与冷启动 / 欢迎文档 / 诊断金丝雀冒烟。
- `../../docs/wave16/portable-mode.md` — 便携模式设计细节。
- `../../docs/sync.md` — 同步（文件夹 / WebDAV / 端到端加密）配置步骤。
- `../../docs/p2-tauri-ci.md`、`../../docs/p2-shells.md` — 早期 Tauri CI 与 shell 规划背景。
