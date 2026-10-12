import type {
  BlockNode,
  Edge,
  KBNoteDoc,
  PageSettings,
  Tag,
} from '@drawpaper/core';
import type {
  PanelsApi,
  DocMeta,
  SearchResultItem,
  TagFilterState,
  SnapshotInfo,
  TrashItem,
} from './panels-api';

/** 构造一个最小合法的空文档（用于 mock）。 */
function makeSampleDoc(id: string, title: string): KBNoteDoc {
  const now = Date.now();
  const rootNode: BlockNode = {
    id: 'n_root',
    type: 'heading',
    x: 0,
    y: 0,
    width: 240,
    height: 60,
    content: { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: title }] }] } },
    parentId: null,
    pinned: false,
    locked: false,
    collapsed: false,
    tags: [],
    style: {},
    heading: { level: 1 },
  };
  const child: BlockNode = {
    id: 'n_child',
    type: 'text',
    x: 320,
    y: 0,
    width: 260,
    height: 100,
    content: {
      format: 'tiptap-json',
      data: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: '示例子块：在这里记录你的想法。' }] },
        ],
      },
    },
    parentId: null,
    pinned: false,
    locked: false,
    collapsed: false,
    tags: [],
    style: {},
  };
  const edge: Edge = {
    id: 'e_1',
    source: 'n_root',
    target: 'n_child',
    sourceHandle: 'right',
    targetHandle: 'left',
    label: '',
    directed: true,
    style: { color: '#94A3B8' },
  };
  return {
    format: 'knowledge-block-notes',
    version: 4,
    id,
    title,
    board: { createdAt: now, updatedAt: now },
    nodes: [rootNode, child],
    edges: [edge],
    tags: [],
    layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
    viewport: { x: 0, y: 0, zoom: 1 },
    page: defaultPageSettings(),
    assetRefs: [],
    links: [],
    sync: { vv: {} },
  };
}

export function defaultPageSettings(): PageSettings {
  return {
    size: 'A4',
    orientation: 'portrait',
    marginMm: 15,
    mode: 'tiles',
    showPageBreak: false,
    colorMode: 'color',
    header: true,
    footer: true,
    showPageNumbers: true,
    edgeLabels: true,
    pageBreaks: [],
  };
}

/**
 * 自包含内存 mock：供开发 / 单测 / 截图使用。
 * 回调会真实改动内部状态（docs 列表、当前文档标题、保存状态等），
 * 但不做任何持久化，也不触发真实布局/分页（那些由 Wave1-B/C 接线）。
 * Wave3-H 的父子/标签/快照/回收站/模板/聚焦回调同样在内存中真实改写
 * 当前文档对象，便于面板交互演示与组件断言。
 */
