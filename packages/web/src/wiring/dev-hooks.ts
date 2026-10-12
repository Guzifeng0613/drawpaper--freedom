import type { KBNoteDoc, DocRefLink, PaginateResult } from '@drawpaper/core';
import { parseKBNote, KBNoteFileError, serializeKBNote, mergeSnapshots } from '@drawpaper/core';
import { editorStore } from '@/store/editor-store';
import { getAsset, isOpfsAvailable, writeAssetToRef, deleteAsset } from '@/storage/opfs';
import {
  listAssets,
  listTrashAssets,
  trashAssetsSize,
} from '@/storage/opfs';
import { reconcileAssetRefs } from '@/storage/asset-reconcile';
import {
  runManualAssetCleanup,
  confirmEmptyRetention,
} from '@/storage/asset-gc-web';
import { loadBacklinks } from '@/storage/backlinks';
import { mountOverviewDev, unmountOverviewDev } from '@/overview/dev-mount';
import { requestDeleteNodes } from './block-delete-guard';
import { buildPagesSvgAsync } from '@/export/svg-export';
import { collabManager } from '@/collab/collab-manager';
import { syncController } from '@/sync/sync-controller';
import { FakeDirectoryHandle } from '@/sync/directory-handle';
import { syncStamper } from '@/sync/stamper';
import { exportAllToKbpackBlob, importKbpackBundle } from '@/sync/kbpack-transfer';
import { estimateStorageQuota, isFsaSupported } from '@/storage/fsa';
import { webCanShare } from '@/host/web-host';
import { raiseQuotaDialog, closeQuotaDialog, checkQuotaPressure, __resetQuotaWatchThrottle } from './quota-watch';
import { getWiringUi } from './ui-store';
import {
  listConflictCopies,
  registerConflictCopy,
} from '@/sync/sync-db';
import { db } from '@/storage/db';
import {
  buildWelcomeDoc,
  detectTauriHost,
  readWelcomeFlag,
  shouldCreateWelcomeDoc,
  writeWelcomeFlag,
  WELCOME_DOC_FLAG,
} from './welcome-doc';

/** e2e 注入的内存 fake 同步目录（FSA 通道测试 seam）。 */
let injectedFake: FakeDirectoryHandle | null = null;

/**
 * DEV-only 测试钩子（window.__drawpaper__）。
 *
 * 仅在 import.meta.env.DEV 下挂载；生产构建不暴露（vite 静态替换为 false，
 * 整段 tree-shake）。供 Playwright e2e 批量灌数据 / 读状态 / 调 action，
 * 绕过 UI 操作以构造 500/2000 块性能夹具与标准验收样例。
 */

