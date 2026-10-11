# drawpaper Windows 用户指南

> 适用版本：Windows 10 / 11（x64 与 ARM64）。
> 安装包由 `.github/workflows/release-windows.yml` 自动构建并发布到 GitHub Releases。
> 本指南面向**最终用户**，只讲「怎么装、数据在哪、出问题怎么办」，不讲构建。
> 想自己构建 / 出包 / 维护发版签名，请转 [`../apps/desktop-tauri/README.md`](../apps/desktop-tauri/README.md)（开发与打包）与 [`RELEASE.md`](./RELEASE.md)（发版操作手册）。

## 0. 选哪个安装包

每个架构有**两种格式**，装出来的是同一个 drawpaper，只是安装器不同：

| 格式 | 文件名 | 适合谁 | 安装范围 |
|---|---|---|---|
| **NSIS（推荐）** | `drawpaper_*_x64-setup.exe` / `drawpaper_*_arm64-setup.exe` | 绝大多数个人用户 | 向导可选「仅当前用户」（默认，不弹 UAC）或「为所有用户」 |
| **WiX MSI** | `drawpaper_*_{x64,arm64}_{en-US,zh-CN}.msi`（共 4 个，英文/简体中文界面各二） | 企业批量部署 / 组策略 / SCCM / Intune | 无 UAC 静默安装为按用户安装到 `%LOCALAPPDATA%\Programs\drawpaper`；elevated 安装到 `C:\Program Files\drawpaper`（需要管理员） |

个人用户直接下 NSIS `*-setup.exe` 即可。MSI 主要给要批量分发 / 静默部署（`msiexec /i xxx.msi /qn`）的 IT 管理员用；MSI 提供英文（en-US）与简体中文（zh-CN）两种安装界面，按文件名后缀选择；NSIS 同样有中 / 英双语。

## 1. 下载与安装

1. 打开仓库 Releases 页（`https://github.com/guzifeng123/drawpaper--freedom/releases`），选最新一条预发布（prerelease）。
2. 按机型下载（个人用户选 NSIS，企业批量部署才选 MSI，见 §0）：
   - 普通 Intel / AMD 笔记本、台式机 → `drawpaper_*_x64-setup.exe`
   - Copilot+ PC、Surface Pro X 等 ARM 设备 → `drawpaper_*_arm64-setup.exe`
   - （可选）企业静默部署 → 中文界面选 `*_x64_zh-CN.msi`（ARM64 同名 arm64），英文界面选 `*_x64_en-US.msi`；管理员 `msiexec /i xxx.msi /qn`
   - 同时下载 `SHA256SUMS.txt`，在 PowerShell 里校验（NSIS 与 MSI 共六个安装包的校验和都在里面）：
     ```powershell
     Get-FileHash .\drawpaper_*_x64-setup.exe -Algorithm SHA256
     # 与 SHA256SUMS.txt 里对应那一行的哈希比对，一致再装
     ```
3. NSIS 双击 `*-setup.exe` 安装；MSI 双击 `.msi` 或命令行 `msiexec /i xxx.msi`。

### 1.1 SmartScreen 蓝色弹窗（「Windows 已保护你的电脑」）

因为安装包**没有购买代码签名证书**（Authenticode 签名每年要付费，本项目目前没有），Microsoft SmartScreen 不认识这个发布者，会拦一道：

- 点击弹窗左侧的 **「更多信息」**，会出现 **「仍要运行」** 按钮，点它即可继续。
- 这是未签名免费开源 Windows 软件的常态，不是病毒；安装包本身在 Releases 页公开、可 anyone 审。
- 装一次之后，SmartScreen 通常不会再拦同一个文件。

### 1.2 安装模式（installMode: both）

Wave13 起安装器配置为 `both`：安装向导里**默认按当前用户安装**（不需要管理员权限，不弹 UAC），装到 `%LOCALAPPDATA%\Programs\drawpaper`，只对当前 Windows 账号生效。

高级选项里可勾选「为所有用户安装」：这一步会弹 UAC，装到 `%ProgramFiles%\drawpaper`，所有本机账号共用一份。两者选其一即可；之后想换模式，先卸载再重装。

两种模式都**不会**改系统环境变量、不动 `PATH`。

### 1.3 卸载

