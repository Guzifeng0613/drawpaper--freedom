import { describe, it, expect } from 'vitest';
import type { KBNoteDoc } from '../model/index.js';
import { createDoc, createNode } from '../model/index.js';
import {
  computeAssetGcPlan,
  orphanRefsAfterPurge,
  isContentHashRef,
} from './asset-gc.js';

/** 造一份带指定 assetRefs 的文档。 */
function docWithRefs(id: string, refs: string[]): KBNoteDoc {
  const d = createDoc('asset-gc-' + id);
  d.id = id;
  d.assetRefs = [...refs];
  return d;
}

// 两个不同内容的 SHA-256 hex（64 位）。
const H_A = 'a'.repeat(64);
const H_B = 'b'.repeat(64);
const H_C = 'c'.repeat(64);
// 旧版 nanoid 形状（21 位，含 '-'）。
const OLD_NANOID = 'V1StGXR8_Z5jdHi6B-myT';

describe('isContentHashRef', () => {
  it('识别 64 位小写 hex 为内容寻址引用', () => {
    expect(isContentHashRef(H_A)).toBe(true);
    expect(isContentHashRef('0123456789abcdef' + '0'.repeat(48))).toBe(true);
  });
  it('拒绝 nanoid / 空 / 大写 / 长度不对', () => {
    expect(isContentHashRef(OLD_NANOID)).toBe(false);
    expect(isContentHashRef('')).toBe(false);
    expect(isContentHashRef(null)).toBe(false);
    expect(isContentHashRef(undefined)).toBe(false);
    expect(isContentHashRef('A'.repeat(64))).toBe(false);
    expect(isContentHashRef('a'.repeat(63))).toBe(false);
  });
});

describe('computeAssetGcPlan: 引用计数与保活', () => {
  it('活动文档引用的 ref 全部 reachable，refcount 按文档数计', () => {
    const d1 = docWithRefs('d1', [H_A, H_B]);
    const d2 = docWithRefs('d2', [H_A]); // H_A 被两篇引用
    const plan = computeAssetGcPlan({
      docs: [d1, d2],
      trashDocs: [],
      conflictCopyRefs: [],
      knownAssets: [H_A, H_B, H_C],
    });
    expect(plan.reachable.has(H_A)).toBe(true);
    expect(plan.reachable.has(H_B)).toBe(true);
    expect(plan.refcount.get(H_A)).toBe(2);
    expect(plan.refcount.get(H_B)).toBe(1);
    // H_C 无人引用 → 孤儿。
    expect(plan.reclaimable.has(H_C)).toBe(true);
    expect(plan.reclaimable.size).toBe(1);
  });

  it('回收站文档引用只保活、不计入活动 refcount', () => {
    const active = docWithRefs('d1', [H_A]);
    const trash = docWithRefs('t1', [H_B]);
    const plan = computeAssetGcPlan({
      docs: [active],
      trashDocs: [trash],
      conflictCopyRefs: [],
      knownAssets: [H_A, H_B, H_C],
    });
    expect(plan.reachable.has(H_B)).toBe(true);
    expect(plan.refcount.has(H_B)).toBe(false); // 回收站不计活动引用计数
    expect(plan.reclaimable.has(H_C)).toBe(true);
    expect(plan.reclaimable.has(H_A)).toBe(false);
    expect(plan.reclaimable.has(H_B)).toBe(false);
  });

  it('冲突副本引用保活（即使活动/回收站都没引）', () => {
    const plan = computeAssetGcPlan({
      docs: [],
      trashDocs: [],
      conflictCopyRefs: [H_A],
      knownAssets: [H_A, H_B],
    });
    expect(plan.reachable.has(H_A)).toBe(true);
    expect(plan.reclaimable.has(H_A)).toBe(false);
    expect(plan.reclaimable.has(H_B)).toBe(true);
  });
});

describe('computeAssetGcPlan: 安全水位', () => {
  it('vv 空 → watermark=0，允许物理清除', () => {
    const plan = computeAssetGcPlan({
      docs: [],
      trashDocs: [],
      conflictCopyRefs: [],
      knownAssets: [H_A],
    });
    expect(plan.watermark).toBe(0);
    expect(plan.mayPhysicallyPurge).toBe(true);
  });

  it('vv 有已知客户端（watermark>0）→ 禁止物理清除', () => {
    const plan = computeAssetGcPlan({
      docs: [],
      trashDocs: [],
      conflictCopyRefs: [],
      knownAssets: [H_A],
      vv: { cA: 10, cB: 5 },
    });
    expect(plan.watermark).toBe(5);
    expect(plan.mayPhysicallyPurge).toBe(false);
  });
});

