import { test, expect } from '@playwright/test';

/**
 * Wave33 A1：导入 id 碰撞防护 e2e。
 *  - 首次导入 .kbnote（id=doc_collide_e2e）→ 落库为该 id；
 *  - 再次导入同一文件 → 检测到同 id 碰撞，fork 为 fresh-id 副本（不覆盖原档）；
 *  - 原文档内容/标题未被改动，副本标题带「（导入副本）」后缀。
 *
 * 注意：App 启动有异步 bootstrap（listDocs/openRecent/newDoc）会在本钩子就绪后
 * 再切一次档；灌数据后必须先等当前文档 id 稳定、再显式 requestSave，
 * 否则自动保存会落在 bootstrap 切走后的文档上。
 */

function collideDoc(): string {
  return JSON.stringify({
    format: 'knowledge-block-notes',
    version: 4,
    id: 'doc_collide_e2e',
    title: '碰撞测试原档',
    board: { createdAt: 1000, updatedAt: 2000 },
    nodes: [
      {
        id: 'n_1',
        type: 'text',
        x: 100,
        y: 100,
        width: 260,
        height: 80,
        content: { format: 'tiptap-json', data: { type: 'doc' } },
      },
    ],
    edges: [],
    tags: [],
    layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
    viewport: { x: 0, y: 0, zoom: 1 },
    page: {
      size: 'A4',
      orientation: 'portrait',
      marginMm: 15,
      mode: 'fit',
      showPageBreak: true,
      colorMode: 'color',
      header: false,
      footer: false,
      showPageNumbers: false,
      edgeLabels: true,
      pageBreaks: [],
    },
    assetRefs: [],
    links: [],
    sync: { vv: {} },
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.react-flow')).toBeVisible();
  // 等待 bootstrap 初始序列落定。
  await page.waitForTimeout(1500);
});

test('double-import of same file yields two independent docs; original untouched', async ({ page }) => {
  const text = collideDoc();

  // 首次导入：无碰撞，当前文档切为 doc_collide_e2e。
  const first = await page.evaluate((t) => window.__drawpaper__!.importKbnoteText(t), text);
  expect(first.ok).toBe(true);
  if (first.ok) expect(first.collision).toBe(false);

  // 等 bootstrap 不再切档，再显式落盘。
  await expect
    .poll(async () => (await page.evaluate(() => window.__drawpaper__!.getState())).doc.id, {
      timeout: 5000,
    })
    .toBe('doc_collide_e2e');
  await page.evaluate(() => window.__drawpaper__!.invoke('requestSave'));
  await expect
    .poll(async () => (await page.evaluate(() => window.__drawpaper__!.getState())).saveState, {
      timeout: 5000,
    })
    .toBe('saved');

  // 第二次导入同一文件：碰撞 → fresh-id 副本。
  const second = await page.evaluate((t) => window.__drawpaper__!.importKbnoteText(t), text);
  expect(second.ok).toBe(true);
  if (second.ok) {
    expect(second.collision).toBe(true);
  }

  let st = await page.evaluate(() => window.__drawpaper__!.getState());
  expect(st.doc.id).not.toBe('doc_collide_e2e');
  expect(st.doc.id).toMatch(/^doc_/);
  expect(st.doc.title).toBe('碰撞测试原档（导入副本）');
  // 副本内部节点原样保留。
  expect(st.doc.nodes.map((n: { id: string }) => n.id)).toEqual(['n_1']);

  // 切回原档：内容/标题未被副本导入改动。
  await page.evaluate((id) => window.__drawpaper__!.invoke('openDoc', id), 'doc_collide_e2e');
  await page.waitForTimeout(300);
  st = await page.evaluate(() => window.__drawpaper__!.getState());
  expect(st.doc.id).toBe('doc_collide_e2e');
  expect(st.doc.title).toBe('碰撞测试原档');
  expect(st.doc.nodes).toHaveLength(1);
});
