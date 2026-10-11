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
import { editorStore } from '@/store/editor-store';
import { resolveBlockDeleteRequest } from '@/wiring/block-delete-guard';

/**
 * Wave7 P2.1：删除块时的跨文档反链影响确认框。
 *
 * 与删文档 ConfirmDialog 视觉一致（同一套 Dialog primitives），但因有两个破坏性动作：
 *  - 「保留为悬挂链接」：删块，incoming 链接记录保留 → 目标块缺失后 chip 显示 .is-dangling；
 *  - 「一并移除这些链接」：删块 + 摘除所有指向/发自该块的 docRef mark 与 links 记录。
 * 另设「取消」不删。
 */
export function BlockDeleteConfirmDialog() {
  const req = useWiringUi((s) => s.blockDeleteRequest);
  const open = req !== null;

  const close = () => useWiringUi.getState().setBlockDeleteRequest(null);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>删除该块？</DialogTitle>
          <DialogDescription>
            该块与其他块存在双向链接，删除前请选择如何处理这些链接：
          </DialogDescription>
        </DialogHeader>

        {req && req.incoming.length > 0 ? (
          <div className="mt-1 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700">
            <p className="font-medium">{req.incoming.length} 处链接指向本块：</p>
            <ul className="mt-1 list-disc pl-4">
              {req.incoming.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {req && req.outgoing.length > 0 ? (
          <div className="mt-2 rounded-md border border-muted bg-muted/40 p-2 text-xs text-muted-foreground">
            <p className="font-medium">本块链向 {req.outgoing.length} 处：</p>
            <ul className="mt-1 list-disc pl-4">
              {req.outgoing.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          「保留为悬挂链接」会留下红虚边的失效引用；「一并移除」会级联清理其他文档里的引用（操作前自动快照，可从快照恢复）。
        </p>

        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={close}>
            取消
          </Button>
          <div className="flex gap-2">
            <Button
              variant="default"
              onClick={() => resolveBlockDeleteRequest(editorStore, 'keep')}
            >
              保留为悬挂链接
            </Button>
            <Button
              className="bg-red-700 text-white hover:bg-red-800"
              onClick={() => resolveBlockDeleteRequest(editorStore, 'remove')}
            >
              一并移除这些链接
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
