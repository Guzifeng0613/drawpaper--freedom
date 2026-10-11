import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * Wave10 阶段 B 跨设备同步 e2e（零托管、零官方服务器）。
 *
 * 用 page.route 在 Node 侧用一个模块级 Map 模拟 WebDAV 服务器；
 * 两个 BrowserContext = 两台设备（各自独立 IndexedDB / localStorage / deviceClientId）。
 *
 * 覆盖：
 *  ① route mock WebDAV：A 推 → B 拉合并 → B 改 → A 拉，双向收敛。
 *  ③ 未配置通道时零外网请求审计（独立用例）。
 *  ④ 同一 v2 档两端升级 v3 后首次同步 0 假冲突（dev-hook v3MigrationCheck）。
 *
 * 注意：每台设备 bootstrap 各自生成一个不同 nanoid 文档 id；跨设备按 docId 同步，
 * 拉取的远端文档进入本资料库后需 openDoc 打开才能在画布看到。
 */

/** Node 侧共享的 WebDAV 服务器状态（path → 内容）。 */
function createMockServer() {
  const files = new Map<string, string>();

  const multistatus = (paths: string[]): string => {
    const responses = paths
      .map((p) => `  <d:response><d:href>${p}</d:href><d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response>`)
      .join('\n');
    return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">\n${responses}\n</d:multistatus>`;
  };

  async function handler(route: Route): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    const path = decodeURIComponent(url.pathname.replace(/^\/dav\/?/, ''));
    const method = req.method();
    if (method === 'PROPFIND') {
      const names = [...files.keys()].map((k) => `/dav/${k}`);
      await route.fulfill({ status: 207, contentType: 'application/xml; charset=utf-8', body: multistatus(names) });
      return;
    }
    if (method === 'GET') {
      const body = files.get(path);
      if (body == null) {
        await route.fulfill({ status: 404, body: '' });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body });
      return;
    }
    if (method === 'PUT') {
      files.set(path, req.postData() ?? '');
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    await route.fulfill({ status: 200, body: '' });
  }

  return { files, handler };
}

const waitBoot = async (page: Page) => {
  await page.goto('/');
  await expect(page.locator('.react-flow')).toBeVisible();
  await page.waitForFunction(() => {
    const h = window.__drawpaper__;
    return h && !!h.getState().doc.id;
  });
  await page.waitForTimeout(300);
};

const nodeCount = (page: Page) => page.evaluate(() => window.__drawpaper__!.getState().nodeCount);

const contentOf = (page: Page, nodeId: string) =>
  page.evaluate(
    (nid) => {
      const n = window.__drawpaper__!.getState().doc.nodes.find((x) => x.id === nid);
      return JSON.stringify(n?.content?.data ?? '');
    },
    nodeId,
  );

