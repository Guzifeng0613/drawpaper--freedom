import { test } from '@playwright/test';
import { waitForApp } from './fixtures/load-doc';

/**
 * Wave26 路 2 —— WebKit 全量覆盖的**引擎能力取证**（只记录、不断言）。
 *
 * 在 webkit-full job 首轮采集时打印 headless Linux WebKitGTK 的原生能力到
 * CI ::warning annotation（黄标，Actions 匿名可读），作为「引擎耦合用例是否
 * 该被 testIgnore 排除」的取证依据：
 *   - !!navigator.storage?.getDirectory   → OPFS 是否原生可用
 *   - !!window.showDirectoryPicker        → FSA 是否原生可用
 *   - !!navigator.share                   → Web Share 是否原生可用
 * 另附产品侧封装钩子 opfsAvailable() / webFsaSupported() 的取值对照。
 *
 * 本 spec 不断言（只取证），永远绿；chromium 默认套件把它 testIgnore（见
 * playwright.config.ts），不在 chromium job 上打印 webkit 向的 warning。
 */

test.describe('Wave26 WebKit 全量覆盖 — 引擎能力取证（::warning）', () => {
  test('打印 WebKitGTK 原生 OPFS / FSA / Share 能力', async ({ page }) => {
    await waitForApp(page);
    const cap = await page.evaluate(() => {
      const nav = navigator as Navigator & {
        storage?: { getDirectory?: unknown };
        share?: unknown;
      };
      const w = window as unknown as {
        showDirectoryPicker?: unknown;
        __drawpaper__?: {
          opfsAvailable?: () => boolean;
          webFsaSupported?: () => boolean;
          webCanShare?: () => boolean;
        };
      };
      return {
        raw_getDirectory: !!(nav.storage && typeof nav.storage.getDirectory === 'function'),
        raw_showDirectoryPicker: typeof w.showDirectoryPicker === 'function',
        raw_share: typeof nav.share === 'function',
        hook_opfsAvailable: w.__drawpaper__?.opfsAvailable?.() ?? null,
        hook_fsaSupported: w.__drawpaper__?.webFsaSupported?.() ?? null,
        hook_canShare: w.__drawpaper__?.webCanShare?.() ?? null,
        userAgent: navigator.userAgent,
      };
    });
    // GitHub Actions workflow command → ::warning annotation（匿名可读）。
    // 直接写 stdout，避免 list reporter 前缀吃掉 :: 前缀。
    process.stdout.write(
      '::warning title=WEBKIT_CAPABILITY::webkit-full ' +
        `getDirectory=${cap.raw_getDirectory} showDirectoryPicker=${cap.raw_showDirectoryPicker} ` +
        `share=${cap.raw_share} opfsAvailable()=${cap.hook_opfsAvailable} ` +
        `fsaSupported()=${cap.hook_fsaSupported} canShare()=${cap.hook_canShare} ` +
        `UA=${cap.userAgent}\n`,
    );
  });
});