export interface DrawpaperDevHook {
  /** 整体替换当前文档（跳过 UI）。 */
  loadFixture(doc: KBNoteDoc): void;
  /** 读当前文档与视口快照。 */
  getState(): {
    doc: KBNoteDoc;
    viewport: { x: number; y: number; zoom: number };
    nodeCount: number;
    layoutUi: { scopeSelected: boolean; tighten: boolean };
    backupEnabled: boolean;
    searchResults: unknown[];
    saveState: 'idle' | 'saving' | 'saved' | 'error';
    savedAt: number | null;
  };
  /** 按名调用白名单内的 store action。 */
  invoke(action: string, ...args: unknown[]): unknown;
  /** 常驻渲染离屏打印容器（e2e 截图/矢量 PDF 用）。 */
  setDebugSheets(on: boolean): void;
  // ---- Wave5b 附件 OPFS 检视（DEV-only，供 e2e 断言）----
  /** OPFS（navigator.storage.getDirectory）当前是否可用。 */
  opfsAvailable(): boolean;
  /** 当前文档登记的 assetRef 列表。 */
  listAssetRefs(): string[];
  /** 检查某 assetRef 的 blob 是否真的落在 OPFS 中。 */
  opfsHasAsset(ref: string): Promise<boolean>;
  // ---- Wave6a schema 迁移：e2e 走真实 parse+迁移路径 ----
  /**
   * 走真实 parseKBNote 路径导入一段 .kbnote 文本（供 e2e 注入 v1/v9 文件）。
   * 成功才 loadDoc；失败不替换当前文档，返回错误 kind。
   */
  importKbnoteText(text: string):
    | { ok: true; version: number; migrationNotes: string[] }
    | { ok: false; errorKind: string };
  // ---- Wave6b 跨文档双向链接：e2e 数据断言 ----
  /** 当前文档的规范化反链索引（保存时由 flushSave 从正文重建）。 */
  currentLinks(): DocRefLink[];
  /** 序列化当前文档为 .kbnote 文本。 */
  exportCurrent(): string;
  /** 查询指向 (docId, nodeId?) 的反链条目（来源文档/块标题）。 */
  backlinksTo(docId: string, nodeId?: string | null): Promise<unknown[]>;
  // ---- Wave7 P2.1 删块反链影响：e2e 走守卫入口（与键盘/hover 工具条同一函数）----
  /** 经反链影响守卫请求删除一批块（无影响直删；有影响弹确认框）。 */
  deleteBlocksGuarded(ids: string[]): Promise<void>;
  // ---- Wave6b 全局知识图谱总览（DEV-only，供 e2e 临时挂载；Wave7 由 App 正式挂载）----
  /** 临时挂载只读全局总览画布（全屏 fixed 容器）。 */
  mountOverviewDev(): void;
  /** 卸载临时总览容器。 */
  unmountOverviewDev(): void;
  // ---- Wave7 image-opfs：e2e 断言 SVG 导出内嵌图片 ----
  /**
   * 用真实 SVG 导出管线（buildPagesSvgAsync）把当前文档构建成 SVG 字符串数组，
   * OPFS 图片已被读成 data: URI 内嵌。供 e2e 断言「导出 SVG 含该图片」。
   */
  buildSvgPagesDev(): Promise<string[]>;
  // ---- Wave9 同浏览器多标签协作：e2e 检视钩子 ----
  /** 协作管理器检视（clientId/transport/peers/ Lamport /对齐状态）。 */
  collab(): ReturnType<typeof collabManager.inspect>;
  /** 当前冲突的中文摘要（summarizeConflicts）。 */
  collabConflicts(): string[];
  // ---- Wave10 v2→v3 迁移 + 跨设备合并：e2e 走真实 core 路径 ----
  /**
   * 同一份 v2 .kbnote 文本「在两台设备」各升级一次：
   *  - 两份 v3 结果必须 deep-equal（确定性迁移）；
   *  - 合并两份 v3 必须 0 假冲突。
   */
  v3MigrationCheck(text: string): {
    ok: boolean;
    version: number;
    migratedDeepEqual: boolean;
    mergedConflictCount: number;
  };
  // ---- Wave10 跨设备同步：e2e 测试 seam ----
  /** 注入内存 fake 同步目录并启动 FSA 通道。返回目录转储（路径→内容）。 */
  syncUseFakeFolder(): Record<string, string>;
  /** 向 fake 目录写一个 .kbnote（模拟对端/Syncthing 落盘）。 */
  syncFakeWrite(path: string, contents: string): void;
  /** 读 fake 目录转储（断言 conflicted 副本）。 */
  syncFakeDump(): Record<string, string>;
  /** 以 WebDAV 配置启动通道（host 由 page.route mock）。 */
  syncStartWebdav(url: string, username: string, password: string, e2eePassphrase?: string): void;
  /** 跑一轮同步并返回结果。 */
  syncRunNow(): Promise<unknown>;
  /** 停止同步并清除全部元数据/凭据。 */
  syncStop(): Promise<void>;
  /** 同步状态检视。 */
  syncInspect(): unknown;
  /** 本端同步 clientId / Lamport 水位。 */
  syncIdentity(): { clientId: string; lamport: number };
  /** Wave11：用口令解锁已配置的加密 WebDAV 通道。 */
  syncUnlock(passphrase: string): Promise<unknown>;
  // ---- Wave11 阶段 B 手动备份包 + 冲突副本：e2e seam ----
  /** 导出全部文档为 .kbpack，返回 base64 字节（e2e 捕获后用于导入还原）。 */
  syncExportKbpack(): Promise<string>;
  /** 导入 base64 编码的 .kbpack 并合并，返回摘要。 */
  syncImportKbpack(b64: string): Promise<unknown>;
  /** 列出待处理冲突副本（id/标题/来源）。 */
  syncListConflictCopies(): Promise<unknown[]>;
  /** 制造一个可在面板处理的冲突副本登记（直接落注册表，供三动作 e2e）。 */
  syncSeedConflictCopy(docId: string, title: string, text: string): Promise<void>;
  /** 清空全部文档与 OPFS 资产（导出→清空→导入还原 e2e）。 */
  syncWipeAllDocs(): Promise<void>;
  /** 覆盖 FSA 目录选择能力探测（无 FSA 环境 e2e：注入 false 让面板高亮手动通道）。 */
  setFsaSupported(supported: boolean): void;
  /** 按指定 ref 写一个字节资产到 OPFS（资产往返 e2e 播种）。 */
  opfsSeedAsset(ref: string, b64: string): Promise<void>;
  /** 删除 OPFS 中某资产（导出→清空→导入还原 e2e 验证资产回填）。 */
  opfsRemoveAsset(ref: string): Promise<void>;
  /** Wave14：读 OPFS 某资产为 base64（跨设备 FSA e2e 把 A 的资产搬到 B 的 fake 目录）。 */
  opfsReadAssetB64(ref: string): Promise<string | null>;
  /** Wave14：向注入的 fake 同步目录写字节文件（assets/<ref>），模拟对端落盘资产。 */
  syncFakeWriteBytes(path: string, b64: string): void;
  // ---- Wave20 R 路 墓碑裁剪：e2e 注入合成墓碑（仅测试用，不造真实删除）----
  /**
   * 向本地库注入一份带 `count` 条合成节点墓碑的文档（全部 lamport ≤ vv，即全部安全），
   * 供 e2e 一轮同步触发 pruneTombstones。返回文档 id 与注入墓碑数。
   */
  syncSeedTombstoneDoc(count: number): { id: string; tombstones: number };
  // ---- Wave16 F：资产内容寻址 + 孤儿 GC e2e seam ----
  /** 跑一次 v3→v4 资产 reconcile（nanoid→hash），返回摘要。 */
  opfsReconcile(): Promise<unknown>;
  /** 列出现存主资产区全部 ref。 */
  opfsListAssets(): Promise<string[]>;
  /** 保留区（孤儿资产）现有条目 ref 列表。 */
  trashListAssets(): Promise<string[]>;
  /** 保留区占用字节。 */
  trashAssetsBytes(): Promise<number>;
  /** 手动「清理未使用资产」：孤儿移进保留区，返回结果。 */
  assetGcManual(): Promise<unknown>;
  /** 用户确认后物理清空保留区，返回清除条数。 */
  assetGcPurge(): Promise<number>;
  // ---- Wave13 欢迎文档：e2e 模拟宿主首次运行创建流程 ----
  /** 当前是否检测到 Tauri 宿主（duck-type __TAURI__）。 */
  welcomeDetectHost(): boolean;
  /** 读欢迎文档已创建标记。 */
  welcomeFlagSet(): boolean;
  /** 清除欢迎文档标记（e2e 复跑前重置）。 */
  welcomeClearFlag(): void;
  /** 按当前宿主检测 + 标记跑一次真实「首次运行创建」决策；返回是否创建。 */
  welcomeRunFirstRunFlow(): { created: boolean; title?: string };
  // ---- Wave21 WebKit/Safari 存储兼容：配额弹窗 e2e seam ----
  /** 拉起「存储空间不足」引导弹窗（e2e 直接触发；Tauri 下内部 no-op）。 */
  quotaRaise(): Promise<void>;
  /** 关闭配额弹窗。 */
  quotaClose(): void;
  /** 弹窗是否打开（e2e 断言用）。 */
  quotaDialogOpen(): boolean;
  /** 真实读一次 navigator.storage.estimate()（不支持返回 null）。 */
  quotaEstimate(): Promise<{ usage: number; quota: number } | null>;
  /** 跑一次写入前预检（临界才弹；返回档位）。 */
  quotaCheck(): Promise<string>;
  /** 重置临界弹窗节流窗口（e2e 复跑前调用）。 */
  quotaResetThrottle(): void;
  /** 宿主能力探测（e2e 能力矩阵断言）：Web Share / FSA。 */
  webCanShare(): boolean;
  webFsaSupported(): boolean;
  // ---- Wave26 a11y：关闭守卫弹窗 e2e seam（Tauri-only 弹窗在 Chromium 无原生关闭事件）----
  /** 直接开关 CloseGuardDialog（e2e axe 扫描用；DEV-only）。 */
  closeGuardSet(open: boolean): void;
}

