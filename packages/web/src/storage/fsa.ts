import Dexie, { type Table } from 'dexie';
import type { FsaCapability } from '@drawpaper/core';

/**
 * File System Access 活动文件句柄管理。
 *  - pickLocalFile：弹打开框选 .kbnote（句柄持久化到 Dexie，刷新后可恢复）。
 *  - writeActiveFile：500ms 防抖写当前句柄（有活动句柄才写，否则 false）。
 *  - saveFileAs：另存为 .kbnote 并把句柄设为活动句柄。
 * 不支持 File System Access 的浏览器整组能力在 isSupported() 报 false，
 * 由 web-host 层走 <input type=file> / <a download> 降级。
 */

interface FsaWindow {
  showOpenFilePicker?: (opts?: unknown) => Promise<Array<{ getFile: () => Promise<File> } & FileSystemFileHandleLike>>;
  showSaveFilePicker?: (opts?: unknown) => Promise<FileSystemFileHandleLike>;
}

interface FileSystemFileHandleLike {
  name?: string;
  createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }>;
  queryPermission?: (opts: { mode: 'read' | 'readwrite' }) => Promise<string>;
  requestPermission?: (opts: { mode: 'read' | 'readwrite' }) => Promise<string>;
}

const KBNOTE_TYPES = {
  description: 'drawpaper 笔记',
  accept: { 'application/json': ['.kbnote'] },
} as const;

// ============ 配额感知（Safari/Firefox 兜底 + QuotaExceededError 提示）============

/**
 * 写盘/配额失败的外部通知钩子。fsa.ts 不直接依赖 toast 组件，
 * 由 web 接线层（editor-store）挂一个 pushToast 实现，便于单测替换。
 */
export type StorageQuotaWarning = (kind: 'quota' | 'write-failed', detail?: string) => void;
let quotaWarningHook: StorageQuotaWarning = () => {
  /* 默认静默；接线层挂载后才弹 toast */
};
export function setStorageQuotaWarningHook(hook: StorageQuotaWarning): void {
  quotaWarningHook = hook;
}

/**
 * 判断一个异常是否为「配额/磁盘已满」类错误。
 * 覆盖 DOMException.name、Firefox 的 NS_ERROR_* 以及 message 文本。
 */
export function isQuotaError(err: unknown): boolean {
  const name = (err as { name?: string } | null | undefined)?.name;
  if (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_FILE_NO_DEVICE_SPACE' ||
    name === 'NS_ERROR_DOM_FILESYSTEM_NO_MODIFICATION_ALLOWED_ERR'
  ) {
    return true;
  }
  const msg = (err as { message?: string } | null | undefined)?.message ?? '';
  return /quota|no space|no_device_space|enospc/i.test(msg);
}

/**
 * 读 navigator.storage.estimate()；不支持或失败返回 null。
 * 返回 usage/quota 字节数，供导出前做配额预检与人工验证清单使用。
 */
export async function estimateStorageQuota(): Promise<{ usage: number; quota: number } | null> {
  const s = (
    navigator as unknown as {
      storage?: { estimate?: () => Promise<{ usage?: number; quota?: number }> };
    }
  ).storage;
  if (typeof s?.estimate !== 'function') return null;
  try {
    const e = await s.estimate();
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
  } catch {
    return null;
  }
}

/** 用户主动取消文件选择（AbortError）不属于错误，静默。 */
function isAbortError(err: unknown): boolean {
  return (err as { name?: string } | null | undefined)?.name === 'AbortError';
}

/** 写盘失败时的统一出口：区分配额错误并通知接线层。 */
function notifyWriteFailure(err: unknown): void {
  if (isQuotaError(err)) {
    quotaWarningHook('quota', typeof err === 'object' && err !== null ? (err as Error).message : undefined);
  } else {
    quotaWarningHook('write-failed', typeof err === 'object' && err !== null ? (err as Error).message : undefined);
  }
}

/** 单独的小库持久化活动句柄（FileSystemHandle 可结构化克隆进 IndexedDB）。 */
class FsaDB extends Dexie {
  active!: Table<{ id: string; handle: FileSystemFileHandleLike }, string>;
  constructor() {
    super('drawpaper-fsa');
    this.version(1).stores({ active: 'id' });
  }
}
const fsaDb = new FsaDB();

/** 活动文件管理器：实现 core 的 FsaCapability 接口。 */
export class ActiveFileManager implements FsaCapability {
  private activeHandle: FileSystemFileHandleLike | null = null;
  private writeTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingText: string | null = null;
  private pendingResolve: ((ok: boolean) => void) | null = null;
  /** v1→v2 升级确认门控：true 时暂停对活动文件的写盘（Dexie 自动保存不受影响）。 */
  private writesBlocked = false;

  /** 升级门控：blocked=true 时 writeActiveFile 暂停写盘，直到用户确认。 */
  setWritesBlocked(blocked: boolean): void {
    this.writesBlocked = blocked;
    if (blocked && this.writeTimer !== undefined) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
  }

