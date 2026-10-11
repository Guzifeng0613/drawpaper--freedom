import * as React from 'react';
import { Eye, CheckCircle2, Trash2, AlertTriangle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useSyncUi } from './sync-ui-store';
import {
  getConflictCopies,
  openConflictCopyAsPreview,
  adoptConflictCopyAsWinner,
  discardConflictCopy,
} from './conflict-copies';
import type { ConflictCopyRow } from './sync-db';

/**
 * 冲突副本处理面板（Wave11 阶段 B）：聚合三来源（FSA 列目录 / WebDAV PROPFIND /
 * 手动通道本地登记）的 `*.conflicted-*.kbnote`，逐项给三个确定性动作。
 *
 * 三动作：
 *  ① 打开为新文档预览（Eye）——载入为新 docId 浏览，不动原文档；
 *  ② 以此副本为准（CheckCircle2）——副本胜合并落库；
 *  ③ 丢弃（Trash2）——删登记（在线通道连着时一并删远端文件）。
 */

const SOURCE_LABEL: Record<ConflictCopyRow['source'], string> = {
  folder: '同步文件夹',
  webdav: 'WebDAV',
  manual: '手动备份包',
};

export function ConflictCopiesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [rows, setRows] = React.useState<ConflictCopyRow[]>([]);
  const [busyId, setBusyId] = React.useState<string>('');
  const refresh = useSyncUi((s) => s.refreshConflictCopies);

  React.useEffect(() => {
    if (!open) return;
    void getConflictCopies().then((r) => setRows(r));
  }, [open]);

  const act = async (row: ConflictCopyRow, action: 'preview' | 'adopt' | 'discard') => {
    setBusyId(row.id);
    try {
      if (action === 'preview') {
        await openConflictCopyAsPreview(row);
      } else if (action === 'adopt') {
        await adoptConflictCopyAsWinner(row);
      } else {
        await discardConflictCopy(row);
      }
      const rest = await getConflictCopies();
      setRows(rest);
      await refresh();
    } finally {
      setBusyId('');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            待处理冲突副本
          </DialogTitle>
          <DialogDescription>
            合并时保留了对端版本副本。逐项选择如何处理：预览核对、以此副本为准，或丢弃。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 text-sm">
          {rows.length === 0 ? (
            <div className="rounded border bg-muted/40 px-3 py-6 text-center text-xs text-muted-foreground" data-testid="conflict-list-empty">
              没有待处理的冲突副本
            </div>
          ) : (
            <ul className="flex max-h-[46vh] flex-col gap-2 overflow-auto">
              {rows.map((row) => (
                <li key={row.id} className="rounded border p-2" data-testid="conflict-row">
                  <div className="flex items-center justify-between">
                    <div className="flex flex-col">
                      <span className="text-xs font-medium" data-testid="conflict-title">{row.title}</span>
                      <span className="text-[11px] text-muted-foreground">
                        来自 {SOURCE_LABEL[row.source]} · {new Date(row.createdAt).toLocaleString()}
                      </span>
                    </div>
                  </div>
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === row.id}
                      onClick={() => void act(row, 'preview')}
                      data-testid="conflict-preview"
                    >
                      <Eye className="h-3.5 w-3.5" /> 打开预览
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === row.id}
                      onClick={() => void act(row, 'adopt')}
                      data-testid="conflict-adopt"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" /> 以此副本为准
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-red-700"
                      disabled={busyId === row.id}
                      onClick={() => void act(row, 'discard')}
                      data-testid="conflict-discard"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> 丢弃
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={() => onOpenChange(false)} data-testid="conflict-close">
              关闭
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