- 方式一：Windows 设置 → 应用 → 已安装的应用 → drawpaper → 卸载。
- 方式二：开始菜单 → 右键 drawpaper → 卸载。
- NSIS 静默卸载器是安装目录下的 `unins000.exe`。
- MSI 版卸载走系统「应用」面板，或管理员命令行 `msiexec /x drawpaper_*_x64_zh-CN.msi /qn`（按安装时所用 culture 选择对应文件）。elevated 安装在 `C:\Program Files\drawpaper`，无 UAC 静默安装在 `%LOCALAPPDATA%\Programs\drawpaper`。

## 2. 数据目录与卸载后保留策略

drawpaper 是本地优先应用，**所有文档、最近文件列表、自动快照、同步配置、AI endpoint 都存在本机**，不注册账号、不上传云端。

Tauri 2 按 identifier `com.drawpaper.app` 决定目录名，Windows 上对应位置：

| 用途 | 路径（资源管理器地址栏直接粘贴） |
|---|---|
| 配置 / 最近文件 / 自动保存元数据 | `%APPDATA%\com.drawpaper.app\` |
| 文档时间戳备份（`backups\*.kbnote`） | `%APPDATA%\com.drawpaper.app\backups\` |
| 日志（`drawpaper.log`） | `%APPDATA%\com.drawpaper.app\logs\` |
| 程序本体（currentUser 模式） | `%LOCALAPPDATA%\Programs\drawpaper\` |
| 程序本体（整机模式） | `%ProgramFiles%\drawpaper\` |

**卸载会删程序本体目录，但保留 `%APPDATA%\com.drawpaper.app\` 下的用户数据**（最近文件、备份、配置）。这样误装/重装不会丢文档；如果你要彻底清干净，卸载后手动删掉上面那个 `Roaming\com.drawpaper.app` 目录即可。

文档本体本身（`.kbnote` 文件）由你通过「另存为」或同步通道放在任意目录，drawpaper 不会动你没绑定的文件。

### 2.1 便携版（U盘运行，可选）

drawpaper 也支持**不安装、直接拷到 U 盘/移动硬盘里跑**：所有数据都放在 exe 旁边的 `data\` 目录，和装在本机的版本**各写各的、互不干扰**。

**怎么进入便携模式（二选一）：**

1. 在 `drawpaper.exe` 同目录新建一个空文件，命名为 `drawpaper.portable`（内容随便留空即可）；**或者**
2. 在 exe 同目录手动建一个 `data\` 文件夹。

下次启动 drawpaper.exe 即进入便携模式。两个条件都没有 → 按安装版运行，数据仍在 `%APPDATA%\com.drawpaper.app\`，和以前一样。

**便携模式下的目录结构：**

```
任意文件夹\
├─ drawpaper.exe
├─ drawpaper.portable        ← 你建的空标记（可选）
└─ data\                     ← 便携数据全在这
   ├─ drawpaper-recents.json  最近打开列表
   ├─ window-state.json       窗口位置/大小
   ├─ backups\*.kbnote       时间戳备份
   ├─ logs\drawpaper.log      日志
   └─ EBWebView\              WebView2 网页数据（画布/IndexedDB）
