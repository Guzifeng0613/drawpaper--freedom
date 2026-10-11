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
import {
  closeGuardCancel,
  closeGuardDiscardAndQuit,
  closeGuardSaveAndQuit,
} from '@/host/desktop-bridge';

/**
 * Wave12 原生关闭守卫三选框。
 *
 * 仅当「已绑定原生 .kbnote 且脏」时，Rust 拦截窗口关闭并 emit
 * `app:close-requested` → desktop-bridge 把 closeGuardOpen 置 true。
 *  - 保存并退出：原地覆盖 .kbnote → force_quit；
 *  - 不保存并退出：丢弃未保存改动 → force_quit；
 *  - 取消：留在应用（不退出）。
 * IDB 文档（未绑定原生文件）关闭时不弹此框——IndexedDB 自动保存兜底。
 */
export function CloseGuardDialog() {
  const open = useWiringUi((s) => s.closeGuardOpen);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && closeGuardCancel()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>保存对当前文档的更改？</DialogTitle>
          <DialogDescription>
            关闭前未保存的改动将丢失。是否现在保存到 .kbnote 文件？
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={closeGuardCancel}>
            取消
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="bg-red-700 text-white hover:bg-red-800"
              onClick={() => void closeGuardDiscardAndQuit()}
            >
              不保存
            </Button>
            <Button variant="default" onClick={() => void closeGuardSaveAndQuit()}>
              保存并退出
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
