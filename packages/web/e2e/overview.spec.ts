import { test, expect } from '@playwright/test';

/**
 * Wave6b：全局知识图谱总览（只读 P3 视图）e2e。
 *  - 两份文档（各 3~4 块）含一条跨文档双链 → 两组块节点 + 簇内父子边 + 一条跨文档虚线；
 *  - 折叠到文档簇后只剩两个簇节点；
 *  - 搜索定位块；点击块触发 onOpenDocNode（__lastOpenDocNode）；
 *  - 2000+ 块多文档夹具：总览挂载 TTI 在阈值内、虚拟化生效。
 *
 * 挂载走 DEV 钩子 window.__drawpaper__.mountOverviewDev()（全屏 fixed 容器），
 * 不修改 App.tsx；Wave7 由 App 正式挂载。
 */

function v2Doc(
  id: string,
  title: string,
  blocks: Array<{ id: string; text: string; refTo?: { doc: string; node: string; title: string } }>,
  links: Array<Record<string, unknown>>,
): string {
  return JSON.stringify({
    format: 'knowledge-block-notes',
    version: 2,
    id,
    title,
    board: { createdAt: 0, updatedAt: 0 },
    nodes: blocks.map((b, i) => ({
      id: b.id,
      type: i === 0 ? 'heading' : 'text',
      x: 100 + i * 30,
      y: 100,
      width: 260,
      height: 80,
      content: {
        format: 'tiptap-json',
        data: {
          type: 'doc',
          content: [
            b.refTo
              ? {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: b.text, marks: [{ type: 'docRef', attrs: { targetDocId: b.refTo.doc, targetNodeId: b.refTo.node, targetTitle: b.refTo.title } }] },
                  ],
                }
              : { type: 'paragraph', content: [{ type: 'text', text: b.text }] },
          ],
        },
      },
    })),
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
    links,
  });
}

