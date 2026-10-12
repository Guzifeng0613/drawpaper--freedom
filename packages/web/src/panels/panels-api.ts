import type {
  BlockNode,
  BlockType,
  KBNoteDoc,
  LayoutMode,
  LayoutPrefs,
  PageSettings,
  Tag,
} from '@drawpaper/core';

/**
 * PanelsApi：工具栏 / 文档列表 / 搜索 / 大纲 / 标签 / 模板 / 快照 / 回收站
 * 面板与应用主状态之间的结构型接口。
 *
 * 设计约定（Wave1-E / Wave3-H 接缝）：
 * - 面板组件不直接 import src/store，只通过 props 拿这个 api。
 * - api 同时承载「数据切片」与「回调」；Wave2/Wave4 由 App 用 zustand store 把它们接起来。
 * - createMockPanelsApi() 提供一个自包含、可交互的内存实现，供开发、单测与截图使用。
 * - Wave3-H 新增的父子/标签/快照/回收站/模板/聚焦等回调，签名在此冻结；
 *   真实 store 动作由存储 agent 同期实现，总装时按本接口接线。
 */

/** 文档列表项元信息。 */
export interface DocMeta {
  id: string;
  title: string;
  updatedAt: number;
  /** 坏档：列表隔离展示，仅可删除。 */
  corrupt?: boolean;
}

/** 自动保存状态文案机。 */
export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** 单条全文搜索命中。 */
export interface SearchResultItem {
  nodeId: string;
  nodeType: BlockNode['type'];
  /** 命中片段（纯文本）。 */
  snippet: string;
  /** 命中词在 snippet 中的起止（用于 <mark> 高亮）。 */
  matchStart: number;
  matchLength: number;
  score: number;
}

/**
 * 标签筛选状态。所有维度同时生效（AND）；标签维度内部按 match 决定 any/all。
 * 空状态（tagIds/blockTypes/colors 全空）= 不筛选，全部节点可见。
 * 画布侧消费约定（见 docs/wave3/h-panels.md）：非匹配节点降透明度、隐藏其连线。
 */
export interface TagFilterState {
  /** 选中的标签 id（空 = 不限标签）。 */
  tagIds: string[];
  /** 按块类型筛选（空 = 不限类型）。 */
  blockTypes: BlockType[];
  /** 按节点背景色（style.bg，hex/命名色）筛选（空 = 不限颜色）。 */
  colors: string[];
  /** any = 命中任一选中标签即过；all = 必须同时拥有全部选中标签。 */
  match: 'any' | 'all';
}

/** 一条自动/手动快照元信息。 */
export interface SnapshotInfo {
  id: string;
  /** 拍摄时间戳。 */
  at: number;
  /** 用户给的标签（空串 = 自动快照）。 */
  label: string;
  /** 快照时的文档标题（预览用）。 */
  docTitle: string;
}

/** 回收站条目（被删除的文档或旧快照）。 */
export interface TrashItem {
  id: string;
  title: string;
  deletedAt: number;
  kind: 'doc' | 'snapshot';
}

/** 已绑定的本地 .kbnote 文件句柄（File System Access；null = 未绑定）。 */
export interface ActiveFileHandle {
  /** 文件名，如「读书笔记.kbnote」。 */
  name: string | null;
  /** 句柄 readwrite 权限丢失：写盘暂停，需用户手势内重新授权。 */
  needsAuth?: boolean;
}

export interface PanelsApi {
  // ---- 文档列表 / 当前文档 ----
  docs: DocMeta[];
  currentDocId: string | null;
  doc: KBNoteDoc | null;

  // ---- 保存状态 ----
  saveState: SaveState;
  savedAt: number | null;

  // ---- 选择 / 布局偏好 ----
  selectedNodeIds: string[];
  layoutPrefs: LayoutPrefs;
  /** 「仅整理选中分支」开关。 */
  branchOnly: boolean;
  /** 「折叠后自动收紧」开关（LayoutInput.tighten）。 */
  tighten: boolean;
  /** 定时备份开关。 */
  backupEnabled: boolean;
  canUndo: boolean;
  canRedo: boolean;

  // ---- 页面 / 导出 ----
  page: PageSettings;
  exportOpen: boolean;

  // ---- 搜索 ----
  searchOpen: boolean;
  searchQuery: string;
  searchResults: SearchResultItem[];
  /** 索引喂入完成（false=分片重建中，面板显示「正在建立索引…」）。 */
  searchReady: boolean;
  /** 键盘 ↑↓ 选中的结果下标（-1 表示无）。 */
  activeSearchIndex: number;

  // ---- 文档回调 ----
  newDoc(): void;
  renameDoc(id: string, title: string): void;
  duplicateDoc(id: string): void;
  removeDoc(id: string): void;
  openDoc(id: string): void;
  importKbnote(file: File): void;
  exportKbnote(id: string): void;
  requestSave(): void;
  /** 保存失败后手动重试落盘。 */
  retrySave(): void;
  /** 用户手势内重新请求活动本地文件 readwrite 权限。 */
  relinkActiveFile(): Promise<void>;