export function createMockPanelsApi(): PanelsApi {
  const docs: DocMeta[] = [
    { id: 'doc_1', title: '未命名画布', updatedAt: Date.now() - 1000 * 60 * 12 },
    { id: 'doc_2', title: '读书笔记', updatedAt: Date.now() - 1000 * 60 * 60 * 5 },
  ];
  const docById = new Map<string, KBNoteDoc>([
    ['doc_1', makeSampleDoc('doc_1', '未命名画布')],
    ['doc_2', makeSampleDoc('doc_2', '读书笔记')],
  ]);

  const state = {
    currentDocId: 'doc_1' as string,
    saveState: 'saved' as PanelsApi['saveState'],
    savedAt: Date.now() - 1000 * 30,
    branchOnly: false,
    tighten: true,
    backupEnabled: false,
    canUndo: false,
    canRedo: false,
    exportOpen: false,
    searchOpen: false,
    searchQuery: '',
    searchReady: true,
    activeSearchIndex: -1,
    focusNodeId: null as string | null,
    activeFileName: '读书笔记.kbnote' as string | null,
    tagFilter: { tagIds: [], blockTypes: [], colors: [], match: 'any' } as TagFilterState,
  };

  // Wave3-H 内存态：快照 / 回收站 / 标签
  const snapshots: SnapshotInfo[] = [
    { id: 'snap_1', at: Date.now() - 1000 * 60 * 20, label: '初稿', docTitle: '未命名画布' },
  ];
  const trash: TrashItem[] = [];
  const tags: Tag[] = [
    { id: 't_1', name: '灵感', color: '#7c3aed' },
    { id: 't_2', name: '待办', color: '#ef4444' },
  ];

  let nodeSeq = 100;
  let tagSeq = 10;

  const api: PanelsApi = {
    docs,
    get currentDocId() {
      return state.currentDocId;
    },
    get doc() {
      return docById.get(state.currentDocId) ?? null;
    },
    get saveState() {
      return state.saveState;
    },
    get savedAt() {
      return state.savedAt;
    },
    selectedNodeIds: [],
    layoutPrefs: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
    get branchOnly() {
      return state.branchOnly;
    },
    get tighten() {
      return state.tighten;
    },
    get backupEnabled() {
      return state.backupEnabled;
    },
    get canUndo() {
      return state.canUndo;
    },
    get canRedo() {
      return state.canRedo;
    },
    get page() {
      return api.doc?.page ?? defaultPageSettings();
    },
    get exportOpen() {
      return state.exportOpen;
    },
    get searchOpen() {
      return state.searchOpen;
    },
    get searchQuery() {
      return state.searchQuery;
    },
    get searchReady() {
      return state.searchReady;
    },
    searchResults: [] as SearchResultItem[],
    get activeSearchIndex() {
      return state.activeSearchIndex;
    },
    get focusNodeId() {
      return state.focusNodeId;
    },
    get activeFile() {
      return { name: state.activeFileName };
    },
    get tagFilter() {
      return state.tagFilter;
    },
    get tags() {
      return tags;
    },
    get snapshots() {
      return snapshots;
    },
    get trash() {
      return trash;
    },

    newDoc() {
      const id = `doc_${Date.now()}`;
      const d = makeSampleDoc(id, '未命名画布');
      docs.push({ id, title: d.title, updatedAt: d.board.updatedAt });
      docById.set(id, d);
      state.currentDocId = id;
    },
    renameDoc(id, title) {
      const meta = docs.find((d) => d.id === id);
      if (meta) meta.title = title;
      const doc = docById.get(id);
      if (doc) doc.title = title;
    },
    duplicateDoc(id) {
      const src = docById.get(id);
      if (!src) return;
      const copy: KBNoteDoc = JSON.parse(JSON.stringify(src)) as KBNoteDoc;
      copy.id = `doc_${Date.now()}`;
      copy.title = `${src.title} 副本`;
      docById.set(copy.id, copy);
      docs.push({ id: copy.id, title: copy.title, updatedAt: Date.now() });
    },
    removeDoc(id) {
      const idx = docs.findIndex((d) => d.id === id);
      if (idx >= 0) docs.splice(idx, 1);
      docById.delete(id);
      if (state.currentDocId === id) state.currentDocId = docs[0]?.id ?? '';
    },
    openDoc(id) {
      state.currentDocId = id;
    },
    importKbnote(_file: File) {
      /* mock：真实导入由 Wave1-A serialize + Wave1-C storage 接线 */
    },
    exportKbnote(_id: string) {
      /* mock：真实导出由 host/storage 接线 */
    },
    requestSave() {
      state.saveState = 'saved';
      state.savedAt = Date.now();
    },
    retrySave() {
      state.saveState = 'saved';
      state.savedAt = Date.now();
    },
    async relinkActiveFile() {
      /* mock：无句柄可重授权 */
    },
    undo() {
      state.canUndo = false;
    },
    redo() {
      state.canRedo = false;
    },
    setLayoutMode(mode) {
      api.layoutPrefs.mode = mode;
    },
    previewLayout() {
      /* mock：真实预览由画布侧消费 */
    },
    setRankSpacing(v) {
      api.layoutPrefs.rankSpacing = v;
    },
    setNodeSpacing(v) {
      api.layoutPrefs.nodeSpacing = v;
    },
    setBranchOnly(v) {
      state.branchOnly = v;
    },
    setTighten(v) {
      state.tighten = v;
    },
    setBackupEnabled(v) {
      state.backupEnabled = v;
    },
    setPageSettings(patch) {
      const doc = docById.get(state.currentDocId);
      if (doc) doc.page = { ...doc.page, ...patch };
    },
    setPageOrigin(origin) {
      const doc = docById.get(state.currentDocId);
      if (doc) doc.page = { ...doc.page, pageOrigin: origin };
    },
    openExport() {
      state.exportOpen = true;
    },
    closeExport() {
      state.exportOpen = false;
    },
    openSearch() {
      state.searchOpen = true;
    },
    closeSearch() {
      state.searchOpen = false;
      state.searchQuery = '';
    },
    setSearchQuery(q) {
      state.searchQuery = q;
      state.activeSearchIndex = -1;
    },
    selectSearchResult(index) {
      state.activeSearchIndex = index;
      const item = api.searchResults[index];
      if (item) api.flyToNode(item.nodeId);
    },
    flyToNode(_id: string) {
      /* mock：真实飞行定位由画布侧消费 */
    },

    // ---- Wave3-H 标签 ----
    createTag(name, color) {
      tags.push({ id: `t_${++tagSeq}`, name, color });
    },
    renameTag(id, name) {
      const t = tags.find((x) => x.id === id);
      if (t) t.name = name;
    },
    changeTagColor(id, color) {
      const t = tags.find((x) => x.id === id);
      if (t) t.color = color;
    },
    deleteTag(id) {
      const idx = tags.findIndex((x) => x.id === id);
      if (idx >= 0) tags.splice(idx, 1);
      for (const doc of docById.values()) {
        for (const n of doc.nodes) n.tags = n.tags.filter((t) => t !== id);
      }
    },

    // ---- Wave3-H 标签筛选 ----
    setTagFilter(patch) {
      state.tagFilter = { ...state.tagFilter, ...patch };
    },
    clearTagFilter() {
      state.tagFilter = { tagIds: [], blockTypes: [], colors: [], match: state.tagFilter.match };
    },

    // ---- Wave3-H 大纲：折叠 / 改父子 / 内联建块 ----
    toggleCollapseNode(id) {
      const doc = docById.get(state.currentDocId);
      const node = doc?.nodes.find((n) => n.id === id);
      if (node) node.collapsed = !node.collapsed;
    },
    reparentNode(nodeId, newParentId, index) {
      const doc = docById.get(state.currentDocId);
      if (!doc) return;
      // 摘掉旧父子边，挂到新父下（mock 内存改写；真实实现走可撤销命令）。
      doc.edges = doc.edges.filter((e) => e.target !== nodeId);
      if (newParentId) {
        doc.edges.push({
          id: `e_re_${Date.now()}`,
          source: newParentId,
          target: nodeId,
          sourceHandle: 'right',
          targetHandle: 'left',
          label: '',
          directed: true,
          style: { color: '#94A3B8' },
        });
      }
      void index;
    },
    addChildBlock(parentId, text) {
      const doc = docById.get(state.currentDocId);
      const id = `n_new_${++nodeSeq}`;
      if (doc) {
        const node: BlockNode = {
          id,
          type: 'text',
          x: 0,
          y: 0,
          width: 260,
          height: 80,
          content: {
            format: 'tiptap-json',
            data: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
          },
          parentId: parentId,
          pinned: false,
          locked: false,
          collapsed: false,
          tags: [],
          style: {},
        };
        doc.nodes.push(node);
        if (parentId) {
          doc.edges.push({
            id: `e_new_${id}`,
            source: parentId,
            target: id,
            sourceHandle: 'right',
            targetHandle: 'left',
            label: '',
            directed: true,
            style: { color: '#94A3B8' },
          });
        }
      }
      return id;
    },
    addSiblingBlock(afterNodeId, text) {
      const doc = docById.get(state.currentDocId);
      const parent = doc
        ? doc.edges.find((e) => e.target === afterNodeId)?.source ?? null
        : null;
      return api.addChildBlock(parent, text);
    },

    // ---- Wave3-H 聚焦分支 ----
    setFocusNode(id) {
      state.focusNodeId = id;
    },

    // ---- Wave3-H 活动本地文件 ----
    openLocalFile() {
      /* mock：真实 File System Access 由 host/storage 接线 */
    },
    saveAsLocalFile() {
      const doc = docById.get(state.currentDocId);
      state.activeFileName = doc ? `${doc.title}.kbnote` : '未命名.kbnote';
    },

    // ---- Wave3-H 模板 ----
    createDocFromTemplate(templateId) {
      const id = `doc_${Date.now()}`;
      const d = makeSampleDoc(id, `模板-${templateId}`);
      docs.push({ id, title: d.title, updatedAt: d.board.updatedAt });
      docById.set(id, d);
      state.currentDocId = id;
    },

    // ---- Wave3-H 快照 ----
    takeSnapshot(label) {
      const doc = docById.get(state.currentDocId);
      snapshots.unshift({
        id: `snap_${Date.now()}`,
        at: Date.now(),
        label: label ?? '',
        docTitle: doc?.title ?? '',
      });
    },
    restoreSnapshot(id) {
      const snap = snapshots.find((s) => s.id === id);
      if (!snap) return;
      // mock：只记录一次自动快照作为「可再恢复」的退路。
      snapshots.unshift({ id: `snap_pre_${Date.now()}`, at: Date.now(), label: '恢复前自动快照', docTitle: snap.docTitle });
    },
    deleteSnapshot(id) {
      const idx = snapshots.findIndex((s) => s.id === id);
      if (idx >= 0) snapshots.splice(idx, 1);
    },

    // ---- Wave3-H 回收站 ----
    restoreFromTrash(id) {
      const idx = trash.findIndex((t) => t.id === id);
      if (idx >= 0) trash.splice(idx, 1);
    },
    purgeFromTrash(id) {
      const idx = trash.findIndex((t) => t.id === id);
      if (idx >= 0) trash.splice(idx, 1);
    },
    emptyTrash() {
      trash.length = 0;
    },
    openDocRef(_targetDocId, _targetNodeId) {},
    backlinksNodeId: null,
    setBacklinksNodeId(_id) {},
    docDeleteImpact: async () => ({ count: 0, samples: [] }),
  };

  return api;
}
