# 发布操作手册（RELEASE）

> 本手册面向维护者：在 develop 合并、CI 全绿之后，如何打 tag 触发发布、产物落在哪、以后发版要改哪些文件、以及出问题如何回滚。
> 当前版本：**0.1.0-rc.22**（预发布 / Release Candidate）。

## 1. 何时打 tag

- 前置：要发布的 commit 已合入 `develop`，且该 commit 在 GitHub 上的 `web-ci` / `release-windows`(build) / `android-debug` 三条 workflow 均为绿色。
- `chore/*`、`feat/*`、`fix/*` 分支本身不触发云端 workflow；只有合到 `develop` 并在 develop tip 跑绿后，才以 develop tip 的 commit 为基线打 tag。
- 本次（RC）约定 tag 为 `v0.1.0-rc.22`。正式版将为 `v0.1.0` / `v1.0.0` 等（不含 `-`）。

## 2. 打 tag 与推送

```bash
# 1) 切到要发布的 commit（通常是 develop tip）
git checkout develop
git pull --ff-only
git log --oneline -1          # 确认这是已跑绿的那个 commit

# 2) 打带注释的 tag（annotated tag）
git tag -a v0.1.0-rc.22 -m "drawpaper 0.1.0-rc.22 (pre-release)"

# 3) 只推这一个 tag（不要用 git push --tags，避免误推其他临时 tag）
git push origin v0.1.0-rc.22
```

推送 tag 后，`release-windows` 的 `publish` job 只在 `github.ref` 以 `refs/tags/` 开头时才会跑；分支 push / 手动触发只验证出包，不创建 Release。

## 3. 触发后三条 workflow 各做什么

| workflow | 触发 | 行为 |
|---|---|---|
| **web-ci** | push / PR 到 develop、PR | 不随 tag 重跑（tag push 不在其触发分支列表）；它是合 develop 前的守门，已在 develop tip 跑绿。 |
| **release-windows** | push tag `v*`（也监听 develop、`feat/p2-tauri-ci`、workflow_dispatch） | 两个 matrix job（windows-latest）并行构建 NSIS 安装包并各自上传 artifact `nsis-x64` / `nsis-arm64`；`publish` job（ubuntu）在两 build 成功后，用 `download-artifact@v4` 分别取回两个目录，再用 `softprops/action-gh-release@v2` 创建 **GitHub Release 并标记为 prerelease: true**，把两个 `.exe` 挂上去。 |
| **android-debug** | push 到 develop / `feat/**` / `fix/**`、PR | **不会随 tag 重跑**（tag 不在其触发分支列表）。它在每次 develop push 时产出一个未签名 debug APK 的 workflow artifact（保留 14 天），**不进 GitHub Release**。 |

> 说明：tag push 本身只直接触发 `release-windows`。`web-ci` 与 `android-debug` 对 tag push 不响应，这是设计如此——它们的产物（测试报告、debug APK）不属于 Release 交付物。

## 4. 产物清单

### 4.1 GitHub Release 上的 Windows 安装包

版本号取自 `tauri.conf.json`（本版 `0.1.0-rc.22`）。自 rc.11 起同一次 CI 产出 **NSIS（x64 / ARM64 各一）与 WiX MSI（en-US / zh-CN 两种 UI 语言 × x64 / ARM64 各二），共六个安装包**：

- `drawpaper_0.1.0-rc.22_x64-setup.exe` — NSIS，64 位 Intel/AMD（Win10/11），个人用户推荐
- `drawpaper_0.1.0-rc.22_arm64-setup.exe` — NSIS，ARM64（Copilot+ PC、Surface Pro X 等）
- `drawpaper_0.1.0-rc.22_x64_en-US.msi` — WiX MSI，x64，英文 UI（ProductLanguage 1033），企业批量部署（`msiexec /qn` 静默）
- `drawpaper_0.1.0-rc.22_arm64_en-US.msi` — WiX MSI，ARM64，英文 UI
- `drawpaper_0.1.0-rc.22_x64_zh-CN.msi` — WiX MSI，x64，简体中文 UI（ProductLanguage 2052）
- `drawpaper_0.1.0-rc.22_arm64_zh-CN.msi` — WiX MSI，ARM64，简体中文 UI

