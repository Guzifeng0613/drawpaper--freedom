import type { KBNoteDoc } from '../model/index.js';

/**
 * 平台适配器接口（core 只定义类型，由 web / Tauri 各端实现）。
 * 这是「core 零 DOM、三端复用」的接缝：core 不直接碰 IndexedDB / 窗口 / 打印。
 */

/**
 * 跨端 Blob 抽象（core 不引用 DOM 类型，故 duck-type 一个最小形状；
 * web 侧浏览器原生 Blob、Tauri 侧 Rust 侧都可满足此结构）。
 */
export interface BlobLike {
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  slice(start?: number, end?: number): BlobLike;
}

// ============ StorageAdapter：本地文档与 Blob 存储 ============

/** 文档元信息（列表用）。 */
export interface DocMeta {
  id: string;
  title: string;
  updatedAt: number;
  createdAt: number;
  /** 记录无法通过结构校验（坏档）：列表隔离展示，仅可删除/导出原始数据。 */
  corrupt?: boolean;
}

/**
 * 快照记录元信息（历史版本列表用）。
 * snapshot 为序列化后的 .kbnote 文本（恢复时经 parseKBNote 校验）。
 */
export interface SnapshotMeta {
  id: string;
  docId: string;
  takenAt: number;
  label: string | null;
}

/** 快照完整记录（含文本本体）。 */
export interface SnapshotRecord extends SnapshotMeta {
  text: string;
}

/** 回收站文档元信息（比 DocMeta 多一个被删时间）。 */
export interface TrashDocMeta extends DocMeta {
  trashedAt: number;
}

export interface StorageAdapter {
  /** 保存/覆盖整份文档（自动保存防抖 500ms 由调用方控制）。 */
  saveDoc(doc: KBNoteDoc): Promise<void>;
  /** 按 id 加载文档；不存在返回 null。 */
  loadDoc(id: string): Promise<KBNoteDoc | null>;
  /** 列出全部文档元信息（按 updatedAt 倒序，不含回收站）。 */
  listDocs(): Promise<DocMeta[]>;
  /**
   * 删除文档。P1 起语义为「移入回收站」：实现方应把整份 doc 拷入 trash 表并打上 trashedAt，
   * 而非物理删除；物理删除由 purgeTrash 显式触发。
   */
  deleteDoc(id: string): Promise<void>;

  /** 读取附件 Blob（OPFS）。 */
  getAsset(assetRef: string): Promise<BlobLike | null>;
  /** 写入附件 Blob，返回引用 id。 */
  putAsset(blob: BlobLike): Promise<{ assetRef: string }>;
  /** 删除附件 Blob。 */
  deleteAsset(assetRef: string): Promise<void>;

  // ---- 可选：自动快照 / 回收站（P1；缺省时对应 store action 安全降级为 no-op）----
  /** 写入一条快照（实现方负责按 docId 保留最近 N 条、淘汰最旧）。 */
  saveSnapshot?(docId: string, label: string | null, text: string): Promise<SnapshotMeta>;
  /** 列出某文档的全部快照（takenAt 倒序）。 */
  listSnapshots?(docId: string): Promise<SnapshotMeta[]>;
  /** 读取单条快照全文；不存在返回 null。 */
  getSnapshot?(id: string): Promise<SnapshotRecord | null>;
  /** 物理删除一条快照。 */
  deleteSnapshot?(id: string): Promise<void>;

  /** 列出回收站（trashedAt 倒序）。 */
  listTrash?(): Promise<TrashDocMeta[]>;
  /** 从回收站恢复到 docs（取消删除）。 */
  restoreFromTrash?(id: string): Promise<void>;
  /** 物理删除回收站中的一份文档（连同其 assetRefs 附件）。 */
  purgeTrash?(id: string): Promise<void>;
  /** 清空回收站（物理删除全部）。 */
  emptyTrash?(): Promise<void>;
}

// ============ HostAdapter：平台外壳能力（文件选择/打印/分享）============

/** showOpenFilePicker 等 File System Access API 的最小形状（web 不支持时降级）。 */
export interface OpenFileResult {
  /** 文件名（含 .kbnote）。 */
  name: string;
  text: string;
}

