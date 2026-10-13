import { nanoid } from 'nanoid';
import { createStore } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';
import type { StoreApi } from 'zustand/vanilla';
import type {
  BlockContent,
  BlockNode,
  BlockStyle,
  BlockType,
  Edge,
  KBNoteDoc,
  LayoutMode,
  PageSettings,
  Viewport,
} from '../model/index.js';
import { DEFAULT_EDGE_COLOR, DOC_FORMAT, CURRENT_DOC_VERSION, EMPTY_TIPTAP_DOC, DEFAULT_NODE_SIZES } from '../model/index.js';
import { createCommandStack } from './command.js';
import type { Command, CommandStack } from './command.js';
import type {
  AISuggestion,
  BlobLike,
  DocMeta,
  FsaCapability,
  SnapshotMeta,
  StorageAdapter,
  TemplateFactory,
  TrashDocMeta,
} from './adapters.js';
import { detectConflicts } from '../graph/index.js';
import type { CycleIssue, MultiParentIssue } from '../graph/index.js';
import { layoutTree } from '../layout/index.js';
import type { LayoutInput, LayoutPosition, MeasuredSize } from '../layout/index.js';
import { serializeKBNote, parseKBNote } from '../serialize/index.js';
import { extractDocLinks, stripDocRefMarks, retitleDocRefMarks } from '../links/index.js';

/** 每份文档自动快照保留的最近条数（超出淘汰最旧）。 */
export const SNAPSHOT_KEEP = 20;

/**
 * 从一组快照里保留最近 N 条（takenAt 倒序取前 N）。纯函数：web Dexie 与 node 内存桩共用。
 */
export function pruneSnapshotsToLatest<T extends { takenAt: number }>(items: T[], keep = SNAPSHOT_KEEP): T[] {
  return [...items].sort((a, b) => b.takenAt - a.takenAt).slice(0, keep);
}

/** UI 态标签/类型/颜色筛选（不落 doc）。 */
export interface TagFilter {
  tagIds: string[];
  types: BlockType[];
  colors: string[];
  match: 'any' | 'all';
}

/** 手动分页符（store 与导出 agent 的契约形状）。 */
export interface ManualPageBreak {
  id: string;
  x: number;
  y: number;
}

/**
 * LayoutInput 扩展：布局 agent 同期新增 manualFixed 字段前，本分支用局部接口条件传入；
 * 合并后字段就位即可删除此扩展（行为不变）。
 */
interface LayoutInputWithManual extends LayoutInput {
  manualFixed?: ReadonlySet<string>;
}

/**
 * EditorStore：全局编辑状态 + 全部 action。
 * 实现：zustand(vanilla) + immer middleware + 自研 Command 撤销栈。
 * 所有 doc 写操作经 CommandStack（可撤销、coalesce、宏）；UI 态用 immer draft。
 */

/** 交互模式（工具状态机）。 */
export type InteractionMode =
  | 'select' // 默认选择
  | 'connect' // 连线
  | 'pan' // 平移
  | 'box-select' // 框选
  | 'insert'; // 新建块

/** 保存状态（自动保存提示用）。 */
/** 保存状态（自动保存提示用）。 */
export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * 纯错误分类（core 零 DOM）：判断是否配额/磁盘已满类错误。
 * 覆盖 DOMException.name、Firefox NS_ERROR_* 与 message 文本；与 web fsa.ts 同口径。
 */
export function classifyStorageErrorKind(err: unknown): 'quota' | 'write-failed' {
  const name = (err as { name?: string } | null | undefined)?.name;
  if (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_FILE_NO_DEVICE_SPACE' ||
    name === 'NS_ERROR_DOM_FILESYSTEM_NO_MODIFICATION_ALLOWED_ERR'
  ) {
    return 'quota';
  }
  const msg = (err as { message?: string } | null | undefined)?.message ?? '';
  if (/quota|no space|no_device_space|enospc/i.test(msg)) return 'quota';
  return 'write-failed';
}

/**
 * 多父/成环冲突的用户裁决结果（由 UI 弹窗异步收集后回传）。
 * 多父：选唯一主父 edgeId，其余父子边经可撤销 Command 删除；
 * 成环：选一条边断开。不存在「降级为虚线回链」。
 */
export interface ConflictResolution {
  /** 多父：每个冲突节点选一条保留为主父的 edgeId。 */
  choosePrimaryParent: Record<string, string>;
  /** 成环：要断开的边 id。 */
  breakEdgeIds: string[];
}

/** 搜索索引句柄（MiniSearch 实例由 web 侧持有，core 只存不透明句柄）。 */
export type SearchIndexHandle = unknown;

/** 待裁决冲突负载（addEdge / 导入 / 粘贴后检测到）。 */
export interface PendingConflicts {
  multiParents: MultiParentIssue[];
  cycles: CycleIssue[];
  /** 触发本次冲突的新增边 id（用户取消时用于精确回退）。 */
  triggerEdgeIds: string[];
}

/** 一条搜索命中。 */
export interface SearchResultItem {
  nodeId: string;
  snippet: string;
}

/** 内部剪贴板（深拷贝）。 */
export interface ClipboardData {
  nodes: BlockNode[];
  edges: Edge[];
}

/** 对齐方式（纯几何）。 */
export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';
/** 分布轴向。 */
export type DistributeAxis = 'horizontal' | 'vertical';

/** flyTo 目标（web 动画消费）。 */
export interface FocusTarget {
  nodeId: string;
  nonce: number;
}

/** analyzer 返回形状（与 graph.GraphAnalysis 冲突部分结构一致）。 */
interface GraphAnalysisLike {
  multiParents: MultiParentIssue[];
  cycles: CycleIssue[];
}

/** layoutEngine 返回形状。 */
interface LayoutResultLike {
  positions: Record<string, LayoutPosition>;
}

/**
 * 创建 editor store 所需的可注入依赖。
 * 浏览器能力一律经此注入，保证 core 零 DOM。
 */
export interface StoreDeps {
  /** 本地文档/附件存储（存在时启用防抖自动保存）。 */
  storage?: StorageAdapter;
  /** 平台外壳能力（文件选择/打印/分享）——web 注入，store 不直接调用。 */
  host?: unknown;
  /** 时钟注入（默认 Date.now）。 */
  now?: () => number;
  /** 图冲突检测（默认 graph.detectConflicts）。 */
  analyzer?: (nodes: BlockNode[], edges: Edge[]) => GraphAnalysisLike;
  /** 布局引擎（默认 layout.layoutTree）。 */
  layoutEngine?: (input: LayoutInput, mode: LayoutMode) => LayoutResultLike;
  /** UI 冲突弹窗（web 注入）；resolve 给裁决，null = 取消回滚。 */
  resolveConflictUi?: (pending: PendingConflicts) => Promise<ConflictResolution | null>;
  /** File System Access 活动文件能力（web 注入）；缺省则纯 IndexedDB 自动保存。 */
  fsa?: FsaCapability;
  /** 模板 id → 工厂（web 注入，6 份示例模板）；createDocFromTemplate 按 id 取用。 */
  templates?: Record<string, TemplateFactory>;
  /**
   * 本地自动保存失败通知（web 注入；core 零 DOM）。
   * quota = 配额/磁盘已满（引导导出）；write-failed = 其他写盘错误（toast）。
   * 与 FSA 路径共用同一套用户提示。
   */
  onSaveError?: (kind: 'quota' | 'write-failed', message?: string) => void;
}

/** Store 状态形状。 */
export interface EditorState {
  /** 当前打开的文档。 */
  doc: KBNoteDoc;
  /** 当前文档 id（= doc.id）。 */
  currentDocId: string;
  /** 文档列表元信息（来自 storage.listDocs）。 */
  docs: DocMeta[];

  /** 选中的节点 id 集合。 */
  selection: Set<string>;
  /** 选中的边 id 集合。 */
  edgeSelection: Set<string>;
  /** 当前正在编辑（块内 Tiptap）的节点 id。 */
  editingNodeId: string | null;
  /** 当前交互模式。 */
  mode: InteractionMode;
  /** 画布视口。 */
  viewport: Viewport;

  /** 撤销/重做可用。 */
  canUndo: boolean;
  canRedo: boolean;

  /** 待裁决冲突（null = 无）。 */
  pendingConflicts: PendingConflicts | null;

  /** 布局 UI 偏好（非 doc 持久化）。tighten：折叠后自动收紧。 */
  layoutUi: { scopeSelected: boolean; tighten: boolean };
  /** web 侧 ResizeObserver 实测尺寸。 */
  measuredSizes: Record<string, MeasuredSize>;
  /** 布局预览位置（不落 doc）；null = 无预览。 */
  layoutPreview: Record<string, LayoutPosition> | null;

  /** 搜索索引句柄。 */
  searchIndex: SearchIndexHandle;
  searchQuery: string;
  searchResults: SearchResultItem[];
  /**
   * 当前文档索引是否已喂完（rIC 分片喂入期间为 false）。
   * false 时搜索面板展示「正在建立索引…」而非把部分/空结果误报为「无匹配结果」。
   */
  searchReady: boolean;
  /** 搜索结果高亮的节点 id。 */
  searchHighlight: Set<string>;

  /** 内部剪贴板。 */
  clipboard: ClipboardData | null;

  /** 画布偏好。 */
  prefs: { showGrid: boolean; snapToGrid: boolean };
  /** doc 是否相对上次保存有改动。 */
  dirty: boolean;
  /** 保存状态与时间戳。 */
  saveState: SaveState;
  savedAt: number | null;

  /** flyTo 目标（每次 nonce++ 触发动画）。 */
  lastFocus: FocusTarget | null;

  /** 最近一次 undo/redo 事件（含命令名 + 递增 nonce），供画布判断是否回位相机。 */
  historyEvent: { kind: 'undo' | 'redo'; name: string; nonce: number } | null;

  /**
   * 活动本地文件（File System Access）。只持有文件名用于标题栏「已保存到 xxx.kbnote」；
   * 句柄本体在 web 侧。null = 纯 IndexedDB 自动保存。
   * needsAuth=true 表示句柄权限丢失、写盘已暂停，需用户在手势内重新授权。
   */
  activeFile: { name: string; needsAuth?: boolean } | null;
  /** 手动移动过的块 id（UI 态）：布局时作为 manualFixed 钉住，confirmLayout 后清空。 */
  manuallyMoved: Set<string>;
  /** 当前聚焦分支块 id（工具栏/画布高亮联动）。 */
  focusNodeId: string | null;
  /** 标签/类型/颜色筛选（UI 态，不落 doc）。 */
  tagFilter: TagFilter;
  /** 定时 JSON 备份开关（默认关；P1 由 web 按间隔提醒+下载）。 */
  backupEnabled: boolean;
}

