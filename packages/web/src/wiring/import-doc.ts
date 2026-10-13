import { parseKBNote, importedDocWithFreshId, type KBNoteDoc } from '@drawpaper/core';
import { db } from '@/storage/db';

/**
 * 导入 .kbnote 的碰撞防护接缝（Web 层）。
 *
 * 背景（Wave33 A1）：旧实现 parseKBNote 后直接 loadDoc → switchDoc → autosave →
 * db.docs.put，若导入文件的 doc.id 与库内已有文档相同，会静默整包覆盖原档
 *（无提示、无合并、无被替换档快照）。
 *
 * 本模块把「parse → 碰撞检测 → 决定落哪份文档」收敛为一个 async 纯接缝：
 *  - 解析失败照常抛 KBNoteFileError（调用方负责 toast）；
 *  - 库内已存在同 id 文档时，走 core `importedDocWithFreshId` fork 一份新 id 副本，
 *    原档一字节不动；
 *  - 无碰撞则原样返回解析出的文档。
 *
 * panels 导入动作（create-panels-api）与 e2e dev-hook（importKbnoteText）共用本接缝，
 * 保证测试喂入路径与真实用户路径行为一致。
 */

export interface ImportKbnoteOutcome {
  /** 实际应 loadDoc 的文档（碰撞时为 fresh-id 副本）。 */
  doc: KBNoteDoc;
  /** 经过了哪些迁移（展示用）。 */
  migrationNotes: string[];
  /** 是否发生了 id 碰撞（true = 已转为副本导入）。 */
  collision: boolean;
}

/**
 * 解析 .kbnote 文本并做碰撞决策。
 * 抛错语义与 parseKBNote 一致（KBNoteFileError / zod error），不落盘、不 loadDoc。
 */
export async function importKbnoteTextWithGuard(text: string): Promise<ImportKbnoteOutcome> {
  const { doc, migrationNotes } = parseKBNote(text);
  const existing = await db.docs.get(doc.id);
  if (existing) {
    return { doc: importedDocWithFreshId(doc), migrationNotes, collision: true };
  }
  return { doc, migrationNotes, collision: false };
}
