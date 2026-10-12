import * as React from 'react';
import { FileText, FilePlus2, Copy, Trash2, Pencil, ChevronDown, FileWarning } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { PanelsApi, DocMeta } from './panels-api';
import { useCollabUi } from '@/collab/collab-ui-store';
import { useUiShell } from '@/store/ui-shell-store';

/** 友好相对时间（"刚刚 / n 分钟前 / n 小时前 / MM-DD"）。 */
function friendlyTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function DocRow({
  doc,
  active,
  api,
}: {
  doc: DocMeta;
  active: boolean;
  api: PanelsApi;
}) {
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(doc.title);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [impact, setImpact] = React.useState<{ count: number; samples: string[] } | null>(null);
  const openedMap = useCollabUi((s) => s.docsOpenedElsewhere);
  const openedElsewhere = openedMap[doc.id] ?? [];

  React.useEffect(() => {
    if (editing) requestAnimationFrame(() => inputRef.current?.select());
  }, [editing]);

  const openConfirm = () => {
    setConfirmOpen(true);
    setImpact(null);
    void api.docDeleteImpact(doc.id).then(setImpact);
  };

  const commit = () => {
    const t = value.trim();
    if (t) api.renameDoc(doc.id, t);
    setEditing(false);
  };

  // 坏档隔离行：不打开、不重命名、不复制，仅展示 + 删除（原始记录经回收站可追溯）。
  if (doc.corrupt) {
    return (
      <div
        className="group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm"
        title="此文档记录损坏，无法打开；可删除（移入回收站）"
      >
        <FileWarning className="h-4 w-4 shrink-0 text-amber-600" />
        <span className="flex-1 truncate text-amber-700">
          损坏文档
          <span className="ml-1 rounded-full bg-amber-500/15 px-1 text-[9px] text-amber-700">损坏</span>
        </span>
        <button
          type="button"
          title="删除损坏记录"
          className="rounded p-1 text-muted-foreground hover:text-destructive"
          onClick={openConfirm}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title="删除损坏记录？"
          confirmText="删除"
          onConfirm={() => api.removeDoc(doc.id)}
        >
          <p className="text-sm text-muted-foreground">
            将把这条无法解析的记录移入回收站；其余文档不受影响。
          </p>
        </ConfirmDialog>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm',
        active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
      )}
    >
      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
      {editing ? (
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          className="h-6 flex-1 px-1 text-xs"
        />
      ) : (
        <button
          type="button"
          className="flex-1 truncate text-left"
          onClick={() => api.openDoc(doc.id)}
          onDoubleClick={() => setEditing(true)}
          title={
            openedElsewhere.length > 0
              ? `${doc.title} · 已在其他 ${openedElsewhere.length} 个标签打开（协作中，无强制锁）`
              : `${doc.title} · ${friendlyTime(doc.updatedAt)}更新`
          }
        >
          <span className="flex items-center gap-1 truncate">
            {doc.title}
            {openedElsewhere.length > 0 ? (
              <span
                data-testid="doc-open-elsewhere"
                title={`已在其他标签打开：${openedElsewhere.map((p) => p.name).join('、')}`}
                className="inline-flex items-center gap-0.5 rounded-full px-1 text-[9px] text-muted-foreground"
                style={{ boxShadow: `inset 0 0 0 1px ${openedElsewhere[0]!.color}` }}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: openedElsewhere[0]!.color }}
                />
                他标签打开
              </span>
            ) : null}
          </span>
          <span className="block text-[10px] text-muted-foreground">{friendlyTime(doc.updatedAt)}</span>
        </button>
      )}

      <div className="hidden shrink-0 items-center group-hover:flex">
        <button
          type="button"
          title="重命名"
          className="rounded p-1 text-muted-foreground hover:text-foreground"
          onClick={() => setEditing(true)}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="复制"
          className="rounded p-1 text-muted-foreground hover:text-foreground"
          onClick={() => api.duplicateDoc(doc.id)}
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="删除"
          className="rounded p-1 text-muted-foreground hover:text-destructive"
          onClick={openConfirm}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="删除文档？"
        confirmText="删除"
        onConfirm={() => api.removeDoc(doc.id)}
      >
        <p className="text-sm text-muted-foreground">
          将永久删除「{doc.title}」，此操作不可撤销。
        </p>
        {impact ? (
          impact.count > 0 ? (
            <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
              <p className="font-medium">
                将有 {impact.count} 处引用变为悬挂：
              </p>
              <ul className="mt-1 list-disc pl-4">
                {impact.samples.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">没有其他文档引用它。</p>
          )
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">正在检查引用…</p>
        )}
      </ConfirmDialog>
    </div>
  );
}

/**
 * 左侧可折叠文档列表。
 */
export const DocsListPanel = React.memo(function DocsListPanel({ api }: { api: PanelsApi }) {
  // Wave22：窄屏（≤639px）默认收起为 40px 轨道，避免 288px 展开态+遮罩永久压住画布；
  // 桌面保持默认展开。仅初始值按视口取一次，后续展开/收起完全由用户点按驱动（语义不变）。
  const [collapsed, setCollapsed] = React.useState(
    () => typeof window !== 'undefined' && window.innerWidth < 640,
  );
  const setDocsCollapsed = useUiShell((st) => st.setDocsCollapsed);
  React.useEffect(() => {
    setDocsCollapsed(collapsed);
  }, [collapsed, setDocsCollapsed]);

  if (collapsed) {
    return (
      <aside className="absolute bottom-4 left-4 top-16 z-10 flex w-10 flex-col items-center rounded-lg border bg-card/95 py-2 shadow-sm max-sm:bottom-2 max-sm:top-14">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title="展开文档列表"
          aria-label="展开文档列表"
          className="rounded p-1 text-muted-foreground hover:bg-accent"
        >
          <FileText className="h-4 w-4" />
        </button>
      </aside>
    );
  }

  return (
    <>
      {/* Wave22 窄屏（≤639px）遮罩：点击收起文档列表；桌面无此层。 */}
      <div
        className="narrow-backdrop fixed inset-0 z-[9] bg-black/40 sm:hidden"
        onClick={() => setCollapsed(true)}
      />
      <aside
        data-testid="docs-list-panel"
        className="absolute bottom-4 left-4 top-16 z-10 flex w-56 flex-col rounded-lg border bg-card/95 shadow-sm max-sm:bottom-2 max-sm:left-0 max-sm:top-14 max-sm:w-[min(18rem,90vw)] max-sm:rounded-l-none"
      >
        <div className="flex items-center justify-between border-b px-2 py-1.5">
          <span className="text-xs font-semibold text-muted-foreground">文档</span>
          <div className="flex items-center">
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => api.newDoc()} title="新建文档">
              <FilePlus2 className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setCollapsed(true)}
              title="收起列表"
              aria-label="收起文档列表"
            >
              <ChevronDown className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <ScrollArea className="flex-1 p-1">
          {api.docs.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              还没有文档
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {api.docs.map((d) => (
                <DocRow key={d.id} doc={d} active={d.id === api.currentDocId} api={api} />
              ))}
            </div>
          )}
        </ScrollArea>
      </aside>
    </>
  );
});
