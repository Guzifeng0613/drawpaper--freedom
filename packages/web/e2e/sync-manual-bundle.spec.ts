import { test, expect, type Page } from '@playwright/test';

/**
 * Wave11 阶段 B 手动备份包 + 冲突副本处理 e2e。
 *
 * 覆盖：
 *  ① 导出 kbpack → 清空库 → 导入合并还原（多文档 + 资产）；
 *  ② 制造 conflicted 副本后三动作：打开预览 / 以此副本为准（内容生效）/ 丢弃（列表清空）；
 *  ③ 无 FSA 环境（注入 showDirectoryPicker=undefined）下面板高亮推荐手动通道；
 *  ④ 单个 .kbnote 导入仍可用（真实 parse+loadDoc 路径）。
 */

const waitBoot = async (page: Page) => {
  await page.goto('/');
  await expect(page.locator('.react-flow')).toBeVisible();
  await page.waitForFunction(() => {
    const h = window.__drawpaper__;
    return h && !!h.getState().doc.id;
  });
  await page.waitForTimeout(300);
};

const openSyncPanel = async (page: Page) => {
  await page.getByTestId('open-sync').click();
  await expect(page.getByTestId('channel-folder')).toBeVisible();
  // 首次引导弹层会盖住面板：点掉它（可跳过）。
  const skip = page.getByTestId('onboard-skip');
  if (await skip.isVisible().catch(() => false)) await skip.click();
};

const nodeText = (page: Page) =>
  page.evaluate(() => {
    const n = window.__drawpaper__!.getState().doc.nodes[0];
    return JSON.stringify(n?.content?.data ?? '');
  });