```

**特点：**

- **与安装版互不干扰**：便携版读写 U盘上的 `data\`，安装版读写 `%APPDATA%`，两边数据各一份，不会串。
- **升级不丢数据**：换新版本时只用新 `drawpaper.exe` 覆盖旧 exe，`data\` 整个保留，最近文件/窗口状态/备份/网页存储都在。
- **换电脑即用**：把整个文件夹（含 `data\`）拷到另一台 Windows 机器，插上 U盘直接跑。

**已知边界（请务必读）：**

- 便携版**不写注册表、不注册 `.kbnote` 双击关联**。在资源管理器里双击 `.kbnote` 仍会唤起本机已安装的版本（或弹「打开方式」）；要打开便携版里的文档，请先开便携版，再用「文件 → 打开」。
- WebView2 **运行时本身**是系统共享组件（Win11 自带、Win10 首启自动联网装一次），不在 `data\` 里；这不影响你的数据便携性。
- 如果 `data\` 所在盘是**只读**的（CD-ROM、U盘锁死），drawpaper 写不进去，会自动**回退到本机 `%APPDATA%`** 运行，并在启动时说明原因——不会崩溃。
- 设计细节见 [`wave16/portable-mode.md`](./wave16/portable-mode.md)。

## 3. `.kbnote` 文件关联

安装包会把 `.kbnote` 扩展名注册给 drawpaper：

- currentUser 模式写到 `HKCU\Software\Classes\.kbnote`
- 整机模式写到 `HKLM\Software\Classes\.kbnote`
- 双击任何 `.kbnote` 文件应直接用 drawpaper 打开。

### 3.1 双击没反应 / 弹「打开方式」怎么办

1. 右键任意 `.kbnote` 文件 → **打开方式 → 选择另一个应用**。
2. 选 drawpaper（如果列表里没有，点「更多应用 → 在此电脑上查找另一个应用」，手动选 `drawpaper.exe`，通常在 `%LOCALAPPDATA%\Programs\drawpaper\drawpaper.exe`）。
3. 勾选 **「始终使用此应用打开 .kbnote 文件」**。
4. 如果还是被浏览器 / 记事本抢回去，到 Windows 设置 → 应用 → 默认应用，搜 `.kbnote`，把它指到 drawpaper。

## 4. WebView2 运行时

drawpaper 的窗口用 Microsoft Edge WebView2 渲染：

- **Win11**：系统自带 WebView2 运行时，装完即跑。
- **Win10 或精简过的系统（联网）**：安装器已内置 WebView2 引导程序（bootstrapper stub），安装时本地执行引导、从微软官方 CDN 自动下载约 200 MB 的 Evergreen Runtime；只要能联网到微软 CDN，装完即跑。
- **完全离线 / 内网隔离机器**：标准安装包仍不内置完整运行时。两种办法：
  1. 到能上网的机器上，从 Microsoft 官网下载「WebView2 Evergreen Standalone Installer」（按机型选 x64 / x86 / ARM64），拷到内网先装好，再装 drawpaper。官方下载页：`https://developer.microsoft.com/microsoft-edge/webview2/`（选 *Evergreen Standalone Installer*，不是 Bootstrapper）。
  2. 若 Releases 页提供 `drawpaper_*_offline-setup.exe`（全离线附加包，已内嵌完整运行时），直接用它在内网安装，无需任何联网。
- WebView2 崩了会表现为白屏 / 窗口卡死；关掉 drawpaper 重开即可，文档有 500ms 防抖自动保存兜底。

## 5. 检查更新

点菜单 **「帮助 → 检查更新…」** 即可。这是**纯手动**的：只在你点这一下时才联网查一次，启动时不查、后台不自动下载。

- 如果有更新的版本，会弹出一个原生对话框，告诉你当前版本 / 最新版本 / 更新说明，你点「是」才会下载、安装并自动重启；点「否」就什么都不做。
- **在项目配置好更新签名私钥之前**（当前阶段）：应用内检查会因为还没有更新清单而自动**打开 Releases 网页**，这和以前一样。

手动升级（任何时候都适用）：

1. 打开 `https://github.com/guzifeng123/drawpaper--freedom/releases/latest`。
2. 看页面顶部的版本号是不是比你菜单「帮助 → 关于」里的新。
3. 新版下载新的 `*-setup.exe`，直接双击覆盖安装即可（用户数据不动）。

## 6. 同步（文件夹 / WebDAV / 端到端加密）

drawpaper 官方不提供任何云服务，同步通道完全由你自己选，配置在 app 内「同步」菜单：

- **同步文件夹（推荐）**：选一个本地目录（Syncthing / iCloud Drive / OneDrive / Dropbox 同步的那个文件夹都行），文档自动导出为 `<docId>.kbnote`，图片附件进 `assets/` 子目录。多台机器放同一个文件夹即同步。
- **WebDAV**：自填 base URL / 用户名 / 应用密码（Nextcloud、坚果云、群晖、威联通等）。凭据只存本机，不发往任何第三方。
- **端到端加密（仅 WebDAV）**：在 WebDAV 设置里开 E2EE，口令经 PBKDF2 派生 AES-256-GCM 密钥，服务器端看不到正文。口令默认只在内存里，关掉 app 就要重新输。
- **冲突**：自动合并失败时会保留 `《文档名》.conflicted-《时间》.kbnote` 副本，并在同步设置里提供「冲突副本中心」让你挑以哪边为准。