> ARM64 安装包自 rc.11 起在 GitHub hosted `windows-11-arm` runner 上做原生构建 + 静默安装/启动/卸载冒烟（`arm64-native` job）；发布资产仍以矩阵交叉构建产物为唯一来源。zh-CN MSI 在 CI（无 UAC）下走 per-user 落点，企业管理员 elevated 按机器安装请先小批量验证。

> MSI 的 ProductVersion 不接受 semver 预发布后缀，tauri.conf 用 MSI-only 覆盖 `bundle.windows.wix.version=0.1.0.17`；应用「关于」与 NSIS 显示的对外版本仍是 `0.1.0-rc.22`。MSI 提供 en-US / zh-CN 两种安装界面语言（自 rc.11 起）。

六个文件由 `publish` job 从 `artifacts/nsis-x64/**`、`artifacts/nsis-arm64/**`、`artifacts/msi-x64/**`、`artifacts/msi-arm64/**` 通配收集（MSI 含 en-US 与 zh-CN 两种 culture 后缀）并挂到 Release，`SHA256SUMS.txt` 覆盖全部六个（workflow 硬断言 6 行）。构建在 Windows runner 上完成；Linux/macOS 无法本地复现该产物。

### 4.2 Android APK 为什么不在 Release

`android-debug.yml` 用 CI 临时 `npx cap add android` 生成工程、`gradlew assembleDebug` 产出 **未签名** 的 `app-debug.apk`，并以 workflow artifact（名 `drawpaper-android-debug`，保留 14 天）形式留存。它**没有签名密钥、不上架、也不进 GitHub Release**。

获取方式：
1. 打开该次提交对应的 `android-debug` workflow run 页面；
2. 拉到底部 Artifacts 区，下载 `drawpaper-android-debug` 压缩包，解压得到 `app-debug.apk`；
3. 侧载（sideload）到 Android 平板测试。

> RC 阶段不提供签名 release APK；未来若上架应用商店，需要单独的签名流程与 keystore，不在本手册范围。

### 4.3 Web PWA

浏览器直接打开部署地址即可「添加到主屏幕」离线使用，无需 Release 产物。

## 5. 以后发版要改的版本号文件清单

发版时把下列文件里的版本号统一改成新版本（例如 `0.1.0` 或 `0.2.0`）：

| 文件 | 字段 | 说明 |
|---|---|---|
| `package.json`（根） | `version` | monorepo 根元数据 |
| `packages/web/package.json` | `version` | PWA 包元数据 |
| `apps/desktop-tauri/src-tauri/tauri.conf.json` | `version` | **决定 NSIS 产物文件名与应用内版本** |
| `apps/desktop-tauri/src-tauri/Cargo.toml` | `[package] version` | Rust crate 版本 |
| `apps/desktop-tauri/src-tauri/Cargo.lock` | `[[package]]` 中 `name = "drawpaper"` 的 `version` | 与 Cargo.toml 保持一致 |
| `apps/mobile-capacitor/package.json` | `version` | Capacitor 外壳 JS 元数据 |
| Android `versionName` | `apps/mobile-capacitor/android/app/build.gradle` 的 `versionName` | **仅当 android 工程已在本地生成**时同步；`versionCode` 保持整数递增、不要回退。本仓库 android 工程由 CI 临时生成、不入库，故发版时通常无需手改。 |

不改动（刻意保持现状）：
- `packages/core/package.json` 的 `version`：内部私有逻辑库，不影响任何交付物，维持 `0.0.0`。
- `apps/desktop-tauri/package.json` 的 `version`：Tauri CLI 的 JS 包装元数据，不参与 NSIS 命名（以 `tauri.conf.json` 为准）。
- PWA manifest（`packages/web/vite.config.ts` 的 `VitePWA.manifest`）：当前不含独立 `version` 字段，`name` / `short_name` 保持不变；PWA 缓存由 Workbox 构建哈希自动失效。

