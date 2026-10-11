import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KBNoteDoc } from '@drawpaper/core';

// ---- mock 依赖（在 import 被测模块前 mock）----
const mockDocsToArray = vi.fn<() => KBNoteDoc[]>();
const mockTrashToArray = vi.fn<() => Array<KBNoteDoc & { trashedAt: number }>>();
const mockTrashClear = vi.fn<() => Promise<void>>();
const mockMoveAssetToTrash = vi.fn<(ref: string, meta: { movedAt: number; sourceDocId: string }) => Promise<void>>();
const mockListConflictCopies = vi.fn<() => Array<{ text: string }>>();

vi.mock('./db', () => ({
  db: {
    docs: { toArray: () => Promise.resolve(mockDocsToArray()) },
    trash: {
      toArray: () => Promise.resolve(mockTrashToArray()),
      clear: () => mockTrashClear(),
    },
  },
}));

vi.mock('./opfs', () => ({
  moveAssetToTrash: (ref: string, meta: { movedAt: number; sourceDocId: string }) =>
    mockMoveAssetToTrash(ref, meta),
}));

vi.mock('@/sync/sync-db', () => ({
  listConflictCopies: () => mockListConflictCopies(),
}));

import { orphansAfterEmptyTrash } from './asset-gc-web';

/** 造一份带指定 assetRefs 的文档。 */
function docWithRefs(id: string, refs: string[]): KBNoteDoc {
  return {
    id,
    title: 'doc-' + id,
    assetRefs: [...refs],
  } as unknown as KBNoteDoc;
}

const H_A = 'a'.repeat(64);
const H_B = 'b'.repeat(64);
const H_C = 'c'.repeat(64);

beforeEach(() => {
  mockDocsToArray.mockReset();
  mockTrashToArray.mockReset();
  mockTrashClear.mockReset();
  mockMoveAssetToTrash.mockReset();
  mockListConflictCopies.mockReset();
  mockListConflictCopies.mockResolvedValue([]);
});

describe('orphansAfterEmptyTrash（批量清空回收站的孤儿资产计算）', () => {
  it('两份 trash 文档共享同一资产、无活文档引用 → 该资产判为孤儿（恰好 1 个）', async () => {
    // 无活文档引用 H_A。
    mockDocsToArray.mockReturnValue([]);
    const t1 = docWithRefs('t1', [H_A]);
    const t2 = docWithRefs('t2', [H_A]);

    const orphans = await orphansAfterEmptyTrash([t1, t2]);

    expect(orphans.has(H_A)).toBe(true);
    expect(orphans.size).toBe(1);
  });

  it('同一资产同时被一份活文档引用 → 不判孤儿（保留不动）', async () => {
    // 活文档 d1 引用 H_A。
    mockDocsToArray.mockReturnValue([docWithRefs('d1', [H_A])]);
    const t1 = docWithRefs('t1', [H_A, H_B]);
    const t2 = docWithRefs('t2', [H_A]);

    const orphans = await orphansAfterEmptyTrash([t1, t2]);

    // H_A 被活文档保活 → 不动；H_B 只在 trash 里 → 孤儿。
    expect(orphans.has(H_A)).toBe(false);
    expect(orphans.has(H_B)).toBe(true);
    expect(orphans.size).toBe(1);
  });

  it('两份 trash 各独引资产 → 均判孤儿', async () => {
    mockDocsToArray.mockReturnValue([]);
    const t1 = docWithRefs('t1', [H_A]);
    const t2 = docWithRefs('t2', [H_B]);

    const orphans = await orphansAfterEmptyTrash([t1, t2]);

    expect(orphans.has(H_A)).toBe(true);
    expect(orphans.has(H_B)).toBe(true);
    expect(orphans.size).toBe(2);
  });

  it('冲突副本引用的资产不判孤儿', async () => {
    mockDocsToArray.mockReturnValue([]);
    mockListConflictCopies.mockResolvedValue([
      { text: JSON.stringify({ assetRefs: [H_C] }) },
    ]);
    const t1 = docWithRefs('t1', [H_A, H_C]);

    const orphans = await orphansAfterEmptyTrash([t1]);

    // H_C 被冲突副本保活 → 不动；H_A 只在 trash → 孤儿。
    expect(orphans.has(H_C)).toBe(false);
    expect(orphans.has(H_A)).toBe(true);
  });

  it('空 trash 行列表 → 返回空集，不炸', async () => {
    mockDocsToArray.mockReturnValue([docWithRefs('d1', [H_A])]);
    const orphans = await orphansAfterEmptyTrash([]);
    expect(orphans.size).toBe(0);
  });
});