详细配置步骤见 [`sync.md`](./sync.md)。

## 7. 日志与反馈

- 日志文件位置：`%APPDATA%\com.drawpaper.app\logs\drawpaper.log`（按启动追加，由 tauri-plugin-log 写入）。
- **一键导出诊断包（推荐）**：菜单「帮助 → 导出诊断信息…」，选个保存位置，会生成一个
  `drawpaper-diagnostic-YYYYMMDD.zip`。里面有：`system.json`（版本/OS/架构/WebView2 版本）、
  日志尾部（约 256KB）、`files-manifest.json`（数据目录文件清单，仅路径/大小/时间）、
  `coldstart.json`（冷启动分段时间线，仅数字/阶段名，无文档内容）、说明。
  **这个 zip 不含任何 `.kbnote` 文档正文，也不含图片/附件字节**——你可以放心附上。
  取消对话框不会报错。
- 出 bug（崩溃、白屏、同步报错、快捷键失灵）时：
  1. 先把 app 关掉再重开一次，看是否复现。
  2. 复现后用上面的「导出诊断信息」生成 zip。
  3. 到仓库 Issues 页提一条：附上 drawpaper 版本号（菜单「帮助 → 关于」）、Windows 版本（Win10/11、x64/ARM64）、复现步骤，以及导出的诊断 zip。
- 反馈时**不要**把 `%APPDATA%\com.drawpaper.app\` 下的备份 `.kbnote` 直接贴出来——那是你的私有文档；诊断包已经替你避开了它们的正文。

## 8. 全局快捷键

drawpaper 注册了一组**系统级**快捷键——即使窗口没在前台（你在浏览器 / 别的软件里打字），
按下去也会生效。动作和你点原生菜单完全一样，只是失焦时也能用：

| 快捷键 | 作用 | 相当于点菜单 |
|---|---|---|
| `Ctrl+Shift+D` | 把 drawpaper 窗口唤到前台（显示 + 取消最小化 + 聚焦） | （无，窗口本身） |
| `Ctrl+S` | 保存当前文档 | 文件 → 保存 |
| `Ctrl+P` | 打印 / 另存为 PDF | 导出 → 打印 / 另存为 PDF |
| `Ctrl+F` | 聚焦搜索框 | 视图 → 搜索… |

- **失焦可用**：上面这几个键在 drawpaper 没前台时也会触发；窗口前台时菜单本身的行为不变。
- **想改键位**：用记事本打开 `%APPDATA%\com.drawpaper.app\drawpaper-shortcuts.json`
  （没有就新建），写成 `"快捷键": "动作"` 的 JSON 对象。合法动作只有四个：
  `focus_window`、`file:save`、`export:print`、`view:search`。把动作写成空字符串 `""` 表示
  关掉这个全局热键。例如：

  ```json
  {
    "Ctrl+Shift+D": "focus_window",
    "Ctrl+S": "file:save",
    "F9": "export:print"
  }
  ```

  改完重启 drawpaper 生效。
- **注册失败是静默的**：如果某个快捷键被别的软件先占用了（例如 `Ctrl+Shift+D` 被截图工具
  抢了），drawpaper 不会弹窗、也不会影响启动，只会在日志里记一条 `warn`。出问题时按 §7
  导出诊断包，在 `drawpaper.log` 里搜 `global-shortcut` 就能看到哪些注册成功、哪些被跳过。

## 9. 边界与已知限制

- 本 RC 版本**没有后台自动更新**（只有手动「帮助 → 检查更新…」，且在更新签名私钥配好前会回退到手动网页下载）、**不做 Authenticode 代码签名**、**不收集任何遥测**。
- 同步是文件夹级 / WebDAV 级，**不是实时云端多人协作**；同一台机器同一个浏览器开多个标签页是实时的（`BroadcastChannel`，零外网）。
- ARM64 包在 x64 Windows 上跑不起来（反之亦然），别下错架构。
- 卸载保留 `%APPDATA%\com.drawpaper.app\`；要彻底清理请手动删。
- CI 冒烟只覆盖「当前用户」静默安装路径；「为所有用户安装」（整机 / UAC / `C:\Program Files\drawpaper`）路径目前需人工在 Windows 桌面验证，注册表 HKLM 与公共快捷方式双探测已在冒烟里预留但不做硬门。