/**
 * 全部 action 签名。
 * 约定：所有写操作内部走 Command（可撤销）；content/move/resize 走 coalesceKey 防抖合并。
 */
export interface EditorActions {
  // ---- 文档级 ----
  /** 新建空白文档（替换当前 doc，重置撤销栈）。 */
  newDoc(): void;
  /** 重命名当前文档。 */
  renameDoc(title: string): void;
  /** 以导入的文档替换当前。 */
  loadDoc(doc: KBNoteDoc): void;
  /** 复制当前文档为新 id 的副本并切换过去。 */
  duplicateDoc(): Promise<void>;
  /** 按 id 从 storage 打开文档。 */
  openDoc(id: string): Promise<void>;
  /** 从 storage 刷新文档列表。 */
  listDocs(): Promise<void>;
  /** 删除指定文档（storage）。 */
  deleteDoc(id: string): Promise<void>;

  // ---- 节点 CRUD ----
  /** 新建块（type + 位置），返回新块 id。 */
  addNode(type: BlockType, x: number, y: number): string;
  /** 批量新建块。 */
  addNodes(nodes: BlockNode[]): void;
  /** 粘贴/拖拽图片：dataURL 直接进 image 块，返回新块 id。 */
  addImageBlock(dataUrl: string, x: number, y: number): string;
  /** 删除块（连同其出入边）。 */
  deleteNode(id: string): void;
  /** 删除多个块。 */
  deleteNodes(ids: string[]): void;
  /**
   * Wave7 P2.1：删除块并「一并移除链接」——先摘同文档内指向被删块的 docRef mark，
   * 再删块；两步打包为一次可撤销 macro（删块 + mark 清理同进同退）。
   * 跨文档（其他 Dexie 文档里的源 mark）由 web 存储层级联并快照，不进本 undo 栈。
   */
  deleteNodesWithLinkCleanup(ids: string[], stripLinkIds: ReadonlySet<string>): void;
  /**
   * Wave7 P2.1 重命名追踪：把当前文档内指向 targetNodeId 的 docRef mark
   * （可见文本 + attrs.targetTitle）刷新为新标题。可撤销命令；跨文档源 mark 由 web 存储层回写。
   */
  retitleSelfMarks(targetNodeId: string, newTitle: string): void;
  /** 更新块内富文本 content（防抖合并）。 */
  updateContent(id: string, data: unknown): void;
  /** 移动块。 */
  moveNode(id: string, x: number, y: number): void;
  /** 调整块尺寸。 */
  resizeNode(id: string, width: number, height: number): void;
  /** 更新块样式（颜色/背景/边框补丁）。 */
  updateNodeStyle(id: string, patch: Partial<BlockStyle>): void;
  /** 切换块类型（斜杠菜单 / hover 工具条）；内容重置为该类型空稿，尺寸取默认。
   *  content 可选：web 侧传入类型专属空稿（如表格 2x2 网格）；缺省为通用空段落。 */
  setBlockType(id: string, type: BlockType, content?: BlockContent): void;

  // ---- 边（父子）----
  /** 新增父子边；若产生多父/成环，挂起冲突等待 resolveConflicts。 */
  addEdge(
    source: string,
    target: string,
    opts?: {
      label?: string;
      color?: string;
      sourceHandle?: Edge['sourceHandle'];
      targetHandle?: Edge['targetHandle'];
    },
  ): void;
  /** 删除边。 */
  deleteEdge(id: string): void;
  /** 设置边颜色。 */
  setEdgeColor(id: string, color: string): void;
  /** 设置边文字标签。 */
  setEdgeLabel(id: string, label: string): void;
  /** 设置边手动弯折点（世界坐标，≤64；空数组=恢复贝塞尔）。可撤销。 */
  setEdgePoints(id: string, points: Array<{ x: number; y: number }>): void;
  /**
   * 多选边一键清除弯折点：对每条边把 points 清空（恢复贝塞尔），
   * 合并为一次可撤销宏（P2.1）。无弯折点的边自动跳过。
   */
  clearEdgesPoints(ids: readonly string[]): void;

  // ---- 导图键盘建块 ----
  /** Tab：在选中块下新建子块并连父子边。 */
  tabAddChild(): void;
  /** Enter：在同级新建兄弟块。 */
  enterAddSibling(): void;
  /** Shift+Tab：把当前块升级（脱离当前父，挂到祖父）。 */
  shiftTabDemote(): void;

  // ---- 对齐 / 分布（纯几何，宏命令）----
  alignSelection(mode: AlignMode): void;
  distributeSelection(axis: DistributeAxis): void;

  // ---- 布局（宏命令，可撤销）----
  /** 一键整理：预览→应用→落位，整体作为一条可撤销宏。 */
  applyLayout(): void;
  /** 用 measuredSizes + layoutEngine 算位置写入 layoutPreview（不落 doc）。 */
  previewLayout(): void;
  /** 把预览位置作为一条宏命令落 doc、清预览，单次 undo 整体回退。 */
  confirmLayout(): void;
  /** 取消预览（不落 doc）。 */
  cancelLayout(): void;
  setLayoutMode(mode: LayoutMode): void;
  setSpacing(rankSpacing: number, nodeSpacing: number): void;
  toggleScopeSelected(): void;
  setTighten(on: boolean): void;

  // ---- 块属性 ----
  /** 置顶/取消置顶（pinned）。 */
  togglePin(id: string): void;
  /** 折叠/展开子分支。 */
  toggleCollapse(id: string): void;
  /** todo 块勾选。 */
  toggleTodo(id: string): void;

  // ---- 标签 ----
  addTagToNode(nodeId: string, tagId: string): void;
  removeTagFromNode(nodeId: string, tagId: string): void;

  // ---- 页面 / 测量 ----
  setPageSettings(patch: Partial<PageSettings>): void;
  setPageOrigin(origin: { x: number; y: number }): void;
  setMeasuredSizes(map: Record<string, MeasuredSize>): void;

  // ---- 搜索 ----
  setSearchQuery(query: string): void;
  setSearchResults(results: SearchResultItem[]): void;
  clearSearchHighlight(): void;
  /** web 写入不透明索引句柄。 */
  setSearchIndex(handle: SearchIndexHandle): void;
  /** web 标记索引喂入完成/进行中（分片重建生命周期）。 */
  setSearchReady(ready: boolean): void;

  // ---- 选择 / 模式 ----
  setSelection(ids: string[]): void;
  setEdgeSelection(ids: string[]): void;
  setMode(mode: InteractionMode): void;
  setEditingNode(id: string | null): void;
  setViewport(vp: Viewport): void;

  // ---- 剪贴板 ----
  copy(): void;
  cut(): void;
  paste(): void;
  duplicate(): void;

  // ---- 撤销重做 ----
  undo(): void;
  redo(): void;

  // ---- 冲突裁决 ----
  /** UI 弹窗收集完用户裁决后回传，store 据此落定主父、删除多余边、断环。 */
  resolveConflicts(resolution: ConflictResolution): void;

  // ---- 导入导出 / 保存 ----
  /** 序列化为 .kbnote 文本。 */
  exportKBNoteText(): string;
  /** 解析 .kbnote 文本并加载（触发冲突检测）。 */
  importKBNoteText(json: string): void;
  /** 触发一次立即落盘（不等防抖窗口）。 */
  requestSave(): void;
  /** 保存失败后由 UI「重试」按钮触发：复位退避标记并立即落盘一次。 */
  retrySave(): void;
  /**
   * Wave9 协作：把「远端合并后的 doc」作为新基线直接落库。
   * 不进 undo 栈——重置命令栈基线为新 doc（远端 op 不可撤销，本地 undo 基线随之重置，
   * 这是同浏览器多标签协作的有意取舍：远端合并后本地撤销栈整体作废，见 collab-multitab.md）。
   * 供 web CollabManager 在 applyOp/applySnapshot 收敛后调用。
   */
  applyRemoteDoc(doc: KBNoteDoc): void;
  /** flyTo：仅记录 viewport 目标，web 动画消费。 */
  flyToNode(nodeId: string): void;

  // ---- 保存状态 ----
  setSaveState(s: SaveState): void;
  setPrefs(patch: Partial<{ showGrid: boolean; snapToGrid: boolean }>): void;

  // ---- 标签 CRUD（doc.tags 为真相；全部可撤销）----
  /** 新建标签，返回 id。 */
  createTag(name: string, color: string): string;
  renameTag(id: string, name: string): void;
  setTagColor(id: string, color: string): void;
  /** 删除标签：宏命令，从 doc.tags 与所有节点 tags 中移除（可撤销）。 */
  deleteTag(id: string): void;
  /** 筛选态补丁（UI 态，不落 doc）。 */
  setTagFilter(patch: Partial<TagFilter>): void;
  clearTagFilter(): void;

  // ---- 结构调整（大纲拖拽 / 边反转）----
  /** 改父子归属：删旧入边、建新边 newParent→node、同步 parentId 冗余。newParentId=null 退化为根。 */
  reparentNode(nodeId: string, newParentId: string | null, index?: number): void;
  /** 反转边方向（source/target 与句柄位互换）。 */
  reverseEdge(edgeId: string): void;

  // ---- 手动分页符（写入 doc.page.pageBreaks，供导出）----
  addManualPageBreak(id: string, x: number, y: number): void;
  removePageBreak(id: string): void;
  setPageBreaks(breaks: ManualPageBreak[]): void;

  // ---- AI 建议应用（一条宏命令，可撤销）----
  applyAISuggestions(suggestions: ReadonlyArray<AISuggestion>, accepted: ReadonlySet<number>): void;

  // ---- 聚焦 / 手动位置 ----
  setFocusNode(id: string | null): void;

  // ---- 文档生命周期：快照 / 回收站 / 模板 / 备份 ----
  /** 拍一条当前文档快照（label 可空）。 */
  snapshotDoc(label?: string): Promise<void>;
  listSnapshots(docId: string): Promise<SnapshotMeta[]>;
  /** 恢复快照：作为一条可撤销/可再恢复命令替换当前 doc。 */
  restoreSnapshot(id: string): Promise<void>;
  listTrash(): Promise<TrashDocMeta[]>;
  restoreTrash(id: string): Promise<void>;
  purgeTrash(id: string): Promise<void>;
  emptyTrash(): Promise<void>;
  /** 用模板 id 新建文档（deps.templates 注册）。 */
  createDocFromTemplate(templateId: string): void;
  setBackupEnabled(on: boolean): void;

