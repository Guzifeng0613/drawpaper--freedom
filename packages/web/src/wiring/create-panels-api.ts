import type { EditorStoreApi, KBNoteDoc } from '@drawpaper/core';
import { parseKBNote, KBNoteFileError, linksAffectedByDeleteDoc } from '@drawpaper/core';
import type { PanelsApi, SearchResultItem, DocMeta, SnapshotInfo, TrashItem } from '@/panels/panels-api';
import { pushToast } from '@/panels/lib/toast';
import { useWiringUi } from './ui-store';
import { storageAdapter, hostAdapter } from '@/store/editor-store';
import { db } from '@/storage/db';

/** 取块正文前 12 字做摘要（失败回退类型名）。 */
function summarizeNode(n: { type: string; content?: { data?: unknown } }): string {
  try {
    const data = (n.content as { data?: { content?: unknown[] } } | undefined)?.data as
      | { content?: Array<{ content?: Array<{ text?: string }> }> }
      | undefined;
    const txt = data?.content?.[0]?.content?.[0]?.text ?? '';
    return txt.slice(0, 12) || n.type;
  } catch {
    return n.type;
  }
}

/** 大纲内联建块用：一段纯文本的 Tiptap doc。 */
function paraDoc(text: string): unknown {
  return {
    type: 'doc',
    content: text ? [{ type: 'paragraph', content: [{ type: 'text', text }] }] : [],
  };
}

// ---- 快照 / 回收站异步缓存（store.list* 为 async，getter 是同步）----
// 注意：createPanelsApi 每次 App 渲染都重建（getter 读最新值），缓存必须放模块级，
// 否则每次渲染都重置 dirty=true → 异步加载 → bump nonce → 再渲染 → 死循环。
let snapshotDirty = true;
let trashDirty = true;
let snapshotCache: SnapshotInfo[] = [];
let trashCache: TrashItem[] = [];
let cachedDocId: string | null = null;

/**
 * createPanelsApi —— 把真实 EditorStore + wiring ui store + storage/host 适配为 E 的 PanelsApi。
 *
 * PanelsApi 是「读时取最新」的 getter 对象：面板组件在渲染期读 api.xxx；
 * App 通过 useEditorStore 订阅驱动自身重渲染，从而让面板读到最新值。
 * 回调直接转调 store action / storage / host / ui store。
 */
