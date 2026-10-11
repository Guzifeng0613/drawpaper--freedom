import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { waitForApp, loadStandard, invoke } from './fixtures/load-doc';

/**
 * Wave11 阶段 C：axe-core 自动化无障碍扫描固化（chromium，DEV server）。
 *
 * 扫描目标（每个目标单独跑一次 AxeBuilder）：
 *  - 主画布：空文档 / 有内容 / 深色模式 三态；
 *  - 导出对话框；
 *  - 同步设置面板（SyncSettingsDialog，含 WebDAV 加密区）；
 *  - AI diff 面板（route mock OpenAI 兼容端点，真实 run→setDiff 路径）；
 *  - 大纲面板；
 *  - 文档列表面板。
 *
 * 验收口径：
 *  - critical / serious 违规必须为 0（发现即修源码）；
 *  - moderate 允许存在，但逐条记入 docs/wave11/a11y-axe.md 已知清单；
 *  - 深色画布 :focus-visible 焦点环对比度须 ≥3:1（计算样式比对）。
 *
 * 面板控件一律用 role / 可访问名 / data-testid 定位，不依赖临时 class 或 DOM 层级
 * （降低与并行「引导式三通道」改造的合并摩擦）。
 */

interface ViolationBrief {
  id: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical' | null | undefined;
  help: string;
  nodeCount: number;
  samples: string[];
  html?: string;
}

async function scan(page: Page): Promise<ViolationBrief[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodeCount: v.nodes.length,
    samples: v.nodes.slice(0, 3).map(
      (n) => `${n.target.join(' ')} || ${(n.failureSummary ?? '').split('\n').slice(0, 5).join(' / ')}`,
    ),
    html: v.nodes[0]?.html ?? '',
  }));
}

/** 按 impact 分桶。 */
function bucket(list: ViolationBrief[]) {
  const crit = list.filter((v) => v.impact === 'critical');
  const serious = list.filter((v) => v.impact === 'serious');
  const moderate = list.filter((v) => v.impact === 'moderate');
  const minor = list.filter((v) => v.impact === 'minor');
  return { crit, serious, moderate, minor };
}

/** 断言一个目标：critical+serious 必须为 0；moderate 打印出来供入档。 */
async function assertTarget(page: Page, label: string) {
  const list = await scan(page);
  const { crit, serious, moderate, minor } = bucket(list);
  console.log(`\n=== axe scan: ${label} ===`);
  for (const v of list) {
    console.log(`  [${v.impact ?? 'none'}] ${v.id} (${v.nodeCount}x) ${v.help}`);
    if (v.html) console.log(`      html: ${v.html.slice(0, 220)}`);
  }
  if (crit.length || serious.length) {
    const bad = [...crit, ...serious];
    throw new Error(
      `axe: ${label} 存在 ${bad.length} 个 critical/serious 违规：\n` +
        bad.map((v) => `  - [${v.impact}] ${v.id}: ${v.help}\n    例: ${v.samples.join(' | ')}`).join('\n'),
    );
  }
  return { moderate, minor, total: list.length };
}

async function freshCanvas(page: Page, opts: { dark?: boolean } = {}) {
  if (opts.dark) {
    await page.addInitScript(() => localStorage.setItem('drawpaper-theme', 'dark'));
  }
  await waitForApp(page);
  await invoke(page, 'newDoc');
  await page.waitForTimeout(300);
}

