import { useMemo, useEffect, useRef } from 'react';
import { editorStore, conflictBridge, hostAdapter } from '@/store/editor-store';
import { useEditorStore } from '@/store';
import { createEditorApi } from '@/wiring/create-editor-api';
import { createPanelsApi } from '@/wiring/create-panels-api';
import { createAiApi } from '@/wiring/create-ai-api';
import { createBackupScheduler } from '@/wiring/backup-scheduler';
import { pushToast } from '@/panels/lib/toast';
import { useWiringUi } from '@/wiring/ui-store';
import { CanvasEditor } from '@/editor/canvas/CanvasEditor';
import { TopToolbar } from '@/panels/TopToolbar';
import { DocsListPanel } from '@/panels/DocsListPanel';
import { SearchPanel } from '@/panels/SearchPanel';
import { OutlinePanel } from '@/panels/OutlinePanel';
import { TagFilterBar } from '@/panels/TagFilterBar';
import { BacklinksPanel } from '@/panels/BacklinksPanel';
import { BlockDeleteConfirmDialog } from '@/panels/BlockDeleteConfirmDialog';
import { StorageQuotaDialog } from '@/panels/StorageQuotaDialog';
import { Toaster } from '@/panels/lib/toast';
import { AiPanel } from '@/ai/AiPanel';
import { setDocRefClickHandler, installDocRefClickDelegate, setDanglingTargets, applyDanglingClasses, docRefTargetKey } from '@/editor/tiptap/doc-ref-mark';
import { OverviewCanvas } from '@/overview/OverviewCanvas';
import { DexieOverviewProvider } from '@/overview/DexieOverviewProvider';
import { CollabBanner } from '@/collab/CollabBanner';
import { PresenceAvatars } from '@/collab/PresenceAvatars';
import { RemoteSelectionOverlay } from '@/collab/RemoteSelectionOverlay';
import { SyncBanner } from '@/sync/SyncBanner';
import { SyncSettingsDialog } from '@/sync/SyncSettingsDialog';
import { db } from '@/storage/db';
import { findDanglingLinks } from '@drawpaper/core';
import { syncBacklinkTitles } from '@/storage/link-writes';
import {
  ExportDialog,
  PageBreakOverlay,
  PrintSheets,
  useExportModel,
  computePanelsPaginate,
} from '@/export';
import { registerExportActions } from '@/export/export-actions-bridge';
import { initDesktopBridge } from '@/host/desktop-bridge';
import { initNativeAutosave } from '@/host/native-autosave-adapter';
import { CloseGuardDialog } from '@/panels/CloseGuardDialog';
import { mark } from '@/wiring/cold-starts';

/**
 * App 总装（Wave4 P1）：在 Wave2 基础上接齐大纲 / 标签筛选 / AI 面板 / 导出新选项。
 *
 * - CanvasEditor 拿真实 EditorApi（含 focusNodeId/tagFilter/manualFixed/reverseEdge）；
 * - TopToolbar / DocsListPanel / SearchPanel / OutlinePanel / TagFilterBar 拿 PanelsApi；
 * - AiPanel 接真实 createAiApi（合入 → previewLayout）；
 * - 导出三按钮 + SVG / Markdown 端到端打通。
 */
