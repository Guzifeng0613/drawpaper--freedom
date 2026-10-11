import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useWiringUi } from '@/wiring/ui-store';
import { closeQuotaDialog } from '@/wiring/quota-watch';
import { editorStore, hostAdapter } from '@/store/editor-store';
import { webCanShare } from '@/host/web-host';
import { isFsaSupported } from '@/storage/fsa';
import { detectTauriHost } from '@/wiring/welcome-doc';
import {
  formatBytes,
  quotaPressureRatio,
  selectRecoveryActions,
  type RecoveryAction,
} from '@/storage/quota-policy';
import { downloadBlob, exportAllToKbpackBlob } from '@/sync/kbpack-transfer';
import { pushToast } from '@/panels/lib/toast';

/**
 * Wave21：浏览器「本地存储空间不足」引导弹窗（Safari/WebKit 兼容兜底）。
 *
 * 触发：写入 QuotaExceededError（fsa 钩子）或启动/写入前预检 usage/quota 临界。
 * host 门控：Tauri 桌面端绝不挂载打开（quota-watch.openQuotaDialog 内部 no-op），
 * 桌面用原生 Save 对话框。这里只在 Web/PWA 出现。
 *
 * 动作（按宿主能力矩阵 selectRecoveryActions 渲染）：
 *  - 导出当前文档 .kbnote（FSA 另存；不支持时 host 自动 anchor 下载）；
 *  - 有 Web Share → 「分享…」（移动端 Safari）；
 *  - 无 Web Share（桌面 Safari/WebKit）→ 「下载整库备份 .kbpack」兜底。
 */
export function StorageQuotaDialog() {
  const quotaDialog = useWiringUi((s) => s.quotaDialog);
  const [packing, setPacking] = useState(false);

  // 能力快照（每次渲染读最新；弹窗打开时才计算，开销可忽略）。
  const actions = quotaDialog.open
    ? selectRecoveryActions({
        isTauri: detectTauriHost(),
        hasShare: webCanShare(),
        fsaSupported: isFsaSupported(),
      })
    : [];

  const est = quotaDialog.estimate;
  const ratio = est ? quotaPressureRatio(est.usage, est.quota) : null;

  const exportCurrent = () => {
    const s = editorStore.getState();
    s.requestSave();
    void hostAdapter.showSaveFilePicker(`${s.doc.title || '未命名画布'}.kbnote`, s.exportKBNoteText());
    closeQuotaDialog();
  };

  const shareCurrent = () => {
    const s = editorStore.getState();
    s.requestSave();
    // host 内部：有 Web Share 走系统分享；无则自动降级为 .kbnote 下载。
    void hostAdapter.share({ title: s.doc.title || 'drawpaper', text: s.exportKBNoteText() });
    closeQuotaDialog();
  };

  const downloadBackupPack = async () => {
    setPacking(true);
    try {
      const { blob, filename } = await exportAllToKbpackBlob();
      downloadBlob(blob, filename);
      pushToast('success', '已下载整库备份包（.kbpack）');
      closeQuotaDialog();
    } catch (e) {
      pushToast('error', `备份包导出失败：${e instanceof Error ? e.message : '未知错误'}`);
    } finally {
      setPacking(false);
    }
  };

  const onAction = (action: RecoveryAction) => {
    if (action === 'export-file') exportCurrent();
    else if (action === 'share') shareCurrent();
    else void downloadBackupPack();
  };

  return (
    <Dialog open={quotaDialog.open} onOpenChange={(o) => !o && closeQuotaDialog()}>
      <DialogContent className="sm:max-w-[440px]" data-testid="storage-quota-dialog">
        <DialogHeader>
          <DialogTitle>本地存储空间不足</DialogTitle>
          <DialogDescription>
            浏览器留给本应用的存储快满了，自动保存可能失败。建议立即把笔记导出到文件备份：
          </DialogDescription>
        </DialogHeader>

        {est ? (
          <div className="mt-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
            <div className="flex justify-between">
              <span>已用</span>
              <span className="font-medium text-foreground">{formatBytes(est.usage)}</span>
            </div>
            <div className="flex justify-between">
              <span>配额</span>
              <span className="font-medium text-foreground">{formatBytes(est.quota)}</span>
            </div>
            {ratio !== null && (
              <div className="mt-1 flex justify-between">
                <span>占用</span>
                <span className="font-medium text-amber-700">{Math.round(ratio * 100)}%</span>
              </div>
            )}
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            当前浏览器未提供用量查询（旧版 Safari），仍建议导出备份以防数据丢失。
          </p>
        )}

        <DialogFooter className="flex-col gap-2 sm:flex-col">
          {actions.includes('export-file') && (
            <Button type="button" onClick={() => onAction('export-file')} data-testid="quota-action-export">
              导出当前文档（.kbnote）
            </Button>
          )}
          {actions.includes('share') && (
            <Button
              type="button"
              variant="outline"
              onClick={() => onAction('share')}
              data-testid="quota-action-share"
            >
              分享…
            </Button>
          )}
          {actions.includes('download-backup-pack') && (
            <Button
              type="button"
              variant="outline"
              disabled={packing}
              onClick={() => onAction('download-backup-pack')}
              data-testid="quota-action-backup"
            >
              {packing ? '正在打包…' : '下载整库备份（.kbpack）'}
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={closeQuotaDialog} data-testid="quota-action-dismiss">
            以后再说
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