  // ---- File System Access 活动文件 ----
  openLocalFile(): Promise<void>;
  saveLocalFileAs(): Promise<void>;
  clearActiveFile(): void;
  /** 用户手势内重新请求活动文件 readwrite 权限；成功后恢复写盘。 */
  relinkActiveFile(): Promise<void>;

  // ---- 附件（OPFS）----
  /** 写入图片 Blob 到 OPFS 并登记 doc.assetRefs；返回引用 src（OPFS 不可用返回 src=''，调用方降级 dataURL）。 */
  putImageAsset(blob: BlobLike): Promise<{ src: string; assetRef?: string }>;
}

/** 组合后的 store：state + actions。 */
export type EditorStore = EditorState & EditorActions;

/** createEditorStore 返回值：zustand vanilla store（web 用 useStore 接线）。 */
export type EditorStoreApi = StoreApi<EditorStore>;

/** 深拷贝（core 无 structuredClone；doc 全是 JSON 数据）。 */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 空 Tiptap doc 数据的全新副本（structuredClone 在 core 被禁，用 JSON 克隆）。 */
function emptyDocData(): unknown {
  return deepClone(EMPTY_TIPTAP_DOC);
}

function makeBlock(id: string, type: BlockType, x: number, y: number): BlockNode {
  const node: BlockNode = {
    id,
    type,
    x,
    y,
    width: 220,
    height: 80,
    content: { format: 'tiptap-json', data: { type: 'doc', content: [] } },
    parentId: null,
    pinned: false,
    locked: false,
    collapsed: false,
    tags: [],
    style: {},
  };
  if (type === 'todo') node.todo = { checked: false };
  return node;
}

function blankDoc(now: number): KBNoteDoc {
  return {
    format: DOC_FORMAT,
    version: CURRENT_DOC_VERSION,
    id: nanoid(),
    title: '未命名画布',
    board: { createdAt: now, updatedAt: now },
    nodes: [],
    edges: [],
    tags: [],
    layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
    viewport: { x: 0, y: 0, zoom: 1 },
    page: {
      size: 'A4',
      orientation: 'portrait',
      marginMm: 15,
      mode: 'fit',
      showPageBreak: true,
      colorMode: 'color',
      header: false,
      footer: false,
      showPageNumbers: false,
      edgeLabels: true,
      pageBreaks: [],
    },
    assetRefs: [],
    links: [],
    sync: { vv: {} },
  };
}

/**
 * 创建 editor store（zustand vanilla + immer + Command 栈）。
 * @param init  初始文档
 * @param deps  可注入依赖（storage / now / analyzer / layoutEngine / resolveConflictUi）
 */