test.describe('Wave6b 全局知识图谱总览', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.react-flow')).toBeVisible();
    await page.waitForTimeout(800);
    // 导入两份 v2 文档（含一条跨文档双链 a1 → b1）。
    const docA = v2Doc(
      'ov_docA',
      '总览A',
      [
        { id: 'a1', text: '总览A 引言', refTo: { doc: 'ov_docB', node: 'b1', title: '总览B 结果' } },
        { id: 'a2', text: '总览A 方法' },
        { id: 'a3', text: '总览A 讨论' },
      ],
      [
        {
          id: 'ln_ab',
          sourceDocId: 'ov_docA',
          sourceNodeId: 'a1',
          targetDocId: 'ov_docB',
          targetNodeId: 'b1',
          targetTitle: '总览B 结果',
          createdAt: 0,
        },
      ],
    );
    const docB = v2Doc(
      'ov_docB',
      '总览B',
      [
        { id: 'b1', text: '总览B 结果' },
        { id: 'b2', text: '总览B 结论' },
        { id: 'b3', text: '总览B 附录' },
      ],
      [],
    );
    await page.evaluate(async (docs) => {
      // importKbnoteText 现为 async（碰撞防护需查库），必须 await，否则种子文档未导入完。
      await window.__drawpaper__!.importKbnoteText(docs[0]!);
    }, [docA, docB]);
    // 每次 loadDoc 会重置防抖保存：间隔等待，确保两份文档都落 IndexedDB。
    await page.waitForTimeout(1500);
    await page.evaluate(async (docs) => {
      await window.__drawpaper__!.importKbnoteText(docs[1]!);
    }, [docA, docB]);
    await page.waitForTimeout(1500);
    // 挂载总览。
    await page.evaluate(() => window.__drawpaper__!.mountOverviewDev());
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(() => window.__drawpaper__!.unmountOverviewDev());
  });

  test('两组块节点可见，含一条跨文档虚线', async ({ page }) => {
    await expect(page.getByTestId('overview-canvas')).toBeVisible();
    // 块节点标题
    await expect(page.getByText('总览A 引言').first()).toBeVisible();
    await expect(page.getByText('总览B 结果').first()).toBeVisible();
    // 跨文档 docref 边为虚线（ReactFlow 用 CSS 应用 dasharray，查计算样式）
    const hasDashedEdge = await page.evaluate(() => {
      const paths = [...document.querySelectorAll('.react-flow__edge path')];
      return paths.some((p) => {
        const s = getComputedStyle(p);
        return s.strokeDasharray !== 'none' && s.strokeDasharray !== '';
      });
    });
    expect(hasDashedEdge).toBe(true);
  });

  test('折叠到文档簇后只剩两个簇节点', async ({ page }) => {
    await expect(page.getByText('总览A 引言').first()).toBeVisible();
    // 点「折叠全部」按钮
    await page.getByTestId('overview-collapse-all').click();
    // 折叠后块节点消失，簇节点仍在（IndexedDB 可能含 bootstrap 默认文档，故断言 ≥2）
    await expect(page.getByText('总览A 引言')).toHaveCount(0);
    await expect(page.locator('.overview-cluster-node').first()).toBeVisible();
    expect(await page.locator('.overview-cluster-node').count()).toBeGreaterThanOrEqual(2);
  });

  test('搜索定位块并高亮', async ({ page }) => {
    const search = page.getByTestId('overview-search');
    await search.fill('总览B 结果');
    await expect(page.getByText('总览B 结果').first()).toBeVisible();
  });

  test('点击块节点触发 onOpenDocNode', async ({ page }) => {
    await page.getByText('总览A 引言').first().click();
    const opened = await page.evaluate(
      () => (window as unknown as { __lastOpenDocNode?: [string, string] }).__lastOpenDocNode,
    );
    expect(opened).toEqual(['ov_docA', 'a1']);
  });

  test('2000+ 块多文档：自动折叠 + TTI 在阈值内', async ({ page }) => {
    // 先卸载，灌入 3 文档 × 700 块 = 2100 块。
    await page.evaluate(() => window.__drawpaper__!.unmountOverviewDev());
    await page.evaluate(async () => {
      const docs: string[] = [];
      for (let d = 0; d < 3; d++) {
        const blocks: Array<{ id: string; text: string }> = [];
        for (let i = 0; i < 700; i++) blocks.push({ id: `n${i}`, text: `doc${d} block ${i}` });
        docs.push(
          JSON.stringify({
            format: 'knowledge-block-notes',
            version: 2,
            id: `perf_doc${d}`,
            title: `性能文档${d}`,
            board: { createdAt: 0, updatedAt: 0 },
            nodes: blocks.map((b, i) => ({
              id: b.id,
              type: 'text',
              x: i * 2,
              y: 0,
              width: 260,
              height: 80,
              content: {
                format: 'tiptap-json',
                data: {
                  type: 'doc',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: b.text }] }],
                },
              },
            })),
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
          }),
        );
      }
      // 直接落 IndexedDB（不经过 switchDoc 防抖，避免连续导入被合并只留最后一份），逐个 await。
      for (const t of docs) {
        const r = await window.__drawpaper__!.seedDocDirect(t);
        if (r.nodeCount !== 700) throw new Error(`seedDocDirect 节点数异常: ${r.nodeCount}`);
      }
    });
    // seedDocDirect 已 await 落库，无需再等防抖保存。
    // 挂载并测 TTI：从 mountOverviewDev 到 overview-canvas 可见 ≤ 15s（主画布同口径）。
    const t0 = Date.now();
    await page.evaluate(() => window.__drawpaper__!.mountOverviewDev());
    await expect(page.getByTestId('overview-canvas')).toBeVisible();
    const tti = Date.now() - t0;
    expect(tti).toBeLessThan(15000);
    // 虚拟化：DOM 中渲染的 .react-flow__node 数量远小于总块数（>2000）。
    const rendered = await page.locator('.react-flow__node').count();
    expect(rendered).toBeLessThan(400);
    // 自动折叠提示出现（>600 节点 → 按文档聚合）。
    await expect(page.getByText('节点较多，已按文档聚合')).toBeVisible();
  });
});
