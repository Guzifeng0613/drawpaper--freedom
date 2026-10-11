import { test, expect, type Page } from '@playwright/test';

/**
 * Wave9 阶段 B：同浏览器多标签实时协作（同一 BrowserContext 两个 page，
 * 共享 IndexedDB + BroadcastChannel，零服务器/零外网）。
 *
 * 6 场景：
 *  ① A 建块/连线/输入，B 实时出现且可编辑；
 *  ② A 删边/改父子，B 同步；
 *  ③ late-joiner：先有内容后开标签直接对齐（snapshot-request/snapshot）；
 *  ④ 并发改不同字段双方保留；并发 reparent 产生冲突横幅且无数据丢失；
 *  ⑤ A 异常关闭（page.close）后，B presence 心跳超时自动清除；
 *  ⑥ 无 BroadcastChannel 降级单标签正常。
 * 另：协作全程零 http(s) 外网请求审计。
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

const docIdOf = (page: Page) =>
  page.evaluate(() => window.__drawpaper__!.getState().doc.id);

const nodeCount = (page: Page) =>
  page.evaluate(() => window.__drawpaper__!.getState().nodeCount);

/** 让 pageB 打开 pageA 当前的同一篇文档（确定性对齐到同一 docId）。 */
const openSameDoc = async (pageA: Page, pageB: Page) => {
  const id = await docIdOf(pageA);
  await pageB.evaluate((docId) => {
    void window.__drawpaper__!.invoke('openDoc', docId);
  }, id);
  // 等 B 打开 + 完成 late-join 对齐。
  await pageB.waitForFunction(
    (docId) => window.__drawpaper__!.getState().doc.id === docId,
    id,
  );
  await pageB.waitForTimeout(600);
};

/** 等 B 看到 A 的 presence（在线点）。 */
const waitPeerSeen = async (page: Page, minCount: number) => {
  await page.waitForFunction(
    (n) => (window.__drawpaper__!.collab().peerCount ?? 0) >= n,
    minCount,
    { timeout: 8000 },
  );
};

