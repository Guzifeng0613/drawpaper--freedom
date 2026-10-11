import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// 本机 playwright 浏览器（webkit-2359）装在 /home/user/ms-playwright；
// CI runner 上该路径不存在，保持默认缓存路径。仅当本机路径真实存在时覆盖。
const LOCAL_BROWSERS_PATH = '/home/user/ms-playwright';
if (existsSync(LOCAL_BROWSERS_PATH)) {
  process.env['PLAYWRIGHT_BROWSERS_PATH'] = LOCAL_BROWSERS_PATH;
}

/**
 * Wave26 路 2 —— WebKit **全量** e2e 覆盖（独立于 wave21-webkit-compat 的 5 例窄配置）。
 *
 * 与 playwright.webkit.config.ts 的区别：
 *  - 那个 testMatch 只跑 wave21-webkit-compat.spec.ts（5 例兼容降级）；
 *  - 本配置 testMatch = **全量** e2e（与默认 chromium config 同口径：只 testIgnore
 *    offline 目录），把「chromium 全量套件」整体搬到 webkit project 下真跑，
 *    用 CI 实测区分：引擎耦合（WebKit 无 OPFS/FSA 等硬断言）vs 产品真缺陷
 *    （该降级却没降级/静默失败）vs 计时 flake。
 *
 *  - project 固定 webkit（devices['Desktop Safari']）；webServer 走 `pnpm dev`
 *    （e2e 依赖 window.__drawpaper__ DEV 钩子）；workers=1（与既有 webkit config 一致，
 *    单 dev server 串行，避免并发抢端口/IDB）；
 *  - 端口 **4191**：WebKitGTK 内置受限端口黑名单含 4190（见 webkit-compat.md 取证），
 *    4191 已实测安全（WEBKIT_PORT 可覆盖；勿改回 4190）；
 *  - reporter CI 下含 github：失败用例发 ::error annotation，匿名可读逐条原因。
 *
 * 前置：packages/web 先 build（@drawpaper/core exports 指向 dist）；WebKit 需系统库。
 *
 * 引擎耦合排除（取证后据此维护，勿用 test.skip 凑绿）：
 * 见本文件 testIgnore 注释 + docs/wave21/webkit-compat.md「全量 WebKit 覆盖」小节。
 */
const WEBKIT_PORT = Number(process.env['WEBKIT_PORT'] ?? 4191);

export default defineConfig({
  testDir: './e2e',
  // 全量口径：与默认 chromium config 一样只排除 offline（离线回归走独立生产 preview
  // config，dev server 无 SW，不在此跑）。wave21-webkit-compat.spec.ts 是 webkit 兼容
  // 断言（fsa/share=false），在 webkit 下本就应绿，故**不**排除，纳入全量。
  //
  // 【引擎耦合排除区】(Wave26 首轮全量采集取证后追加；每条注明取证依据。
  //   原则：这些用例硬断言 headless WebKitGTK 不具备的能力，属「测试与引擎耦合」，
  //   不是改断言/不是改产品代码/不是 skip 凑绿——产品降级路径均已正确工作。
  //   取证 ::warning：getDirectory=true（函数存在）但 opfsAvailable()=true，而真实
  //   OPFS 后端写入 reject，image-pipeline 正确降级 data: 内联；showDirectoryPicker=false、
  //   navigator.share=false。)
  testIgnore: [
    '**/offline/**',
    // OPFS 持久化后端在 headless WebKitGTK 不可用（写入 reject→产品降级 data:）：
    // 下列用例硬断言「图片/附件落 OPFS assetRef、跨刷新幸存、资产 GC」，引擎耦合。
    '**/opfs-idb-survive.spec.ts',
    '**/p21-image-opfs.spec.ts',
    '**/wave16-asset-dedup-gc.spec.ts',
    '**/sync-asset-push.spec.ts',
    // (f) 正常上下文走 OPFS assetRef（从 wave20-opfs-degraded 抽出；降级模式 A/B 保留真跑）。
    '**/wave20-opfs-normal.spec.ts',
    // page.pdf() 仅 Headless Chromium 支持（Playwright 引擎限制，非产品缺陷）。
    '**/acceptance-export.spec.ts',
  ],
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${WEBKIT_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'on',
  },
  projects: [
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
  webServer: {
    command: `pnpm dev --host 127.0.0.1 --port ${WEBKIT_PORT} --strictPort`,
    url: `http://127.0.0.1:${WEBKIT_PORT}`,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});