改完后本地跑一遍 `pnpm -r build` 确认 PWA 仍能构建，再走 §2 打 tag。

## 6. 更新器现状（Wave15 A 已接入，待配 secret 后生效）

Wave15 A 起，Windows 桌面壳**已接入官方 `tauri-plugin-updater` v2**：「帮助 → 检查更新…」改为纯用户手动触发的原生更新流程，零后台检查（启动不查、无定时器、不自动下载）。有新版则原生对话框确认后下载验签安装并重启；无更新 / 离线 / 端点未就绪 / 任意报错一律回退为打开 Releases 网页。

**当前还差最后一步才真正生效**：

1. 仓库 Settings → Secrets 里还没配 `TAURI_SIGNING_KEY`（updater 签名私钥，由 Wave15 A 生成，公钥已在 `tauri.conf.json`）；
2. 因此 tag 构建暂时**不出 `.sig`、不生成 `latest.json`**，应用内检查会 404 回退网页。

在维护者把私钥加为 GitHub secret 之前，用户升级方式仍是手动下载新的 NSIS 安装包覆盖安装。完整流程与密钥引导见 **[`docs/wave15/updater.md`](./wave15/updater.md)**。

## 7. 回滚方式

- **删 Release**：在 GitHub Releases 页面删掉误发的预发布 Release（不影响代码与 tag）。
- **移动 / 删除 tag**（必须重发时）：
  ```bash
  # 删远端 tag 后本地重建到正确 commit
  git push origin :refs/tags/v0.1.0-rc.22
  git tag -d v0.1.0-rc.22
  git checkout <correct-commit-sha>
  git tag -a v0.1.0-rc.22 -m "drawpaper 0.1.0-rc.22 (pre-release)"
  git push origin v0.1.0-rc.22
  ```
- **版本号回退**：若某个版本号打错了（例如把 `-rc.1` 打成 `-rc.2`），按 §5 改回版本文件并合并到 develop，再用修正后的 tag 重发；已发错 tag 的 Release 按上面删除。
- 代码本身不回滚：develop 已合入的功能不因为某个 tag 发错而撤回，下一个 tag 带上修复即可。

## 8. 发布前文档核对清单

- [ ] 发布前确认 `docs/sync.md` 的截图 / 操作步骤与最终 UI 文案一致（跨设备同步文档先行编写，同步设置项的按钮名 / 弹窗标题可能在开发阶段微调，见该文 §2.5 注）。

## 9. 代码签名（Code Signing）—— 当前未启用

> 本节只描述现状与接入路径，**本期不实现、不提交任何证书或私钥**。

### 9.1 现状

本仓库的 NSIS 安装包（`drawpaper_*_*-setup.exe`）**当前未做 Authenticode 代码签名**。后果：

- 首次在 Windows 10/11 上双击安装时，SmartScreen 会弹出「Windows 已保护你的电脑」蓝色提示（因为该发布者没有信誉），用户需要点「更多信息 → 仍要运行」才能继续。
- 杀毒软件对未签名、从 GitHub Release 下载的未知 exe 可能产生额外启发式告警。
- 这是 RC 阶段的已知现状，不是 CI 失败。

### 9.2 接入代码签名需要什么

1. **一张代码签名证书（PFX）**
   - 从受信任 CA（DigiCert / Sectigo / SSL.com 等）购买；EV 证书可立即获得 SmartScreen 信誉，OV 证书需要积累下载量后才会被 SmartScreen 信任。
   - 证书以 `.pfx`（PKCS#12）文件形式拿到，含私钥与证书链。
2. **GitHub Secrets（在仓库 Settings → Secrets and variables → Actions 配置，不要入库）**
   - `CERTIFICATE_BASE64`：`.pfx` 文件 base64 编码后的字符串（`base64 -w0 cert.pfx`）。
   - `CERTIFICATE_PASSWORD`：导出 PFX 时设置的口令。
