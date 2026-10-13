import type { KBNoteDoc } from '../model/index.js';
import { CURRENT_DOC_VERSION, DOC_FORMAT } from '../model/index.js';
import { safeParseKBNoteDoc } from '../model/index.js';
import { migrateV2ToV3, migrateV3ToV4 } from '../sync/migrate.js';
import { nanoid } from 'nanoid';

/**
 * serialize 模块：.kbnote 序列化 / 解析 / 版本迁移。
 * .kbnote 本质是 JSON；这里只做确定性的字符串化与版本升级管线。
 */

export { CURRENT_DOC_VERSION, DOC_FORMAT };

/** 解析 .kbnote 时的类型化错误。kind 区分失败原因。 */
export type KBNoteFileErrorKind = 'invalid-json' | 'wrong-format' | 'unsupported-version' | 'schema';

export class KBNoteFileError extends Error {
  readonly kind: KBNoteFileErrorKind;
  constructor(kind: KBNoteFileErrorKind, message: string) {
    super(message);
    this.name = 'KBNoteFileError';
    this.kind = kind;
  }
}

/**
 * 把文档序列化为 .kbnote 文件内容（UTF-8 JSON，2 空格缩进）。
 * 键序稳定：format/version 在前，其余按模型定义顺序。
 */
export function serializeKBNote(doc: KBNoteDoc): string {
  const ordered: Record<string, unknown> = {
    format: doc.format,
    version: doc.version,
    id: doc.id,
    title: doc.title,
    board: doc.board,
    nodes: doc.nodes,
    edges: doc.edges,
    tags: doc.tags,
    layout: doc.layout,
    viewport: doc.viewport,
    page: doc.page,
    assetRefs: doc.assetRefs,
    links: doc.links,
    sync: doc.sync ?? { vv: {} },
  };
  return JSON.stringify(ordered, null, 2);
}

/**
 * v1 -> v2 迁移步（纯数据补字段，不做内容抽取）：
 *  - version 置 2
 *  - 补 links = []（反链索引由 web 从 Tiptap docRef mark 重建，迁移期不抽取）
 *  - edges 原样保留（points 缺省即默认贝塞尔）
 * 不从 Tiptap 内容抽取链接——那是 web 侧链接 agent 的职责。
 */
function migrateV1ToV2(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  return {
    ...obj,
    version: 2,
    links: Array.isArray(obj['links']) ? obj['links'] : [],
  };
}

/**
 * 迁移管线：一个 version step = 把 v(n) 的 JSON 对象升级为 v(n+1)。
 * 注册 key 为「源版本」。以后每升一版，在此注册一步即可。
 */
export type MigrationStep = (raw: unknown) => unknown;

/** version n -> 升级到 n+1 的 step 注册表。 */
export const MIGRATION_REGISTRY: Record<number, MigrationStep> = {
  1: migrateV1ToV2,
  2: migrateV2ToV3,
  3: migrateV3ToV4,
};

/** 每个迁移步的人类可读说明（migrationNotes 展示给用户）。 */
export const MIGRATION_NOTES: Record<number, string> = {
  1: 'v1→v2：新增 links/points 字段',
  2: 'v2→v3：注入同步元数据（版本向量/字段时钟/墓碑集），开启跨设备合并',
  3: 'v3→v4：资产引用规范化（去重/去空），启用内容寻址去重',
};

export interface ParseKBNoteResult {
  doc: KBNoteDoc;
  /** 经过了哪些迁移（从原版本升到 current），无迁移则空数组。 */
  migrationNotes: string[];
}

export interface MigrateResult {
  value: unknown;
  notes: string[];
}

/**
 * 按注册表把 raw（fromVersion 版）逐级升级到 CURRENT_DOC_VERSION。
 * fromVersion === current 时恒等返回。缺少 step 抛 KBNoteFileError。
 */
export function migrate(raw: unknown, fromVersion: number): MigrateResult {
  let current = raw;
  let v = fromVersion;
  const notes: string[] = [];
  while (v < CURRENT_DOC_VERSION) {
    const step = MIGRATION_REGISTRY[v];
    if (!step) {
      throw new KBNoteFileError('unsupported-version', `未注册从版本 ${v} 的迁移步骤`);
    }
    current = step(current);
    notes.push(MIGRATION_NOTES[v] ?? `migrated v${v} -> v${v + 1}`);
    v += 1;
  }
  return { value: current, notes };
}

/**
 * 解析 .kbnote 文本：JSON.parse → format/version 校验 → 逐级迁移 → zod 校验。
 * 非法 JSON / format 不符 / 版本高于 current / schema 不合法均抛类型化错误。
 */
