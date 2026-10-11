import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serializeKBNote } from '@drawpaper/core';
import type { KBNoteDoc } from '@drawpaper/core';
import { packZip, encodeText } from './kbpack';
import { buildKbpackManifest } from './kbpack-manifest';

/**
 * Wave26 路 1：no-OPFS 设备（Safari/WebKit/旧浏览器）导入 .kbpack 时，
 * 「资产回填」循环必须逐篇 try/catch——文档已全部落库，绝不能让首个资产写失败
 * （writeAssetToRef 内部 getAssetsDir 抛 OpfsUnavailableError）把整个 import reject，
 * 让 caller 弹「导入备份包失败」的假错误。
 *
 * 覆盖：
 *  ① OPFS 不可用（writeAssetToRef 恒抛 OpfsUnavailableError）：文档全部 saveDoc 落库、
 *     整体 promise resolve 不 reject、summary.skippedAssets == 缺失数、assetsRestored == 0；
 *  ② 正常路径：assetsRestored 计数不回归、skippedAssets == 0；
 *  ③ 混合路径：部分资产写失败时逐篇隔离——成功的仍 assetsRestored++，失败的计入 skippedAssets，
 *     不中断后续资产。
 */

// ---- 内存替身状态（vi.mock 工厂闭包共享）----
const mem = {
  docs: new Map<string, KBNoteDoc>(),
  currentDocId: null as string | null,
  /** 可控的 writeAssetToRef 行为（测试按用例替换）。 */
  writeImpl: (_ref: string, _bytes: Uint8Array): Promise<void> => Promise.resolve(),
  writtenAssets: [] as string[],
};

vi.mock('@/storage/db', () => ({
  db: {
    docs: {
      toArray: async () => [...mem.docs.values()],
      get: async (id: string) => mem.docs.get(id) ?? undefined,
    },
  },
}));

vi.mock('@/store/editor-store', () => ({
  editorStore: {
    getState: () => ({
      currentDocId: mem.currentDocId,
      requestSave: () => {},
      snapshotDoc: async () => {},
      applyRemoteDoc: async () => {},
    }),
  },
  storageAdapter: {
    saveDoc: async (doc: KBNoteDoc) => {
      mem.docs.set(doc.id, doc);
    },
  },
}));

vi.mock('./stamper', () => ({
  syncStamper: {
    stampForPersist: <T extends KBNoteDoc>(doc: T): T => doc,
    beginRemoteApply: () => {},
    endRemoteApply: () => {},
  },
}));

vi.mock('./device-identity', () => ({
  loadOrCreateDeviceClientId: () => 'test-dev',
}));

vi.mock('./sync-ui-store', () => ({
  useSyncUi: {
    getState: () => ({ bumpCounts: () => {} }),
  },
}));

// 只 mock writeAssetToRef / getAsset，保留真实 OpfsUnavailableError 类以忠实复现 no-OPFS 环境。
vi.mock('@/storage/opfs', async () => {
  const actual = await vi.importActual<typeof import('@/storage/opfs')>('@/storage/opfs');
  return {
    ...actual,
    getAsset: async () => null,
    writeAssetToRef: async (ref: string, bytes: Uint8Array) => {
      await mem.writeImpl(ref, bytes);
      mem.writtenAssets.push(ref);
    },
  };
});

// 导入被测对象与真实错误类（必须在 vi.mock 之后）。
import { importKbpackBundle } from './kbpack-transfer';
import { OpfsUnavailableError } from '@/storage/opfs';

