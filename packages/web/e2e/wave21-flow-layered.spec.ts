import { test, expect, type Page } from '@playwright/test';
import { getState, invoke, waitForApp } from './fixtures/load-doc';

/**
 * Wave21 · flow-layered 逻辑流分层有向图 e2e。
 *
 * 断言：
 *  1. 工具栏「逻辑流」按钮可点 → ghost 整理预览出现；
 *  2. 应用后层级坐标关系：同根 y 单调（子 > 父）、同层 y 近似一致、节点 AABB 无重叠；
 *  3. 多根森林可用：两根同层同行且水平不重叠；
 *  4. 动画落位后可撤销还原（可撤销宏走既有管线）。
 */

interface Pt {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 读 store 中节点世界坐标。 */
async function nodesOf(page: Page): Promise<Pt[]> {
  const st = (await getState(page)) as { doc: { nodes: Pt[] } };
  return st.doc.nodes.map((n) => ({ ...n }));
}

/** 灌入两棵根树（多根森林）：n1→n2,n3；n2→n4；另起 m1→m2。 */
async function loadFlowDoc(page: Page): Promise<void> {
  // 与 loadStandard 同范式：waitForApp（只等 __drawpaper__ 就绪）后**立即** loadFixture，
  // 此时启动序列的异步 openDoc 尚未发生，fixture 直接占位成为当前文档；
  // 切勿先等 doc.id——welcome 临时文档已有 id，会落进「灌完被迟到 openDoc 覆盖」窗口。
  const loadOnce = () =>
    page.evaluate(() => {
      const mk = (id: string) => ({
        id,
        type: 'text',
        x: 0,
        y: 0,
        width: 200,
        height: 60,
        content: { format: 'tiptap-json', data: { type: 'doc', content: [] } },
        parentId: null,
        pinned: false,
        locked: false,
        collapsed: false,
        tags: [],
        style: {},
      });
      const doc = {
        format: 'knowledge-block-notes',
        version: 4,
        id: 'wave21-flow',
        title: 'wave21 flow',
        board: { createdAt: 0, updatedAt: 0 },
        nodes: ['n1', 'n2', 'n3', 'n4', 'm1', 'm2'].map((id) => mk(id)),
        edges: [
          { id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'right', targetHandle: 'left', label: '', directed: true, style: { color: '#94A3B8' } },
          { id: 'e2', source: 'n1', target: 'n3', sourceHandle: 'right', targetHandle: 'left', label: '', directed: true, style: { color: '#94A3B8' } },
          { id: 'e3', source: 'n2', target: 'n4', sourceHandle: 'right', targetHandle: 'left', label: '', directed: true, style: { color: '#94A3B8' } },
          { id: 'e4', source: 'm1', target: 'm2', sourceHandle: 'right', targetHandle: 'left', label: '', directed: true, style: { color: '#94A3B8' } },
        ],
        tags: [],
        layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
        viewport: { x: 0, y: 0, zoom: 1 },
        page: {
          size: 'A4',
          orientation: 'portrait',
          marginMm: 15,
          mode: 'fit',
          showPageBreak: false,
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
      };
      (window as unknown as { __drawpaper__: { loadFixture: (d: unknown) => void } }).__drawpaper__.loadFixture(doc);
    });

  // 有界轮询：确认 state 真为 wave21-flow 且 6 节点；被 bootstrap 迟到 openDoc 冲掉则重灌。
  const check = () =>
    page.evaluate(() => {
      const h = (window as unknown as { __drawpaper__?: { getState: () => { doc: { id: string; nodes: unknown[] } } } }).__drawpaper__;
      return !!h && h.getState().doc.id === 'wave21-flow' && h.getState().doc.nodes.length === 6;
    });

  // headless WebKitGTK 上 bootstrap 的异步 listDocs→openDoc/newDoc 序列比 chromium 更慢地
  // 后到，在 chromium 的 3 轮 / 10s 落位 / 2s 观察窗内仍会把 fixture 冲掉。仅在 WEBKIT_FULL
  // 下加大重灌轮次、落位 poll 与观察窗（引擎加固，不改任何断言意图）；chromium 路径保持原值。
  const webkitFull = !!process.env.WEBKIT_FULL;
  const maxAttempts = webkitFull ? 6 : 3;
  const settleMs = webkitFull ? 20_000 : 10_000;
  const observeMs = webkitFull ? 4_000 : 2_000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await loadOnce();
    // fixture 落位。
    await expect.poll(check, { timeout: settleMs }).toBe(true);
    // 观察窗：bootstrap 的 listDocs→newDoc/openDoc 是异步后到，可能把 fixture 冲掉；
    // 窗后复查仍为真才算稳，否则重灌（bootstrap 已在窗口内跑完，下轮落位即钉住）。
    await page.waitForTimeout(observeMs);
    if (await check()) break;
    if (attempt === maxAttempts - 1) {
      throw new Error('loadFlowDoc：fixture 被 bootstrap openDoc 连续多轮覆盖，state 未钉住');
    }
  }
  await page.keyboard.press('Control+0');
  await page.waitForTimeout(300);
}

test.describe('Wave21 · flow-layered 逻辑流分层', () => {
  test('工具栏一键整理：层级坐标正确、多根可用、可撤销还原', async ({ page }) => {
    await waitForApp(page);
    await loadFlowDoc(page);

    // 0) 记录整理前坐标（全部 0,0）。
    const before = await nodesOf(page);
    const beforeMap = new Map(before.map((n) => [n.id, { x: n.x, y: n.y }]));

    // 1) 点工具栏「逻辑流」→ 触发整理预览（ghost）。
    await page.getByRole('button', { name: /逻辑流/ }).click();
    await expect(page.getByText('应用', { exact: true })).toBeVisible({ timeout: 3000 });
    // 模式已写回 store。
    const st0 = (await getState(page)) as { doc: { layout: { mode: string } } };
    expect(st0.doc.layout.mode).toBe('flow-layered');

    // 2) 应用（250ms 缓动落位）。
    await page.getByText('应用', { exact: true }).click();
    await page.waitForTimeout(600);

    // 3) 断言层级坐标关系。
    const after = await nodesOf(page);
    const p = new Map(after.map((n) => [n.id, n]));
    expect(p.size).toBe(6);

    // 3a) 同根 y 单调：父 < 子（主树边）。
    expect(p.get('n1')!.y).toBeLessThan(p.get('n2')!.y);
    expect(p.get('n1')!.y).toBeLessThan(p.get('n3')!.y);
    expect(p.get('n2')!.y).toBeLessThan(p.get('n4')!.y);
    expect(p.get('m1')!.y).toBeLessThan(p.get('m2')!.y);

    // 3b) 同层 y 近似一致：rank0 = n1,m1；rank1 = n2,n3,m2；rank2 = n4。
    const approx = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(2);
    approx(p.get('n1')!.y, p.get('m1')!.y);
    approx(p.get('n2')!.y, p.get('n3')!.y);
    approx(p.get('n2')!.y, p.get('m2')!.y);
    // rank2 明显低于 rank1。
    expect(p.get('n4')!.y - p.get('n2')!.y).toBeGreaterThan(40);

    // 3c) 多根：两根水平不重叠（x 间距 ≥ 块宽）。
    expect(Math.abs(p.get('n1')!.x - p.get('m1')!.x)).toBeGreaterThanOrEqual(190);

    // 3d) 无节点重叠（AABB）。
    const arr = [...p.values()];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i]!;
        const b = arr[j]!;
        const overlap =
          a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap, `节点 ${a.id} 与 ${b.id} 不应重叠`).toBe(false);
      }
    }

    // 4) 撤销还原：坐标回到整理前。
    await invoke(page, 'undo');
    await page.waitForTimeout(500);
    const undone = await nodesOf(page);
    for (const n of undone) {
      const b = beforeMap.get(n.id)!;
      expect(n.x, `undo 后 ${n.id} x 应还原`).toBe(b.x);
      expect(n.y, `undo 后 ${n.id} y 应还原`).toBe(b.y);
    }
  });
});