test.describe('Wave11 阶段 B 手动备份包 + 冲突副本', () => {
  test('① 导出 kbpack → 清空库 → 导入合并还原（多文档 + 资产）', async ({ page }) => {
    // Wave26：用例经 opfsSeedAsset 播种资产字节；headless WebKitGTK OPFS 后端写入抛
    // UnknownError（取证），无法播种资产。引擎耦合，chromium 下真跑。
    test.skip(!!process.env.WEBKIT_FULL, 'webkit OPFS 播种资产抛 UnknownError');
    await waitBoot(page);

    // 建两个文档：doc1 带一个资产引用。
    await page.evaluate(() => {
      const h = window.__drawpaper__!;
      const id = h.invoke('addNode', 'text', 100, 100) as string;
      h.invoke('updateContent', id, { type: 'doc', content: [{ type: 'paragraph', text: '文档一内容' }] });
      h.invoke('requestSave');
    });
    const docId1 = await page.evaluate(() => window.__drawpaper__!.getState().doc.id);

    // 给 doc1 挂一个资产 ref，并把资产字节播进 OPFS。
    await page.evaluate(async () => {
      const h = window.__drawpaper__!;
      // 一张最小 PNG（1x1）的 base64。
      await h.opfsSeedAsset('asset-seed-1', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
      // 把 asset-seed-1 登记进当前文档 assetRefs（state 数组冻结，需克隆后 loadDoc）。
      const s = h.getState();
      const doc = structuredClone(s.doc);
      doc.assetRefs = [...doc.assetRefs, 'asset-seed-1'];
      h.invoke('loadDoc', doc);
      h.invoke('requestSave');
    });
    expect(await page.evaluate(() => window.__drawpaper__!.opfsHasAsset('asset-seed-1'))).toBe(true);

    // 新建第二个文档。
    await page.evaluate(() => {
      const h = window.__drawpaper__!;
      h.invoke('newDoc');
      const id = h.invoke('addNode', 'text', 100, 100) as string;
      h.invoke('updateContent', id, { type: 'doc', content: [{ type: 'paragraph', text: '文档二内容' }] });
      h.invoke('requestSave');
    });
    const docId2 = await page.evaluate(() => window.__drawpaper__!.getState().doc.id);

    // 导出 kbpack（base64）。
    const b64 = await page.evaluate(() => window.__drawpaper__!.syncExportKbpack());
    expect(b64.length).toBeGreaterThan(100);

    // 清空库 + 删掉 OPFS 资产（验证导入能真正回填）。
    await page.evaluate(() => window.__drawpaper__!.syncWipeAllDocs());
    await page.evaluate(() => window.__drawpaper__!.opfsRemoveAsset('asset-seed-1'));
    await page.evaluate(() => window.__drawpaper__!.invoke('newDoc'));
    await page.waitForFunction(() => window.__drawpaper__!.getState().nodeCount === 0);
    expect(await page.evaluate(() => window.__drawpaper__!.opfsHasAsset('asset-seed-1'))).toBe(false);

    // 导入合并。
    const summary = await page.evaluate((b) => window.__drawpaper__!.syncImportKbpack(b), b64);
    expect(summary).toMatchObject({ totalDocs: 2 });

    // 还原：打开 doc1，看到内容与资产；doc2 也在。
    await page.evaluate((id) => window.__drawpaper__!.invoke('openDoc', id), docId1);
    await expect.poll(() => page.evaluate(() => window.__drawpaper__!.getState().nodeCount), { timeout: 5000 }).toBe(1);
    await expect.poll(() => nodeText(page)).toContain('文档一内容');
    expect(await page.evaluate(() => window.__drawpaper__!.opfsHasAsset('asset-seed-1'))).toBe(true);

    await page.evaluate((id) => window.__drawpaper__!.invoke('openDoc', id), docId2);
    await expect.poll(() => page.evaluate(() => window.__drawpaper__!.getState().nodeCount), { timeout: 5000 }).toBe(1);
    await expect.poll(() => nodeText(page)).toContain('文档二内容');
  });

  test('② 冲突副本三动作：预览 / 以此为准 / 丢弃', async ({ page }) => {
    await waitBoot(page);

    // 当前文档内容 = 原始。
    await page.evaluate(() => {
      const h = window.__drawpaper__!;
      const id = h.invoke('addNode', 'text', 100, 100) as string;
      h.invoke('updateContent', id, { type: 'doc', content: [{ type: 'paragraph', text: '原始内容' }] });
      h.invoke('requestSave');
    });
    const docId = await page.evaluate(() => window.__drawpaper__!.getState().doc.id);

    // 造一个同 docId、内容为「副本内容」的冲突副本 .kbnote。
    const copyText = await page.evaluate(() => {
      const s = window.__drawpaper__!.getState();
      const doc = structuredClone(s.doc);
      doc.nodes[0]!.content.data = { type: 'doc', content: [{ type: 'paragraph', text: '副本内容' }] };
      doc.title = '冲突文档';
      return JSON.stringify(doc);
    });
    await page.evaluate(({ id, text }) => window.__drawpaper__!.syncSeedConflictCopy(id, '冲突文档', text), { id: docId, text: copyText });

    // 打开同步面板 → 打开冲突面板，看到一行。全程待在主对话框内（open-conflict-panel 是其内部按钮）。
    await openSyncPanel(page);
    await page.getByTestId('open-conflict-panel').click();
    await expect(page.getByTestId('conflict-row')).toHaveCount(1);
    await expect(page.getByTestId('conflict-title')).toHaveText('冲突文档');

    // (a) 打开预览 → 新开一个预览文档（标题带 [副本预览]）；关掉冲突面板，回到原文档。
    await page.getByTestId('conflict-preview').first().click();
    await expect.poll(() => page.evaluate(() => window.__drawpaper__!.getState().doc.title), { timeout: 5000 }).toContain('[副本预览]');
    await page.getByTestId('conflict-close').click();
    await page.evaluate((id) => window.__drawpaper__!.invoke('openDoc', id), docId);

    // 再开冲突面板（useEffect 重新拉取）→ 采纳副本为准。
    await page.getByTestId('open-conflict-panel').click();
    await expect(page.getByTestId('conflict-row')).toHaveCount(1);
    await page.getByTestId('conflict-adopt').first().click();
    // 采纳后该行从列表消失，且原文档内容变为副本内容。
    await expect.poll(() => page.evaluate(() => window.__drawpaper__!.syncListConflictCopies()), { timeout: 5000 }).toHaveLength(0);
    await expect.poll(() => nodeText(page)).toContain('副本内容');
    await page.getByTestId('conflict-close').click();

    // (b) 丢弃：再 seed 一条，重开面板后点丢弃，列表清空。
    await page.evaluate(({ id, text }) => window.__drawpaper__!.syncSeedConflictCopy(id, '待丢弃副本', text), { id: docId, text: copyText });
    await expect.poll(() => page.evaluate(() => window.__drawpaper__!.syncListConflictCopies())).toHaveLength(1);
    await page.getByTestId('open-conflict-panel').click();
    await expect(page.getByTestId('conflict-row')).toHaveCount(1);
    await page.getByTestId('conflict-discard').first().click();
    await expect.poll(() => page.evaluate(() => window.__drawpaper__!.syncListConflictCopies()), { timeout: 5000 }).toHaveLength(0);
    await expect(page.getByTestId('conflict-list-empty')).toBeVisible();
  });

  test('③ 无 FSA 环境下面板高亮推荐手动通道', async ({ page }) => {
    await waitBoot(page);
    // 移除 showDirectoryPicker → 模拟不支持 FSA 的浏览器。
    await page.evaluate(() => window.__drawpaper__!.setFsaSupported(false));

    await openSyncPanel(page);
    // 手动通道卡片出现「推荐」徽标；文件夹卡片置灰。
    await expect(page.getByTestId('manual-recommend')).toBeVisible();
    await expect(page.getByTestId('channel-manual')).toHaveClass(/border-primary/);
    // 点选手动通道 → 出现导出/导入按钮。
    await page.getByTestId('channel-manual').click();
    await expect(page.getByTestId('manual-panel')).toBeVisible();
    await expect(page.getByTestId('bundle-export')).toBeVisible();
    await expect(page.getByTestId('bundle-import')).toBeVisible();

    // 恢复 FSA（避免影响后续用例）。
    await page.evaluate(() => window.__drawpaper__!.setFsaSupported(true));
  });

  test('④ 单个 .kbnote 导入仍可用（真实 parse 路径）', async ({ page }) => {
    await waitBoot(page);
    const v3 = JSON.stringify({
      format: 'knowledge-block-notes',
      version: 4,
      id: 'single-import-doc',
      title: '单文件导入',
      board: { createdAt: 1000, updatedAt: 2000 },
      nodes: [
        { id: 'sn1', type: 'text', x: 0, y: 0, width: 200, height: 80, content: { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', text: '单文件导入的块' }] } }, parentId: null, tags: [] },
      ],
      edges: [],
      tags: [],
      layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
      viewport: { x: 0, y: 0, zoom: 1 },
      page: { size: 'A4', orientation: 'portrait', marginMm: 15, mode: 'fit', showPageBreak: true, colorMode: 'color', header: false, footer: false, showPageNumbers: false, edgeLabels: true, pageBreaks: [] },
      assetRefs: [],
      links: [],
      sync: { vv: {} },
    });
    const res = await page.evaluate((text) => window.__drawpaper__!.importKbnoteText(text), v3);
    expect(res).toMatchObject({ ok: true, version: 4 });
    await expect.poll(() => page.evaluate(() => window.__drawpaper__!.getState().doc.title)).toBe('单文件导入');
    await expect.poll(() => nodeText(page)).toContain('单文件导入的块');
  });
});
