import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// 本机 playwright 浏览器（chromium 1243）实际装在 /home/user/ms-playwright。
// shell 可能全局导出 PLAYWRIGHT_BROWSERS_PATH=/opt/vm/preinstall/...
// （该路径缺 chromium_headless_shell），干净环境下浏览器会找不到。
// 但 CI runner 上 /home/user/ms-playwright 不存在，必须走默认缓存路径，
// 所以仅当本机路径真实存在时才覆盖（本地行为不变，CI 用 ~/.cache/ms-playwright）。
const LOCAL_BROWSERS_PATH = '/home/user/ms-playwright';
if (existsSync(LOCAL_BROWSERS_PATH)) {
  process.env['PLAYWRIGHT_BROWSERS_PATH'] = LOCAL_BROWSERS_PATH;
}

/**
 * Playwright e2e 配置：chromium，webServer 自动起 preview（build 后）或 dev。
 * 本机浏览器缓存目录 /home/user/ms-playwright。
 */
const E2E_PORT = Number(process.env['E2E_PORT'] ?? 4173);

export default defineConfig({
  testDir: './e2e',
  // Wave8 离线回归跑生产预览（独立 playwright.offline.config.ts），dev server 无 SW，
  // 这里显式忽略 offline 目录，避免 dev 套件误跑离线用例。
  // Wave21：webkit 专用兼容 spec 只在 playwright.webkit.config.ts（project=webkit）下跑，
  // 绝不让默认 chromium 套件误跑（其断言按 WebKit 无 FSA 写）。
  // Wave26：wave26-webkit-capability.spec 是 webkit-full 的引擎能力取证（只打 ::warning），
  // 不在 chromium job 上打印 webkit 向 warning，故一并忽略。
  testIgnore: ['**/offline/**', '**/wave21-webkit-compat.spec.ts', '**/wave26-webkit-capability.spec.ts'],
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // DEV server：e2e 依赖 window.__drawpaper__ 测试钩子（仅 import.meta.env.DEV 暴露，
    // 生产构建不挂载）。生产产物的零外网/无钩子由 build 后 grep 单独核验。
    // 端口可用 E2E_PORT 覆盖，便于多个 worktree 并行跑 e2e 互不抢端口。
    command: `pnpm dev --port ${E2E_PORT} --strictPort`,
    url: `http://localhost:${E2E_PORT}`,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});
