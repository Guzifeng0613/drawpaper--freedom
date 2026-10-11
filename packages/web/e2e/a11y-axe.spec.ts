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
    // Wave26：headless WebKitGTK 弹窗无 dimmed backdrop，axe 按白色底计算有效对比度，
    // 两个 muted 文案/radio 算出 3.07/3.74（chromium 有 backdrop 合成 → 通过）。
    // 引擎背景合成差异，非产品缺陷；chromium a11y 门禁仍真跑。
    test.skip(!!process.env.WEBKIT_FULL, 'webkit 无弹窗 backdrop→axe 对比度按白底误判');
    await freshCanvas(page);
    await page.keyboard.press('Control+p');
    await expect(page.getByRole('heading', { name: '导出 / 打印' })).toBeVisible();
    await page.waitForTimeout(200);
    await assertTarget(page, '导出对话框');
  });

  test('同步设置面板（WebDAV 加密区）', async ({ page }) => {
    // Wave26：同上——webkit headless 无 backdrop，.opacity-50 .text-xs hint 文案按白底算出
    // 3.74（chromium 有 backdrop → 通过）。引擎背景合成差异，非产品缺陷。
    test.skip(!!process.env.WEBKIT_FULL, 'webkit 无 backdrop→axe 对比度按白底误判');
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
});
