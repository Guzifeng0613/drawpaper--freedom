import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * Wave11 阶段 A：WebDAV 端到端加密 e2e。
 *
 * 沿用 sync-channels.spec.ts 的 Node Map route mock；两个 BrowserContext = 两台设备。
 *
 * 覆盖：
 *  ① 开启加密后服务器收到的全部 PUT body（.kbnote）grep 不到任何块文本/文档标题，
 *     只匹配信封结构 {v,kdf,enc,it,salt,nonce,ct}。
 *  ② 两端相同口令双向收敛。
 *  ③ 错误口令 toast 且本地/远端数据完好。
 *  ④ 关闭加密后恢复明文同步并收敛。
 */

const SECRET_BLOCK = 'E2EE-SECRET-BLOCK-42';
const SECRET_TITLE = 'E2EE-SECRET-TITLE-42';

function createMockServer() {
  const files = new Map<string, string>();
  const putLog: string[] = [];

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
      const body = req.postData() ?? '';
      files.set(path, body);
      putLog.push(`${method} ${path} :: ${body}`);
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    await route.fulfill({ status: 200, body: '' });
  }

  return { files, putLog, handler };
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

/** 判定一段 PUT body 是否是合法 E2EE 信封（而非明文 KBNote）。 */
function looksLikeEnvelope(body: string): boolean {
  try {
    const o = JSON.parse(body);
    return (
      o &&
      o.v === 1 &&
      o.kdf === 'PBKDF2-SHA-256' &&
      o.enc === 'A256GCM' &&
      typeof o.it === 'number' &&
      typeof o.salt === 'string' &&
      typeof o.nonce === 'string' &&
      typeof o.ct === 'string' &&
      // 明文 .kbnote 顶层是 format/version/id/title；信封绝不该带这些。
      !('format' in o) &&
      !('title' in o)
    );
  } catch {
    return false;
  }
}