export function createPanelsApi(store: EditorStoreApi): PanelsApi {
  const nodeTypeOf = (nodeId: string) =>
    store.getState().doc.nodes.find((n) => n.id === nodeId)?.type ?? 'text';

  const api: PanelsApi = {
    // ---- 读切片（getter，每次渲染取最新）----
    get docs(): DocMeta[] {
      return store.getState().docs;
    },
    get currentDocId(): string | null {
      return store.getState().currentDocId;
    },
    get doc(): KBNoteDoc | null {
      return store.getState().doc;
    },
    get saveState() {
      return store.getState().saveState;
    },
    get savedAt() {
      return store.getState().savedAt;
    },
    get selectedNodeIds(): string[] {
      return [...store.getState().selection];
    },
    get layoutPrefs() {
      return store.getState().doc.layout;
    },
    get branchOnly() {
      return store.getState().layoutUi.scopeSelected;
    },
    get tighten() {
      return store.getState().layoutUi.tighten;
    },
    get backupEnabled() {
      return store.getState().backupEnabled;
    },
    get canUndo() {
      return store.getState().canUndo;
    },
    get canRedo() {
      return store.getState().canRedo;
    },
    get page() {
      return store.getState().doc.page;
    },
    get exportOpen() {
      return useWiringUi.getState().exportOpen;
    },
    get searchOpen() {
      return useWiringUi.getState().searchOpen;
    },
    get searchQuery() {
      return store.getState().searchQuery;
    },
    get searchResults(): SearchResultItem[] {
      const q = store.getState().searchQuery.trim();
      return store.getState().searchResults.map((r) => {
        const lower = r.snippet.toLowerCase();
        const idx = q ? lower.indexOf(q.toLowerCase()) : -1;
        return {
          nodeId: r.nodeId,
          nodeType: nodeTypeOf(r.nodeId),
          snippet: r.snippet,
          matchStart: idx < 0 ? 0 : idx,
          matchLength: idx < 0 ? 0 : q.length,
          score: 1,
        };
      });
    },
    get activeSearchIndex() {
      return useWiringUi.getState().activeSearchIndex;
    },
    get searchReady() {
      return store.getState().searchReady;
    },

    // ---- 文档回调 ----
    newDoc: () => store.getState().newDoc(),
    renameDoc: (id, title) => {
      if (id === store.getState().currentDocId) {
        store.getState().renameDoc(title);
      } else {
        // 重命名非当前打开的文档：直接改 storage 记录。
        void (async () => {
          try {
            const d = await storageAdapter.loadDoc(id);
            if (!d) {
              pushToast('error', '重命名失败：找不到原文档');
              return;
            }
            await storageAdapter.saveDoc({ ...d, title });
            await store.getState().listDocs();
            pushToast('success', `已重命名为「${title}」`);
          } catch (err) {
            pushToast('error', `重命名失败：${err instanceof Error ? err.message : '未知错误'}`);
          }
        })();
      }
    },
    duplicateDoc: (id) => {
      if (id === store.getState().currentDocId) {
        void store.getState().duplicateDoc();
      } else {
        void (async () => {
          try {
            const src = await storageAdapter.loadDoc(id);
            if (!src) return;
            const copy: KBNoteDoc = JSON.parse(JSON.stringify(src)) as KBNoteDoc;
            copy.id = `doc_${Date.now()}`;
            copy.title = `${src.title} 副本`;
            copy.board = { createdAt: Date.now(), updatedAt: Date.now() };
            await storageAdapter.saveDoc(copy);
            await store.getState().listDocs();
            pushToast('success', `已创建副本「${copy.title}」`);
          } catch (err) {
            pushToast('error', `创建副本失败：${err instanceof Error ? err.message : '未知错误'}`);
          }
        })();
      }
    },
    removeDoc: (id) => void store.getState().deleteDoc(id),
    openDoc: (id) => void store.getState().openDoc(id),
    importKbnote: (file: File) => {
      void (async () => {
        try {
          const text = await file.text();
          const { doc, migrationNotes } = parseKBNote(text);
          store.getState().loadDoc(doc);
          if (migrationNotes.length > 0) {
            pushToast('success', `已导入「${doc.title}」（已自动升级 schema）`);
          } else {
            pushToast('success', `已导入「${doc.title}」`);
          }
        } catch (err) {
          if (err instanceof KBNoteFileError && err.kind === 'unsupported-version') {
            pushToast('error', '文件版本更高，当前应用版本不支持打开');
          } else {
            pushToast('error', `导入失败：${err instanceof Error ? err.message : '文件格式错误'}`);
          }
        }
      })();
    },
    exportKbnote: (_id) => {
      const s = store.getState();
      s.requestSave();
      const text = s.exportKBNoteText();
      void hostAdapter.showSaveFilePicker(`${s.doc.title || '未命名画布'}.kbnote`, text);
    },
    requestSave: () => store.getState().requestSave(),

    // ---- 编辑回调 ----
    undo: () => store.getState().undo(),
    redo: () => store.getState().redo(),

    // ---- 布局回调 ----
    setLayoutMode: (mode) => store.getState().setLayoutMode(mode),
    previewLayout: () => store.getState().previewLayout(),
    setRankSpacing: (v) => store.getState().setSpacing(v, store.getState().doc.layout.nodeSpacing),
    setNodeSpacing: (v) => store.getState().setSpacing(store.getState().doc.layout.rankSpacing, v),
    setBranchOnly: (v) => {
      if (store.getState().layoutUi.scopeSelected !== v) store.getState().toggleScopeSelected();
    },
    setTighten: (v) => store.getState().setTighten(v),
    setBackupEnabled: (v) => {
      store.getState().setBackupEnabled(v);
      try {
        localStorage.setItem('drawpaper-backup-enabled', v ? '1' : '0');
      } catch {
        /* 隐私模式忽略 */
      }
    },

    // ---- 页面 / 导出回调 ----
    setPageSettings: (patch) => store.getState().setPageSettings(patch),
    setPageOrigin: (origin) => store.getState().setPageOrigin(origin),
    openExport: () => useWiringUi.getState().setExportOpen(true),
    closeExport: () => useWiringUi.getState().setExportOpen(false),

    // ---- 搜索回调 ----
    openSearch: () => useWiringUi.getState().setSearchOpen(true),
    closeSearch: () => {
      useWiringUi.getState().setSearchOpen(false);
      useWiringUi.getState().setActiveSearchIndex(-1);
      store.getState().setSearchQuery('');
    },
    setSearchQuery: (q) => {
      store.getState().setSearchQuery(q);
      useWiringUi.getState().setActiveSearchIndex(-1);
    },
    selectSearchResult: (index) => {
      useWiringUi.getState().setActiveSearchIndex(index);
      const item = store.getState().searchResults[index];
      if (item) store.getState().flyToNode(item.nodeId);
    },
    flyToNode: (id) => store.getState().flyToNode(id),

    // ============================================================
    // Wave4 总装：把 Wave3-H 桩全部换成真实 store 动作。
    // store.tagFilter 形状 {tagIds,types,colors,match} ↔ PanelsApi
    // TagFilterState {tagIds,blockTypes,colors,match}：types↔blockTypes 整形。
    // ============================================================
    get tags() {
      return store.getState().doc.tags;
    },
    get tagFilter() {
      const f = store.getState().tagFilter;
      return { tagIds: f.tagIds, blockTypes: f.types, colors: f.colors, match: f.match };
    },
    get focusNodeId() {
      return store.getState().focusNodeId;
    },
    get activeFile() {
      return store.getState().activeFile ?? { name: null };
    },
    get snapshots() {
      // 异步列表：读取时若缓存过期则触发加载，加载完成 bump ui.nonce 驱动重渲染。
      void refreshSnapshots();
      return snapshotCache;
    },
    get trash() {
      void refreshTrash();
      return trashCache;
    },
    createTag: (name, color) => {
      store.getState().createTag(name, color);
    },
    renameTag: (id, name) => store.getState().renameTag(id, name),
    changeTagColor: (id, color) => store.getState().setTagColor(id, color),
    deleteTag: (id) => store.getState().deleteTag(id),
    setTagFilter: (patch) => {
      // blockTypes → types 整形后下发 store。
      store.getState().setTagFilter({
        tagIds: patch.tagIds,
        types: patch.blockTypes,
        colors: patch.colors,
        match: patch.match,
      });
    },
    clearTagFilter: () => store.getState().clearTagFilter(),
    toggleCollapseNode: (id) => store.getState().toggleCollapse(id),
    reparentNode: (nodeId, newParentId, index) => store.getState().reparentNode(nodeId, newParentId, index),
    addChildBlock: (parentId, text) => {
      const s = store.getState();
      const parent = parentId ? s.doc.nodes.find((n) => n.id === parentId) : undefined;
      const x = (parent?.x ?? 0) + (parent?.width ?? 240) + 120;
      const y = parent?.y ?? 0;
      const id = s.addNode('text', x, y);
      s.updateContent(id, paraDoc(text));
      if (parentId) s.addEdge(parentId, id);
      return id;
    },
    addSiblingBlock: (afterNodeId, text) => {
      const s = store.getState();
      const after = s.doc.nodes.find((n) => n.id === afterNodeId);
      const parentEdge = after ? s.doc.edges.find((e) => e.target === afterNodeId) : undefined;
      const parentId = parentEdge?.source ?? null;
      const x = after?.x ?? 0;
      const y = (after?.y ?? 0) + (after?.height ?? 80) + 40;
      const id = s.addNode('text', x, y);
      s.updateContent(id, paraDoc(text));
      if (parentId) s.addEdge(parentId, id);
      return id;
    },
    setFocusNode: (id) => store.getState().setFocusNode(id),
    openLocalFile: () => void store.getState().openLocalFile(),
    saveAsLocalFile: () => void store.getState().saveLocalFileAs(),
    createDocFromTemplate: (templateId) => {
      store.getState().createDocFromTemplate(templateId);
      pushToast('success', '已从模板新建文档');
    },
    takeSnapshot: (label) => {
      void store.getState().snapshotDoc(label).then(() => {
        snapshotDirty = true;
        useWiringUi.getState().bumpSnapshots();
      });
    },
    restoreSnapshot: (id) => {
      void store.getState().restoreSnapshot(id).then(() => {
        snapshotDirty = true;
        pushToast('success', '已恢复快照');
      });
    },
    deleteSnapshot: (id) => {
      void storageAdapter.deleteSnapshot?.(id).then(() => {
        snapshotDirty = true;
        useWiringUi.getState().bumpSnapshots();
      });
    },
    restoreFromTrash: (id) => {
      void store.getState().restoreTrash(id).then(() => {
        trashDirty = true;
        void store.getState().listDocs();
        pushToast('success', '已从回收站恢复');
      });
    },
    purgeFromTrash: (id) => {
      void store.getState().purgeTrash(id).then(() => {
        trashDirty = true;
        useWiringUi.getState().bumpTrash();
      });
    },
    emptyTrash: () => {
      void store.getState().emptyTrash().then(() => {
        trashDirty = true;
        useWiringUi.getState().bumpTrash();
      });
    },

    // ---- Wave6b 跨文档双向链接 ----
    openDocRef: (targetDocId, targetNodeId) => {
      const s = store.getState();
      if (targetDocId === s.currentDocId) {
        s.flyToNode(targetNodeId);
      } else {
        void s.openDoc(targetDocId).then(() => {
          store.getState().flyToNode(targetNodeId);
        });
      }
    },
    get backlinksNodeId() {
      return useWiringUi.getState().backlinksNodeId;
    },
    setBacklinksNodeId: (id) => useWiringUi.getState().setBacklinksNodeId(id),
    docDeleteImpact: async (docId) => {
      const all = await db.docs.toArray();
      const allLinks = all.flatMap((d) => d.links ?? []);
      const { incoming } = linksAffectedByDeleteDoc(docId, allLinks);
      const docTitle = new Map(all.map((d) => [d.id, d.title]));
      const nodeText = new Map(all.map((d) => [d.id, d.nodes]));
      const samples = incoming.slice(0, 5).map((l) => {
        const fromDoc = docTitle.get(l.sourceDocId) ?? l.sourceDocId;
        const nodes = nodeText.get(l.sourceDocId) ?? [];
        const n = nodes.find((nn) => nn.id === l.sourceNodeId);
        const label = n ? summarizeNode(n) : l.sourceNodeId;
        return `《${fromDoc}》块「${label}」`;
      });
      return { count: incoming.length, samples };
    },
  };

  const refreshSnapshots = async (): Promise<void> => {
    const docId = store.getState().currentDocId;
    if (!snapshotDirty && docId === cachedDocId) return;
    snapshotDirty = false;
    cachedDocId = docId;
    if (!docId) {
      snapshotCache = [];
      return;
    }
    try {
      const list = await store.getState().listSnapshots(docId);
      const title = store.getState().doc?.title ?? '';
      snapshotCache = list.map((s) => ({
        id: s.id,
        at: s.takenAt,
        label: s.label ?? '',
        docTitle: title,
      }));
      useWiringUi.getState().bumpSnapshots();
    } catch {
      /* ignore */
    }
  };

  const refreshTrash = async (): Promise<void> => {
    if (!trashDirty) return;
    trashDirty = false;
    try {
      const list = await store.getState().listTrash();
      trashCache = list.map((t) => ({
        id: t.id,
        title: t.title,
        deletedAt: t.trashedAt,
        kind: 'doc' as const,
      }));
      useWiringUi.getState().bumpTrash();
    } catch {
      /* ignore */
    }
  };

  return api;
}