describe('computeAssetGcPlan: 幂等与不可变', () => {
  it('重复计算结果一致', () => {
    const d1 = docWithRefs('d1', [H_A]);
    const known = [H_A, H_B];
    const p1 = computeAssetGcPlan({
      docs: [d1], trashDocs: [], conflictCopyRefs: [], knownAssets: known,
    });
    const p2 = computeAssetGcPlan({
      docs: [d1], trashDocs: [], conflictCopyRefs: [], knownAssets: known,
    });
    expect([...p1.reclaimable]).toEqual([...p2.reclaimable]);
    expect(p1.refcount.get(H_A)).toBe(p2.refcount.get(H_A));
  });

  it('不改入参文档', () => {
    const d1 = docWithRefs('d1', [H_A, OLD_NANOID]);
    const snapshot = JSON.parse(JSON.stringify(d1));
    computeAssetGcPlan({ docs: [d1], trashDocs: [], conflictCopyRefs: [], knownAssets: [H_A] });
    expect(d1).toEqual(snapshot);
  });

  it('坏输入（缺字段/非数组）不抛，且产出空计划（零回收、零引用）', () => {
    const plan = computeAssetGcPlan({
      docs: undefined as unknown as KBNoteDoc[],
      trashDocs: undefined,
      conflictCopyRefs: undefined,
      knownAssets: undefined,
    });
    // 安全契约：坏输入绝不产出待回收集合——否则 emptyTrash / 物理清除会误删 blob。
    // reachable/reclaimable/refcount 三者必须全空；watermark=0（vv 缺失）。
    expect(plan.reachable.size).toBe(0);
    expect(plan.reclaimable.size).toBe(0);
    expect(plan.refcount.size).toBe(0);
    expect(plan.watermark).toBe(0);
    // reclaimable 为空时物理清除许可为真也是空操作（无可删），锁此真实契约。
    expect(plan.mayPhysicallyPurge).toBe(true);
  });
});

describe('orphanRefsAfterPurge: refcount 归零才进保留区', () => {
  it('删除回收站文档后，仅「不再被任何剩余文档引用」的 ref 成为孤儿', () => {
    // H_A 同时被活动文档引用 → 不是孤儿；H_B 只被这份回收站文档引用 → 孤儿。
    const purged = docWithRefs('t1', [H_A, H_B]);
    const remainingActive = docWithRefs('d1', [H_A]);
    const orphans = orphanRefsAfterPurge({
      purgedDoc: purged,
      remainingDocs: [remainingActive],
      remainingTrashDocs: [],
      conflictCopyRefs: [],
    });
    expect(orphans.has(H_B)).toBe(true);
    expect(orphans.has(H_A)).toBe(false);
  });

  it('内容寻址 dedup：同一 hash 被两篇活动文档引用时，回收站删除不影响', () => {
    // H_A 被两篇活动文档引用（refcount=2），回收站文档也引了 H_A。
    const purged = docWithRefs('t1', [H_A]);
    const orphans = orphanRefsAfterPurge({
      purgedDoc: purged,
      remainingDocs: [docWithRefs('d1', [H_A]), docWithRefs('d2', [H_A])],
      remainingTrashDocs: [],
      conflictCopyRefs: [],
    });
    expect(orphans.has(H_A)).toBe(false);
  });

  it('冲突副本保活：即使其余文档都不引，冲突副本引了就不算孤儿', () => {
    const purged = docWithRefs('t1', [H_A]);
    const orphans = orphanRefsAfterPurge({
      purgedDoc: purged,
      remainingDocs: [],
      remainingTrashDocs: [],
      conflictCopyRefs: [H_A],
    });
    expect(orphans.has(H_A)).toBe(false);
  });

  it('剩余回收站文档仍引用 → 不算孤儿', () => {
    const purged = docWithRefs('t1', [H_A]);
    const otherTrash = docWithRefs('t2', [H_A]);
    const orphans = orphanRefsAfterPurge({
      purgedDoc: purged,
      remainingDocs: [],
      remainingTrashDocs: [otherTrash],
      conflictCopyRefs: [],
    });
    expect(orphans.has(H_A)).toBe(false);
  });
});

describe('computeAssetGcPlan: 历史版本引用过的资产不被误删（保守）', () => {
  it('assetRefs 累积语义：只要文档历史登记过就保活', () => {
    // 即使节点已删，assetRefs 仍累积登记 → reachable，绝不回收。
    const d = docWithRefs('d1', [H_A, H_B]);
    d.nodes.push(createNode('image', 0, 0));
    const plan = computeAssetGcPlan({
      docs: [d],
      trashDocs: [],
      conflictCopyRefs: [],
      knownAssets: [H_A, H_B, H_C],
    });
    expect(plan.reclaimable.has(H_A)).toBe(false);
    expect(plan.reclaimable.has(H_B)).toBe(false);
    expect(plan.reclaimable.has(H_C)).toBe(true);
  });
});