3. **CI 集成（在 `release-windows.yml` 的 build job 里，`tauri build` 之前/之后做）**
   - 用官方 `tauri-apps/tauri-action`（它原生支持读 `TAURI_SIGNING_IDENTITY` 等环境变量并在打包后调用 signtool）；或在 NSIS 产物出来后用 Windows SDK 自带的 `signtool sign /f cert.pfx /p $env:CERTIFICATE_PASSWORD /fd sha256 /tr <timestamp-url> /td sha256 <installer.exe>`。
   - 注意：Tauri 的 `TAURI_SIGNING_PRIVATE_KEY*` 这一组 secret 是给 **updater 签名**（见 §10）用的，和 Authenticode 代码签名（`CERTIFICATE_BASE64` / `CERTIFICATE_PASSWORD`）是**两套不同的密钥**，不要混用。
4. **签名后**：安装包在 Release 页面附 `SHA256SUMS.txt`（见 §4.1，由 publish job 生成），用户校验完整性；SmartScreen 提示会随证书信誉积累而消失。

> 在拿到证书之前，不要在 CI 里留任何占位 secret 引用；未签名就保持现状并在 Release 正文说明「未签名，首次运行需点仍要运行」。

## 10. 更新器清单（Tauri Updater）—— Wave15 A 已落地，待配 secret

> 本节原为「未来接入 checklist」。Wave15 A 已把代码与 CI 链路落地，**只剩「把私钥加为 GitHub secret」这一运维动作**。状态对照如下（详情见 [`docs/wave15/updater.md`](./wave15/updater.md)）。

| # | 步骤 | 状态 |
|---|---|---|
| 1 | 生成 updater 签名密钥对 | ✅ 已做。公钥已写入 `tauri.conf.json`；私钥在仓库外 `~/drawpaper-tauri-updater.key`（`600`）。 |
| 2 | 公钥 + endpoints 填入 `tauri.conf.json` `plugins.updater` | ✅ 已做。endpoints = `https://github.com/guzifeng123/drawpaper--freedom/releases/latest/download/latest.json`。**`bundle` 段未动。** |
| 3 | 引入 `tauri-plugin-updater` 并在 `lib.rs` 注册 | ✅ 已做。`help:check-update` 改为手动原生流程（纯用户触发，零后台）。 |
| 4 | 私钥存 GitHub Secrets | ⏳ **待维护者手动操作**：新建 secret `TAURI_SIGNING_KEY`，值为私钥文件全部内容。本路密钥无口令，**无需** `TAURI_SIGNING_KEY_PASSWORD`。 |
| 5 | CI 产出 `.sig` | ✅ 已接入。build job 检测到 `TAURI_SIGNING_KEY` 时自动给每个 NSIS 产物出 `.sig`；缺失则跳过签名、安装包照常。 |
| 6 | publish job 生成 `latest.json` 并上传 | ✅ 已接入（仅 tag push 跑）。把 `.exe` + `.sig` + `latest.json` + `SHA256SUMS.txt` 挂到 Release。`.sig` 缺失时跳过 latest.json，不阻断发布。 |
| 7 | 检查更新入口 | ✅ 已做（菜单「帮助 → 检查更新…」，Rust 侧原生对话框，非前端按钮）。 |
| 8 | 验证 | ⏳ 待第一个带签名 tag 验证：Release 上应有两个 `.exe` + 两个 `.sig` + `latest.json` + `SHA256SUMS.txt`，旧版应用点「检查更新…」能原生发现新版。 |

> 当前（未配 secret）实际行为：应用点「检查更新…」会因 Release 上还没有 `latest.json` 而检查失败，**自动回退为打开 Releases 网页**——与 rc.7 体验一致，需手动下载新安装包覆盖安装。

> 再次强调：updater 签名（`TAURI_SIGNING_KEY`，验证「更新包是否被篡改」）与 §9 的 Authenticode 代码签名（`CERTIFICATE_BASE64`，让 Windows 信任安装包）是两套密钥，不要混用。