export function parseKBNote(json: string): ParseKBNoteResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new KBNoteFileError('invalid-json', `文件不是合法 JSON：${(e as Error).message}`);
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new KBNoteFileError('wrong-format', '.kbnote 根节点必须是 JSON 对象');
  }
  const obj = raw as Record<string, unknown>;

  if (obj['format'] !== DOC_FORMAT) {
    throw new KBNoteFileError(
      'wrong-format',
      `format 必须为 "${DOC_FORMAT}"，实际为 ${JSON.stringify(obj['format'])}`,
    );
  }

  const version = obj['version'];
  if (typeof version !== 'number' || !Number.isFinite(version)) {
    throw new KBNoteFileError('wrong-format', 'version 缺失或不是数字');
  }
  if (version > CURRENT_DOC_VERSION) {
    throw new KBNoteFileError(
      'unsupported-version',
      `文件版本 v${version} 高于当前支持的 v${CURRENT_DOC_VERSION}，请升级应用`,
    );
  }

  let migrationNotes: string[] = [];
  let toValidate: unknown = raw;
  if (version < CURRENT_DOC_VERSION) {
    const result = migrate(raw, version);
    toValidate = result.value;
    migrationNotes = result.notes;
  }

  const parsed = safeParseKBNoteDoc(toValidate);
  if (!parsed.success) {
    throw parsed.error;
  }
  return { doc: parsed.doc, migrationNotes };
}

/** 已存储记录（IndexedDB 行）的宽容解析结果。 */
export type StoredDocResult = { success: true; doc: KBNoteDoc } | { success: false };

/**
 * 解析一条「已存进 IndexedDB 的文档对象」（不是 .kbnote 文本，无 format 包装）。
 *
 * 与 parseKBNote 同口径但作用于对象：先按 version 逐级迁移到 CURRENT_DOC_VERSION，
 * 再做 zod 校验。这样 v2/v3 旧版 IDB 记录（未被迁移重存）不会被误判为坏档；
 * 真正 JSON 结构损坏 / 字段类型错 / 迁移后仍不过 schema 的记录才判失败。
 *
 * 与 parseKBNote 的差异：不要求 format 字段（IDB 直接存 KBNoteDoc），版本高于 current
 * 也不抛，按无法校验返回 success:false（交由上层隔离）。
 */
export function parseStoredDoc(raw: unknown): StoredDocResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { success: false };
  }
  let toValidate: unknown = raw;
  const version = (raw as Record<string, unknown>)['version'];
  try {
    if (typeof version === 'number' && Number.isFinite(version) && version < CURRENT_DOC_VERSION && version >= 1) {
      toValidate = migrate(raw, version).value;
    }
    const parsed = safeParseKBNoteDoc(toValidate);
    return parsed.success ? { success: true, doc: parsed.doc } : { success: false };
  } catch {
    return { success: false };
  }
}

/** 导入副本标题后缀。 */
export const IMPORT_COPY_SUFFIX = '（导入副本）' as const;

/**
 * 导入碰撞时生成「导入副本」纯函数：
 * - 给文档本身分配新 doc id（`doc_` + nanoid，与 model/factory 同前缀约定）；
 * - 标题追加 {@link IMPORT_COPY_SUFFIX}；
 * - **节点/边/标签内部关系原样保留**：nodes/edges/tags 自身 id、edge.source/target、
 *   node.parentId、assetRefs、sync 元数据不动——连线不断、墓碑不丢；
 * - **links 反链索引随新 doc id 改写**：
 *   - 每条 link.sourceDocId → 新 id（提及发生在副本这张新文档里）；
 *   - 文档内提及（targetDocId === 旧 id）的 targetDocId 同步 → 新 id，否则文档内
 *     引用会变成指向旧文档的悬挂跨文档链；
 *   - 真正跨文档 link（targetDocId !== 旧 id）targetDocId 保持不变；
 *   - link 自身 id / sourceNodeId / targetNodeId / targetTitle 保留。
 *
 * 用途：导入的 .kbnote 与库内已有文档同 id 时，绝不覆盖原档；
 * 走本函数 fork 出一份独立新档再落库。零 DOM、纯数据变换。
 */
export function importedDocWithFreshId(doc: KBNoteDoc): KBNoteDoc {
  const oldId = doc.id;
  const newId = `doc_${nanoid()}`;
  const links = (doc.links ?? []).map((l) => ({
    ...l,
    sourceDocId: newId,
    targetDocId: l.targetDocId === oldId ? newId : l.targetDocId,
  }));
  return {
    ...doc,
    id: newId,
    title: `${doc.title}${IMPORT_COPY_SUFFIX}`,
    links,
  };
}
