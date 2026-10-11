import {
  computeAssetGcPlan,
  orphanRefsAfterPurge,
  type KBNoteDoc,
} from '@drawpaper/core';
import { db } from './db';
import {
  moveAssetToTrash,
  listTrashAssets,
  trashAssetsSize,
  emptyTrashAssets,
  listAssets,
} from './opfs';
import { listConflictCopies } from '@/sync/sync-db';

/**
 * Web 侧孤儿资产 GC 编排（Wave16 F 路阶段二）。
 *
 * 自动动作（purgeTrash/emptyTrash 触发）：
 *  - 物理清除一份回收站文档时，不盲目删它登记的 blob——同一份 blob 可能仍被别的
 *    文档引用（内容寻址 dedup）。只有 refcount 归零（不再被任何剩余活动/回收站文档
 *    或冲突副本引用）的 ref 才移进「保留区」（可恢复），不直接物理删除。
 *
 * 手动动作（设置里「清理未使用资产」入口）：
 *  - 计算已知资产里全部不可达项 → 移进保留区；
 *  - 显示可回收体积（字节）；用户确认后才物理清空保留区。
 */

/** 收集冲突副本登记里引用到的全部资产 ref。 */
async function conflictRefs(): Promise<string[]> {
  try {
    const rows = await listConflictCopies();
    const refs = new Set<string>();
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.text);
        for (const r of parsed?.assetRefs ?? []) {
          if (typeof r === 'string') refs.add(r);
        }
      } catch {
        /* 坏副本忽略 */
      }
    }
    return [...refs];
  } catch {
    return [];
  }
}

/** 取全部活动文档 + 回收站文档（内存对象）。 */
async function allDocs(): Promise<{ docs: KBNoteDoc[]; trash: KBNoteDoc[] }> {
  const docs = await db.docs.toArray();
  const trash = await db.trash.toArray();
  return { docs, trash };
}

/**
 * 即将物理清除一份回收站文档时，算出需要移入保留区的孤儿 ref。
 * （refcount 归零的那些；被剩余文档/冲突副本引用的不动。）
 */
export async function orphansAfterPurge(purgedDoc: KBNoteDoc): Promise<Set<string>> {
  const { docs, trash } = await allDocs();
  const remainingTrash = trash.filter((d) => d.id !== purgedDoc.id);
  return orphanRefsAfterPurge({
    purgedDoc,
    remainingDocs: docs,
    remainingTrashDocs: remainingTrash,
    conflictCopyRefs: await conflictRefs(),
  });
}

/**
 * 批量清空回收站时，统一算出全部待删文档的孤儿 ref 并集。
 *
 * 与逐行 orphansAfterPurge 的区别：此处「剩余回收站」为空集（全部 trash 行都将被删），
 * 因此多份 trash 文档共享的资产也会被正确判为孤儿——不会被兄弟 trash 行保活。
 *
 * 调用前提：db.trash 已清空（或即将清空），remainingTrashDocs 恒为空。
 * 返回的 Set 已去重，moveOrphansToTrash 逐 ref 移入恰好一次。
 */
export async function orphansAfterEmptyTrash(purgedDocs: KBNoteDoc[]): Promise<Set<string>> {
  const activeDocs = await db.docs.toArray();
  const cRefs = await conflictRefs();
  const allOrphans = new Set<string>();
  for (const doc of purgedDocs) {
    const orphans = orphanRefsAfterPurge({
      purgedDoc: doc,
      remainingDocs: activeDocs,
      remainingTrashDocs: [],
      conflictCopyRefs: cRefs,
    });
    for (const ref of orphans) allOrphans.add(ref);
  }
  return allOrphans;
}

/** 把指定 ref 移入保留区（带来源 doc 记录）。 */
export async function moveOrphansToTrash(refs: Set<string>, sourceDocId: string): Promise<number> {
  let moved = 0;
  for (const ref of refs) {
    await moveAssetToTrash(ref, { movedAt: Date.now(), sourceDocId });
    moved += 1;
  }
  return moved;
}

export interface ManualCleanupResult {
  /** 移进保留区的孤儿 ref 数。 */
  movedToRetention: number;
  /** 保留区现有总字节。 */
  retentionBytes: number;
  /** 安全水位（>0 时不建议物理清空）。 */
  watermark: number;
  mayPhysicallyPurge: boolean;
}

/**
 * 手动「清理未使用资产」：
 *  1. 计算全部已知资产里不可达的孤儿 → 移进保留区；
 *  2. 返回保留区体积与安全许可。物理清空由 UI 再调 confirmEmptyRetention。
 */
export async function runManualAssetCleanup(): Promise<ManualCleanupResult> {
  const { docs, trash } = await allDocs();
  const known = await listAssets();
  const plan = computeAssetGcPlan({
    docs,
    trashDocs: trash,
    conflictCopyRefs: await conflictRefs(),
    knownAssets: known,
  });
  let moved = 0;
  for (const ref of plan.reclaimable) {
    await moveAssetToTrash(ref, { movedAt: Date.now(), sourceDocId: 'manual' });
    moved += 1;
  }
  return {
    movedToRetention: moved,
    retentionBytes: await trashAssetsSize(),
    watermark: plan.watermark,
    mayPhysicallyPurge: plan.mayPhysicallyPurge,
  };
}

/** 保留区体积（字节）。 */
export async function retentionSize(): Promise<number> {
  return trashAssetsSize();
}

/** 保留区现有条目数。 */
export async function retentionCount(): Promise<number> {
  return (await listTrashAssets()).length;
}

/** 用户确认后物理清空保留区（不可恢复）。返回清除条数。 */
export async function confirmEmptyRetention(): Promise<number> {
  return emptyTrashAssets();
}