export interface HostAdapter {
  /** 弹出系统打开文件框，读取 .kbnote 文本。不支持时 resolve 为 null（web 降级为 <input type=file>）。 */
  showOpenFilePicker(): Promise<OpenFileResult | null>;
  /** 弹出保存文件框，把文本落盘为 .kbnote。不支持时触发下载。 */
  showSaveFilePicker(filename: string, text: string): Promise<void>;
  /** 触发系统打印（另存为 PDF）。 */
  print(): void;
  /** 分享（Web Share / Tauri 分享）。 */
  share?(payload: { title: string; text?: string; file?: BlobLike }): Promise<void>;
}

// ============ AIProvider（P1，接口先行，零后端）============

/** OpenAI 兼容 chat.completions 请求形状（用户自配 endpoint + key）。 */
export interface AIChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIChatRequest {
  endpoint: string;
  apiKey: string;
  model: string;
  messages: AIChatMessage[];
  /** 要求模型输出 JSON。 */
  responseFormat?: 'json';
  temperature?: number;
}

export interface AIChatResponse {
  content: string;
}

export interface AIProvider {
  chat(req: AIChatRequest): Promise<AIChatResponse>;
}

/** AI 给出的「建议」：新增父子边 / 建议根 / 分组 / 拆块 / 摘要。Schema 校验后才进入 diff。 */
export interface AISuggestion {
  type: 'add-edge' | 'set-root' | 'group' | 'split-block' | 'summarize';
  /** 建议涉及的节点 id（已知的）。 */
  nodeIds?: string[];
  /** 建议新增的边（source→target）。仅 type=add-edge 使用。 */
  proposedEdges?: Array<{ source: string; target: string; label?: string }>;
  /**
   * type=split-block / summarize：建议写入块的文本段落（纯文本，store 包成 Tiptap paragraph）。
   * type=group：分组块的标题文本。
   */
  text?: string;
  /** type=group：分组容器块标题（缺省用 text 或「分组」）。 */
  title?: string;
  /** type=split-block：在该节点之后新建兄弟块；缺省取 nodeIds[0]。 */
  afterNodeId?: string;
  /** 自然语言说明（UI 展示用）。 */
  reason: string;
}

/** AI diff：一组待用户逐条勾选的建议。 */
export interface AIDiff {
  suggestions: AISuggestion[];
}

// ============ File System Access 活动文件能力（web 注入；core 零 DOM）============

/**
 * 活动本地文件句柄能力。句柄本体（FileSystemFileHandle）是浏览器对象，
 * 留在 web 侧并可经 IndexedDB 持久化；core 只持有「文件名」用于标题栏状态。
 * 不支持 File System Access API 的浏览器整组为 undefined，store 自动降级为纯 IndexedDB 自动保存。
 */
export interface FsaCapability {
  /** 当前浏览器是否支持 File System Access（能力检测，供 UI 降级提示）。 */
  isSupported(): boolean;
  /** 弹系统打开框选 .kbnote；返回文件名+文本。取消/不支持为 null。 */
  pickLocalFile(): Promise<{ name: string; text: string } | null>;
  /**
   * 把文本写入「当前活动句柄」（web 内部 500ms 防抖）。
   * 无活动句柄时返回 false（调用方应维持 Dexie 自动保存）。
   */
  writeActiveFile(text: string): Promise<boolean>;
  /** 弹另存为框落盘；返回最终文件名（含 .kbnote），取消为 null。 */
  saveFileAs(suggestedName: string, text: string): Promise<string | null>;
  /**
   * 上次恢复活动句柄时权限不足（浏览器重启后 permission 丢失）：
   * true 表示有待重新授权的句柄，写盘已暂停（Dexie 主保存继续，待写内容不丢）。
   */
  hasPendingReauth(): boolean;
  /**
   * 必须在用户手势（按钮点击）内调用：请求 readwrite 权限。
   * 成功返回文件名并恢复写盘；用户拒绝/取消返回 null。
   */
  relinkActiveFile(): Promise<string | null>;
}

// ============ 模板工厂（web 注入；core 只按 id 取用）============

/** 一份模板 = 产出结构完整的全新 KBNoteDoc（id/board 全新）。 */
export type TemplateFactory = () => KBNoteDoc;

// ============ CollabAdapter（P3 预留，空接口）============
/**
 * Yjs/CRDT 协作预留。本期不实现、不安装 yjs。
 * 仅固定接口形态：未来把文档层拆成独立记录后接入。
 */
export interface CollabAdapter {
  readonly docId: string;
  /** 连接/断开（未来）。 */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}