  isWritesBlocked(): boolean {
    return this.writesBlocked;
  }

  isSupported(): boolean {
    if (typeof window === 'undefined') return false;
    const w = window as unknown as FsaWindow;
    return typeof w.showOpenFilePicker === 'function' && typeof w.showSaveFilePicker === 'function';
  }

  async pickLocalFile(): Promise<{ name: string; text: string } | null> {
    if (!this.isSupported()) return null;
    try {
      const w = window as unknown as FsaWindow;
      const [handle] = await w.showOpenFilePicker!({ types: [KBNOTE_TYPES], excludeAcceptAllOption: true, multiple: false });
      if (!handle) return null;
      const file = await handle.getFile();
      const text = await file.text();
      await this.setActive(handle);
      return { name: file.name, text };
    } catch {
      return null;
    }
  }

  writeActiveFile(text: string): Promise<boolean> {
    if (this.writesBlocked) return Promise.resolve(false);
    if (!this.activeHandle) return Promise.resolve(false);
    this.pendingText = text;
    if (this.writeTimer !== undefined) clearTimeout(this.writeTimer);
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
      this.writeTimer = setTimeout(async () => {
        const t = this.pendingText;
        this.pendingText = null;
        let ok = false;
        if (t != null && this.activeHandle) {
          try {
            const writable = await this.activeHandle.createWritable();
            await writable.write(t);
            await writable.close();
            ok = true;
          } catch (e) {
            ok = false;
            notifyWriteFailure(e);
          }
        }
        this.pendingResolve?.(ok);
        this.pendingResolve = null;
      }, 500);
    });
  }

  async saveFileAs(suggestedName: string, text: string): Promise<string | null> {
    if (!this.isSupported()) return null;
    try {
      const w = window as unknown as FsaWindow;
      const handle = await w.showSaveFilePicker!({ suggestedName, types: [KBNOTE_TYPES] });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      await this.setActive(handle);
      return handle.name ?? suggestedName;
    } catch (e) {
      // 用户取消（AbortError）不告警；仅配额/写盘失败提示。
      if (!isAbortError(e)) notifyWriteFailure(e);
      return null;
    }
  }

  /** 清除活动句柄（不落盘关系解除）。 */
  clear(): void {
    this.activeHandle = null;
    if (this.writeTimer !== undefined) clearTimeout(this.writeTimer);
  }

  /**
   * 刷新后恢复上次活动句柄（需用户重新授权 readwrite）。
   * 成功返回文件名，失败/未授权返回 null。
   */
  async restoreActiveFile(): Promise<string | null> {
    if (!this.isSupported()) return null;
    try {
      const row = await fsaDb.active.get('current');
      if (!row) return null;
      const handle = row.handle;
      const perm =
        (await handle.requestPermission?.({ mode: 'readwrite' })) ??
        (await handle.queryPermission?.({ mode: 'readwrite' }));
      if (perm !== 'granted') return null;
      this.activeHandle = handle;
      return handle.name ?? null;
    } catch {
      return null;
    }
  }

  private async setActive(handle: FileSystemFileHandleLike): Promise<void> {
    this.activeHandle = handle;
    try {
      await fsaDb.active.put({ id: 'current', handle });
    } catch {
      /* 持久化失败不影响当前会话 */
    }
  }
}

/** 单例。 */
export const activeFileManager = new ActiveFileManager();

// ============ 一次性打开/保存（web-host 降级流，不绑定活动句柄）============

/** 能力检测别名。 */
export function isFsaSupported(): boolean {
  return activeFileManager.isSupported();
}

/** 一次性打开 .kbnote（不把句柄设为活动句柄）；不支持或取消返回 null。 */
export async function openWithFsa(): Promise<{ name: string; text: string } | null> {
  if (!activeFileManager.isSupported()) return null;
  const w = window as unknown as FsaWindow;
  try {
    const [handle] = await w.showOpenFilePicker!({ types: [KBNOTE_TYPES], excludeAcceptAllOption: true, multiple: false });
    if (!handle) return null;
    const file = await handle.getFile();
    return { name: file.name, text: await file.text() };
  } catch {
    return null;
  }
}

/** 一次性另存 .kbnote；不支持或取消返回 false（由 host 走下载降级）。 */
export async function saveWithFsa(filename: string, text: string): Promise<boolean> {
  if (!activeFileManager.isSupported()) return false;
  const w = window as unknown as FsaWindow;
  try {
    const handle = await w.showSaveFilePicker!({ suggestedName: filename, types: [KBNOTE_TYPES] });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    return true;
  } catch (e) {
    // 用户取消不告警；配额/写盘失败通知接线层（host 仍会走 anchor 下载兜底）。
    if (!isAbortError(e)) notifyWriteFailure(e);
    return false;
  }
}