test.describe('Wave11 阶段 C axe 自动化无障碍扫描', () => {
  test('主画布：空文档', async ({ page }) => {
    await freshCanvas(page);
    await assertTarget(page, '主画布·空文档');
  });

  test('主画布：有内容', async ({ page }) => {
    await waitForApp(page);
    await loadStandard(page);
    await assertTarget(page, '主画布·有内容');
  });

  test('主画布：深色模式（含焦点环对比度断言）', async ({ page }) => {
    await freshCanvas(page, { dark: true });
    // 等 <html> 真的挂上 .dark（index.html 内联脚本 + 本模块 apply 双保险）
    await expect(page.locator('html.dark')).toHaveCount(1, { timeout: 5000 });
    await loadStandard(page);
    await assertTarget(page, '主画布·深色模式');

    // ---- 深色 :focus-visible 焦点环对比度 ≥3:1 ----
    // 点空白 pane → Enter 建块并 Esc 退出编辑 → focus 块外壳，读 outline-color 与相邻背景。
    await page.locator('.react-flow__pane').click({ position: { x: 600, y: 300 } });
    await page.keyboard.press('Enter');
    await expect(page.locator('.ProseMirror-focused')).toBeVisible({ timeout: 5000 });
    await page.keyboard.type('焦点环对比度测试');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await page.locator('.react-flow__node .block-shell').first().focus();
    await page.waitForTimeout(150);

    const ratio = await page.evaluate(() => {
      const el = document.activeElement?.closest('.block-shell') as HTMLElement | null;
      if (!el) return null;
      const cs = getComputedStyle(el);
      const outline = cs.outlineColor; // rgb(r,g,b)
      // 焦点环落在画布底色上（outline-offset 2px 外侧 = canvas-bg）。
      const canvas = document.querySelector('.react-flow') as HTMLElement;
      const bg = getComputedStyle(canvas).backgroundColor;
      function lum(rgb: string): number {
        const m = rgb.match(/(\d+(\.\d+)?)/g);
        if (!m) return 0;
        const nums = m.slice(0, 3).map((x) => Number(x) / 255);
        const r = nums[0] ?? 0;
        const g = nums[1] ?? 0;
        const b = nums[2] ?? 0;
        const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      }
      const l1 = lum(outline);
      const l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      return { outline, bg, ratio: Math.round(ratio * 100) / 100 };
    });
    console.log('FOCUS_RING_CONTRAST', JSON.stringify(ratio));
    expect(ratio, `深色焦点环对比度不足: ${JSON.stringify(ratio)}`).not.toBeNull();
    expect(ratio!.ratio).toBeGreaterThanOrEqual(3);
  });

  test('导出对话框', async ({ page }) => {
    await freshCanvas(page);
    await page.keyboard.press('Control+p');
    await expect(page.getByRole('heading', { name: '导出 / 打印' })).toBeVisible();
    await page.waitForTimeout(200);
    await assertTarget(page, '导出对话框');
  });

  test('同步设置面板（WebDAV 加密区）', async ({ page }) => {
    await freshCanvas(page);
    await page.locator('[data-testid="open-sync"]').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.waitForTimeout(200);
    await assertTarget(page, '同步设置面板');
  });

  test('AI diff 面板（route mock OpenAI 端点）', async ({ page }) => {
    // 预置 AI 配置（endpoint 指向被 route 拦截的 mock 主机）。
    await page.addInitScript(() => {
      localStorage.setItem(
        'drawpaper.ai.config.v1',
        JSON.stringify({ endpoint: 'http://ai.mock/v1', apiKey: 'test', model: 'mock', temperature: 0.2 }),
      );
    });
    await waitForApp(page);
    await loadStandard(page);

    // 读真实节点 id，供 mock 返回合法建议（validateAiOutput 要求端点 id 存在）。
    const nodeIds = (await page.evaluate(() =>
      window.__drawpaper__!.getState().doc.nodes.map((n) => n.id),
    )) as string[];
    expect(nodeIds.length).toBeGreaterThanOrEqual(2);

    // route mock：返回合法 set-root + add-edge 建议，走真实 runAiTask→setDiff 路径。
    await page.route('**/chat/completions', async (route) => {
      const content = JSON.stringify({
        suggestions: [
          { kind: 'set-root', reason: '将该块设为主根（axe 扫描夹具）', rootNodeId: nodeIds[0] },
          { kind: 'add-edge', reason: '建议连接两块（axe 扫描夹具）', source: nodeIds[0], target: nodeIds[1] },
        ],
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }),
      });
    });

    // 打开 AI 面板 → 点「一键整理建议」→ diff 对话框出现。
    await page.getByRole('button', { name: 'AI 辅助' }).click();
    await page.getByRole('button', { name: '一键整理建议' }).click();
    await expect(page.getByRole('heading', { name: /AI 建议/ })).toBeVisible({ timeout: 8000 });
    await page.waitForTimeout(200);
    await assertTarget(page, 'AI diff 面板');
  });

  test('大纲面板', async ({ page }) => {
    await waitForApp(page);
    await loadStandard(page);
    await page.getByRole('button', { name: /大纲面板/ }).click();
    await page.waitForTimeout(200);
    await assertTarget(page, '大纲面板');
  });

  test('文档列表面板', async ({ page }) => {
    await waitForApp(page);
    await loadStandard(page);
    // 文档列表是常驻左侧 aside；确保有若干文档行渲染。
    await page.waitForTimeout(200);
    await assertTarget(page, '文档列表面板');
  });

  // ============================================================
  // Wave26：补 Radix Dialog 弹层 axe 扫描护栏（10 个此前未覆盖的弹层）。
  // 口径与上方一致：critical/serious 必须为 0；moderate 打印供入档。
  // ============================================================

  test('弹层·存储空间不足引导（StorageQuotaDialog）', async ({ page }) => {
    await freshCanvas(page);
    await page.evaluate(() => window.__drawpaper__!.quotaResetThrottle());
    await page.evaluate(() => window.__drawpaper__!.quotaRaise());
    await expect(page.getByText('本地存储空间不足')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(200);
    await assertTarget(page, 'StorageQuotaDialog');
    await page.evaluate(() => window.__drawpaper__!.quotaClose());
  });

  test('弹层·连线冲突裁决（ConflictDialog，成环触发）', async ({ page }) => {
    await freshCanvas(page);
    await page.evaluate(() => {
      window.__drawpaper__!.invoke('addNode', 'text', 50, 200); // A
      window.__drawpaper__!.invoke('addNode', 'text', 500, 200); // B
    });
    await page.waitForTimeout(400);
    const [A, B] = (await page.evaluate(() =>
      window.__drawpaper__!.getState().doc.nodes.map((n) => n.id),
    )) as [string, string];
    // A→B 先落一条边，再 B→A 成环 → 弹裁决框。
    await page.evaluate(([a, b]) => window.__drawpaper__!.invoke('addEdge', a, b), [A, B]);
    await page.waitForTimeout(300);
    await page.evaluate(([a, b]) => window.__drawpaper__!.invoke('addEdge', b, a), [A, B]);
    await expect(page.getByText('连线冲突，请裁决')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(200);
    await assertTarget(page, 'ConflictDialog');
    // 取消关闭。
    await page.getByRole('button', { name: '取消' }).click();
    await expect(page.getByText('连线冲突，请裁决')).toBeHidden({ timeout: 3000 });
  });

  test('弹层·回收站（TrashDialog）', async ({ page }) => {
    await freshCanvas(page);
    await page.getByRole('button', { name: '文档', exact: true }).click();
    await page.getByRole('menuitem', { name: /回收站/ }).click();
    await expect(page.getByRole('heading', { name: '回收站' })).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(200);
    await assertTarget(page, 'TrashDialog');
  });

  test('弹层·标签管理（TagManagerDialog）', async ({ page }) => {
    await freshCanvas(page);
    await page.locator('button[title="标签管理"]').click();
    await expect(page.getByRole('heading', { name: '标签管理' })).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(200);
    await assertTarget(page, 'TagManagerDialog');
  });

  test('弹层·模板库（TemplatesDialog）', async ({ page }) => {
    await freshCanvas(page);
    await page.getByRole('button', { name: '文档', exact: true }).click();
    await page.getByRole('menuitem', { name: /从模板新建/ }).click();
    await expect(page.getByRole('heading', { name: '模板库' })).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(200);
    await assertTarget(page, 'TemplatesDialog');
  });

  test('弹层·快照历史（SnapshotsDialog）', async ({ page }) => {
    await freshCanvas(page);
    await page.getByRole('button', { name: '文档', exact: true }).click();
    await page.getByRole('menuitem', { name: /快照历史/ }).click();
    await expect(page.getByRole('heading', { name: '快照历史' })).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(200);
    await assertTarget(page, 'SnapshotsDialog');
  });

  test('弹层·删块跨文档反链确认（BlockDeleteConfirmDialog）', async ({ page }) => {
    // 构造 docB 目标块 + docA 内嵌 docRef 指向它 → 在 docB 删除目标块触发确认框。
    await waitForApp(page);
    async function seedDoc(d: {
      id: string; title: string; blockId: string; text: string;
      ref?: { targetDocId: string; targetNodeId: string; targetTitle: string };
    }) {
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
      }, d);
      await page.waitForTimeout(600);
    }
    await seedDoc({ id: 'doc_B', title: '目标文档B', blockId: 'n_B1', text: '目标块B' });
    await seedDoc({
      id: 'doc_A', title: '来源文档A', blockId: 'n_A1', text: '看 [[目标块B]]',
      ref: { targetDocId: 'doc_B', targetNodeId: 'n_B1', targetTitle: '目标块B' },
    });
    await page.evaluate(() => window.__drawpaper__!.invoke('openDoc', 'doc_B'));
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__drawpaper__!.deleteBlocksGuarded(['n_B1']));
    await expect(page.getByRole('heading', { name: '删除该块？' })).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(200);
    await assertTarget(page, 'BlockDeleteConfirmDialog');
    // 取消关闭。
    await page.getByRole('button', { name: '取消' }).click();
    await expect(page.getByRole('heading', { name: '删除该块？' })).toBeHidden({ timeout: 3000 });
  });

  test('弹层·关闭守卫三选框（CloseGuardDialog，Tauri-only 弹窗经 DEV seam 打开）', async ({ page }) => {
    await freshCanvas(page);
    await page.evaluate(() => window.__drawpaper__!.closeGuardSet(true));
    await expect(page.getByRole('heading', { name: '保存对当前文档的更改？' })).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(200);
    await assertTarget(page, 'CloseGuardDialog');
    await page.evaluate(() => window.__drawpaper__!.closeGuardSet(false));
  });

  test('弹层·AI 辅助设置（AiSettingsDialog）', async ({ page }) => {
    await freshCanvas(page);
    await page.getByRole('button', { name: 'AI 辅助' }).click();
    await page.locator('button[title="AI 设置"]').click();
    await expect(page.getByRole('heading', { name: 'AI 辅助设置' })).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(200);
    await assertTarget(page, 'AiSettingsDialog');
  });

  test('弹层·待处理冲突副本（ConflictCopiesDialog）', async ({ page }) => {
    await freshCanvas(page);
    // 种子一条冲突副本，使列表非空。
    await page.evaluate(() =>
      window.__drawpaper__!.syncSeedConflictCopy('axe-conflict-doc', '冲突副本-axe', 'remote body'),
    );
    await page.waitForTimeout(300);
    // 打开同步设置 → 点「查看待处理冲突副本」。
    await page.locator('[data-testid="open-sync"]').click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(400); // 等对话框入场动画 settle
    // 按钮在滚动列表内，直接 dispatch click 绕过指针拦截（Radix 嵌套弹窗）。
    await page.locator('[data-testid="open-conflict-panel"]').dispatchEvent('click');
    await expect(page.getByRole('heading', { name: /待处理冲突副本/ })).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(200);
    await assertTarget(page, 'ConflictCopiesDialog');
  });
});
