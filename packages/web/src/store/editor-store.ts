import { createEditorStore, CURRENT_DOC_VERSION } from '@drawpaper/core';
import type { KBNoteDoc } from '@drawpaper/core';
import { DexieStorageAdapter } from '../storage/db';
import { WebHostAdapter } from '../host/web-host';
import { createEmptyIndex, feedIndexChunked, searchDocs } from '../storage/search-index';
import { activeFileManager, setStorageQuotaWarningHook } from '../storage/fsa';
import { TEMPLATE_REGISTRY } from '../storage/templates';
import { createConflictBridge, type ConflictBridge } from '../wiring/conflict-bridge';
import { pushToast } from '../panels/lib/toast';
import { syncStamper } from '../sync/stamper';
import {
  buildWelcomeDoc,
  detectTauriHost,
  readWelcomeFlag,
  shouldCreateWelcomeDoc,
  writeWelcomeFlag,
} from '../wiring/welcome-doc';
import { checkQuotaPressure, raiseQuotaDialog } from '../wiring/quota-watch';
import { mark, timed } from '../wiring/cold-starts';

/**
 * React 单例 editor store：注入浏览器 storage / host，启动时打开最近文档或新建空白。
 * core 内部已自带 500ms 防抖自动保存；这里额外负责 MiniSearch 索引的 doc 变更同步。
 */

function blankInitialDoc(): KBNoteDoc {
  return {
    format: 'knowledge-block-notes',
    version: CURRENT_DOC_VERSION,
    id: 'boot',
    title: '未命名画布',
    board: { createdAt: Date.now(), updatedAt: Date.now() },
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

export const storageAdapter = new DexieStorageAdapter();
export const hostAdapter = new WebHostAdapter();

// Wave10 阶段 B：落盘前给本地变更盖 v3 同步戳（clientId+递增 lamport → doc.sync）。
syncStamper.wrapSaveDoc(storageAdapter);

/** 多父/成环冲突弹窗桥：store 挂起 → CanvasEditor 的 ConflictDialog 收集结果。 */
export const conflictBridge: ConflictBridge = createConflictBridge();

export const editorStore = createEditorStore(blankInitialDoc(), {
  storage: storageAdapter,
  host: hostAdapter,
  resolveConflictUi: (pending) => conflictBridge.handler(pending),
  templates: TEMPLATE_REGISTRY,
  fsa: activeFileManager,
});

// Wave7 robustness / Wave21 WebKit 兼容：FSA 写盘配额/失败不再静默。
//  - quota（QuotaExceededError）：Web/PWA 弹「导出到文件 / 分享」引导弹窗
//    （raiseQuotaDialog 内部 Tauri 桌面端 no-op，走原生 Save 对话框）；
//  - write-failed：轻 toast（另存为路径仍会走 web-host 的 anchor 下载兜底）。
setStorageQuotaWarningHook((kind) => {
  if (kind === 'quota') {
    void raiseQuotaDialog();
  } else {
    pushToast('warn', '写入本地文件失败，已降级为浏览器下载');
  }
});

// Wave10 阶段 B：订阅命令管道，本地变更差量盖章（加载文档后先 adoptClockFloor 抬钟）。
syncStamper.install(editorStore);
mark('store');

/** 启动后：列出文档 → 打开最近一份；没有则新建。桌面端首次运行先建欢迎文档。 */
async function bootstrap(): Promise<void> {
  mark('bootstrap');
  // Wave24：首次 IDB 操作 = Dexie 打开 + 全量列表读出（2k 块场景这是主线程反序列化大户之一）。
  await timed('idb-open', 'idb-open-start', editorStore.getState().listDocs());
  // Wave13：桌面端首次运行自动创建「欢迎使用 drawpaper」。
  // 浏览器/PWA/e2e 无 __TAURI__ → shouldCreateWelcomeDoc 恒 false，永不创建。
  mark('doc-open-start');
  if (shouldCreateWelcomeDoc({ isTauri: detectTauriHost(), flagSet: readWelcomeFlag() })) {
    editorStore.getState().loadDoc(buildWelcomeDoc());
    writeWelcomeFlag();
  } else {
    const docs = editorStore.getState().docs;
    const recent = [...docs].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (recent) {
      await editorStore.getState().openDoc(recent.id);
    } else {
      editorStore.getState().newDoc();
    }
  }
  mark('doc-open');
  // 尝试恢复上次活动本地文件句柄（需用户重新授权；失败则保持 IndexedDB 自动保存）。
  try {
    const name = await activeFileManager.restoreActiveFile();
    if (name) {
      editorStore.setState({ activeFile: { name } });
    }
  } catch {
    /* 无活动句柄或未授权 */
  }
  startSearchSync();
  // Wave21：启动时预检一次浏览器配额（临界才弹引导，10 分钟节流；Tauri 内部 no-op）。
  void checkQuotaPressure().catch(() => {
    /* estimate 不支持/失败时静默——防御性，不阻塞启动 */
  });
  mark('bootstrap-done');
}

/** doc 变更防抖重建 MiniSearch；searchQuery 变化时即时查询。
 *  Wave24：索引构建改为「空占位 + idle 分片喂入」——2k 块下同步 buildIndex
 *  ~865ms 长任务不再压住首帧后的可交互窗口；分片喂完后回放当前搜索词。
 *  Wave30：重建期间保留旧索引继续回答查询，新索引在本地分片喂入、完成后原子替换；
 *  重建期间 searchReady=false，面板显示「正在建立索引…」而不是把部分/空索引
 *  误报为「无匹配结果」。 */
function startSearchSync(): void {
  let index = createEmptyIndex();
  editorStore.getState().setSearchIndex(index);
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  let feedHandle: { cancel: () => void } | undefined;
  let feedDocId = '';

  const scheduleRebuild = (doc: KBNoteDoc) => {
    feedHandle?.cancel();
    feedDocId = doc.id;
    editorStore.getState().setSearchReady(false);
    // 本地构建新索引：分片喂入期间旧索引仍对外提供结果（不立即换空索引）。
    const nextIndex = createEmptyIndex();
    feedHandle = feedIndexChunked(nextIndex, doc, () => {
      if (feedDocId !== doc.id) return; // 已被更新的文档取代，丢弃旧分片
      mark('search-index');
      index = nextIndex;
      editorStore.getState().setSearchIndex(nextIndex);
      editorStore.getState().setSearchReady(true);
      const q = editorStore.getState().searchQuery;
      if (q) editorStore.getState().setSearchResults(searchDocs(nextIndex, q));
    });
  };

  scheduleRebuild(editorStore.getState().doc);

  editorStore.subscribe((state, prev) => {
    if (state.searchQuery !== prev.searchQuery) {
      editorStore.getState().setSearchResults(searchDocs(index, state.searchQuery));
    }
    if (state.doc !== prev.doc) {
      if (rebuildTimer !== undefined) clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => scheduleRebuild(state.doc), 300);
    }
  });
}

// 启动为 fire-and-forget：浏览器隐私模式 / 无 IndexedDB 的测试环境（jsdom）下
// listDocs 可能 reject，必须接住，否则形成 unhandled rejection（CI 单测退出 1）；
// 存储不可用时应用以内存态运行，不阻塞渲染。
bootstrap().catch((err: unknown) => {
  console.warn('[drawpaper] 启动引导失败（存储可能不可用），以内存态运行：', err);
});
