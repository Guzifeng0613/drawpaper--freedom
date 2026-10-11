import { test, expect, devices, type Browser, type Page } from '@playwright/test';
import { waitForApp } from './fixtures/load-doc';

/**
 * Wave21 Safari/WebKit 存储兼容兜底 — chromium 默认套件回归。
 *
 * 契约：
 *  - 能力探测：headless chromium 有 FSA、无 Web Share（与桌面 Safari 同形）；
 *  - 「存储空间不足」引导弹窗可被 dev-hook 拉起，文案/动作按钮按能力矩阵渲染；
 *  - 无 FSA（= WebKit 形态）下「导出当前文档」走 anchor 下载 .kbnote；
 *  - 无 Web Share 时弹窗给「下载整库备份 .kbpack」，不出现「分享…」；
 *  - stub 出 navigator.share 后才出现「分享…」且真实调用 Web Share；
 *  - estimate() 在 chromium 可用，返回数值字段（不支持的环境由纯函数兜底 null）。
 */

async function raiseDialog(page: Page) {
  await page.evaluate(() => window.__drawpaper__!.quotaResetThrottle());
  await page.evaluate(() => window.__drawpaper__!.quotaRaise());
}

async function dialogState(page: Page) {
  return page.evaluate(() => ({
    open: window.__drawpaper__!.quotaDialogOpen(),
    canShare: window.__drawpaper__!.webCanShare(),
    fsa: window.__drawpaper__!.webFsaSupported(),
  }));
}

/** 无 FSA + 无 Web Share 的 WebKit 形上下文（addInitScript 在页面脚本前覆写）。 */
async function webKitShapeContext(browser: Browser, opts: { stubShare?: boolean } = {}) {
  const ctx = await browser.newContext(devices['Desktop Chrome']);
  await ctx.addInitScript((stubShare) => {
    const w = window as unknown as Record<string, unknown>;
    // WebKit 无 File System Access。
    delete w.showOpenFilePicker;
    delete w.showSaveFilePicker;
    delete w.showDirectoryPicker;
    // 记录 Web Share 调用（若 stub）。
    (window as unknown as { __shareCalls: unknown[] }).__shareCalls = [];
    if (stubShare) {
      Object.defineProperty(navigator, 'share', {
        value: (data: unknown) => {
          (window as unknown as { __shareCalls: unknown[] }).__shareCalls.push(data);
          return Promise.resolve();
        },
        configurable: true,
        writable: true,
      });
    }
  }, opts.stubShare ?? false);
  return ctx;
}

test.describe('Wave21 配额弹窗（chromium 默认套件）', () => {
  test('基线能力：chromium 有 FSA、无 Web Share；estimate 返回数值', async ({ page }) => {
    // Wave26：本用例是 chromium 基线（断言 fsa=true）。headless WebKitGTK 无 FSA
    // （取证 showDirectoryPicker=false），webkit 真实能力由 wave26-webkit-capability 的
    // ::warning + wave21-webkit-compat 覆盖。引擎耦合，chromium 下真跑。
    test.skip(!!process.env.WEBKIT_FULL, 'webkit 无 FSA，此为 chromium 基线断言');
    await waitForApp(page);
    const cap = await dialogState(page);
    console.log('WAVE21_CAP', cap);
    expect(cap.fsa).toBe(true);
    expect(cap.canShare).toBe(false);
    const est = await page.evaluate(() => window.__drawpaper__!.quotaEstimate());
    console.log('WAVE21_ESTIMATE', est);
    // estimate 在 chromium 应可用；字段为数值（可能为 0，但不能是 undefined/NaN 报错）。
    expect(est).not.toBeNull();
    expect(typeof est!.usage).toBe('number');
    expect(typeof est!.quota).toBe('number');
  });

  test('无 FSA/无 Web Share（WebKit 形）：弹窗给导出 .kbnote + 备份包下载，下载真实触发', async ({ browser }) => {
    test.setTimeout(60_000);
    const ctx = await webKitShapeContext(browser);
    const page = await ctx.newPage();
    await waitForApp(page);

    const cap = await dialogState(page);
    expect(cap.fsa).toBe(false);
    expect(cap.canShare).toBe(false);

    await raiseDialog(page);
    await expect(page.getByTestId('storage-quota-dialog')).toBeVisible();
    await expect(page.getByText('本地存储空间不足')).toBeVisible();
    // 能力矩阵：无 Web Share → 有备份包按钮，无分享按钮。
    await expect(page.getByTestId('quota-action-export')).toBeVisible();
    await expect(page.getByTestId('quota-action-backup')).toBeVisible();
    await expect(page.getByTestId('quota-action-share')).toHaveCount(0);

    // 点「导出当前文档」→ 无 FSA 走 anchor 下载 .kbnote。
    const [dlKbnote] = await Promise.all([
      page.waitForEvent('download', { timeout: 15_000 }),
      page.getByTestId('quota-action-export').click(),
    ]);
    console.log('WAVE21_EXPORT_SUGGESTED', dlKbnote.suggestedFilename());
    expect(dlKbnote.suggestedFilename()).toMatch(/\.kbnote$/);

    // 重新拉起弹窗，点「下载整库备份」→ .kbpack。
    await raiseDialog(page);
    const [dlPack] = await Promise.all([
      page.waitForEvent('download', { timeout: 20_000 }),
      page.getByTestId('quota-action-backup').click(),
    ]);
    console.log('WAVE21_PACK_SUGGESTED', dlPack.suggestedFilename());
    expect(dlPack.suggestedFilename()).toMatch(/\.kbpack$/);

    await ctx.close();
  });

  test('stub 出 Web Share：弹窗出现「分享…」且真实调用 navigator.share', async ({ browser }) => {
    test.setTimeout(60_000);
    const ctx = await webKitShapeContext(browser, { stubShare: true });
    const page = await ctx.newPage();
    await waitForApp(page);

    expect(await page.evaluate(() => window.__drawpaper__!.webCanShare())).toBe(true);

    await raiseDialog(page);
    await expect(page.getByTestId('storage-quota-dialog')).toBeVisible();
    await expect(page.getByTestId('quota-action-share')).toBeVisible();
    await expect(page.getByTestId('quota-action-backup')).toHaveCount(0);

    await page.getByTestId('quota-action-share').click();
    await page.waitForFunction(() => (window as unknown as { __shareCalls: unknown[] }).__shareCalls.length > 0);
    const calls = await page.evaluate(() => (window as unknown as { __shareCalls: unknown[] }).__shareCalls);
    console.log('WAVE21_SHARE_CALLS', calls.length);
    expect(calls.length).toBe(1);

    await ctx.close();
  });

  test('关闭按钮：以后再说 关弹窗，不触发下载', async ({ browser }) => {
    const ctx = await webKitShapeContext(browser);
    const page = await ctx.newPage();
    await waitForApp(page);
    await raiseDialog(page);
    await expect(page.getByTestId('storage-quota-dialog')).toBeVisible();
    await page.getByTestId('quota-action-dismiss').click();
    await expect(page.getByTestId('storage-quota-dialog')).toHaveCount(0);
    await expect(await page.evaluate(() => window.__drawpaper__!.quotaDialogOpen())).toBe(false);
    await ctx.close();
  });
});