declare global {
  interface Window {
    __drawpaper__?: DrawpaperDevHook;
    /** App 在 DEV 下读取此标志，常驻打印容器供 e2e。 */
    __drawpaper_debugSheets?: boolean;
    /** 性能分阶段采样（仅 DEV）。 */
    __perfStages?: Record<string, number>;
  }
}

const WHITELIST = new Set([
  'loadDoc',
  'newDoc',
  'openDoc',
  'renameDoc',
  'setPageSettings',
  'setViewport',
  'setSelection',
  'setMeasuredSizes',
  'addNode',
  'addNodes',
  'moveNode',
  'addEdge',
  'deleteEdge',
  'deleteNodes',
  'updateContent',
  'undo',
  'redo',
  'previewLayout',
  'confirmLayout',
  'cancelLayout',
  'requestSave',
  'setSearchQuery',
  'setPrefs',
  'setMode',
  // Wave4 P1：供 e2e 断言标签筛选 / 聚焦 / 改父子 / AI 合入。
  'createTag',
  'setTagFilter',
  'clearTagFilter',
  'setFocusNode',
  'reparentNode',
  'reverseEdge',
  'setEdgePoints',
  // ---- Wave7 edge-bend：多选边一键清除弯折点（一次可撤销宏）----
  'clearEdgesPoints',
  'applyAISuggestions',
  'setLayoutMode',
  'setTighten',
  'setBackupEnabled',
  // Wave4b P1 e2e：快照 / 回收站 / 模板 / 文档生命周期 / 手动分页符。
  'listDocs',
  'deleteDoc',
  'createDocFromTemplate',
  'snapshotDoc',
  'restoreSnapshot',
  'listSnapshots',
  'listTrash',
  'restoreTrash',
  'purgeTrash',
  'emptyTrash',
  'addManualPageBreak',
  'removePageBreak',
  // Wave14 D：寄存器并集 e2e 直接驱动打标签。
  'addTagToNode',
  'removeTagFromNode',
]);

