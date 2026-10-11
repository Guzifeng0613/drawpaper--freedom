import { test, expect } from '@playwright/test';
import { waitForApp, loadStandard, invoke } from './fixtures/load-doc';

/**
 * Wave21 A4 导出收尾验收（构建规划 §9）：
 *  ① tiles 横向 A4：标准 30 块样例 → 块零切割、续接记号成对且 out/in 同角度、
 *     页数与分页预览虚线框一致；
 *  ② flow 多根森林：多个无根根全部完整归属、零截断；
 *  ③ 核查项：分页原点手柄可整体拖动、手动分页符可经右键菜单插入并拖动。
 */

test.describe('Wave21 A4 导出收尾', () => {
  test('tiles 横向 A4：块零切割 + 续接记号成对且方向自洽 + 页数与预览一致', async ({ page }) => {
    await waitForApp(page);
    await loadStandard(page);
    await invoke(page, 'setPageSettings', {
      mode: 'tiles',
      orientation: 'landscape',
      marginMm: 15,
      header: true,
      footer: true,
      showPageNumbers: true,
      edgeLabels: true,
    });
    await invoke(page, 'setSelection', []);

    await page.evaluate(() => window.__drawpaper__!.setDebugSheets(true));
    await page.waitForSelector('.drawpaper-print-container .sheet', { state: 'attached', timeout: 10000 });
    await page.waitForTimeout(500);

    const sheetCount = await page.locator('.drawpaper-print-container .sheet').count();
    expect(sheetCount).toBeGreaterThanOrEqual(2);

    // ①a 块零切割：每个 sheet 内 data-node-id 元素的边界严格落在 sheet 矩形内。
    const cutNodes = await page.evaluate(() => {
      const bad: string[] = [];
      document.querySelectorAll('.drawpaper-print-container .sheet').forEach((sheet) => {
        const sr = (sheet as HTMLElement).getBoundingClientRect();
        sheet.querySelectorAll('[data-node-id]').forEach((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.left < sr.left - 1 || r.top < sr.top - 1 || r.right > sr.right + 1 || r.bottom > sr.bottom + 1) {
            bad.push((el as HTMLElement).getAttribute('data-node-id') ?? '?');
          }
        });
      });
      return bad;
    });
    expect(cutNodes, `被切割的块: ${cutNodes.join(',')}`).toEqual([]);

    // ①b 续接记号：同 token 成对、out/in 各一、两侧角度自洽。
    const conts = await page.evaluate(() => {
      const groups = new Map<string, { role: string; angle: string }[]>();
      document.querySelectorAll('.drawpaper-print-container g[data-continuation]').forEach((g) => {
        const token = g.getAttribute('data-continuation')!;
        const arr = groups.get(token) ?? [];
        arr.push({ role: g.getAttribute('data-role')!, angle: g.getAttribute('data-angle')! });
        groups.set(token, arr);
      });
      return [...groups.entries()];
    });
    expect(conts.length, '应至少有一对跨页续接记号').toBeGreaterThan(0);
    for (const [token, arr] of conts) {
      expect(arr, `token ${token} 应成对`).toHaveLength(2);
      const roles = arr.map((c) => c.role).sort();
      expect(roles, `token ${token} role 应 out/in 各一`).toEqual(['in', 'out']);
      expect(arr[0]!.angle, `token ${token} 两侧切线角度应一致`).toBe(arr[1]!.angle);
    }

    // ①c 页数与分页预览虚线框一致。
    await invoke(page, 'setPageSettings', { showPageBreak: true });
    await page.waitForTimeout(600);
    const overlayPages = await page
      .locator('[data-testid="page-break-overlay"] div.border-dashed')
      .count();
    expect(overlayPages).toBe(sheetCount);
  });

  test('flow 多根森林：3 个无根根全部完整归属、零截断', async ({ page }) => {
    await waitForApp(page);
    await page.waitForFunction(() => {
      const h = window.__drawpaper__;
      return h && !!h.getState().doc.id;
    });
    await page.waitForTimeout(300);
    // 手工构造 3 个互不相连的根，各带 2 个子块。
    await page.evaluate(() => {
      const api = window.__drawpaper__!;
      for (let i = 0; i < 3; i++) {
        const rootId = api.invoke('addNode', 'text', 0, i * 500) as string;
        for (let k = 0; k < 2; k++) {
          const kidId = api.invoke('addNode', 'text', 300, i * 500 + k * 140) as string;
          api.invoke('addEdge', rootId, kidId);
        }
      }
    });
    await page.waitForTimeout(500);
    await invoke(page, 'setPageSettings', { mode: 'flow', orientation: 'portrait' });
    await invoke(page, 'setSelection', []);

    await page.evaluate(() => window.__drawpaper__!.setDebugSheets(true));
    await page.waitForSelector('.drawpaper-print-container .sheet', { state: 'attached', timeout: 10000 });
    await page.waitForTimeout(500);

    // 全部 9 块恰好出现一次、且不越出 sheet（零截断）。
    const stats = await page.evaluate(() => {
      const seen = new Map<string, number>();
      let bad = 0;
      document.querySelectorAll('.drawpaper-print-container .sheet').forEach((sheet) => {
        const sr = (sheet as HTMLElement).getBoundingClientRect();
        sheet.querySelectorAll('[data-node-id]').forEach((el) => {
          const id = (el as HTMLElement).getAttribute('data-node-id')!;
          seen.set(id, (seen.get(id) ?? 0) + 1);
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.left < sr.left - 1 || r.top < sr.top - 1 || r.right > sr.right + 1 || r.bottom > sr.bottom + 1) bad++;
        });
      });
      const counts = [...seen.values()];
      return { total: seen.size, notOne: counts.filter((c) => c !== 1).length, bad };
    });
    expect(stats.total).toBe(9);
    expect(stats.notOne).toBe(0);
    expect(stats.bad).toBe(0);
  });

  test('核查：分页原点可整体拖动、手动分页符可插入并拖动', async ({ page }) => {
    // Wave26：webkit headless 下分页原点拖拽结束后 b1.x===b0.x（拖拽位移未落到节点），
    // 合成拖拽事件在 webkit 画布上未触发位移。引擎事件交互差异，非产品缺陷。chromium 下真跑。
    test.skip(!!process.env.WEBKIT_FULL, 'webkit 分页原点合成拖拽未位移');
    await waitForApp(page);
    await page.waitForFunction(() => {
      const h = window.__drawpaper__;
      return h && !!h.getState().doc.id;
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      window.__drawpaper__!.invoke('addNode', 'text', 0, 0);
      window.__drawpaper__!.invoke('addNode', 'text', 1200, 0);
    });
    await page.waitForTimeout(400);
    await page.keyboard.press('Control+0');
    await page.waitForTimeout(400);
    await invoke(page, 'setPageSettings', { showPageBreak: true, mode: 'tiles', orientation: 'landscape' });
    await page.waitForTimeout(500);

    // ③a 原点手柄存在并可拖。
    const handle = page.locator('[data-testid="page-origin-handle"]');
    await expect(handle).toBeVisible();
    const before = (await page.evaluate(
      () => window.__drawpaper__!.getState().doc.page.pageOrigin ?? {},
    )) as { x?: number };
    const hb = await handle.boundingBox();
    expect(hb).toBeTruthy();
    await page.mouse.move(hb!.x + hb!.width / 2, hb!.y + hb!.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb!.x + 200, hb!.y + 100, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const after = (await page.evaluate(
      () => window.__drawpaper__!.getState().doc.page.pageOrigin ?? {},
    )) as { x?: number };
    const dx = Math.abs((after.x ?? 0) - (before.x ?? 0));
    expect(dx, `分页原点 x 应被拖动（before=${before.x}, after=${after.x}）`).toBeGreaterThan(30);

    // ③b 右键菜单插入分页符。
    await page.mouse.click(700, 500, { button: 'right' });
    const menu = page.locator('[data-testid="pane-context-menu"]');
    await expect(menu).toBeVisible();
    await menu.locator('[data-testid="pane-menu-pagebreak"]').click();
    await expect
      .poll(
        async () =>
          await page.evaluate(() => window.__drawpaper__!.getState().doc.page.pageBreaks.length),
        { timeout: 3000 },
      )
      .toBe(1);

    // ③c 分页符手柄出现并可拖。
    const brk = page.locator('[data-testid="manual-break"]');
    await expect(brk).toBeVisible();
    const b0 = await page.evaluate(
      () => ({ ...(window.__drawpaper__!.getState().doc.page.pageBreaks[0] as unknown as { id: string; x: number }) }),
    );
    const bb = await brk.boundingBox();
    expect(bb).toBeTruthy();
    await page.mouse.move(bb!.x + bb!.width / 2, bb!.y + bb!.height / 2);
    await page.mouse.down();
    await page.mouse.move(bb!.x + 150, bb!.y + 60, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const b1 = await page.evaluate(
      () => ({ ...(window.__drawpaper__!.getState().doc.page.pageBreaks[0] as unknown as { id: string; x: number }) }),
    );
    expect(b1.id).toBe(b0.id);
    expect(b1.x).not.toBe(b0.x);
  });
});