test.describe('Wave10 跨设备同步（WebDAV route mock）', () => {
  test('① A 推 → B 拉合并 → B 改 → A 拉，双向收敛', async ({ browser }) => {
    const server = createMockServer();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    await ctxA.route('**/dav/**', (r) => server.handler(r));
    await ctxB.route('**/dav/**', (r) => server.handler(r));

    // 审计：两设备全部 http(s) 请求只允许打到已配置的 dav.mock（无其它外网）。
    const external: string[] = [];
    const audit = (p: Page) =>
      p.on('request', (r) => {
        const u = r.url();
        if (/^https?:\/\//.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u) && !u.includes('dav.mock')) external.push(u);
      });

    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    audit(pageA);
    audit(pageB);

    await waitBoot(pageA);
    await waitBoot(pageB);

    // A 建块 + 落盘 + 启动通道并立即同步（推）。
    const nodeId = await pageA.evaluate(() => {
      const h = window.__drawpaper__!;
      const id = h.invoke('addNode', 'text', 100, 100) as string;
      h.invoke('updateContent', id, { type: 'doc', content: [{ type: 'paragraph', text: '来自A' }] });
      h.invoke('requestSave');
      return id;
    });
    const docId = await pageA.evaluate(() => window.__drawpaper__!.getState().doc.id);
    await pageA.evaluate(() => {
      window.__drawpaper__!.syncStartWebdav('http://dav.mock/dav', 'user', 'pass');
    });
    await pageA.evaluate(() => window.__drawpaper__!.syncRunNow());

    // B 启动同配置通道并同步（把 A 的文档拉进资料库）。
    await pageB.evaluate(() => {
      window.__drawpaper__!.syncStartWebdav('http://dav.mock/dav', 'user', 'pass');
    });
    await pageB.evaluate(() => window.__drawpaper__!.syncRunNow());

    // B 打开从 A 拉来的文档 → 应看到 A 的块。
    await pageB.evaluate((id) => window.__drawpaper__!.invoke('openDoc', id), docId);
    await expect.poll(() => nodeCount(pageB), { timeout: 8000 }).toBe(1);
    await expect.poll(async () => await contentOf(pageB, nodeId), { timeout: 5000 }).toContain('来自A');

    // B 改这块内容 → 推。
    await pageB.evaluate((nid) => {
      window.__drawpaper__!.invoke('updateContent', nid, { type: 'doc', content: [{ type: 'paragraph', text: '来自B' }] });
      window.__drawpaper__!.invoke('requestSave');
    }, nodeId);
    await pageB.evaluate(() => window.__drawpaper__!.syncRunNow());

    // A 拉（WebDAV 手动通道无自动轮询）→ 看到 B 的修改（双向收敛）。
    await pageA.evaluate(() => window.__drawpaper__!.syncRunNow());
    await expect.poll(async () => await contentOf(pageA, nodeId), { timeout: 8000 }).toContain('来自B');

    expect(external, `出现未授权外网请求：${external.join('; ')}`).toEqual([]);
    await ctxA.close();
    await ctxB.close();
  });

  test('③ 未配置通道时零外网请求（离线 zero-extranet 不回退）', async ({ page }) => {
    const external: string[] = [];
    page.on('request', (r) => {
      const u = r.url();
      if (/^https?:\/\//.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u)) external.push(u);
    });
    await waitBoot(page);
    // 建块、改名、改分页等本地编辑，不应产生任何外网请求。
    await page.evaluate(() => {
      const h = window.__drawpaper__!;
      h.invoke('addNode', 'text', 100, 100);
      h.invoke('addNode', 'text', 400, 100);
      h.invoke('requestSave');
    });
    await page.waitForTimeout(800);
    expect(external, `未配置通道时出现外网请求：${external.join('; ')}`).toEqual([]);
  });

  test('④ 同一 v2 档两端升级 v3 后首次同步 0 假冲突', async ({ page }) => {
    await waitBoot(page);
    // 构造一份 v2（version:2）最小档，走真实 parse+迁移路径。
    const v2 = JSON.stringify({
      format: 'knowledge-block-notes',
      version: 2,
      id: 'doc-v2-sync',
      title: '升级档',
      board: { createdAt: 1000, updatedAt: 2000 },
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 200, height: 80, content: { format: 'tiptap-json', data: { type: 'doc' } }, parentId: null, tags: [] }],
      edges: [],
      tags: [],
      layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
      viewport: { x: 0, y: 0, zoom: 1 },
      page: { size: 'A4', orientation: 'portrait', marginMm: 15, mode: 'fit', showPageBreak: true, colorMode: 'color', header: false, footer: false, showPageNumbers: false, edgeLabels: true, pageBreaks: [] },
      assetRefs: [],
      links: [],
    });
    const res = await page.evaluate((text) => window.__drawpaper__!.v3MigrationCheck(text), v2);
    expect(res.ok).toBe(true);
    expect(res.version).toBe(4);
    expect(res.migratedDeepEqual).toBe(true);
    expect(res.mergedConflictCount).toBe(0);
  });
});
