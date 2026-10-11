import {
  parseKBNote,
  serializeKBNote,
  mergeSnapshots,
  type KBNoteDoc,
  type CollabConflict,
} from '@drawpaper/core';
import { db } from '@/storage/db';
import { editorStore, storageAdapter } from '@/store/editor-store';
import { syncStamper } from './stamper';
import { loadOrCreateDeviceClientId } from './device-identity';
import { useSyncUi } from './sync-ui-store';
import { getAsset, writeAssetToRef } from '@/storage/opfs';
import { packZip, unpackZip, encodeText, decodeText, KbpackError } from './kbpack';
import {
  buildKbpackManifest,
  parseKbpackManifest,
  planKbpackImport,
  type KbpackManifest,
} from './kbpack-manifest';

/**
 * 手动备份包通道（Wave11 阶段 B）：零网络、零托管。
 *
 * 导出「全部文档为单个 .kbpack」：Blob 下载，用户自己存到 U 盘 / 网盘 / 发给另一台设备。
 * 导入「.kbpack 并合并」：逐文档走 mergeSnapshots（绝不整包覆盖），资产回填 OPFS。
 * 与在线两通道（FSA / WebDAV）互斥无关——本通道是一次性手动搬运，不常驻、不轮询、零请求。
 */

export interface KbpackImportSummary {
  totalDocs: number;
  /** 本端没有、直接收进库的新文档数。 */
  importedNew: number;
  /** 本端已有、跑 mergeSnapshots 合并的文档数。 */
  merged: number;
  /** 合并产生的冲突字段数。 */
  conflicts: number;
  /** 回填的资产数。 */
  assetsRestored: number;
  /** 因当前设备不支持 OPFS 或写盘失败而未回填的资产数（文档仍已落库）。 */
  skippedAssets: number;
  /** 跳过的坏档数。 */
  skipped: number;
  /** 合并后写回的文档 id（供 UI 提示/打开）。 */
  docIds: string[];
}

/** 文件名时间戳（下载用）。 */
function fileStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * 导出全部文档为单个 .kbpack（store-only ZIP）Blob。
 * 包含：manifest.json + docs/<id>.kbnote × N + assets/<ref> × M。
 */
export async function exportAllToKbpackBlob(): Promise<{ blob: Blob; filename: string }> {
  editorStore.getState().requestSave();
  await new Promise((r) => setTimeout(r, 400));

  const localDocs = await db.docs.toArray();
  const stamped = localDocs.map((d) => syncStamper.stampForPersist(d));
  const manifest: KbpackManifest = buildKbpackManifest(stamped, loadOrCreateDeviceClientId());

  const entries: { name: string; data: Uint8Array }[] = [];
  entries.push({ name: 'manifest.json', data: encodeText(JSON.stringify(manifest, null, 2)) });

  // 文档本体。
  for (const doc of stamped) {
    entries.push({ name: `docs/${doc.id}.kbnote`, data: encodeText(serializeKBNote(doc)) });
  }

  // 资产二进制（按 manifest 收集去重）。
  const assetRefs = new Set<string>();
  for (const doc of stamped) for (const ref of doc.assetRefs) assetRefs.add(ref);
  let assetsRestored = 0;
  for (const ref of assetRefs) {
    const blob = await getAsset(ref);
    if (!blob) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    entries.push({ name: `assets/${ref}`, data: bytes });
    assetsRestored += 1;
  }
  void assetsRestored;

  const zip = packZip(entries);
  const out = new Blob([zip.buffer as ArrayBuffer], { type: 'application/octet-stream' });
  return { blob: out, filename: `drawpaper-backup-${fileStamp()}.kbpack` };
}

/** 触发浏览器下载（Blob → a[download]）。 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 导入一个 .kbpack 字节流并【合并】进本端库。
 * - 逐文档：本端没有 → 直接收；本端已有 → mergeSnapshots(本端, 包内)，绝不覆盖。
 * - 资产：按 manifest 把 assets/<ref> 写回 OPFS（仅补本端缺失）。
 * 抛 KbpackError 时本端未做任何改动（解析失败即返回）。
 */
export async function importKbpackBundle(bytes: Uint8Array): Promise<KbpackImportSummary> {
  const entries = unpackZip(bytes);
  const byName = new Map<string, Uint8Array>();
  for (const e of entries) byName.set(e.name, e.data);

  const manifestRaw = byName.get('manifest.json');
  if (!manifestRaw) throw new KbpackError('not-zip', '备份包缺少 manifest.json');
  const manifest = parseKbpackManifest(decodeText(manifestRaw));

  // 本端现状。
  const localDocs = await db.docs.toArray();
  const localIds = new Set<string>(localDocs.map((d) => d.id));
  const localAssets = new Set<string>();
  for (const d of localDocs) for (const ref of d.assetRefs) localAssets.add(ref);

  const plan = planKbpackImport(localIds, localAssets, manifest);

  const summary: KbpackImportSummary = {
    totalDocs: plan.totalDocs,
    importedNew: 0,
    merged: 0,
    conflicts: 0,
    assetsRestored: 0,
    skippedAssets: 0,
    skipped: 0,
    docIds: [],
  };

  // 逐文档落库。
  for (const [docId, entry] of Object.entries(manifest.docs)) {
    const docBytes = byName.get(entry.file);
    if (!docBytes) {
      summary.skipped += 1;
      continue;
    }
    let remoteDoc: KBNoteDoc;
    try {
      remoteDoc = parseKBNote(decodeText(docBytes)).doc;
    } catch {
      summary.skipped += 1;
      continue;
    }

    const localDoc = await db.docs.get(docId);
    let merged: KBNoteDoc;
    let conflicts: CollabConflict[] = [];
    if (localDoc) {
      const r = mergeSnapshots(localDoc, remoteDoc);
      merged = r.doc;
      conflicts = r.conflicts;
      summary.merged += 1;
    } else {
      merged = remoteDoc;
      summary.importedNew += 1;
    }

    const active = editorStore.getState().currentDocId === docId;
    if (active) await editorStore.getState().snapshotDoc('备份包导入合并前');
    await storageAdapter.saveDoc(merged);
    if (active) {
      syncStamper.beginRemoteApply();
      editorStore.getState().applyRemoteDoc(merged);
      syncStamper.endRemoteApply(merged);
    }
    if (conflicts.length > 0) summary.conflicts += conflicts.length;
    summary.docIds.push(docId);
  }

  // 资产回填（本端缺失者）。
  // no-OPFS 设备（Safari/WebKit/旧浏览器，Wave21 降级目标平台）上 writeAssetToRef 内部
  // getAssetsDir 会抛 OpfsUnavailableError。文档此刻已全部落库，绝不能让首个资产写失败
  // 把整个 importKbpackBundle reject、进而让 caller 弹「导入备份包失败」的假错误。
  // 逐资产 try/catch：失败计入 skippedAssets 并 continue，文档以降级形态（缺图/dataURL）保留。
  for (const ref of plan.missingAssets) {
    const assetBytes = byName.get(`assets/${ref}`);
    if (!assetBytes) continue;
    try {
      await writeAssetToRef(ref, assetBytes);
      summary.assetsRestored += 1;
    } catch {
      summary.skippedAssets += 1;
    }
  }

  useSyncUi.getState().bumpCounts(0, summary.merged + summary.importedNew);
  return summary;
}