export default function App() {
  // editorApi 必须稳定（useSyncExternalStore 要求 subscribe 引用不变）；
  // panelsApi 每次渲染重建——其 getters 读最新 store，新引用驱动 memo 面板重渲染。
  const editorApi = useMemo(() => createEditorApi(editorStore, conflictBridge), []);
  const aiApi = useMemo(() => createAiApi(editorStore), []);
  const panelsApi = createPanelsApi(editorStore);

  // 订阅驱动面板重渲染的切片（getter 在渲染期读最新值）。
  const doc = useEditorStore((s) => s.doc);
  useEditorStore((s) => s.saveState);
  useEditorStore((s) => s.savedAt);
  useEditorStore((s) => s.canUndo);
  useEditorStore((s) => s.canRedo);
  useEditorStore((s) => s.docs);
  const currentDocId = useEditorStore((s) => s.currentDocId);
  useEditorStore((s) => s.searchQuery);
  useEditorStore((s) => s.searchResults);
  useEditorStore((s) => s.searchReady);
  useEditorStore((s) => s.layoutUi.scopeSelected);
  useEditorStore((s) => s.focusNodeId);
  useEditorStore((s) => s.tagFilter);
  useEditorStore((s) => s.activeFile);
  useEditorStore((s) => s.manuallyMoved);
  const viewport = useEditorStore((s) => s.viewport);
  // 一键整理 ghost 预览期间显示「应用 / 取消」浮动条。
  const layoutPreview = useEditorStore((s) => s.layoutPreview);

  // 面板开关（纯 UI 态）
  useWiringUi((s) => s.exportOpen);
  useWiringUi((s) => s.searchOpen);
  useWiringUi((s) => s.activeSearchIndex);
  const aiPanelOpen = useWiringUi((s) => s.aiPanelOpen);
  const outlineOpen = useWiringUi((s) => s.outlineOpen);
  const backlinksOpen = useWiringUi((s) => s.backlinksOpen);
  const overviewOpen = useWiringUi((s) => s.overviewOpen);
  useWiringUi((s) => s.snapshotsNonce);
  useWiringUi((s) => s.trashNonce);

  // 全局图谱总览 provider（只读 Dexie；引用稳定）。
  const overviewProvider = useMemo(() => new DexieOverviewProvider(), []);

  // Wave24 路 3：首次 commit 落 effect（= 首屏 React 树已提交，paint 前最后一个同步点）。
  useEffect(() => {
    mark('react-commit');
  }, []);

  // 跨文档双链：docRef chip 点击 → 真实 store openDocRef（跨文档 openDoc+flyTo+高亮）。
  useEffect(() => {
    setDocRefClickHandler((attrs) => {
      const targetDocId = attrs.targetDocId;
      const targetNodeId = attrs.targetNodeId ?? '';
      const s = editorStore.getState();
      if (targetDocId === s.currentDocId) {
        s.flyToNode(targetNodeId);
      } else {
        void s.openDoc(targetDocId).then(() => {
          editorStore.getState().flyToNode(targetNodeId);
        });
      }
    });
    const dispose = installDocRefClickDelegate();
    return () => {
      setDocRefClickHandler(null);
      dispose();
    };
  }, []);

  // 悬挂 chip：据当前文档 links + Dexie 全量文档做一次悬挂判定，给 chip 补 .is-dangling。
  // doc.links 每次保存重建后引用变化 → 重算；MutationObserver 处理虚拟化滚动进视口的新 chip。
  // docsFp：文档列表增删（删文档进回收站）也要重判。
  const danglingLinkKey = doc ? JSON.stringify((doc.links ?? []).map((l) => l.id)) : '';
  const docsFp = useEditorStore((s) => s.docs.map((d) => d.id).join(','));
  useEffect(() => {
    let cancelled = false;
    void db.docs.toArray().then((all) => {
      if (cancelled) return;
      const cur = editorStore.getState().doc;
      const dangling = findDanglingLinks(cur.links ?? [], all);
      setDanglingTargets(new Set(dangling.map((d) => docRefTargetKey(d.link.targetDocId, d.link.targetNodeId))));
    });
    return () => {
      cancelled = true;
    };
  }, [danglingLinkKey, currentDocId, docsFp]);

  useEffect(() => {
    const observer = new MutationObserver(() => applyDanglingClasses(document));
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  // Wave7 P2.1 重命名追踪：每次保存成功后对账——目标块改名则跨文档批量回写
  // 所有引用它的 chip 文本 / attrs.targetTitle / links 索引（存储层级联 + 快照）。
  const saveState = useEditorStore((s) => s.saveState);
  const lastSavedDocRef = useRef<unknown>(null);
  useEffect(() => {
    if (saveState !== 'saved') return;
    const cur = editorStore.getState().doc;
    // 仅在文档引用真正变化（新一次落盘）后跑一次，避免重复对账。
    if (lastSavedDocRef.current === cur) return;
    lastSavedDocRef.current = cur;
    void syncBacklinkTitles(cur).then((renames) => {
      // 当前文档自身的自引用 mark：走内存命令回写（可撤销、当帧刷新 chip）。
      for (const [nodeId, newTitle] of renames) {
        editorStore.getState().retitleSelfMarks(nodeId, newTitle);
      }
    });
  }, [saveState]);

  // 导出数据流
  const { result, sheetsVisible, actions, scope, setScope, busy } = useExportModel(panelsApi);
  // Wave12：把导出动作注册给原生菜单（浏览器环境菜单不触发，纯注册表 no-op 安全）。
  useEffect(() => {
    registerExportActions(actions);
  }, [actions]);

  // Wave12：桌面桥接——原生菜单路由 / 动态窗口标题 / 关闭守卫。浏览器环境 no-op。
  useEffect(() => {
    return initDesktopBridge();
  }, []);

  // Wave17：原生文件夹自动保存——Tauri 且已配置目录时把 .kbnote+assets 镜像落盘；
  // 浏览器/未配置整体 no-op，现有 OPFS 自动保存零变化。
  useEffect(() => {
    return initNativeAutosave();
  }, []);

  // 定时备份调度：backupEnabled 开启且 dirty 时每 10 分钟下载一份 .kbnote 备份。
  const backupEnabled = useEditorStore((s) => s.backupEnabled);
  useEffect(() => {
    if (!backupEnabled) return;
    const sched = createBackupScheduler({
      isEnabled: () => editorStore.getState().backupEnabled,
      isDirty: () => editorStore.getState().dirty,
      runBackup: () => {
        const s = editorStore.getState();
        const stamp = new Date();
        const p = (n: number) => String(n).padStart(2, '0');
        const name = `${s.doc.title || '未命名画布'}_备份_${stamp.getFullYear()}${p(stamp.getMonth() + 1)}${p(stamp.getDate())}-${p(stamp.getHours())}${p(stamp.getMinutes())}`;
        void hostAdapter.showSaveFilePicker(name, s.exportKBNoteText());
      },
      onBackupDone: () => {
        editorStore.getState().requestSave();
        pushToast('success', '已创建定时备份');
      },
    });
    sched.start();
    return () => sched.stop();
  }, [backupEnabled]);

  // DEV-only：e2e 常驻打印容器（window.__drawpaper_debugSheets）。生产构建 import.meta.env.DEV=false 被剔除。
  const debugSheetsOn = import.meta.env.DEV && typeof window !== 'undefined' && !!window.__drawpaper_debugSheets;
  const debugResult = useMemo(
    () => (debugSheetsOn ? computePanelsPaginate(panelsApi) : null),
    // doc 变化重算分页（刻意依赖）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [debugSheetsOn, panelsApi, doc],
  );

  // 画布分页虚线叠加层：开启 showPageBreak 时实时算分页结果。
  const overlayResult = useMemo(
    () => (doc.page.showPageBreak ? computePanelsPaginate(panelsApi) : null),
    // doc 引用每次写操作都变，足够驱动 overlay 重算。
    [doc, panelsApi],
  );

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* 画布（React Flow + Tiptap 块 + 连线 + 快捷键 + 冲突弹窗） */}
      <div className="absolute inset-0">
        <CanvasEditor api={editorApi} />
      </div>

      {/* 画布分页虚线叠加层（世界坐标 → 屏幕坐标由 viewport 折算）。
          z 必须高于画布/工具 chrome，否则原点手柄与分页符手柄被压在底下抓不到。 */}
      {overlayResult && overlayResult.pages.length > 0 && (
        <div className="pointer-events-none absolute inset-0 z-30">
          <PageBreakOverlay
            result={overlayResult}
            viewport={viewport}
            onDragOrigin={(o) => panelsApi.setPageOrigin(o)}
            breaks={(panelsApi.doc?.page.pageBreaks ?? []) as unknown as { id: string; x: number; y: number }[]}
            onMoveBreak={(id, x, y) => {
              const cur = (panelsApi.doc?.page.pageBreaks ?? []) as unknown as { id: string; x: number; y: number }[];
              editorApi.setPageBreaks(cur.map((b) => (b.id === id ? { ...b, x, y } : b)));
            }}
            onDeleteBreak={(id) => editorApi.removePageBreak(id)}
          />
        </div>
      )}

      {/* 面板层 */}
      {/* 同浏览器多标签协作：冲突横幅 / 在线点 / 远端选区装饰 */}
      <CollabBanner />
      <SyncBanner />
      <PresenceAvatars />
      <RemoteSelectionOverlay />
      <TopToolbar api={panelsApi} />
      <DocsListPanel api={panelsApi} />
      <SearchPanel api={panelsApi} />
      {/* 大纲（左侧可折叠，默认收起避免遮挡建块区域）+ 标签筛选条 */}
      {outlineOpen ? <OutlinePanel api={panelsApi} /> : null}
      <TagFilterBar api={panelsApi} />
      {/* 反链面板（右侧可折叠，文档级/块级联动 editingNodeId） */}
      {backlinksOpen ? (
        <>
          {/* Wave22 窄屏（≤639px）遮罩：点击关闭反链面板；桌面无此层。 */}
          <div
            className="narrow-backdrop fixed inset-0 z-[15] bg-black/40 sm:hidden"
            onClick={() => useWiringUi.getState().setBacklinksOpen(false)}
          />
          <div
            data-testid="backlinks-panel"
            className="absolute right-4 top-14 z-20 flex h-[70vh] w-72 flex-col rounded-lg border bg-card/95 shadow-lg max-sm:bottom-2 max-sm:left-2 max-sm:right-2 max-sm:top-14 max-sm:h-[calc(100dvh-4.5rem)] max-sm:w-[min(18rem,90vw)]"
          >
            <div className="flex justify-end px-1 pt-1">
              <button
                type="button"
                aria-label="关闭反链面板"
                className="rounded p-1 text-muted-foreground hover:bg-accent"
                onClick={() => useWiringUi.getState().setBacklinksOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <BacklinksPanel api={panelsApi} />
            </div>
          </div>
        </>
      ) : null}
      {/* AI 辅助面板（右侧可开关） */}
      {aiPanelOpen ? (
        <div className="absolute bottom-4 right-4 z-20 w-72 rounded-lg border bg-card/95 p-3 shadow-lg">
          <div className="mb-2 flex items-center justify-end">
            <button
              type="button"
              aria-label="关闭 AI 面板"
              className="rounded p-1 text-muted-foreground hover:bg-accent"
              onClick={() => useWiringUi.getState().setAiPanelOpen(false)}
            >
              ×
            </button>
          </div>
          <AiPanel doc={doc} api={aiApi} />
        </div>
      ) : null}

      {/* 导出弹窗 + 离屏打印容器 */}
      <ExportDialog api={panelsApi} actions={actions} scope={scope} onScopeChange={setScope} busy={busy} />
      {sheetsVisible && result.pages.length > 0 && (
        <PrintSheets result={result} doc={doc} settings={doc.page} edgeLabelsVisible={doc.page.edgeLabels} />
      )}
      {debugSheetsOn && debugResult && debugResult.pages.length > 0 && (
        <PrintSheets result={debugResult} doc={doc} settings={doc.page} edgeLabelsVisible={doc.page.edgeLabels} />
      )}

      {/* 一键整理 ghost 预览：应用 / 取消 */}
      {layoutPreview ? (
        <div className="absolute bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full bg-slate-800/90 px-4 py-2 text-white shadow-lg max-sm:bottom-[calc(1.5rem+env(safe-area-inset-bottom))] max-sm:max-w-[92vw] max-sm:flex-wrap max-sm:justify-center">
          <span className="text-xs opacity-80">整理预览</span>
          <button
            className="rounded-full bg-emerald-500 px-3 py-1 text-xs font-medium hover:bg-emerald-400"
            onClick={() => editorApi.confirmLayout()}
          >
            应用
          </button>
          <button
            className="rounded-full bg-slate-600 px-3 py-1 text-xs hover:bg-slate-500"
            onClick={() => editorApi.cancelLayout()}
          >
            取消
          </button>
        </div>
      ) : null}

      {/* 全局知识图谱总览（全屏只读，点块跳回文档） */}
      {overviewOpen ? (
        <div className="fixed inset-0 z-40 bg-background">
          <OverviewCanvas
            provider={overviewProvider}
            onClose={() => useWiringUi.getState().setOverviewOpen(false)}
            onOpenDocNode={(docId, nodeId) => {
              useWiringUi.getState().setOverviewOpen(false);
              const s = editorStore.getState();
              if (docId === s.currentDocId) {
                s.flyToNode(nodeId);
              } else {
                void s.openDoc(docId).then(() => editorStore.getState().flyToNode(nodeId));
              }
            }}
          />
        </div>
      ) : null}

      {/* 全局 toast（editor 与 panels 共用） */}
      <Toaster />
      {/* Wave10 跨设备同步：设置→同步面板 */}
      <SyncSettingsDialog open={useWiringUi((s) => s.syncOpen)} onOpenChange={(o) => useWiringUi.getState().setSyncOpen(o)} />
      <button
        type="button"
        aria-label="打开同步设置"
        data-testid="open-sync"
        onClick={() => useWiringUi.getState().setSyncOpen(true)}
        className="absolute right-4 top-14 z-20 rounded-full border bg-card/90 p-2 shadow hover:bg-accent"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M17.5 19a4.5 4.5 0 0 0 .42-8.98 6 6 0 0 0-11.7 1.5A4 4 0 0 0 7 19h10.5z" />
        </svg>
      </button>
      {/* Wave7 P2.1：删块反链影响确认框（有 incoming/outgoing 链接时才弹出） */}
      <BlockDeleteConfirmDialog />
      {/* Wave21：浏览器存储配额不足引导弹窗（Tauri 桌面端内部不弹） */}
      <StorageQuotaDialog />
      {/* Wave12：原生关闭守卫三选框（仅桌面端绑定且脏时出现） */}
      <CloseGuardDialog />
    </div>
  );
}
