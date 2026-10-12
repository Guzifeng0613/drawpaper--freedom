import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/react';
import { FileText } from 'lucide-react';
import { searchDocRefTargets, type DocRefTarget } from '../../storage/doc-ref-search';
import { isInCodeContext } from './doc-embed-trigger';

/**
 * docRef 提及浮层：在块内输入 `[[`（可继续输查询词）唤起，
 * 跨当前文档 + 所有 Dexie 文档搜索块标题/正文（异步、150ms 防抖）。
 * 方向键/鼠标/Esc 选择；插入文本 `[[目标标题]]` 并包上 docRef mark。
 */
export function DocRefMention({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<DocRefTarget[]>([]);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [active, setActive] = useState(0);
  const fromRef = useRef<number | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // 监听事务：检测 `[[query` 唤起浮层。
  useEffect(() => {
    const update = () => {
      const { state } = editor.view;
      const $head = state.selection.$head;
      if (!$head.parent.isTextblock) {
        close();
        return;
      }
      // 代码块/行内代码内不弹双链浮层（与 `{{` 嵌入触发同一约定）。
      if (isInCodeContext($head)) {
        close();
        return;
      }
      const textBefore = $head.parent.textBetween(0, $head.parentOffset);
      const m = /\[\[([^\]]*)$/.exec(textBefore);
      if (!m) {
        close();
        return;
      }
      const from = $head.start() + textBefore.length - m[0].length;
      fromRef.current = from;
      setQuery(m[1] ?? '');
      setActive(0);
      // jsdom / 零尺寸容器下 coordsAtPos 可能抛错，兜底 (0,0)，浮层仍可用（同 {{ 触发器约定）。
      let pos = { x: 0, y: 0 };
      try {
        const coords = editor.view.coordsAtPos(from);
        pos = { x: coords.left, y: coords.bottom + 4 };
      } catch {
        /* noop */
      }
      setPos(pos);
      setOpen(true);
    };
    editor.on('transaction', update);
    update();
    return () => {
      editor.off('transaction', update);
    };
  }, [editor]);

  // 查询防抖：异步查 Dexie。
  useEffect(() => {
    if (!open) return;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      const results = await searchDocRefTargets(null, query, 15);
      setItems(results);
      setActive(0);
    }, 150);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [open, query]);

  // 键盘接管。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // IME 组词期一律让路：回车确认候选 / 上下键翻候选 / Esc 关候选窗都不得触发选定
      // 或删除 `[[query` 触发文本；keyCode===229 兜底首个组词键先于 compositionstart 的竞态。
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setActive((a) => (a + 1) % Math.max(items.length, 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setActive((a) => (a - 1 + items.length) % Math.max(items.length, 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const item = items[active];
        if (item) apply(item);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, items, active]);

  function close() {
    setOpen(false);
    fromRef.current = null;
  }

  function apply(target: DocRefTarget) {
    const from = fromRef.current;
    if (from !== null) {
      const to = editor.state.selection.from;
      if (to > from) {
        editor.view.dispatch(editor.view.state.tr.delete(from, to));
      }
    }
    editor
      .chain()
      .insertContent({
        type: 'text',
        text: `[[${target.nodeTitle}]]`,
        marks: [
          {
            type: 'docRef',
            attrs: {
              targetDocId: target.docId,
              targetNodeId: target.nodeId,
              targetTitle: target.nodeTitle,
            },
          },
        ],
      })
      .run();
    close();
  }

  if (!open) return null;

  return createPortal(
    <div
      className="fixed z-50 w-72 overflow-hidden rounded-lg border bg-[hsl(var(--popover))] text-[hsl(var(--popover-foreground))] shadow-lg"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="max-h-64 overflow-y-auto py-1">
        {items.length === 0 && <div className="px-3 py-2 text-xs text-slate-400">无匹配块</div>}
        {items.map((item, i) => (
          <button
            key={`${item.docId}::${item.nodeId}`}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
              i === active ? 'bg-[hsl(var(--accent))]' : ''
            }`}
            onMouseEnter={() => setActive(i)}
            onClick={() => apply(item)}
          >
            <FileText size={13} className="shrink-0 text-[hsl(var(--muted-foreground))]" />
            <span className="flex-1 truncate">{item.nodeTitle}</span>
            <span className="shrink-0 text-[10px] text-[hsl(var(--muted-foreground))]">{item.docTitle}</span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
