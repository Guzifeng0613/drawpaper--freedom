import { test, expect } from '@playwright/test';

/**
 * Wave5b 收口：附件 OPFS 上传 / 触屏长按连线 / 表格合并拆分按钮。
 * 时序下沉 gesture 单测；e2e 只做主路径与 DEV 钩子断言。
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.react-flow')).toBeVisible();
  await page.waitForFunction(() => {
    const h = window.__drawpaper__;
    return h && !!h.getState().doc.id;
  });
  await page.waitForTimeout(300);
});

test.describe('附件 OPFS 上传', () => {
  test('上传真实 txt → 卡片显示文件名 → assetRefs 登记且 OPFS 落盘 → 刷新仍在', async ({ page }) => {
    // Wave26：headless WebKitGTK OPFS 后端写入 reject（取证 getDirectory=true 但写入失败），
    // 附件不登记 assetRefs（产品正确走 toast 降级）。引擎耦合，chromium 下真跑。
    test.skip(!!process.env.WEBKIT_FULL, 'webkit OPFS 后端不可写→附件不登记 assetRefs');
    const opfsReady = await page.evaluate(() => window.__drawpaper__!.opfsAvailable());
    // 造一个附件块
    await page.evaluate(() => {
      window.__drawpaper__!.invoke('addNode', 'attachment', 100, 100);
    });
    await page.waitForTimeout(300);

    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByText('上传附件').click();
    const chooser = await chooserPromise;
    await chooser.setFiles({
      name: 'note.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello drawpaper attachment'),
    });

    // 卡片显示文件名（OPFS 异步落盘，给足等待）
    await expect(page.getByText('note.txt').first()).toBeVisible({ timeout: 10000 });

    if (opfsReady) {
      // assetRefs 已登记
      const refs = await page.evaluate(() => window.__drawpaper__!.listAssetRefs());
      expect(refs.length).toBeGreaterThan(0);
      // OPFS 中真有该 blob
      const has = await page.evaluate(async () => {
        const r = window.__drawpaper__!.listAssetRefs()[0];
        return r ? window.__drawpaper__!.opfsHasAsset(r) : false;
      });
      expect(has).toBe(true);
    }

    // 刷新后附件卡片仍在（Dexie 持久化）；先等防抖保存落盘再 reload
    await page.waitForTimeout(1500);
    await page.reload();
    await page.waitForFunction(() => {
      const h = window.__drawpaper__;
      return h && !!h.getState().doc.id;
    });
    await expect(page.getByText('note.txt').first()).toBeVisible({ timeout: 10000 });
  });
});

test.describe('触屏长按起连线', () => {
  test('触屏长按 source 连接点 → 出现跟随线 → 拖到目标块松手 → 新增父子边', async ({ page }) => {
    // 造两个块：A(source) 与 B(target)
    await page.evaluate(() => {
      window.__drawpaper__!.invoke('addNode', 'text', 50, 200);
      window.__drawpaper__!.invoke('addNode', 'text', 500, 200);
    });
    await page.waitForTimeout(400);

    const edgesBefore = await page.evaluate(() => window.__drawpaper__!.getState().doc.edges.length);

    // 取 A 右侧 source handle 的屏幕中心
    const handleBox = await page
      .locator('.react-flow__node')
      .first()
      .locator('.react-flow__handle-right')
      .boundingBox();
    const targetBox = await page.locator('.react-flow__node').nth(1).boundingBox();
    expect(handleBox).toBeTruthy();
    expect(targetBox).toBeTruthy();

    const hx = handleBox!.x + handleBox!.width / 2;
    const hy = handleBox!.y + handleBox!.height / 2;
    const tx = targetBox!.x + targetBox!.width / 2;
    const ty = targetBox!.y + targetBox!.height / 2;

    // 派发 touch PointerEvent 序列（pointerType=touch），模拟长按 500ms 后拖动
    await page.evaluate(
      async ({ hx, hy, tx, ty }) => {
        const target = document.elementFromPoint(hx, hy) as Element;
        const pid = 777;
        const down = new PointerEvent('pointerdown', { pointerType: 'touch', pointerId: pid, clientX: hx, clientY: hy, bubbles: true });
        target.dispatchEvent(down);
        await new Promise((r) => setTimeout(r, 600)); // 等长按触发
        const move = new PointerEvent('pointermove', { pointerType: 'touch', pointerId: pid, clientX: tx, clientY: ty, bubbles: true });
        window.dispatchEvent(move);
        await new Promise((r) => setTimeout(r, 50));
        const up = new PointerEvent('pointerup', { pointerType: 'touch', pointerId: pid, clientX: tx, clientY: ty, bubbles: true });
        window.dispatchEvent(up);
      },
      { hx, hy, tx, ty },
    );
    await page.waitForTimeout(400);

    const edgesAfter = await page.evaluate(() => window.__drawpaper__!.getState().doc.edges.length);
    expect(edgesAfter).toBe(edgesBefore + 1);
  });
});

test.describe('表格合并/拆分按钮', () => {
  test('插入表格后编辑态工具条含合并/拆分按钮（无多选时合并禁用）', async ({ page }) => {
    await page.evaluate(() => {
      window.__drawpaper__!.invoke('addNode', 'table', 100, 100);
    });
    await page.waitForTimeout(300);
    // 双击进入编辑态
    await page.locator('.react-flow__node').first().dblclick();
    await page.waitForTimeout(400);
    // 工具条出现合并/拆分按钮
    await expect(page.getByRole('button', { name: /合并/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /拆分/ })).toBeVisible();
    // 普通光标下合并按钮禁用
    await expect(page.getByRole('button', { name: /合并/ })).toBeDisabled();
  });
});
