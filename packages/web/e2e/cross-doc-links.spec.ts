import { test, expect } from '@playwright/test';

/**
 * Wave6b 跨文档双向链接 e2e：
 * - docA 块内 docRef mark → 保存后 flushSave 重建 doc.links；
 * - 导出 .kbnote 含 links，重新导入仍在；
 * - 反链查询在 docB 侧看到 docA 来链；
 * - 删除 docB 后 docA 的链接记录保留不丢。
 *
 * 注意：page.evaluate 运行在浏览器上下文，构造函数必须写在内部。
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.react-flow')).toBeVisible();
  await page.waitForFunction(() => window.__drawpaper__ && !!window.__drawpaper__.getState().doc.id);
  await page.waitForTimeout(300);
});

/** 在浏览器侧构造并 loadFixture 一份单块文档；带 refMark 时块内嵌 docRef mark。 */
async function seedDoc(
  page: import('@playwright/test').Page,
  doc: { id: string; title: string; blockId: string; text: string; ref?: { targetDocId: string; targetNodeId: string; targetTitle: string } },
) {
  await page.evaluate((d) => {
    const h = window.__drawpaper__!;
    const marks = d.ref
      ? [{ type: 'docRef', attrs: {
          targetDocId: d.ref!.targetDocId, targetNodeId: d.ref!.targetNodeId, targetTitle: d.ref!.targetTitle,
        } }]
      : [];
    const fixture = {
      format: 'knowledge-block-notes' as const, version: 2 as const, id: d.id, title: d.title,
      board: { createdAt: Date.now(), updatedAt: Date.now() },
      nodes: [{
        id: d.blockId, type: 'text' as const, x: 0, y: 0, width: 260, height: 80,
        content: { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: d.text, marks }] }] } },
        parentId: null, pinned: false, locked: false, collapsed: false, tags: [], style: {},
      }],
      edges: [], tags: [],
      layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
      viewport: { x: 0, y: 0, zoom: 1 },
      page: { size: 'A4', orientation: 'portrait', marginMm: 15, mode: 'fit', showPageBreak: true, colorMode: 'color', header: false, footer: false, showPageNumbers: false, edgeLabels: true, pageBreaks: [] },
      assetRefs: [], links: [],
    };
    h.loadFixture(fixture as unknown as Parameters<typeof h.loadFixture>[0]);
    h.invoke('requestSave');
  }, doc);
  await page.waitForTimeout(600);
}

test('docRef mark 保存后重建 links；导出/导入持久化；反链可见；删除后链接不丢', async ({ page }) => {
  // 1) 落库 docB（目标文档）。
  await seedDoc(page, { id: 'doc_B', title: '目标文档B', blockId: 'n_B1', text: '目标块B' });

  // 2) 落库 docA（含指向 docB/n_B1 的 docRef mark）。
  await seedDoc(page, {
    id: 'doc_A', title: '来源文档A', blockId: 'n_A1', text: '看 [[目标块B]]',
    ref: { targetDocId: 'doc_B', targetNodeId: 'n_B1', targetTitle: '目标块B' },
  });

  // 3) flushSave 已从正文 mark 重建 links。
  const linkCount = await page.evaluate(() => window.__drawpaper__!.currentLinks().length);
  expect(linkCount).toBe(1);

  // 4) 导出文本含 links；同 id 再导入 → 碰撞 fork 为副本（不覆盖原档）。
  const exported = await page.evaluate(() => window.__drawpaper__!.exportCurrent());
  expect(exported).toContain('"links"');
  const reimported = await page.evaluate((text) => window.__drawpaper__!.importKbnoteText(text), exported);
  expect(reimported.ok).toBe(true);
  if (reimported.ok) expect(reimported.collision).toBe(true);

  // 副本内链接仍在、target 不丢；sourceDocId 已改写为副本新 id。
  const forkId = (await page.evaluate(() => window.__drawpaper__!.getState())).doc.id;
  expect(forkId).not.toBe('doc_A');
  const forkLinks = await page.evaluate(() => window.__drawpaper__!.currentLinks());
  expect(forkLinks).toHaveLength(1);
  expect((forkLinks[0] as { targetDocId: string }).targetDocId).toBe('doc_B');
  expect((forkLinks[0] as { targetNodeId: string }).targetNodeId).toBe('n_B1');
  expect((forkLinks[0] as { targetTitle: string }).targetTitle).toBe('目标块B');
  expect((forkLinks[0] as { sourceDocId: string }).sourceDocId).toBe(forkId);

  // 5) docB 侧反链：原档与副本各贡献一条——sourceDocId 分别是旧 id 与新副本 id
  //    （不是两条都旧 id；fork 已把 link.sourceDocId 改写为新 doc id）。
  const backlinks = await page.evaluate(() => window.__drawpaper__!.backlinksTo('doc_B', 'n_B1'));
  expect(backlinks).toHaveLength(2);
  const sources = backlinks
    .map((b) => (b as { sourceDocId: string }).sourceDocId)
    .sort();
  expect(sources).toEqual(['doc_A', forkId].sort());

  // 6) 删除 docB → docA 的链接记录保留不丢。
  await page.evaluate(() => window.__drawpaper__!.invoke('deleteDoc', 'doc_B'));
  await page.waitForTimeout(400);
  await seedDoc(page, {
    id: 'doc_A', title: '来源文档A', blockId: 'n_A1', text: '看 [[目标块B]]',
    ref: { targetDocId: 'doc_B', targetNodeId: 'n_B1', targetTitle: '目标块B' },
  });
  const retained = await page.evaluate(() => window.__drawpaper__!.currentLinks());
  expect(retained).toHaveLength(1);
  expect((retained[0] as { targetDocId: string }).targetDocId).toBe('doc_B');
});