export function installDevHooks(): void {
  if (!import.meta.env.DEV) return;
  if (typeof window === 'undefined') return;
  window.__drawpaper__ = {
    loadFixture(doc: KBNoteDoc) {
      const w = window as unknown as { __perfStages: Record<string, number | number[]> };
      const stages: Record<string, number | number[]> = {};
      w.__perfStages = stages;
      const t0 = performance.now();
      editorStore.getState().loadDoc(doc);
      stages.switchDocSync = performance.now() - t0;
      // Long Tasks 观察者
      const lt: number[] = [];
      const LO = (window as unknown as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
      if (LO) {
        try {
          const obs = new LO((list) => {
            for (const e of list.getEntries()) lt.push(Math.round(e.duration));
          });
          obs.observe({ entryTypes: ['longtask'] });
        } catch { /* noop */ }
      }
      // 两次 rAF 后 = React 首屏提交完成。
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          stages.afterRaf2 = performance.now() - t0;
          const settle = () => {
            stages.idle1 = performance.now() - t0;
            stages.longTasks = lt.slice(0, 20);
          };
          const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
          if (ric) ric(settle, { timeout: 3000 });
          else setTimeout(settle, 1000);
        }),
      );
    },
    getState() {
      const s = editorStore.getState();
      return {
        doc: s.doc,
        viewport: s.viewport,
        nodeCount: s.doc.nodes.length,
        layoutUi: { scopeSelected: s.layoutUi.scopeSelected, tighten: s.layoutUi.tighten },
        backupEnabled: s.backupEnabled,
        searchResults: s.searchResults,
        searchQuery: s.searchQuery,
        saveState: s.saveState,
        savedAt: s.savedAt,
      };
    },
    invoke(action: string, ...args: unknown[]) {
      if (!WHITELIST.has(action)) throw new Error(`dev-hook: action not whitelisted: ${action}`);
      const fn = (editorStore.getState() as unknown as Record<string, (...a: unknown[]) => unknown>)[action];
      if (typeof fn !== 'function') throw new Error(`dev-hook: no such action: ${action}`);
      return fn.apply(editorStore.getState(), args);
    },
    setDebugSheets(on: boolean) {
      window.__drawpaper_debugSheets = on;
    },
    opfsAvailable() {
      return isOpfsAvailable();
    },
    listAssetRefs() {
      return [...editorStore.getState().doc.assetRefs];
    },
    async opfsHasAsset(ref: string) {
      if (!isOpfsAvailable()) return false;
      const blob = await getAsset(ref);
      return blob !== null;
    },
    importKbnoteText(text: string) {
      try {
        const { doc, migrationNotes } = parseKBNote(text);
        editorStore.getState().loadDoc(doc);
        return { ok: true as const, version: doc.version, migrationNotes };
      } catch (e) {
        if (e instanceof KBNoteFileError) return { ok: false as const, errorKind: e.kind };
        return { ok: false as const, errorKind: 'schema' };
      }
    },
    currentLinks() {
      return [...editorStore.getState().doc.links];
    },
    exportCurrent() {
      return serializeKBNote(editorStore.getState().doc);
    },
    async backlinksTo(docId: string, nodeId: string | null = null) {
      return loadBacklinks(editorStore.getState().doc, docId, nodeId);
    },
    deleteBlocksGuarded(ids: string[]) {
      return requestDeleteNodes(editorStore, ids);
    },
    mountOverviewDev() {
      mountOverviewDev();
    },
    unmountOverviewDev() {
      unmountOverviewDev();
    },
    // Wave7 image-opfs
    async buildSvgPagesDev() {
      const doc = editorStore.getState().doc;
      // 造单页 PaginateResult：全部节点按世界坐标落一页，跑真实 SVG 构建 + OPFS 图片解析。
      const offsets: Record<string, { x: number; y: number }> = {};
      for (const n of doc.nodes) offsets[n.id] = { x: n.x, y: n.y };
      const result: PaginateResult = {
        pages: [
          {
            index: 0,
            pageNumber: 0,
            worldRect: { x: 0, y: 0, width: 4000, height: 4000 },
            nodeIds: doc.nodes.map((n) => n.id),
            edgeIds: [],
            continuations: [],
            scale: 1,
            nodeDrawOffsets: offsets,
          },
        ],
        orphans: [],
        totalPages: 1,
        notes: [],
      };
      return buildPagesSvgAsync(result, doc, { orientation: 'landscape' });
    },
    collab() {
      return collabManager.inspect();
    },
    collabConflicts() {
      return collabManager.conflictSummary();
    },
    v3MigrationCheck(text: string) {
      // 模拟两台设备从同一份 v2 档各自升级
      const a = parseKBNote(text).doc;
      const b = parseKBNote(text).doc;
      const migratedDeepEqual = JSON.stringify(a) === JSON.stringify(b);
      const merged = mergeSnapshots(a, b);
      return {
        ok: true,
        version: a.version,
        migratedDeepEqual,
        mergedConflictCount: merged.conflicts.length,
      };
    },
    syncUseFakeFolder() {
      injectedFake = new FakeDirectoryHandle('e2e-fake-sync');
      syncController.__injectFakeForTest(injectedFake);
      return injectedFake.dump();
    },
    syncFakeWrite(path: string, contents: string) {
      if (!injectedFake) throw new Error('syncUseFakeFolder 未调用');
      void injectedFake.writeText(path, contents);
    },
    syncFakeDump() {
      return injectedFake?.dump() ?? {};
    },
    syncStartWebdav(url: string, username: string, password: string, e2eePassphrase?: string) {
      injectedFake = null;
      syncController.startWebdav(
        { baseUrl: url, username, password },
        0,
        e2eePassphrase ? { enabled: true, passphrase: e2eePassphrase, rememberSession: false } : { enabled: false },
      );
    },
    async syncRunNow() {
      await syncController.runNow();
      return syncController.inspect();
    },
    async syncStop() {
      await syncController.stopAndClear();
      injectedFake = null;
    },
    syncInspect() {
      return syncController.inspect();
    },
    syncIdentity() {
      return { clientId: syncStamper.clientId, lamport: syncStamper.lamport };
    },
    async syncUnlock(passphrase: string) {
      await syncController.unlockWebdav(passphrase);
      return syncController.inspect();
    },
    async syncExportKbpack() {
      const { blob } = await exportAllToKbpackBlob();
      const buf = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < buf.length; i += 1) binary += String.fromCharCode(buf[i] ?? 0);
      return btoa(binary);
    },
    async syncImportKbpack(b64: string) {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return importKbpackBundle(bytes);
    },
    async syncListConflictCopies() {
      const rows = await listConflictCopies();
      return rows.map((r) => ({ id: r.id, title: r.title, source: r.source, docId: r.docId }));
    },
    async syncSeedConflictCopy(docId: string, title: string, text: string) {
      await registerConflictCopy({
        id: `${title}.conflicted-dev.kbnote`,
        source: 'manual',
        docId,
        title,
        text,
        remoteName: '',
        createdAt: Date.now(),
      });
    },
    async syncWipeAllDocs() {
      await db.docs.clear();
      await db.snapshots.clear();
      await db.trash.clear();
      await editorStore.getState().listDocs();
    },
    setFsaSupported(supported: boolean) {
      // isFsaDirectorySupported 读 window.showDirectoryPicker 是否为函数；
      // 注入 false = 删它；true = 补一个 stub（e2e 测「无 FSA 高亮手动」时用）。
      const w = window as unknown as { showDirectoryPicker?: unknown };
      if (supported) w.showDirectoryPicker = w.showDirectoryPicker ?? (() => Promise.reject(new Error('stub')));
      else delete w.showDirectoryPicker;
    },
    async opfsSeedAsset(ref: string, b64: string) {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      await writeAssetToRef(ref, bytes);
    },
    async opfsRemoveAsset(ref: string) {
      await deleteAsset(ref);
    },
    async opfsReadAssetB64(ref: string) {
      const blob = await getAsset(ref);
      if (!blob) return null;
      const buf = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < buf.length; i += 1) binary += String.fromCharCode(buf[i] ?? 0);
      return btoa(binary);
    },
    syncFakeWriteBytes(path: string, b64: string) {
      if (!injectedFake) throw new Error('syncUseFakeFolder 未调用');
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i) ?? 0;
      void injectedFake.writeBytes(path, bytes);
    },
    syncSeedTombstoneDoc(count: number) {
      const id = 'seed-tomb-doc';
      const client = syncStamper.clientId;
      const nodes: Record<string, { t: [number, string] }> = {};
      for (let i = 1; i <= count; i += 1) nodes[`sn${i}`] = { t: [i, client] };
      const doc: KBNoteDoc = {
        format: 'knowledge-block-notes',
        version: 4,
        id,
        title: 'seed-tomb',
        board: { createdAt: 0, updatedAt: Date.now() },
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
        // vv[client]=count：使全部合成墓碑 lamport(1..count) ≤ W=min(vv)=count，即全部安全可裁。
        sync: { vv: { [client]: count }, nodes },
      } as KBNoteDoc;
      void db.docs.put(doc);
      return { id, tombstones: count };
    },
    async opfsReconcile() {
      return reconcileAssetRefs();
    },
    async opfsListAssets() {
      return listAssets();
    },
    async trashListAssets() {
      return listTrashAssets();
    },
    async trashAssetsBytes() {
      return trashAssetsSize();
    },
    async assetGcManual() {
      return runManualAssetCleanup();
    },
    async assetGcPurge() {
      return confirmEmptyRetention();
    },
    // Wave13 欢迎文档 e2e seam
    welcomeDetectHost() {
      return detectTauriHost();
    },
    welcomeFlagSet() {
      return readWelcomeFlag();
    },
    welcomeClearFlag() {
      try {
        localStorage.removeItem(WELCOME_DOC_FLAG);
      } catch { /* 隐私模式忽略 */ }
    },
    welcomeRunFirstRunFlow() {
      const isTauri = detectTauriHost();
      const flagSet = readWelcomeFlag();
      if (!shouldCreateWelcomeDoc({ isTauri, flagSet })) return { created: false as const };
      editorStore.getState().loadDoc(buildWelcomeDoc());
      writeWelcomeFlag();
      return { created: true as const, title: editorStore.getState().doc.title };
    },
    // Wave21 WebKit/Safari 存储兼容 e2e seam
    async quotaRaise() {
      await raiseQuotaDialog();
    },
    quotaClose() {
      closeQuotaDialog();
    },
    quotaDialogOpen() {
      return getWiringUi().quotaDialog.open;
    },
    async quotaEstimate() {
      return estimateStorageQuota();
    },
    async quotaCheck() {
      return checkQuotaPressure();
    },
    quotaResetThrottle() {
      __resetQuotaWatchThrottle();
    },
    webCanShare() {
      return webCanShare();
    },
    webFsaSupported() {
      return isFsaSupported();
    },
    closeGuardSet(open: boolean) {
      getWiringUi().setCloseGuardOpen(open);
    },
  };
}