test.describe('同浏览器多标签实时协作', () => {
  test('① 建块/连线/输入实时同步，且 B 可反向编辑 A 可见', async ({ context }) => {
    // 零外网审计：两个 page 的全部 http(s) 请求都必须是同源本机回环。
    // 回环放行同时覆盖 localhost（chromium config:4173）与 127.0.0.1（webkit-full:4191，
    // WebKit 受限端口规避后用 IP 直连）——两者都是 dev server 本机回环，不是外网。
    const external: string[] = [];
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    const audit = (p: Page) => {
      p.on('request', (r) => {
        const u = r.url();
        if (/^https?:\/\//.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u)) external.push(u);
      });
      p.on('requestfailed', () => {
        /* 协作不应有失败请求；dev server 资源除外 */
      });
    };
    audit(pageA);
    audit(pageB);

    await waitBoot(pageA);
    await waitBoot(pageB);
    await openSameDoc(pageA, pageB);
    await waitPeerSeen(pageB, 1);

    // A 建两个块 + 连线。
    const ids = await pageA.evaluate(() => {
      const h = window.__drawpaper__!;
      const a = h.invoke('addNode', 'text', 100, 100) as string;
      const b = h.invoke('addNode', 'text', 400, 100) as string;
      h.invoke('addEdge', a, b);
      return { a, b };
    });
    // A 给块 a 输入内容。
    await pageA.evaluate((aId) => {
      window.__drawpaper__!.invoke('updateContent', aId, { type: 'doc', content: [{ type: 'paragraph', text: '来自A' }] });
    }, ids.a);

    // B 应实时看到 2 个块与内容。
    await expect.poll(() => nodeCount(pageB), { timeout: 5000 }).toBe(2);
    const bSeesContent = await pageB.evaluate((aId) => {
      const n = window.__drawpaper__!.getState().doc.nodes.find((x) => x.id === aId);
      return JSON.stringify(n?.content?.data ?? '').includes('来自A');
    }, ids.a);
    expect(bSeesContent).toBe(true);

    // B 反向编辑块 b → A 可见。
    await pageB.evaluate((bId) => {
      window.__drawpaper__!.invoke('updateContent', bId, { type: 'doc', content: [{ type: 'paragraph', text: '来自B' }] });
    }, ids.b);
    await expect
      .poll(async () => {
        const txt = await pageA.evaluate((bId) => {
          const n = window.__drawpaper__!.getState().doc.nodes.find((x) => x.id === bId);
          return JSON.stringify(n?.content?.data ?? '');
        }, ids.b);
        return txt.includes('来自B');
      }, { timeout: 5000 })
      .toBe(true);

    expect(external, `协作期间出现外网请求：${external.join('; ')}`).toEqual([]);
    await context.close();
  });

  test('② A 删边 / 改父子 → B 同步', async ({ context }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await waitBoot(pageA);
    await waitBoot(pageB);
    await openSameDoc(pageA, pageB);

    const ids = await pageA.evaluate(() => {
      const h = window.__drawpaper__!;
      const p = h.invoke('addNode', 'text', 0, 0) as string;
      const c = h.invoke('addNode', 'text', 300, 0) as string;
      h.invoke('addEdge', p, c);
      return { p, c };
    });
    await expect.poll(() => nodeCount(pageB), { timeout: 5000 }).toBe(2);

    // 初始边数（B 侧）。
    const edgeCountB = () => pageB.evaluate(() => window.__drawpaper__!.getState().doc.edges.length);
    await expect.poll(edgeCountB, { timeout: 5000 }).toBe(1);

    // A reparent：把 c 挂到 p（同父，制造可观察的 parentId 变化 + 边重排）。
    await pageA.evaluate(({ c, p }) => {
      window.__drawpaper__!.invoke('reparentNode', c, p);
    }, ids);
    await expect
      .poll(async () => {
        const parent = await pageB.evaluate((cid) => {
          const n = window.__drawpaper__!.getState().doc.nodes.find((x) => x.id === cid);
          return n?.parentId ?? null;
        }, ids.c);
        return parent;
      }, { timeout: 5000 })
      .toBe(ids.p);

    // A 删边 → B 边数归 0。
    const edgeId = await pageA.evaluate(() => window.__drawpaper__!.getState().doc.edges[0]!.id);
    await pageA.evaluate((eid) => window.__drawpaper__!.invoke('deleteEdge', eid), edgeId);
    await expect.poll(edgeCountB, { timeout: 5000 }).toBe(0);
    await context.close();
  });

  test('③ late-joiner：先落盘内容，后开标签直接对齐', async ({ context }) => {
    const pageA = await context.newPage();
    await waitBoot(pageA);
    // A 建块并主动落盘（不等 500ms 防抖）。
    await pageA.evaluate(() => {
      const h = window.__drawpaper__!;
      h.invoke('addNode', 'text', 100, 100);
      h.invoke('addNode', 'text', 400, 100);
      h.invoke('requestSave');
    });
    await pageA.waitForTimeout(800); // 等落盘完成
    const aDocId = await docIdOf(pageA);

    // B 全新打开 → bootstrap 选最近文档 = A 的文档 → snapshot 对齐。
    const pageB = await context.newPage();
    await waitBoot(pageB);
    await expect.poll(() => docIdOf(pageB), { timeout: 8000 }).toBe(aDocId);
    await expect.poll(() => nodeCount(pageB), { timeout: 8000 }).toBe(2);
    await context.close();
  });

  test('④ 并发改不同字段双方保留；并发 reparent 触发冲突横幅且无数据丢失', async ({ context }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await waitBoot(pageA);
    await waitBoot(pageB);
    await openSameDoc(pageA, pageB);

    // 一个共享节点 N + 两个候选父 P1/P2/P3。
    const ids = await pageA.evaluate(() => {
      const h = window.__drawpaper__!;
      const n = h.invoke('addNode', 'text', 200, 200) as string;
      const p1 = h.invoke('addNode', 'text', 0, 0) as string;
      const p2 = h.invoke('addNode', 'text', 600, 0) as string;
      const p3 = h.invoke('addNode', 'text', 300, 400) as string;
      h.invoke('reparentNode', n, p1);
      return { n, p1, p2, p3 };
    });
    await expect.poll(() => nodeCount(pageB), { timeout: 5000 }).toBe(4);

    // 并发改不同字段：A 改内容，B 改 x 坐标 → 双方都保留。
    await pageA.evaluate((nid) => {
      window.__drawpaper__!.invoke('updateContent', nid, { type: 'doc', content: [{ type: 'paragraph', text: 'A内容' }] });
    }, ids.n);
    await pageB.evaluate((nid) => {
      window.__drawpaper__!.invoke('moveNode', nid, 555, 200);
    }, ids.n);
    await pageA.waitForTimeout(800);
    await pageB.waitForTimeout(800);

    // 任一端：N 仍存在，内容含 A，x≈555（B 的坐标）。
    const merged = await pageA.evaluate((nid) => {
      const node = window.__drawpaper__!.getState().doc.nodes.find((x) => x.id === nid)!;
      return { hasContent: JSON.stringify(node.content.data).includes('A内容'), x: Math.round(node.x) };
    }, ids.n);
    expect(merged.hasContent).toBe(true);
    expect(merged.x).toBe(555);

    // 并发 reparent：A 挂到 P2，B 挂到 P3（近同时）。
    await Promise.all([
      pageA.evaluate(({ nid, p2 }) => window.__drawpaper__!.invoke('reparentNode', nid, p2), { nid: ids.n, p2: ids.p2 }),
      pageB.evaluate(({ nid, p3 }) => window.__drawpaper__!.invoke('reparentNode', nid, p3), { nid: ids.n, p3: ids.p3 }),
    ]);
    await pageA.waitForTimeout(1000);
    await pageB.waitForTimeout(1000);

    // N 仍在（无数据丢失）；至少一端出现并发冲突横幅。
    const stillThereA = await pageA.evaluate((nid) =>
      window.__drawpaper__!.getState().doc.nodes.some((x) => x.id === nid), ids.n);
    const stillThereB = await pageB.evaluate((nid) =>
      window.__drawpaper__!.getState().doc.nodes.some((x) => x.id === nid), ids.n);
    expect(stillThereA).toBe(true);
    expect(stillThereB).toBe(true);

    const conflictsA = await pageA.evaluate(() => window.__drawpaper__!.collabConflicts().length);
    const conflictsB = await pageB.evaluate(() => window.__drawpaper__!.collabConflicts().length);
    expect(conflictsA + conflictsB).toBeGreaterThan(0);
    await context.close();
  });

  test('⑤ A 异常关闭后，B 心跳超时自动清除 presence', async ({ context }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await waitBoot(pageA);
    await waitBoot(pageB);
    await openSameDoc(pageA, pageB);
    await waitPeerSeen(pageB, 1);

    // A 异常关闭（不发 goodbye）。
    await pageA.close();

    // B 的 presence 在心跳超时（3.5s）后自动清除。
    await expect
      .poll(() => pageB.evaluate(() => window.__drawpaper__!.collab().peerCount), {
        timeout: 9000,
      })
      .toBe(0);
    await context.close();
  });

  test('⑥ 无 BroadcastChannel 时单标签静默降级，编辑正常', async ({ browser }) => {
    const ctx = await browser.newContext();
    // 模拟隐私模式/老浏览器：删掉 BroadcastChannel（storage 兜底仍可用；更差环境退化为 disabled）。
    await ctx.addInitScript(() => {
      // @ts-expect-error 故意删除以触发降级路径
      delete window.BroadcastChannel;
    });
    const page = await ctx.newPage();
    await waitBoot(page);
    const kind = await page.evaluate(() => window.__drawpaper__!.collab().transport);
    expect(['storage', 'disabled']).toContain(kind);

    // 单标签编辑正常：建块落盘不崩。
    await page.evaluate(() => {
      window.__drawpaper__!.invoke('addNode', 'text', 100, 100);
      window.__drawpaper__!.invoke('addNode', 'text', 400, 100);
    });
    await expect.poll(() => nodeCount(page), { timeout: 5000 }).toBe(2);
    await ctx.close();
  });
});