// ---- 文档构造工具 ----
function baseDoc(id: string, title: string, assetRefs: string[]): KBNoteDoc {
  return {
    format: 'knowledge-block-notes',
    version: 4,
    id,
    title,
    board: { createdAt: 1000, updatedAt: 2000 },
    nodes: [
      {
        id: `${id}-n1`,
        type: 'text',
        x: 0,
        y: 0,
        width: 200,
        height: 80,
        content: { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', text: title }] } },
        parentId: null,
        tags: [],
      },
    ],
    edges: [],
    tags: [],
    layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
    viewport: { x: 0, y: 0, zoom: 1 },
    page: { size: 'A4', orientation: 'portrait', marginMm: 15, mode: 'fit', showPageBreak: true, colorMode: 'color', header: false, footer: false, showPageNumbers: false, edgeLabels: true, pageBreaks: [] },
    assetRefs,
    links: [],
    sync: { vv: { c: 1 }, nodes: { [`${id}-n1`]: { f: { content: [1, 'c'] } } } },
  } as unknown as KBNoteDoc;
}

/** 造一个含 2 文档（doc-a 引用 asset-a，doc-b 无资产）的 .kbpack 字节流。 */
function buildBundle(): Uint8Array {
  const docA = baseDoc('doc-a', '甲', ['asset-a']);
  const docB = baseDoc('doc-b', '乙', []);
  const manifest = buildKbpackManifest([docA, docB], 'device-x');
  const entries = [
    { name: 'manifest.json', data: encodeText(JSON.stringify(manifest)) },
    { name: 'docs/doc-a.kbnote', data: encodeText(serializeKBNote(docA)) },
    { name: 'docs/doc-b.kbnote', data: encodeText(serializeKBNote(docB)) },
    { name: 'assets/asset-a', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
  ];
  return packZip(entries);
}

beforeEach(() => {
  mem.docs.clear();
  mem.currentDocId = null;
  mem.writtenAssets.length = 0;
  mem.writeImpl = () => Promise.resolve();
});

describe('importKbpackBundle 资产回填容错（Wave26 no-OPFS）', () => {
  it('① no-OPFS：writeAssetToRef 抛 OpfsUnavailableError 时文档仍全部落库、整体不 reject，skippedAssets==缺失数', async () => {
    mem.writeImpl = () => Promise.reject(new OpfsUnavailableError());
    const bytes = buildBundle();

    // 不应 reject——这是本缺陷的核心断言。
    const summary = await importKbpackBundle(bytes);

    // 文档全部 saveDoc 落库。
    expect(mem.docs.has('doc-a')).toBe(true);
    expect(mem.docs.has('doc-b')).toBe(true);
    expect(summary.importedNew).toBe(2);
    expect(summary.merged).toBe(0);
    // 资产：全部跳过，无成功回填。
    expect(summary.assetsRestored).toBe(0);
    expect(summary.skippedAssets).toBe(1);
    expect(mem.writtenAssets).toHaveLength(0);
    // docIds 仍如实返回（供 UI 打开）。
    expect(summary.docIds.sort()).toEqual(['doc-a', 'doc-b']);
  });

  it('② 正常路径：OPFS 可用时 assetsRestored 计数不回归、skippedAssets==0', async () => {
    const bytes = buildBundle();
    const summary = await importKbpackBundle(bytes);

    expect(mem.docs.has('doc-a')).toBe(true);
    expect(mem.docs.has('doc-b')).toBe(true);
    expect(summary.importedNew).toBe(2);
    expect(summary.assetsRestored).toBe(1);
    expect(summary.skippedAssets).toBe(0);
    expect(mem.writtenAssets).toEqual(['asset-a']);
  });

  it('③ 混合路径：单篇失败不中断后续资产，成功的仍计入 assetsRestored', async () => {
    // 再造一个引用两个资产的包：asset-a 失败、asset-c 成功。
    const docC = baseDoc('doc-c', '丙', ['asset-a', 'asset-c']);
    const manifest = buildKbpackManifest([docC], 'device-x');
    const bytes = packZip([
      { name: 'manifest.json', data: encodeText(JSON.stringify(manifest)) },
      { name: 'docs/doc-c.kbnote', data: encodeText(serializeKBNote(docC)) },
      { name: 'assets/asset-a', data: new Uint8Array([1]) },
      { name: 'assets/asset-c', data: new Uint8Array([2]) },
    ]);
    mem.writeImpl = async (ref: string) => {
      if (ref === 'asset-a') throw new OpfsUnavailableError();
    };

    const summary = await importKbpackBundle(bytes);

    expect(summary.assetsRestored).toBe(1);
    expect(summary.skippedAssets).toBe(1);
    expect(mem.writtenAssets).toEqual(['asset-c']);
    expect(mem.docs.has('doc-c')).toBe(true);
  });
});
