import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/react';
import type { ResolvedPos } from '@tiptap/pm/model';
import { FileText, Blocks } from 'lucide-react';
import { searchDocRefTargets, type DocRefTarget } from '../../storage/doc-ref-search';
import type { KBNoteDoc } from '@drawpaper/core';

/**
 * Wave22 A：块内输入 `{{` 唤起的跨画布块嵌入浮层。
 *
 * 行为与 `[[双链]]` 提及浮层一致：浮层定位在光标处、上下键选择、Enter/Tab 确认、
 * Esc 取消、点击外部关闭；继续输入按查询词过滤目标（复用 doc-ref-search，
 * 与斜杠菜单「嵌入其他画布的块」的 DocEmbedPicker 同一查询）。
 *
 * 选定后由调用方走与斜杠菜单完全相同的插入路径（host note + content.data 挂
 * {kind:'doc-embed',targetDocId,targetNodeId,titleSnapshot}），本组件不造数据结构；
 * `{{query` 触发文本与 `[[` 一样先从正文删除。
 */

/**
 * 光标是否处于代码上下文：代码块节点内，或光标落在行内 code mark 里。
 * 此上下文内 `{{` / `[[` 触发一律禁用（两个触发器共用同一约定）。
 */
export function isInCodeContext($head: ResolvedPos): boolean {
  if ($head.parent.type.name === 'codeBlock') return true;
  return $head.marks().some((m) => m.type.name === 'code');
}

/**
 * 匹配块内末尾的未闭合 `{{query` 触发串。
 * 返回查询词（空串也算匹配——刚打出两个 `{`）；不匹配或处于代码上下文返回 null。
 * 出现闭合 `}` 即视为触发串结束（`{{q}}` 不匹配），与 `[[...]]` 的闭合约定同构。
 */
export function matchEmbedTrigger(textBefore: string, inCodeContext: boolean): string | null {
  if (inCodeContext) return null;
  const m = /\{\{([^{}]*)$/.exec(textBefore);
  return m ? (m[1] ?? '') : null;
}

export function DocEmbedTrigger({
  editor,
  currentDoc,
  excludeNodeId,
  onPick,
}: {
  editor: Editor;
  currentDoc: KBNoteDoc | null;
  /** 正在编辑的块 id：从候选中排除（自己不能嵌入自己；斜杠路径块为空稿不会撞上）。 */
  excludeNodeId?: string;
  onPick: (target: DocRefTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<DocRefTarget[]>([]);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [active, setActive] = useState(0);
  const fromRef = useRef<number | null>(null);
  // IME 组合期标记：组合期间键盘接管（Enter/Tab/方向键）一律让路给输入法候选窗，不误选。
  const composingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // IME 组合状态跟踪（与画布级快捷键同一约定）。
  useEffect(() => {
    const onStart = () => {
      composingRef.current = true;
    };
    const onEnd = () => {
      composingRef.current = false;
    };
    window.addEventListener('compositionstart', onStart);
    window.addEventListener('compositionend', onEnd);
    return () => {
      window.removeEventListener('compositionstart', onStart);
      window.removeEventListener('compositionend', onEnd);
    };
  }, []);

  // 监听事务：块内末尾出现 `{{query` 即唤起浮层（代码上下文不触发）。
  useEffect(() => {
    const update = () => {
      const { state } = editor.view;
      const $head = state.selection.$head;
      if (!$head.parent.isTextblock) {
        close();
        return;
      }
      const textBefore = $head.parent.textBetween(0, $head.parentOffset);
      const q = matchEmbedTrigger(textBefore, isInCodeContext($head));
      if (q === null) {
        close();
        return;
      }
      const from = $head.start() + textBefore.length - (2 + q.length);
      fromRef.current = from;
      setQuery(q);
      setActive(0);
      // jsdom / 零尺寸容器下 coordsAtPos 可能抛错，兜底为 (0,0)，浮层仍可用。
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

  // 查询防抖：异步查 Dexie（空库时 searchDocRefTargets 自行兜底返回空，弹层显示空态不崩）。
  useEffect(() => {
    if (!open) return;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      const results = await searchDocRefTargets(currentDoc, query, 15);
      // 排除正在编辑的块自身（其正文即查询词，会与目标同分排在首位）。
      const filtered = excludeNodeId
        ? results.filter((r) => r.nodeId !== excludeNodeId)
        : results;
      setItems(filtered);
      setActive(0);
    }, 120);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [open, query, currentDoc, excludeNodeId]);

  // 键盘接管：Esc 取消 / 上下移动 / Enter|Tab 确认；IME 组合期全部让路。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // 事件级 IME 守卫：与 composingRef 双保险（首个组词 keydown 先于 compositionstart
      // 时，composingRef 尚未置位，这里靠事件自带的 isComposing / keyCode===229 兜底）。
      if (e.isComposing || e.keyCode === 229) return;
      if (composingRef.current) return;
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
      } else if (e.key === 'Enter' || e.key === 'Tab') {
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

  // 点击浮层外部关闭（浮层内部 mousedown 已 preventDefault，编辑器焦点不丢）。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);

  function close() {
    setOpen(false);
    fromRef.current = null;
  }

  function apply(target: DocRefTarget) {
    // 先删除 `{{query` 触发文本（与 [[ 一致），再把选定交给调用方走嵌入插入路径。
    const from = fromRef.current;
    if (from !== null) {
      const to = editor.state.selection.from;
      if (to > from) {
        editor.view.dispatch(editor.view.state.tr.delete(from, to));
      }
    }
    close();
    onPick(target);
  }

  if (!open) return null;

  return createPortal(
    <div
      ref={rootRef}
      className="fixed z-50 w-80 overflow-hidden rounded-lg border bg-[hsl(var(--popover))] text-[hsl(var(--popover-foreground))] shadow-xl"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Blocks size={14} className="shrink-0 text-sky-500" />
        <span className="text-xs text-slate-400">嵌入其他画布的块</span>
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
            onClick={() => apply(item)}
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
