import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './fixtures/load-doc';

/**
 * Wave20 OPFS 降级 — (f) 正常上下文不回退：OPFS 可用时拖入图片走 assetRef（64-hex）。
 *
 * 从 wave20-opfs-degraded.spec.ts 抽出单独成文件，原因（Wave26 全量 WebKit 覆盖取证）：
 * 本用例硬断言「OPFS 真可用 + 图片落 OPFS assetRef」。headless Linux WebKitGTK 上
 * `navigator.storage.getDirectory` 函数存在（capability 取证 ::warning：getDirectory=true、
 * opfsAvailable()=true），但实际 OPFS 后端写入会 reject，产品按 image-pipeline 正确降级为
 * data: URL 内联——故 src 不会是 64-hex assetRef。这是「测试与引擎耦合」（headless WebKit
 * 无可用 OPFS 持久化后端），不是产品缺陷：产品降级路径本身在 wave20-opfs-degraded 的
 * 模式 A/B 用例里真跑验证。chromium 下本文件照常真跑（OPFS 可用）；webkit-full config 把
 * 本文件 testIgnore（见 playwright.webkit.full.config.ts 排除区注释）。
 */

// 1x1 红点 PNG（合法最小 PNG，canvas 可解码）。
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function dropPng(page: Page): Promise<void> {
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'dropped.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const pane = document.querySelector('.react-flow__pane') as HTMLElement;
    pane.dispatchEvent(
      new DragEvent('drop', {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
        clientX: 500,
        clientY: 400,
      }),
    );
  }, PNG_B64);
}

async function dropPngAndWait(page: Page, minCount = 1) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await dropPng(page);
    try {
      await page.waitForFunction(
        (n) => window.__drawpaper__!.getState().doc.nodes.filter((x) => x.type === 'image' && !!x.image?.src).length >= n,
        minCount,
        { timeout: 8_000 },
      );
      return;
    } catch {
      // 重投一次。
    }
  }
  await page.waitForFunction(
    (n) => window.__drawpaper__!.getState().doc.nodes.filter((x) => x.type === 'image' && !!x.image?.src).length >= n,
    minCount,
    { timeout: 30_000 },
  );
}

test.describe('Wave20 OPFS 降级 — (f) 正常上下文不回退', () => {
  test('不注入覆写：opfsAvailable=true，拖入图片走 OPFS assetRef', async ({ page }) => {
    await waitForApp(page);
    expect(await page.evaluate(() => window.__drawpaper__!.opfsAvailable())).toBe(true);

    await dropPngAndWait(page, 1);
    const src = await page.evaluate(() => {
      const nodes = window.__drawpaper__!.getState().doc.nodes;
      const img = nodes.find((n) => n.type === 'image')!;
      return img.image!.src;
    });
    // OPFS 正常：src 是 64-hex assetRef，不是 data:。
    expect(src.startsWith('data:')).toBe(false);
    expect(src).toMatch(/^[0-9a-f]{64}$/);
  });
});