test.describe('Wave11 WebDAV 端到端加密（route mock）', () => {
  test('① 加密后服务器全部 PUT body 均为信封，grep 不到块文本/标题', async ({ page }) => {
    const server = createMockServer();
    await page.route('**/dav/**', (r) => server.handler(r));
    const external: string[] = [];
    page.on('request', (r) => {
      const u = r.url();
      if (/^https?:\/\//.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u) && !u.includes('dav.mock')) external.push(u);
    });

    await waitBoot(page);
    await page.evaluate(([block, title]) => {
      const h = window.__drawpaper__!;
      const id = h.invoke('addNode', 'text', 100, 100) as string;
      h.invoke('updateContent', id, { type: 'doc', content: [{ type: 'paragraph', text: block }] });
      h.invoke('renameDoc', title);
      h.invoke('requestSave');
    }, [SECRET_BLOCK, SECRET_TITLE]);

    await page.evaluate(() => {
      window.__drawpaper__!.syncStartWebdav('http://dav.mock/dav', 'user', 'pass', 'correct horse battery staple');
    });
    await page.evaluate(() => window.__drawpaper__!.syncRunNow());

    // 服务器上每个 .kbnote 都必须是信封；任何 body 都不能出现秘密块文本/标题。
    const noteEntries = [...server.files.entries()].filter(([p]) => p.endsWith('.kbnote'));
    expect(noteEntries.length).toBeGreaterThan(0);
    for (const [path, body] of noteEntries) {
      expect(looksLikeEnvelope(body), `${path} 不是信封: ${body.slice(0, 120)}`).toBe(true);
      expect(body, `${path} 泄漏了块文本`).not.toContain(SECRET_BLOCK);
      expect(body, `${path} 泄漏了文档标题`).not.toContain(SECRET_TITLE);
      expect(body).not.toContain('"title"');
      expect(body).not.toContain('"blocks"');
    }
    // putLog 全量审计：所有 PUT body 都不含秘密串。
    for (const entry of server.putLog) {
      expect(entry).not.toContain(SECRET_BLOCK);
      expect(entry).not.toContain(SECRET_TITLE);
    }
    expect(external, `未授权外网：${external.join('; ')}`).toEqual([]);
    await page.close();
  });

  test('② 两端相同口令双向收敛', async ({ browser }) => {
    const server = createMockServer();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    await ctxA.route('**/dav/**', (r) => server.handler(r));
    await ctxB.route('**/dav/**', (r) => server.handler(r));

    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await waitBoot(pageA);
    await waitBoot(pageB);

    const nodeId = await pageA.evaluate(() => {
      const h = window.__drawpaper__!;
      const id = h.invoke('addNode', 'text', 100, 100) as string;
      h.invoke('updateContent', id, { type: 'doc', content: [{ type: 'paragraph', text: '来自A加密' }] });
      h.invoke('requestSave');
      return id;
    });
    const docId = await pageA.evaluate(() => window.__drawpaper__!.getState().doc.id);

    await pageA.evaluate(() => {
      window.__drawpaper__!.syncStartWebdav('http://dav.mock/dav', 'user', 'pass', 'same-pass-123');
    });
    await pageA.evaluate(() => window.__drawpaper__!.syncRunNow());

    await pageB.evaluate(() => {
      window.__drawpaper__!.syncStartWebdav('http://dav.mock/dav', 'user', 'pass', 'same-pass-123');
    });
    await pageB.evaluate(() => window.__drawpaper__!.syncRunNow());

    await pageB.evaluate((id) => window.__drawpaper__!.invoke('openDoc', id), docId);
    await expect.poll(() => nodeCount(pageB), { timeout: 8000 }).toBe(1);
    await expect.poll(async () => await contentOf(pageB, nodeId), { timeout: 5000 }).toContain('来自A加密');

    // B 改 → 推 → A 拉（双向收敛）。
    await pageB.evaluate((nid) => {
      window.__drawpaper__!.invoke('updateContent', nid, { type: 'doc', content: [{ type: 'paragraph', text: '来自B加密' }] });
      window.__drawpaper__!.invoke('requestSave');
    }, nodeId);
    await pageB.evaluate(() => window.__drawpaper__!.syncRunNow());
    await pageA.evaluate(() => window.__drawpaper__!.syncRunNow());
    await expect.poll(async () => await contentOf(pageA, nodeId), { timeout: 8000 }).toContain('来自B加密');

    // 服务器侧：两个 .kbnote（A 与 B 各自 bootstrap 文档 + 收敛后的共享文档）全是信封。
    for (const [path, body] of server.files.entries()) {
      if (path.endsWith('.kbnote')) expect(looksLikeEnvelope(body), `${path} 不是信封`).toBe(true);
    }
    await ctxA.close();
    await ctxB.close();
  });

  test('③ 错误口令：toast/锁定，本地与远端数据完好', async ({ browser }) => {
    const server = createMockServer();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    await ctxA.route('**/dav/**', (r) => server.handler(r));
    await ctxB.route('**/dav/**', (r) => server.handler(r));

    const pageA = await ctxA.newPage();
    await waitBoot(pageA);
    // A 用正确口令推一份加密文档。
    await pageA.evaluate(() => {
      const h = window.__drawpaper__!;
      const id = h.invoke('addNode', 'text', 100, 100) as string;
      h.invoke('updateContent', id, { type: 'doc', content: [{ type: 'paragraph', text: 'A的加密文档' }] });
      h.invoke('requestSave');
    });
    await pageA.evaluate(() => {
      window.__drawpaper__!.syncStartWebdav('http://dav.mock/dav', 'user', 'pass', 'right-pass-123');
    });
    await pageA.evaluate(() => window.__drawpaper__!.syncRunNow());
    const filesAfterA = [...server.files.entries()].filter(([p]) => p.endsWith('.kbnote'));
    expect(filesAfterA.length).toBeGreaterThan(0);

    const pageB = await ctxB.newPage();
    await waitBoot(pageB);
    // B 本地先有一块「B-本地块」。
    await pageB.evaluate(() => {
      const h = window.__drawpaper__!;
      h.invoke('addNode', 'text', 100, 100);
      h.invoke('requestSave');
    });
    // B 用错误口令连接。
    await pageB.evaluate(() => {
      window.__drawpaper__!.syncStartWebdav('http://dav.mock/dav', 'user', 'pass', 'WRONG-pass-456');
    });
    const inspectAfter = await pageB.evaluate(() => window.__drawpaper__!.syncRunNow());

    // 通道因认证失败被拆掉、进入锁定态；B 本地块仍在；远端文件数不变（未被覆盖/写坏）。
    expect(inspectAfter).toMatchObject({ e2eeLocked: true, hasChannel: false });
    await expect.poll(() => nodeCount(pageB), { timeout: 3000 }).toBe(1);
    const filesAfterB = [...server.files.entries()].filter(([p]) => p.endsWith('.kbnote'));
    expect(filesAfterB.length).toBe(filesAfterA.length);
    // 远端内容仍是 A 的信封（错误口令没把本地明文推上去）。
    for (const [, body] of filesAfterB) {
      expect(looksLikeEnvelope(body)).toBe(true);
    }
    await ctxA.close();
    await ctxB.close();
  });

  test('④ 关闭加密后恢复明文同步并收敛', async ({ browser }) => {
    const server = createMockServer();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    await ctxA.route('**/dav/**', (r) => server.handler(r));
    await ctxB.route('**/dav/**', (r) => server.handler(r));

    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await waitBoot(pageA);
    await waitBoot(pageB);

    // A 先加密推一份。
    const nodeId = await pageA.evaluate(() => {
      const h = window.__drawpaper__!;
      const id = h.invoke('addNode', 'text', 100, 100) as string;
      h.invoke('updateContent', id, { type: 'doc', content: [{ type: 'paragraph', text: '加密时代内容' }] });
      h.invoke('requestSave');
      return id;
    });
    const docId = await pageA.evaluate(() => window.__drawpaper__!.getState().doc.id);
    await pageA.evaluate(() => {
      window.__drawpaper__!.syncStartWebdav('http://dav.mock/dav', 'user', 'pass', 'off-on-pass-123');
    });
    await pageA.evaluate(() => window.__drawpaper__!.syncRunNow());
    const encryptedBody = server.files.get(`${docId}.kbnote`) ?? '';
    expect(looksLikeEnvelope(encryptedBody)).toBe(true);

    // A 关闭加密（明文重连）→ 下一轮把本地文档以明文重推（覆盖旧信封）。
    await pageA.evaluate(() => {
      window.__drawpaper__!.syncStartWebdav('http://dav.mock/dav', 'user', 'pass');
    });
    await pageA.evaluate(() => window.__drawpaper__!.syncRunNow());
    const plainBody = server.files.get(`${docId}.kbnote`) ?? '';
    expect(looksLikeEnvelope(plainBody)).toBe(false);
    expect(plainBody).toContain('加密时代内容');

    // B 明文同步 → 收敛看到内容。
    await pageB.evaluate(() => {
      window.__drawpaper__!.syncStartWebdav('http://dav.mock/dav', 'user', 'pass');
    });
    await pageB.evaluate(() => window.__drawpaper__!.syncRunNow());
    await pageB.evaluate((id) => window.__drawpaper__!.invoke('openDoc', id), docId);
    await expect.poll(() => nodeCount(pageB), { timeout: 8000 }).toBe(1);
    await expect.poll(async () => await contentOf(pageB, nodeId), { timeout: 5000 }).toContain('加密时代内容');
    await ctxA.close();
    await ctxB.close();
  });
});