  // ---- 编辑回调 ----
  undo(): void;
  redo(): void;

  // ---- 布局回调 ----
  setLayoutMode(mode: LayoutMode): void;
  /** 打开「整理预览」（半透明目标位置）；确认/应用由画布侧消费。 */
  previewLayout(): void;
  setRankSpacing(v: number): void;
  setNodeSpacing(v: number): void;
  setBranchOnly(v: boolean): void;
  setTighten(on: boolean): void;
  setBackupEnabled(on: boolean): void;

  // ---- 页面 / 导出回调 ----
  setPageSettings(patch: Partial<PageSettings>): void;
  setPageOrigin(origin: { x: number; y: number }): void;
  openExport(): void;
  closeExport(): void;

  // ---- 搜索回调 ----
  openSearch(): void;
  closeSearch(): void;
  setSearchQuery(q: string): void;
  selectSearchResult(index: number): void;
  flyToNode(id: string): void;

  // ============================================================
  // Wave3-H 新增（大纲 / 标签 / 模板 / 快照 / 回收站 / 聚焦 / 本地文件）
  // ============================================================

  // ---- 标签（文档级标签表）----
  /** 当前文档的全部标签定义。 */
  tags: Tag[];
  createTag(name: string, color: string): void;
  renameTag(id: string, name: string): void;
  changeTagColor(id: string, color: string): void;
  /** 删除标签：同时从所有节点的 tags 列表中摘除（确认由弹层负责）。 */
  deleteTag(id: string): void;

  // ---- 标签筛选 ----
  tagFilter: TagFilterState;
  setTagFilter(patch: Partial<TagFilterState>): void;
  clearTagFilter(): void;

  // ---- 大纲：折叠 / 改父子 / 内联建块 ----
  /** 切换节点折叠状态（与节点上 collapsed 字段双向同步）。 */
  toggleCollapseNode(id: string): void;
  /**
   * 拖拽改父子：把 nodeId 挂到 newParentId 下的第 index 位。
   * newParentId 为 null = 提升为根级（取消父子边）。
   * 非法位置（拖到自己后代上）由大纲侧先拦截，实现方仍需防御性校验。
   */
  reparentNode(nodeId: string, newParentId: string | null, index: number): void;
  /** 大纲内联输入：在 parentId 下新建一个 text 子块并连父子边，返回新块 id。parentId 为 null = 根级。 */
  addChildBlock(parentId: string | null, text: string): string;
  /** 大纲内联输入：在 afterNodeId 之后新建同级 text 块，返回新块 id。 */
  addSiblingBlock(afterNodeId: string, text: string): string;

  // ---- 聚焦分支 ----
  /** 当前聚焦的分支根节点；null = 未聚焦。 */
  focusNodeId: string | null;
  setFocusNode(id: string | null): void;

  // ---- 活动本地文件（File System Access）----
  activeFile: ActiveFileHandle;
  /** 打开本地 .kbnote 文件（弹出文件选择器；不支持的浏览器降级为上传导入）。 */
  openLocalFile(): void;
  /** 另存为本地 .kbnote 文件。 */
  saveAsLocalFile(): void;

  // ---- 模板 ----
  /** 按模板 id 新建文档（模板定义见 panels/lib/templates.ts）。 */
  createDocFromTemplate(templateId: string): void;

  // ---- 快照 ----
  snapshots: SnapshotInfo[];
  takeSnapshot(label?: string): void;
  /** 恢复快照：替换当前内容（确认框由弹层负责；实现方需保证可再次撤销/再恢复）。 */
  restoreSnapshot(id: string): void;
  deleteSnapshot(id: string): void;

  // ---- 回收站 ----
  trash: TrashItem[];
  restoreFromTrash(id: string): void;
  /** 彻底删除（确认由弹层负责，不可恢复）。 */
  purgeFromTrash(id: string): void;
  emptyTrash(): void;

  // ============================================================
  // Wave6b 跨文档双向链接
  // ============================================================

  /**
   * 打开引用：跨文档则切换到 targetDocId，再 flyToNode(targetNodeId) 并高亮脉冲；
   * 文档内则直接 flyToNode。由 App/CanvasEditor 总装接真实 store（Wave7）。
   */
  openDocRef(targetDocId: string, targetNodeId: string): void;
  /**
   * 删除一份文档前的反链影响：返回指向它的引用条数与可读样例（用于确认弹层列出）。
   * 无引用时 count=0。Wave7。
   */
  docDeleteImpact(docId: string): Promise<{ count: number; samples: string[] }>;
  /** BacklinksPanel 当前查看的块维度（null = 文档级反链）。 */
  backlinksNodeId: string | null;
  setBacklinksNodeId(id: string | null): void;
}