test('删除目标文档后，docA 静态 chip 出现 is-dangling 且链接记录保留', async ({ page }) => {
  await seedDoc(page, { id: 'doc_B', title: '目标B', blockId: 'n_B1', text: '目标块' });
  await seedDoc(page, {
    id: 'doc_A', title: '来源A', blockId: 'n_A1', text: '看 [[目标]]',
    ref: { targetDocId: 'doc_B', targetNodeId: 'n_B1', targetTitle: '目标块' },
  });

  // 打开 docA：chip 可见且未悬挂。
  await page.evaluate(() => window.__drawpaper__!.invoke('openDoc', 'doc_A'));
  await page.waitForTimeout(600);
  let chip = page.locator('.drawpaper-docref').first();
  await expect(chip).toBeVisible();
  await expect(chip).not.toHaveClass(/is-dangling/);

  // 删除 docB（存储路径），再回 docA。
  await page.evaluate(() => window.__drawpaper__!.invoke('deleteDoc', 'doc_B'));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__drawpaper__!.invoke('openDoc', 'doc_A'));
  await page.waitForTimeout(800);
  chip = page.locator('.drawpaper-docref').first();
  await expect(chip).toHaveClass(/is-dangling/);

  // 链接记录仍在。
  const links = await page.evaluate(() => window.__drawpaper__!.currentLinks());
  expect(links).toHaveLength(1);
});

test('删除被引用文档：确认框列出反链影响；取消不删，确认后删除', async ({ page }) => {
  await seedDoc(page, { id: 'doc_B', title: '被引用B', blockId: 'n_B1', text: '目标块' });
  await seedDoc(page, {
    id: 'doc_A', title: '引用A', blockId: 'n_A1', text: '看 [[x]]',
    ref: { targetDocId: 'doc_B', targetNodeId: 'n_B1', targetTitle: '目标块' },
  });
  await page.evaluate(() => window.__drawpaper__!.invoke('openDoc', 'doc_A'));
  await page.waitForTimeout(400);

  const row = page.locator('aside div.group', { hasText: '被引用B' }).first();
  await row.hover();
  await row.locator('button[title="删除"]').click();

  // 确认框列出影响数量与来源。
  await expect(page.getByText('将有 1 处引用变为悬挂')).toBeVisible();
  await expect(page.getByText('《引用A》')).toBeVisible();

  // 取消 → 文档仍在。
  await page.getByRole('button', { name: '取消' }).click();
  await expect(row).toBeVisible();

  // 再次删除 → 确认 → 删除。
  await row.hover();
  await row.locator('button[title="删除"]').click();
  await expect(page.getByText('将有 1 处引用变为悬挂')).toBeVisible();
  await page.locator('[role=dialog]').getByRole('button', { name: '删除' }).click();
  await page.waitForTimeout(500);
  await expect(page.locator('aside div.group', { hasText: '被引用B' })).toHaveCount(0);
});