export function createEditorStore(init: KBNoteDoc, deps: StoreDeps = {}): EditorStoreApi {
  const now = deps.now ?? (() => Date.now());
  const analyze: NonNullable<StoreDeps['analyzer']> =
    deps.analyzer ?? ((nodes, edges) => detectConflicts(nodes, edges));
  const runLayout: NonNullable<StoreDeps['layoutEngine']> = deps.layoutEngine ?? layoutTree;

  let stack: CommandStack = createCommandStack(init, { now, coalesceWindowMs: 800 });
  let saveTimer: number | undefined;
  /** 本次失败是否已退避自动重试过一次（成功后复位）。 */
  let saveRetryArmed = false;
  let focusNonce = 0;
  let historyNonce = 0;
  /**
   * 同一剪贴板连续粘贴的级联偏移计数（会话态，不落 doc / undo）。
   * 第 N 次粘贴偏移 24*N；新一次 copy/cut 后归零，下次 paste 回到 +24 档。
   */
  let pasteCascade = 0;

  // ---- 自动快照（打开时 + 每 5 分钟，有改动才拍；仅 storage 支持时启用）----
  const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  let snapshotDirty = false;

  /** 纯文本 → 合法空 Tiptap doc（单段落）。core 不校验其内部结构。 */
  function paragraphDoc(text: string): unknown {
    return {
      type: 'doc',
      content: text
        ? [{ type: 'paragraph', content: [{ type: 'text', text }] }]
        : [{ type: 'paragraph' }],
    };
  }

  /** 判断 candidate 是否 nodeId 的后代（沿父子边向下）。供 reparent 成环防护。 */
  function isDescendantOf(doc: KBNoteDoc, nodeId: string, candidate: string): boolean {
    const children = new Map<string, string[]>();
    for (const e of doc.edges) {
      const arr = children.get(e.source) ?? [];
      arr.push(e.target);
      children.set(e.source, arr);
    }
    const stack2 = [nodeId];
    const seen = new Set<string>();
    while (stack2.length > 0) {
      const cur = stack2.pop()!;
      if (cur === candidate) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const c of children.get(cur) ?? []) stack2.push(c);
    }
    return false;
  }

  const store = createStore<EditorStore>()(
    immer((set, get) => {
      // ---------- 内部辅助（闭包） ----------
      const syncUndoFlags = () => {
        set((d) => {
          d.canUndo = stack.canUndo();
          d.canRedo = stack.canRedo();
        });
      };

      const flushSave = async () => {
        saveTimer = undefined;
        if (!deps.storage) return;
        // 保存前从块正文 docRef mark 重建规范化反链索引（纯函数；无 mark 时结果与现状一致）。
        const cur = get().doc;
        const prevLinks = cur.links ?? [];
        const links = extractDocLinks(cur.id, cur.nodes, { existingLinks: prevLinks, now });
        const doc: KBNoteDoc =
          links.length === prevLinks.length && links.every((l, i) => l.id === prevLinks[i]?.id)
            ? cur
            : { ...cur, links };
        if (doc !== cur) set((d) => void (d.doc = doc));
        set((d) => {
          d.saveState = 'saving';
        });
        try {
          await deps.storage.saveDoc(doc);
          // 双写：有活动本地句柄时，同一份 JSON 落盘到 .kbnote 文件（web 内部防抖）。
          if (get().activeFile && deps.fsa) {
            try {
              await deps.fsa.writeActiveFile(serializeKBNote(doc));
            } catch {
              /* 文件写入失败不阻塞 IndexedDB 主保存（下次自动保存重试） */
            }
          }
          set((d) => {
            d.saveState = 'saved';
            d.savedAt = now();
            d.dirty = false;
          });
          saveRetryArmed = false;
          // 保存成功后刷新文档列表侧栏（新建/重命名/复制即时可见，无需手动刷新）。
          if (deps.storage) {
            try {
              const metas = await deps.storage.listDocs();
              set((d) => {
                d.docs = metas;
              });
            } catch {
              /* 列表刷新失败不阻塞保存主流程 */
            }
          }
        } catch (err) {
          // 本地主保存（IndexedDB）失败：不再静默吞成 idle。
          // 区分配额错误，显式置 error 态并通知接线层（与 FSA 路径共用 toast/弹窗），
          // 且退避自动重试一次（成功即回 saved），不形成无限重试风暴。
          const kind = classifyStorageErrorKind(err);
          set((d) => {
            d.saveState = 'error';
          });
          deps.onSaveError?.(kind, err instanceof Error ? err.message : undefined);
          if (!saveRetryArmed) {
            saveRetryArmed = true;
            saveTimer = setTimeout(() => {
              saveTimer = undefined;
              void flushSave();
            }, 1500);
          }
        }
      };

      const scheduleAutosave = () => {
        set((d) => {
          d.dirty = true;
        });
        if (!deps.storage) return;
        if (saveTimer !== undefined) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          void flushSave();
        }, 500);
      };

      const runCommand = (cmd: Command) => {
        const nextDoc = stack.push(cmd);
        snapshotDirty = true;
        set((d) => {
          d.doc = nextDoc;
          d.dirty = true;
        });
        syncUndoFlags();
        scheduleAutosave();
      };

      const runMacro = (name: string, cmds: Command[]) => {
        if (cmds.length === 0) return;
        const nextDoc = stack.executeMacro(name, cmds);
        snapshotDirty = true;
        set((d) => {
          d.doc = nextDoc;
          d.dirty = true;
        });
        syncUndoFlags();
        scheduleAutosave();
      };

      const mapNode = (doc: KBNoteDoc, id: string, fn: (n: BlockNode) => BlockNode): KBNoteDoc => ({
        ...doc,
        nodes: doc.nodes.map((n) => (n.id === id ? fn(n) : n)),
      });

      /** 切换文档（新建/打开/导入）：重置撤销栈与临时 UI 态。 */
      const switchDoc = (doc: KBNoteDoc) => {
        stack = createCommandStack(doc, { now, coalesceWindowMs: 800 });
        snapshotDirty = false;
        set((d) => {
          d.doc = doc;
          d.currentDocId = doc.id;
          d.selection = new Set();
          d.edgeSelection = new Set();
          d.editingNodeId = null;
          d.viewport = { ...doc.viewport };
          d.pendingConflicts = null;
          d.layoutPreview = null;
          d.searchQuery = '';
          d.searchResults = [];
          d.searchHighlight = new Set();
          d.canUndo = false;
          d.canRedo = false;
          d.manuallyMoved = new Set();
          d.focusNodeId = null;
          d.activeFile = null;
          d.dirty = true;
        });
        scheduleAutosave();
        // 打开文档即拍一条基线快照，并启动定时自动快照轮询。
        void takeSnapshot();
        armAutoSnapshot();
      };

      const applyResolution = (resolution: ConflictResolution) => {
        const pending = get().pendingConflicts;
        if (!pending) return;
        const drop = new Set<string>();
        for (const mp of pending.multiParents) {
          const keep = resolution.choosePrimaryParent[mp.nodeId];
          for (const eid of mp.parentEdgeIds) if (eid !== keep) drop.add(eid);
        }
        for (const eid of resolution.breakEdgeIds) drop.add(eid);

        const { doc } = get();
        const cmds: Command[] = [];
        for (const eid of drop) {
          const edge = doc.edges.find((e) => e.id === eid);
          if (!edge) continue;
          cmds.push({
            name: 'drop-edge',
            execute: (d) => ({ ...d, edges: d.edges.filter((e) => e.id !== eid) }),
            undo: (d) => ({ ...d, edges: [...d.edges, edge] }),
          });
        }
        runMacro('resolve-conflicts', cmds);
        set((d) => {
          d.pendingConflicts = null;
        });
      };

      /** 检测冲突；有则写 pendingConflicts 并调 UI 弹窗；取消回滚，裁决落定。 */
      const promptConflicts = (triggerEdgeIds: string[], depthBefore: number) => {
        const { doc } = get();
        const { multiParents, cycles } = analyze(doc.nodes, doc.edges);
        if (multiParents.length === 0 && cycles.length === 0) return;
        const pending: PendingConflicts = { multiParents, cycles, triggerEdgeIds };
        set((d) => {
          d.pendingConflicts = pending;
        });
        const resolver = deps.resolveConflictUi;
        if (!resolver) return;
        void resolver(pending)
          .then((resolution) => {
            if (!resolution) {
              // 取消：精确回退本次触发命令
              while (stack.depth().undo > depthBefore) {
                const undone = stack.undo();
                if (undone) {
                  set((d) => {
                    d.doc = undone;
                    d.dirty = true;
                  });
                }
              }
              syncUndoFlags();
              scheduleAutosave();
              set((d) => {
                d.pendingConflicts = null;
              });
              return;
            }
            applyResolution(resolution);
          })
          .catch(() => {
            set((d) => {
              d.pendingConflicts = null;
            });
          });
      };

      /** 当前活跃节点（编辑优先，其次单选）。 */
      const activeNodeId = (): string | null => {
        const s = get();
        if (s.editingNodeId) return s.editingNodeId;
        if (s.selection.size === 1) return [...s.selection][0] ?? null;
        return null;
      };

      /** 拍一条快照（label 可空）；storage 不支持则静默跳过。 */
      const takeSnapshot = async (label?: string): Promise<void> => {
        const st = deps.storage;
        if (!st?.saveSnapshot) return;
        try {
          await st.saveSnapshot(get().doc.id, label ?? null, serializeKBNote(get().doc));
          snapshotDirty = false;
        } catch {
          /* 快照失败不阻塞主流程 */
        }
      };

      /** 启动每 5 分钟自动快照轮询（仅 storage 支持 saveSnapshot 时）。 */
      const armAutoSnapshot = () => {
        if (!deps.storage?.saveSnapshot) return;
        if (snapshotTimer !== undefined) clearTimeout(snapshotTimer);
        snapshotTimer = setTimeout(() => {
          if (snapshotDirty) void takeSnapshot();
          armAutoSnapshot();
        }, SNAPSHOT_INTERVAL_MS);
      };

      /**
       * 把 store 契约 ManualPageBreak[] 写入 doc.page.pageBreaks（纯变换，供 Command）。
       * model/zod 持久化形状为 {at:number}：at 取主轴坐标（纵向取 y、横向/平铺取 x）；
       * id/x/y 在内存会话内供 removePageBreak 使用，经序列化再解析后由 zod 规整为 {at}。
       */
      const withBreaks = (doc: KBNoteDoc, breaks: ManualPageBreak[]): KBNoteDoc => {
        const landscape = doc.page.orientation === 'landscape';
        const stored = breaks.map((b) => ({
          at: landscape ? b.x : b.y,
          id: b.id,
          x: b.x,
          y: b.y,
        }));
        return { ...doc, page: { ...doc.page, pageBreaks: stored as unknown as typeof doc.page.pageBreaks } };
      };

      return {
        // ================= state =================
        doc: init,
        currentDocId: init.id,
        docs: [],
        selection: new Set(),
        edgeSelection: new Set(),
        editingNodeId: null,
        mode: 'select',
        viewport: { ...init.viewport },
        canUndo: false,
        canRedo: false,
        pendingConflicts: null,
        layoutUi: { scopeSelected: false, tighten: true },
        measuredSizes: {},
        layoutPreview: null,
        searchIndex: null,
        searchQuery: '',
        searchResults: [],
        searchReady: false,
        searchHighlight: new Set(),
        clipboard: null,
        prefs: { showGrid: true, snapToGrid: false },
        dirty: false,
        saveState: 'idle',
        savedAt: null,
        lastFocus: null,
        historyEvent: null,
        activeFile: null,
        manuallyMoved: new Set<string>(),
        focusNodeId: null,
        tagFilter: { tagIds: [], types: [], colors: [], match: 'any' },
        backupEnabled: false,

        // ================= 文档级 =================
        newDoc: () => switchDoc(blankDoc(now())),
        renameDoc: (title) => {
          // 调用时捕获旧标题：undo 逆操作必须回到改名前的标题，
          // 不能在 undo 运行时读 get().doc.title（那时已是新名，undo 退化为恒等）。
          const oldTitle = get().doc.title;
          runCommand({
            name: 'rename-doc',
            execute: (d) => ({ ...d, title }),
            undo: (d) => ({ ...d, title: oldTitle }),
          });
        },
        loadDoc: (doc) => switchDoc(doc),
        duplicateDoc: async () => {
          const copy = deepClone(get().doc);
          copy.id = nanoid();
          copy.title = `${get().doc.title} 副本`;
          copy.board = { createdAt: now(), updatedAt: now() };
          switchDoc(copy);
        },
        openDoc: async (id) => {
          if (!deps.storage) return;
          const doc = await deps.storage.loadDoc(id);
          if (doc) switchDoc(doc);
        },
        listDocs: async () => {
          if (!deps.storage) return;
          const metas = await deps.storage.listDocs();
          set((d) => {
            d.docs = metas;
          });
        },
        deleteDoc: async (id) => {
          if (deps.storage) await deps.storage.deleteDoc(id);
          if (deps.storage) {
            const metas = await deps.storage.listDocs();
            set((d) => {
              d.docs = metas;
            });
          }
          if (get().currentDocId === id) get().newDoc();
        },

        // ================= 节点 CRUD =================
        addNode: (type, x, y) => {
          const id = nanoid();
          const node = makeBlock(id, type, x, y);
          runCommand({
            name: 'add-node',
            execute: (d) => ({ ...d, nodes: [...d.nodes, node] }),
            undo: (d) => ({
              ...d,
              nodes: d.nodes.filter((n) => n.id !== id),
              edges: d.edges.filter((e) => e.source !== id && e.target !== id),
            }),
          });
          set((d) => {
            d.selection = new Set([id]);
          });
          return id;
        },
        addNodes: (nodes) => {
          const ids = new Set(nodes.map((n) => n.id));
          runCommand({
            name: 'add-nodes',
            execute: (d) => ({ ...d, nodes: [...d.nodes, ...nodes] }),
            undo: (d) => ({
              ...d,
              nodes: d.nodes.filter((n) => !ids.has(n.id)),
              edges: d.edges.filter((e) => !ids.has(e.source) && !ids.has(e.target)),
            }),
          });
        },
        addImageBlock: (dataUrl, x, y) => {
          const id = nanoid();
          const size = DEFAULT_NODE_SIZES.image;
          const node: BlockNode = {
            id,
            type: 'image',
            x,
            y,
            width: size.width,
            height: size.height,
            content: { format: 'tiptap-json', data: emptyDocData() },
            parentId: null,
            pinned: false,
            locked: false,
            collapsed: false,
            tags: [],
            style: {},
            image: { src: dataUrl, alt: '' },
          };
          runCommand({
            name: 'add-image-block',
            execute: (d) => ({ ...d, nodes: [...d.nodes, node] }),
            undo: (d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== id) }),
          });
          set((d) => {
            d.selection = new Set([id]);
          });
          return id;
        },
        deleteNode: (id) => {
          const { doc } = get();
          const node = doc.nodes.find((n) => n.id === id);
          if (!node) return;
          const removedEdges = doc.edges.filter((e) => e.source === id || e.target === id);
          runCommand({
            name: 'delete-node',
            execute: (d) => ({
              ...d,
              nodes: d.nodes.filter((n) => n.id !== id),
              edges: d.edges.filter((e) => e.source !== id && e.target !== id),
            }),
            undo: (d) => ({
              ...d,
              nodes: [...d.nodes, node],
              edges: [...d.edges, ...removedEdges],
            }),
          });
        },
        deleteNodes: (ids) => {
          if (ids.length === 0) return;
          const idSet = new Set(ids);
          const { doc } = get();
          const removedNodes = doc.nodes.filter((n) => idSet.has(n.id));
          const removedEdges = doc.edges.filter((e) => idSet.has(e.source) || idSet.has(e.target));
          runCommand({
            name: 'delete-nodes',
            execute: (d) => ({
              ...d,
              nodes: d.nodes.filter((n) => !idSet.has(n.id)),
              edges: d.edges.filter((e) => !idSet.has(e.source) && !idSet.has(e.target)),
            }),
            undo: (d) => ({
              ...d,
              nodes: [...d.nodes, ...removedNodes],
              edges: [...d.edges, ...removedEdges],
            }),
          });
        },
        deleteNodesWithLinkCleanup: (ids, stripLinkIds) => {
          if (ids.length === 0) return;
          const idSet = new Set(ids);
          const before = get().doc;
          const removedNodes = before.nodes.filter((n) => idSet.has(n.id));
          const removedEdges = before.edges.filter((e) => idSet.has(e.source) || idSet.has(e.target));
          // 第一步：摘同文档内指向被删块的 docRef mark（core 纯函数，结构共享无改动时自收敛）。
          // execute 必须是输入驱动的 doc→doc 变换：初次执行 d===before 结果与 capture 时一致；
          // redo（undo 后中间发生漂移编辑）时对当前状态重算，避免硬编码过期快照覆盖漂移编辑。
          runMacro('delete-nodes-with-link-cleanup', [
            {
              name: 'strip-incoming-docref-marks',
              execute: (d) => stripDocRefMarks(d, stripLinkIds).doc,
              // 逆操作：还原到 macro 前的整份文档（mark 复原）。
              undo: () => before,
            },
            {
              name: 'delete-nodes',
              execute: (d) => ({
                ...d,
                nodes: d.nodes.filter((n) => !idSet.has(n.id)),
                edges: d.edges.filter((e) => !idSet.has(e.source) && !idSet.has(e.target)),
              }),
              undo: (d) => ({
                ...d,
                nodes: [...d.nodes, ...removedNodes],
                edges: [...d.edges, ...removedEdges],
              }),
            },
          ]);
        },
        retitleSelfMarks: (targetNodeId, newTitle) => {
          const before = get().doc;
          const { doc: next, count } = retitleDocRefMarks(before, before.id, targetNodeId, newTitle);
          if (count === 0) return;
          runCommand({
            name: 'retitle-self-marks',
            execute: () => next,
            undo: () => before,
          });
        },
        updateContent: (id, data) => {
          const node = get().doc.nodes.find((n) => n.id === id);
          if (!node) return;
          const oldData = node.content.data;
          runCommand({
            name: 'update-content',
            coalesceKey: `content:${id}`,
            execute: (d) => mapNode(d, id, (n) => ({ ...n, content: { format: 'tiptap-json', data } })),
            undo: (d) => mapNode(d, id, (n) => ({ ...n, content: { format: 'tiptap-json', data: oldData } })),
          });
        },
        moveNode: (id, x, y) => {
          const node = get().doc.nodes.find((n) => n.id === id);
          if (!node) return;
          const ox = node.x;
          const oy = node.y;
          const dx = x - ox;
          const dy = y - oy;
          // 【P2.1 弯折点随块移动】弯折点刚性锚定在「源端点」坐标系：
          //  本节点作为某条边的 source 时，其弯折点随本节点位移整体平移 (dx,dy)；
          //  本节点仅作为 target 时弯折点不动（折线终点跟着动、内部折点原地保留）。
          //  多选手势两端同移时：source 平移一次、target 不再平移 → 不重复平移。
          //  平移与节点位移同处一个可撤销命令（coalesceKey: move），拖拽一次为一个撤销单元。
          const shiftPts = (d: KBNoteDoc, sx: number, sy: number): KBNoteDoc => ({
            ...d,
            edges: d.edges.map((e) => {
              if (e.source !== id || !e.points || e.points.length === 0) return e;
              return { ...e, points: e.points.map((p) => ({ x: p.x + sx, y: p.y + sy })) };
            }),
          });
          runCommand({
            name: 'move-node',
            coalesceKey: 'move',
            execute: (d) => shiftPts(mapNode(d, id, (n) => ({ ...n, x, y })), dx, dy),
            undo: (d) => shiftPts(mapNode(d, id, (n) => ({ ...n, x: ox, y: oy })), -dx, -dy),
          });
          // 手动移动过的块记入 manualFixed：后续一键布局为其绕行。
          // （Immer 未启用 MapSet 插件：从 get() 读原始集合，整体替换而非变更 draft。）
          const moved = get().manuallyMoved;
          set((d) => {
            d.manuallyMoved = new Set(moved).add(id);
          });
        },
        resizeNode: (id, width, height) => {
          const node = get().doc.nodes.find((n) => n.id === id);
          if (!node) return;
          const ow = node.width;
          const oh = node.height;
          runCommand({
            name: 'resize-node',
            coalesceKey: 'resize',
            execute: (d) => mapNode(d, id, (n) => ({ ...n, width, height })),
            undo: (d) => mapNode(d, id, (n) => ({ ...n, width: ow, height: oh })),
          });
        },
        updateNodeStyle: (id, patch) => {
          const node = get().doc.nodes.find((n) => n.id === id);
          if (!node) return;
          runCommand({
            name: 'update-node-style',
            execute: (d) => mapNode(d, id, (n) => ({ ...n, style: { ...n.style, ...patch } })),
            undo: (d) => mapNode(d, id, (n) => ({ ...n, style: { ...node.style } })),
          });
        },

        setBlockType: (id, type, content) => {
          const node = get().doc.nodes.find((n) => n.id === id);
          if (!node) return;
          const prev = {
            type: node.type,
            content: node.content,
            width: node.width,
            height: node.height,
            todo: node.todo,
            image: node.image,
          };
          const size = DEFAULT_NODE_SIZES[type] ?? DEFAULT_NODE_SIZES.text;
          runCommand({
            name: 'set-block-type',
            execute: (d) =>
              mapNode(d, id, (n) => {
                const next: BlockNode = {
                  ...n,
                  type,
                  // web 侧传入类型专属空稿（表格 2x2 网格等）；缺省回退通用空段落。
                  content: content ?? { format: 'tiptap-json', data: emptyDocData() },
                  width: size.width,
                  height: size.height,
                };
                if (type === 'todo') next.todo = { checked: false };
                else delete next.todo;
                if (type !== 'image') delete next.image;
                return next;
              }),
            undo: (d) =>
              mapNode(d, id, (n) => ({
                ...n,
                type: prev.type,
                content: prev.content,
                width: prev.width,
                height: prev.height,
                todo: prev.todo,
                image: prev.image,
              })),
          });
        },

        // ================= 边 =================
        addEdge: (source, target, opts) => {
          const { doc } = get();
          if (source === target) return; // 自环禁止
          if (!doc.nodes.some((n) => n.id === source)) return;
          if (!doc.nodes.some((n) => n.id === target)) return;
          if (doc.edges.some((e) => e.source === source && e.target === target)) return; // 重复边
          const edge: Edge = {
            id: nanoid(),
            source,
            target,
            sourceHandle: opts?.sourceHandle ?? 'right',
            targetHandle: opts?.targetHandle ?? 'left',
            label: opts?.label ?? '',
            directed: true,
            style: { color: opts?.color ?? DEFAULT_EDGE_COLOR.hex },
          };
          const depthBefore = stack.depth().undo;
          runCommand({
            name: 'add-edge',
            execute: (d) => ({ ...d, edges: [...d.edges, edge] }),
            undo: (d) => ({ ...d, edges: d.edges.filter((e) => e.id !== edge.id) }),
          });
          promptConflicts([edge.id], depthBefore);
        },
        deleteEdge: (id) => {
          const edge = get().doc.edges.find((e) => e.id === id);
          if (!edge) return;
          runCommand({
            name: 'delete-edge',
            execute: (d) => ({ ...d, edges: d.edges.filter((e) => e.id !== id) }),
            undo: (d) => ({ ...d, edges: [...d.edges, edge] }),
          });
        },
        setEdgeColor: (id, color) => {
          const edge = get().doc.edges.find((e) => e.id === id);
          if (!edge) return;
          runCommand({
            name: 'set-edge-color',
            execute: (d) => ({
              ...d,
              edges: d.edges.map((e) => (e.id === id ? { ...e, style: { color } } : e)),
            }),
            undo: (d) => ({
              ...d,
              edges: d.edges.map((e) => (e.id === id ? { ...e, style: { color: edge.style.color } } : e)),
            }),
          });
        },
        setEdgeLabel: (id, label) => {
          const edge = get().doc.edges.find((e) => e.id === id);
          if (!edge) return;
          const old = edge.label;
          runCommand({
            name: 'set-edge-label',
            execute: (d) => ({ ...d, edges: d.edges.map((e) => (e.id === id ? { ...e, label } : e)) }),
            undo: (d) => ({ ...d, edges: d.edges.map((e) => (e.id === id ? { ...e, label: old } : e)) }),
          });
        },
        setEdgePoints: (id, points) => {
          const edge = get().doc.edges.find((e) => e.id === id);
          if (!edge) return;
          const next = points.slice(0, 64);
          const old = edge.points ? edge.points.map((p) => ({ ...p })) : undefined;
          runCommand({
            name: 'set-edge-points',
            execute: (d) => ({
              ...d,
              edges: d.edges.map((e) =>
                e.id === id ? { ...e, points: next.length ? next : undefined } : e,
              ),
            }),
            undo: (d) => ({
              ...d,
              edges: d.edges.map((e) => (e.id === id ? { ...e, points: old ? old.map((p) => ({ ...p })) : undefined } : e)),
            }),
          });
        },
        clearEdgesPoints: (ids) => {
          const { doc } = get();
          const cmds: Command[] = [];
          for (const id of ids) {
            const edge = doc.edges.find((e) => e.id === id);
            if (!edge || !edge.points || edge.points.length === 0) continue;
            const old = edge.points.map((p) => ({ ...p }));
            cmds.push({
              name: 'clear-edge-points-one',
              execute: (d) => ({
                ...d,
                edges: d.edges.map((e) => (e.id === id ? { ...e, points: undefined } : e)),
              }),
              undo: (d) => ({
                ...d,
                edges: d.edges.map((e) =>
                  e.id === id ? { ...e, points: old.map((p) => ({ ...p })) } : e,
                ),
              }),
            });
          }
          runMacro('clear-edge-points', cmds);
        },

        // ================= 导图键盘建块 =================
        tabAddChild: () => {
          const parentId = activeNodeId();
          if (!parentId) return;
          const { doc } = get();
          const parent = doc.nodes.find((n) => n.id === parentId);
          if (!parent) return;
          const childId = nanoid();
          const edgeId = nanoid();
          const x = parent.x + parent.width + doc.layout.rankSpacing;
          const y = parent.y;
          const child = makeBlock(childId, 'text', x, y);
          const edge: Edge = {
            id: edgeId,
            source: parentId,
            target: childId,
            sourceHandle: 'right',
            targetHandle: 'left',
            label: '',
            directed: true,
            style: { color: DEFAULT_EDGE_COLOR.hex },
          };
          const depthBefore = stack.depth().undo;
          runMacro('tab-add-child', [
            {
              name: 'add-child',
              execute: (d) => ({ ...d, nodes: [...d.nodes, child] }),
              undo: (d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== childId) }),
            },
            {
              name: 'link-child',
              execute: (d) => ({ ...d, edges: [...d.edges, edge] }),
              undo: (d) => ({ ...d, edges: d.edges.filter((e) => e.id !== edgeId) }),
            },
          ]);
          set((d) => {
            d.selection = new Set([childId]);
            d.editingNodeId = childId;
          });
          promptConflicts([edgeId], depthBefore);
        },
        enterAddSibling: () => {
          const curId = activeNodeId();
          const { doc } = get();
          const sibId = nanoid();
          if (!curId) {
            const node = makeBlock(sibId, 'text', 40, 40);
            runCommand({
              name: 'add-root',
              execute: (d) => ({ ...d, nodes: [...d.nodes, node] }),
              undo: (d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== sibId) }),
            });
            set((d) => {
              d.selection = new Set([sibId]);
              d.editingNodeId = sibId;
            });
            return;
          }
          const cur = doc.nodes.find((n) => n.id === curId);
          if (!cur) return;
          const parentEdge = doc.edges.find((e) => e.target === curId);
          const sib = makeBlock(sibId, 'text', cur.x + 24, cur.y + cur.height + 40);
          const cmds: Command[] = [
            {
              name: 'add-sibling',
              execute: (d) => ({ ...d, nodes: [...d.nodes, sib] }),
              undo: (d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== sibId) }),
            },
          ];
          let edgeId: string | null = null;
          if (parentEdge) {
            edgeId = nanoid();
            const edge: Edge = {
              id: edgeId,
              source: parentEdge.source,
              target: sibId,
              sourceHandle: 'right',
              targetHandle: 'left',
              label: '',
              directed: true,
              style: { color: DEFAULT_EDGE_COLOR.hex },
            };
            cmds.push({
              name: 'link-sibling',
              execute: (d) => ({ ...d, edges: [...d.edges, edge] }),
              undo: (d) => ({ ...d, edges: d.edges.filter((e) => e.id !== edgeId) }),
            });
          }
          const depthBefore = stack.depth().undo;
          runMacro('enter-add-sibling', cmds);
          set((d) => {
            d.selection = new Set([sibId]);
            d.editingNodeId = sibId;
          });
          if (edgeId) promptConflicts([edgeId], depthBefore);
        },
        shiftTabDemote: () => {
          const curId = activeNodeId();
          if (!curId) return;
          const { doc } = get();
          if (!doc.nodes.some((n) => n.id === curId)) return;
          const parentEdge = doc.edges.find((e) => e.target === curId);
          if (!parentEdge) return; // 已是根
          const grandParentEdge = doc.edges.find((e) => e.target === parentEdge.source);
          const newEdgeId = nanoid();
          const cmds: Command[] = [
            {
              name: 'unlink-parent',
              execute: (d) => ({ ...d, edges: d.edges.filter((e) => e.id !== parentEdge.id) }),
              undo: (d) => ({ ...d, edges: [...d.edges, parentEdge] }),
            },
          ];
          if (grandParentEdge) {
            const newEdge: Edge = {
              id: newEdgeId,
              source: grandParentEdge.source,
              target: curId,
              sourceHandle: 'right',
              targetHandle: 'left',
              label: '',
              directed: true,
              style: { color: DEFAULT_EDGE_COLOR.hex },
            };
            cmds.push({
              name: 'relink-grandparent',
              execute: (d) => ({ ...d, edges: [...d.edges, newEdge] }),
              undo: (d) => ({ ...d, edges: d.edges.filter((e) => e.id !== newEdgeId) }),
            });
          }
          const depthBefore = stack.depth().undo;
          runMacro('shift-tab-demote', cmds);
          if (grandParentEdge) promptConflicts([newEdgeId], depthBefore);
        },

        // ================= 对齐 / 分布 =================
        alignSelection: (mode) => {
          const { doc, selection } = get();
          const selected = doc.nodes.filter((n) => selection.has(n.id));
          if (selected.length < 2) return;
          const xs = selected.map((n) => n.x);
          const ys = selected.map((n) => n.y);
          const minX = Math.min(...xs);
          const maxX = Math.max(...xs);
          const minY = Math.min(...ys);
          const maxY = Math.max(...ys);
          const cmds: Command[] = selected.map((n) => {
            let x = n.x;
            let y = n.y;
            switch (mode) {
              case 'left':
                x = minX;
                break;
              case 'right':
                x = maxX;
                break;
              case 'hcenter':
                x = (minX + maxX) / 2 - n.width / 2;
                break;
              case 'top':
                y = minY;
                break;
              case 'bottom':
                y = maxY;
                break;
              case 'vcenter':
                y = (minY + maxY) / 2 - n.height / 2;
                break;
            }
            return {
              name: 'align',
              execute: (d) => mapNode(d, n.id, (o) => ({ ...o, x, y })),
              undo: (d) => mapNode(d, n.id, (o) => ({ ...o, x: n.x, y: n.y })),
            };
          });
          runMacro('align-selection', cmds);
        },
        distributeSelection: (axis) => {
          const { doc, selection } = get();
          const selected = doc.nodes.filter((n) => selection.has(n.id));
          if (selected.length < 3) return;
          const cmds: Command[] = [];
          if (axis === 'horizontal') {
            const sorted = [...selected].sort((a, b) => a.x - b.x);
            const first = sorted[0]!;
            const last = sorted[sorted.length - 1]!;
            const span = last.x + last.width - first.x;
            const totalWidth = sorted.reduce((w, n) => w + n.width, 0);
            const gap = (span - totalWidth) / (sorted.length - 1);
            let cursor = first.x;
            for (const n of sorted) {
              cmds.push({
                name: 'distribute',
                execute: (d) => mapNode(d, n.id, (o) => ({ ...o, x: cursor, y: n.y })),
                undo: (d) => mapNode(d, n.id, (o) => ({ ...o, x: n.x, y: n.y })),
              });
              cursor += n.width + gap;
            }
          } else {
            const sorted = [...selected].sort((a, b) => a.y - b.y);
            const first = sorted[0]!;
            const last = sorted[sorted.length - 1]!;
            const span = last.y + last.height - first.y;
            const totalHeight = sorted.reduce((h, n) => h + n.height, 0);
            const gap = (span - totalHeight) / (sorted.length - 1);
            let cursor = first.y;
            for (const n of sorted) {
              cmds.push({
                name: 'distribute',
                execute: (d) => mapNode(d, n.id, (o) => ({ ...o, x: n.x, y: cursor })),
                undo: (d) => mapNode(d, n.id, (o) => ({ ...o, x: n.x, y: n.y })),
              });
              cursor += n.height + gap;
            }
          }
          runMacro('distribute-selection', cmds);
        },

        // ================= 布局 =================
        applyLayout: () => {
          get().previewLayout();
          get().confirmLayout();
        },
        previewLayout: () => {
          const s = get();
          const input: LayoutInputWithManual = {
            nodes: s.doc.nodes,
            edges: s.doc.edges,
            rankSpacing: s.doc.layout.rankSpacing,
            nodeSpacing: s.doc.layout.nodeSpacing,
            measured: s.measuredSizes,
            pinned: new Set(s.doc.nodes.filter((n) => n.pinned).map((n) => n.id)),
            collapsed: Object.fromEntries(
              s.doc.nodes.filter((n) => n.collapsed).map((n) => [n.id, true]),
            ),
            // 手动移动过的块作为 manualFixed 钉住（布局 agent 同期接入该字段）。
            manualFixed: s.manuallyMoved,
            tighten: s.layoutUi.tighten,
          };
          const result = runLayout(input, s.doc.layout.mode);
          set((d) => {
            d.layoutPreview = result.positions;
          });
        },
        confirmLayout: () => {
          const s = get();
          if (!s.layoutPreview) return;
          const cmds: Command[] = [];
          for (const [id, pos] of Object.entries(s.layoutPreview)) {
            const node = s.doc.nodes.find((n) => n.id === id);
            if (!node) continue;
            cmds.push({
              name: 'place',
              execute: (d) => mapNode(d, id, (n) => ({ ...n, x: pos.x, y: pos.y })),
              undo: (d) => mapNode(d, id, (n) => ({ ...n, x: node.x, y: node.y })),
            });
          }
          runMacro('confirm-layout', cmds);
          set((d) => {
            d.layoutPreview = null;
            // 布局落位后，手动钉住集合随新布局重置。
            d.manuallyMoved = new Set();
          });
        },
        cancelLayout: () => {
          set((d) => {
            d.layoutPreview = null;
          });
        },
        setLayoutMode: (mode) => {
          set((d) => {
            d.doc.layout.mode = mode;
            d.dirty = true;
          });
          scheduleAutosave();
        },
        setSpacing: (rankSpacing, nodeSpacing) => {
          set((d) => {
            d.doc.layout.rankSpacing = rankSpacing;
            d.doc.layout.nodeSpacing = nodeSpacing;
            d.dirty = true;
          });
          scheduleAutosave();
        },
        toggleScopeSelected: () => {
          set((d) => {
            d.layoutUi.scopeSelected = !d.layoutUi.scopeSelected;
          });
        },
        setTighten: (on) => {
          set((d) => {
            d.layoutUi.tighten = on;
          });
        },

        // ================= 块属性 =================
        togglePin: (id) => {
          const node = get().doc.nodes.find((n) => n.id === id);
          if (!node) return;
          const v = !node.pinned;
          runCommand({
            name: 'toggle-pin',
            execute: (d) => mapNode(d, id, (n) => ({ ...n, pinned: v })),
            undo: (d) => mapNode(d, id, (n) => ({ ...n, pinned: !v })),
          });
        },
        toggleCollapse: (id) => {
          const node = get().doc.nodes.find((n) => n.id === id);
          if (!node) return;
          const v = !node.collapsed;
          runCommand({
            name: 'toggle-collapse',
            execute: (d) => mapNode(d, id, (n) => ({ ...n, collapsed: v })),
            undo: (d) => mapNode(d, id, (n) => ({ ...n, collapsed: !v })),
          });
        },
        toggleTodo: (id) => {
          const node = get().doc.nodes.find((n) => n.id === id);
          if (!node) return;
          const v = !(node.todo?.checked ?? false);
          runCommand({
            name: 'toggle-todo',
            execute: (d) => mapNode(d, id, (n) => ({ ...n, todo: { checked: v } })),
            undo: (d) => mapNode(d, id, (n) => ({ ...n, todo: { checked: !v } })),
          });
        },

        // ================= 标签 =================
        addTagToNode: (nodeId, tagId) => {
          const node = get().doc.nodes.find((n) => n.id === nodeId);
          if (!node || node.tags.includes(tagId)) return;
          runCommand({
            name: 'add-tag',
            execute: (d) => mapNode(d, nodeId, (n) => ({ ...n, tags: [...n.tags, tagId] })),
            undo: (d) => mapNode(d, nodeId, (n) => ({ ...n, tags: n.tags.filter((t) => t !== tagId) })),
          });
        },
        removeTagFromNode: (nodeId, tagId) => {
          runCommand({
            name: 'remove-tag',
            execute: (d) => mapNode(d, nodeId, (n) => ({ ...n, tags: n.tags.filter((t) => t !== tagId) })),
            undo: (d) => mapNode(d, nodeId, (n) => ({ ...n, tags: [...n.tags, tagId] })),
          });
        },

        // ================= 页面 / 测量 =================
        setPageSettings: (patch) => {
          set((d) => {
            d.doc.page = { ...d.doc.page, ...patch };
            d.dirty = true;
          });
          scheduleAutosave();
        },
        setPageOrigin: (origin) => {
          set((d) => {
            d.doc.page.pageOrigin = origin;
            d.dirty = true;
          });
          scheduleAutosave();
        },
        setMeasuredSizes: (map) => {
          set((d) => {
            d.measuredSizes = map;
          });
        },

        // ================= 搜索 =================
        setSearchQuery: (query) => {
          set((d) => {
            d.searchQuery = query;
            if (!query) {
              d.searchResults = [];
              d.searchHighlight = new Set();
            }
          });
        },
        setSearchResults: (results) => {
          set((d) => {
            d.searchResults = results;
            d.searchHighlight = new Set(results.map((r) => r.nodeId));
          });
        },
        clearSearchHighlight: () => {
          set((d) => {
            d.searchHighlight = new Set();
          });
        },
        setSearchIndex: (handle) => {
          set((d) => {
            d.searchIndex = handle;
          });
        },
        setSearchReady: (ready) => {
          set((d) => {
            d.searchReady = ready;
          });
        },

        // ================= 选择 / 模式 =================
        setSelection: (ids) => {
          set((d) => {
            d.selection = new Set(ids);
          });
        },
        setEdgeSelection: (ids) => {
          set((d) => {
            d.edgeSelection = new Set(ids);
          });
        },
        setMode: (mode) => {
          set((d) => {
            d.mode = mode;
          });
        },
        setEditingNode: (id) => {
          set((d) => {
            d.editingNodeId = id;
          });
        },
        setViewport: (vp) => {
          set((d) => {
            d.viewport = { ...vp };
          });
        },

        // ================= 剪贴板 =================
        copy: () => {
          const { doc, selection } = get();
          const nodes = doc.nodes.filter((n) => selection.has(n.id));
          const edges = doc.edges.filter((e) => selection.has(e.source) && selection.has(e.target));
          pasteCascade = 0;
          set((d) => {
            d.clipboard = deepClone({ nodes, edges });
          });
        },
        cut: () => {
          get().copy();
          const ids = [...get().selection];
          get().deleteNodes(ids);
        },
        paste: () => {
          const s = get();
          if (!s.clipboard || s.clipboard.nodes.length === 0) return;
          pasteCascade += 1;
          const pasteOffset = 24 * pasteCascade;
          const oldToNew = new Map<string, string>();
          for (const n of s.clipboard.nodes) oldToNew.set(n.id, nanoid());
          const nodes: BlockNode[] = s.clipboard.nodes.map((n) => {
            const copy = deepClone(n);
            copy.id = oldToNew.get(n.id)!;
            copy.x += pasteOffset;
            copy.y += pasteOffset;
            copy.parentId = copy.parentId ? (oldToNew.get(copy.parentId) ?? null) : null;
            return copy;
          });
          const edges: Edge[] = s.clipboard.edges.map((e) => {
            const copy = deepClone(e);
            copy.id = nanoid();
            copy.source = oldToNew.get(e.source)!;
            copy.target = oldToNew.get(e.target)!;
            return copy;
          });
          const newNodeIds = new Set(nodes.map((n) => n.id));
          const newEdgeIds = new Set(edges.map((e) => e.id));
          runCommand({
            name: 'paste',
            execute: (d) => ({ ...d, nodes: [...d.nodes, ...nodes], edges: [...d.edges, ...edges] }),
            undo: (d) => ({
              ...d,
              nodes: d.nodes.filter((n) => !newNodeIds.has(n.id)),
              edges: d.edges.filter((e) => !newEdgeIds.has(e.id)),
            }),
          });
          set((d) => {
            d.selection = new Set(nodes.map((n) => n.id));
          });
        },
        duplicate: () => {
          get().copy();
          get().paste();
        },

        // ================= 撤销重做 =================
        undo: () => {
          const undone = stack.undo();
          if (undone) {
            historyNonce += 1;
            set((d) => {
              d.doc = undone;
              d.dirty = true;
              d.historyEvent = { kind: 'undo', name: stack.lastUndoName() ?? 'undo', nonce: historyNonce };
            });
          }
          syncUndoFlags();
          scheduleAutosave();
        },
        redo: () => {
          const redone = stack.redo();
          if (redone) {
            historyNonce += 1;
            set((d) => {
              d.doc = redone;
              d.dirty = true;
              d.historyEvent = { kind: 'redo', name: 'redo', nonce: historyNonce };
            });
          }
          syncUndoFlags();
          scheduleAutosave();
        },

        // ================= 冲突裁决 =================
        resolveConflicts: (resolution) => applyResolution(resolution),

        // ================= 导入导出 / 保存 =================
        exportKBNoteText: () => serializeKBNote(get().doc),
        importKBNoteText: (json) => {
          const { doc } = parseKBNote(json);
          switchDoc(doc);
          promptConflicts([], 0);
        },
        requestSave: () => {
          void flushSave();
        },
        retrySave: () => {
          saveRetryArmed = false;
          void flushSave();
        },
        applyRemoteDoc: (doc) => {
          // 远端合并结果作为新基线：重置命令栈（远端 op 不进 undo），落盘。
          stack = createCommandStack(doc, { now, coalesceWindowMs: 800 });
          snapshotDirty = true;
          set((d) => {
            d.doc = doc;
            d.dirty = true;
          });
          syncUndoFlags();
          scheduleAutosave();
        },
        flyToNode: (nodeId) => {
          focusNonce += 1;
          set((d) => {
            d.lastFocus = { nodeId, nonce: focusNonce };
          });
        },

        // ================= 保存状态 =================
        setSaveState: (s) => {
          set((d) => {
            d.saveState = s;
          });
        },
        setPrefs: (patch) => {
          set((d) => {
            d.prefs = { ...d.prefs, ...patch };
          });
        },

        // ================= 标签 CRUD =================
        createTag: (name, color) => {
          const id = 't_' + nanoid();
          runCommand({
            name: 'create-tag',
            execute: (d) => ({ ...d, tags: [...d.tags, { id, name, color }] }),
            undo: (d) => ({ ...d, tags: d.tags.filter((t) => t.id !== id) }),
          });
          return id;
        },
        renameTag: (id, name) => {
          const tag = get().doc.tags.find((t) => t.id === id);
          if (!tag) return;
          runCommand({
            name: 'rename-tag',
            execute: (d) => ({ ...d, tags: d.tags.map((t) => (t.id === id ? { ...t, name } : t)) }),
            undo: (d) => ({ ...d, tags: d.tags.map((t) => (t.id === id ? { ...t, name: tag.name } : t)) }),
          });
        },
        setTagColor: (id, color) => {
          const tag = get().doc.tags.find((t) => t.id === id);
          if (!tag) return;
          runCommand({
            name: 'set-tag-color',
            execute: (d) => ({ ...d, tags: d.tags.map((t) => (t.id === id ? { ...t, color } : t)) }),
            undo: (d) => ({ ...d, tags: d.tags.map((t) => (t.id === id ? { ...t, color: tag.color } : t)) }),
          });
        },
        deleteTag: (id) => {
          const doc = get().doc;
          const tag = doc.tags.find((t) => t.id === id);
          if (!tag) return;
          const hadTag = new Set(doc.nodes.filter((n) => n.tags.includes(id)).map((n) => n.id));
          runMacro('delete-tag', [
            {
              name: 'drop-tag',
              execute: (d) => ({ ...d, tags: d.tags.filter((t) => t.id !== id) }),
              undo: (d) => ({ ...d, tags: [...d.tags, tag] }),
            },
            {
              name: 'detach-tag-from-nodes',
              execute: (d) => ({
                ...d,
                nodes: d.nodes.map((n) =>
                  n.tags.includes(id) ? { ...n, tags: n.tags.filter((t) => t !== id) } : n,
                ),
              }),
              undo: (d) => ({
                ...d,
                nodes: d.nodes.map((n) =>
                  hadTag.has(n.id) && !n.tags.includes(id) ? { ...n, tags: [...n.tags, id] } : n,
                ),
              }),
            },
          ]);
        },
        setTagFilter: (patch) => {
          set((d) => {
            d.tagFilter = { ...d.tagFilter, ...patch };
          });
        },
        clearTagFilter: () => {
          set((d) => {
            d.tagFilter = { tagIds: [], types: [], colors: [], match: 'any' };
          });
        },

        // ================= 结构调整 =================
        reparentNode: (nodeId, newParentId, index) => {
          const { doc } = get();
          const node = doc.nodes.find((n) => n.id === nodeId);
          if (!node) return;
          if (newParentId === nodeId) return;
          if (newParentId && !doc.nodes.some((n) => n.id === newParentId)) return;
          // 成环防护：不能把节点挂到自己的后代下
          if (newParentId && isDescendantOf(doc, nodeId, newParentId)) return;

          const oldIncoming = doc.edges.filter((e) => e.target === nodeId);
          const oldParentId = node.parentId;
          const cmds: Command[] = [
            {
              name: 'detach-old-parent',
              execute: (d) => ({ ...d, edges: d.edges.filter((e) => e.target !== nodeId) }),
              undo: (d) => ({ ...d, edges: [...d.edges, ...oldIncoming] }),
            },
          ];

          if (newParentId) {
            const newEdge: Edge = {
              id: nanoid(),
              source: newParentId,
              target: nodeId,
              sourceHandle: 'right',
              targetHandle: 'left',
              label: '',
              directed: true,
              style: { color: DEFAULT_EDGE_COLOR.hex },
            };
            cmds.push({
              name: 'attach-new-parent',
              execute: (d) => {
                if (typeof index !== 'number') return { ...d, edges: [...d.edges, newEdge] };
                // 在新父的兄弟间按 index 落位（按 edges 数组中 source===newParentId 的顺序）。
                const others = d.edges.filter((e) => e.source !== newParentId);
                const sibs = d.edges.filter((e) => e.source === newParentId);
                const ordered = [...sibs];
                ordered.splice(Math.max(0, Math.min(index, ordered.length)), 0, newEdge);
                return { ...d, edges: [...others, ...ordered] };
              },
              undo: (d) => ({ ...d, edges: d.edges.filter((e) => e.id !== newEdge.id) }),
            });
          }

          cmds.push({
            name: 'sync-parent-id',
            execute: (d) => ({
              ...d,
              nodes: d.nodes.map((n) => (n.id === nodeId ? { ...n, parentId: newParentId } : n)),
            }),
            undo: (d) => ({
              ...d,
              nodes: d.nodes.map((n) => (n.id === nodeId ? { ...n, parentId: oldParentId } : n)),
            }),
          });

          runMacro('reparent-node', cmds);
        },
        reverseEdge: (edgeId) => {
          const edge = get().doc.edges.find((e) => e.id === edgeId);
          if (!edge) return;
          runCommand({
            name: 'reverse-edge',
            execute: (d) => ({
              ...d,
              edges: d.edges.map((e) =>
                e.id === edgeId
                  ? { ...e, source: e.target, target: e.source, sourceHandle: e.targetHandle, targetHandle: e.sourceHandle }
                  : e,
              ),
            }),
            undo: (d) => ({
              ...d,
              edges: d.edges.map((e) =>
                e.id === edgeId
                  ? { ...e, source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle }
                  : e,
              ),
            }),
          });
        },

        // ================= 手动分页符 =================
        addManualPageBreak: (id, x, y) => {
          const prev = get().doc.page.pageBreaks as unknown as ManualPageBreak[];
          if (prev.some((b) => b.id === id)) return;
          const next = [...prev, { id, x, y }];
          runCommand({
            name: 'add-page-break',
            execute: (d) => withBreaks(d, next),
            undo: (d) => withBreaks(d, prev),
          });
        },
        removePageBreak: (id) => {
          const prev = get().doc.page.pageBreaks as unknown as ManualPageBreak[];
          const next = prev.filter((b) => b.id !== id);
          runCommand({
            name: 'remove-page-break',
            execute: (d) => withBreaks(d, next),
            undo: (d) => withBreaks(d, prev),
          });
        },
        setPageBreaks: (breaks) => {
          const prev = get().doc.page.pageBreaks as unknown as ManualPageBreak[];
          runCommand({
            name: 'set-page-breaks',
            execute: (d) => withBreaks(d, breaks),
            undo: (d) => withBreaks(d, prev),
          });
        },

        // ================= AI 建议（一条宏命令）=================
        applyAISuggestions: (suggestions, accepted) => {
          const doc = get().doc;
          const existingIds = new Set(doc.nodes.map((n) => n.id));
          const existingEdgePairs = new Set(doc.edges.map((e) => `${e.source}->${e.target}`));
          const cmds: Command[] = [];

          accepted.forEach((idx) => {
            const s = suggestions[idx];
            if (!s) return;
            switch (s.type) {
              case 'add-edge': {
                for (const pe of s.proposedEdges ?? []) {
                  if (!existingIds.has(pe.source) || !existingIds.has(pe.target)) continue;
                  if (pe.source === pe.target) continue;
                  if (existingEdgePairs.has(`${pe.source}->${pe.target}`)) continue; // 幂等：重复边不建
                  const edge: Edge = {
                    id: nanoid(),
                    source: pe.source,
                    target: pe.target,
                    sourceHandle: 'right',
                    targetHandle: 'left',
                    label: pe.label ?? '',
                    directed: true,
                    style: { color: DEFAULT_EDGE_COLOR.hex },
                  };
                  cmds.push({
                    name: 'ai-add-edge',
                    execute: (d) => ({ ...d, edges: [...d.edges, edge] }),
                    undo: (d) => ({ ...d, edges: d.edges.filter((e) => e.id !== edge.id) }),
                  });
                }
                break;
              }
              case 'set-root': {
                // 根由布局引擎按入边推导；本动作不改结构（记录为标记，占位保证宏边界完整）。
                break;
              }
              case 'group': {
                const members = (s.nodeIds ?? []).filter((id) => existingIds.has(id));
                if (members.length === 0) break;
                const memberNodes = members.map((id) => doc.nodes.find((n) => n.id === id)!).filter(Boolean);
                const cx = memberNodes.reduce((sum, n) => sum + n.x, 0) / Math.max(1, memberNodes.length);
                const cy = memberNodes.reduce((sum, n) => sum + n.y, 0) / Math.max(1, memberNodes.length);
                const groupId = nanoid();
                const groupNode: BlockNode = {
                  id: groupId,
                  type: 'group',
                  x: cx - 180,
                  y: cy - 120,
                  width: 360,
                  height: 240,
                  content: { format: 'tiptap-json', data: paragraphDoc(s.title ?? s.text ?? '分组') },
                  parentId: null,
                  pinned: false,
                  locked: false,
                  collapsed: false,
                  tags: [],
                  style: {},
                };
                cmds.push({
                  name: 'ai-add-group',
                  execute: (d) => ({ ...d, nodes: [...d.nodes, groupNode] }),
                  undo: (d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== groupId) }),
                });
                for (const m of members) {
                  const oldParent = doc.nodes.find((n) => n.id === m)?.parentId ?? null;
                  const ge: Edge = {
                    id: nanoid(),
                    source: groupId,
                    target: m,
                    sourceHandle: 'right',
                    targetHandle: 'left',
                    label: '',
                    directed: true,
                    style: { color: DEFAULT_EDGE_COLOR.hex },
                  };
                  cmds.push(
                    {
                      name: 'ai-group-member-parent',
                      execute: (d) => ({
                        ...d,
                        nodes: d.nodes.map((n) => (n.id === m ? { ...n, parentId: groupId } : n)),
                      }),
                      undo: (d) => ({
                        ...d,
                        nodes: d.nodes.map((n) => (n.id === m ? { ...n, parentId: oldParent } : n)),
                      }),
                    },
                    {
                      name: 'ai-group-edge',
                      execute: (d) => ({ ...d, edges: [...d.edges, ge] }),
                      undo: (d) => ({ ...d, edges: d.edges.filter((e) => e.id !== ge.id) }),
                    },
                  );
                }
                break;
              }
              case 'split-block': {
                const afterId = s.afterNodeId ?? s.nodeIds?.[0];
                if (!afterId || !existingIds.has(afterId)) break;
                const anchor = doc.nodes.find((n) => n.id === afterId);
                if (!anchor) break;
                const sibId = nanoid();
                const sib: BlockNode = {
                  id: sibId,
                  type: 'text',
                  x: anchor.x,
                  y: anchor.y + anchor.height + 40,
                  width: DEFAULT_NODE_SIZES.text.width,
                  height: DEFAULT_NODE_SIZES.text.height,
                  content: { format: 'tiptap-json', data: paragraphDoc(s.text ?? '') },
                  parentId: anchor.parentId,
                  pinned: false,
                  locked: false,
                  collapsed: false,
                  tags: [],
                  style: {},
                };
                cmds.push({
                  name: 'ai-split-block',
                  execute: (d) => ({ ...d, nodes: [...d.nodes, sib] }),
                  undo: (d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== sibId) }),
                });
                break;
              }
              case 'summarize': {
                const targetId = s.nodeIds?.[0];
                if (!targetId || !existingIds.has(targetId)) break;
                const before = doc.nodes.find((n) => n.id === targetId)?.content;
                if (!before) break;
                cmds.push({
                  name: 'ai-summarize',
                  execute: (d) => ({
                    ...d,
                    nodes: d.nodes.map((n) =>
                      n.id === targetId ? { ...n, content: { format: 'tiptap-json', data: paragraphDoc(s.text ?? '') } } : n,
                    ),
                  }),
                  undo: (d) => ({
                    ...d,
                    nodes: d.nodes.map((n) => (n.id === targetId ? { ...n, content: before } : n)),
                  }),
                });
                break;
              }
            }
          });

          runMacro('apply-ai-suggestions', cmds);
        },

        // ================= 聚焦 =================
        setFocusNode: (id) => {
          set((d) => {
            d.focusNodeId = id;
          });
        },

        // ================= 文档生命周期 =================
        snapshotDoc: (label) => takeSnapshot(label),
        listSnapshots: async (docId) => {
          if (!deps.storage?.listSnapshots) return [];
          return deps.storage.listSnapshots(docId);
        },
        restoreSnapshot: async (id) => {
          const st = deps.storage;
          if (!st?.getSnapshot) return;
          const rec = await st.getSnapshot(id);
          if (!rec) return;
          const { doc: restored } = parseKBNote(rec.text);
          const before = deepClone(get().doc);
          runCommand({
            name: 'restore-snapshot',
            execute: () => restored,
            undo: () => before,
          });
        },
        listTrash: async () => {
          if (!deps.storage?.listTrash) return [];
          return deps.storage.listTrash();
        },
        restoreTrash: async (id) => {
          if (!deps.storage?.restoreFromTrash) return;
          await deps.storage.restoreFromTrash(id);
          await get().listDocs();
        },
        purgeTrash: async (id) => {
          if (!deps.storage?.purgeTrash) return;
          await deps.storage.purgeTrash(id);
          await get().listDocs();
        },
        emptyTrash: async () => {
          if (!deps.storage?.emptyTrash) return;
          await deps.storage.emptyTrash();
          await get().listDocs();
        },
        createDocFromTemplate: (templateId) => {
          const factory = deps.templates?.[templateId];
          if (!factory) return;
          switchDoc(factory());
        },
        setBackupEnabled: (on) => {
          set((d) => {
            d.backupEnabled = on;
          });
        },

        // ================= File System Access =================
        openLocalFile: async () => {
          if (!deps.fsa) return;
          const r = await deps.fsa.pickLocalFile();
          if (!r) return;
          get().importKBNoteText(r.text);
          set((d) => {
            d.activeFile = { name: r.name };
          });
        },
        saveLocalFileAs: async () => {
          if (!deps.fsa) return;
          const text = get().exportKBNoteText();
          const name = await deps.fsa.saveFileAs(`${get().doc.title || '未命名画布'}.kbnote`, text);
          if (name) set((d) => { d.activeFile = { name }; });
        },
        clearActiveFile: () => {
          set((d) => {
            d.activeFile = null;
          });
        },
        relinkActiveFile: async () => {
          if (!deps.fsa?.relinkActiveFile) return;
          const name = await deps.fsa.relinkActiveFile();
          if (name) {
            set((d) => {
              d.activeFile = { name, needsAuth: false };
            });
            // 授权恢复后立即把当前待写内容落盘一次。
            void flushSave();
          }
        },

        // ================= 附件（OPFS）=================
        putImageAsset: async (blob) => {
          if (!deps.storage?.putAsset) return { src: '' };
          try {
            const { assetRef } = await deps.storage.putAsset(blob);
            runCommand({
              name: 'register-asset',
              execute: (d) => ({
                ...d,
                assetRefs: d.assetRefs.includes(assetRef) ? d.assetRefs : [...d.assetRefs, assetRef],
              }),
              undo: (d) => ({ ...d, assetRefs: d.assetRefs.filter((a) => a !== assetRef) }),
            });
            return { src: assetRef, assetRef };
          } catch {
            return { src: '' };
          }
        },
      };
    }),
  );

  return store;
}
