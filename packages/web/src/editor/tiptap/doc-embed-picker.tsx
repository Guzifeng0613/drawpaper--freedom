import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText, Blocks } from 'lucide-react';
import { searchDocRefTargets, type DocRefTarget } from '../../storage/doc-ref-search';
import type { KBNoteDoc } from '@drawpaper/core';

/**
 * Wave20 块嵌入目标选择器：斜杠菜单选「嵌入其他画布的块」后弹出。
 * 复用 doc-ref-search（与 [[双链]] 同一目标查询）：输入即搜跨文档块，点击选定。
 * 选定后由调用方把当前块改造成 doc-embed 嵌入块。
 */
export function DocEmbedPicker({
  currentDoc,
  onPick,
  onClose,
}: {
  currentDoc: KBNoteDoc | null;
  onPick: (target: DocRefTarget) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<DocRefTarget[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      const results = await searchDocRefTargets(currentDoc, query, 15);
      setItems(results);
      setActive(0);
    }, 120);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [currentDoc, query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 搜索框内 IME 组词期：回车确认拼音候选时不得连带选定候选；keyCode===229 兜底。
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => (a + 1) % Math.max(items.length, 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a - 1 + items.length) % Math.max(items.length, 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = items[active];
        if (item) onPick(item);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, active]);

  return createPortal(
    <div
      className="fixed left-1/2 top-1/3 z-50 w-80 -translate-x-1/2 rounded-lg border bg-[hsl(var(--popover))] text-[hsl(var(--popover-foreground))] shadow-xl"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Blocks size={14} className="shrink-0 text-sky-500" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索要嵌入的其他画布块…"
          className="w-full bg-transparent text-sm outline-none placeholder:text-slate-400"
        />
      </div>
      <div className="max-h-64 overflow-y-auto py-1">
        {items.length === 0 && <div className="px-3 py-2 text-xs text-slate-400">无匹配块</div>}
        {items.map((item, i) => (
          <button
            key={`${item.docId}::${item.nodeId}`}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
              i === active ? 'bg-[hsl(var(--accent))]' : ''
            }`}
            onMouseEnter={() => setActive(i)}
            onClick={() => onPick(item)}
          >
            <FileText size={13} className="shrink-0 text-[hsl(var(--muted-foreground))]" />
            <span className="flex-1 truncate">{item.nodeTitle}</span>
            <span className="shrink-0 rounded bg-sky-100 px-1 text-[10px] text-sky-700">{item.docTitle}</span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
