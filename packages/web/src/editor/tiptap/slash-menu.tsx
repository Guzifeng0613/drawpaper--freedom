import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/react';
import {
  Type,
  Heading1,
  Heading2,
  Heading3,
  CheckSquare,
  List,
  Image,
  StickyNote,
  Group,
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Highlighter,
  Link2,
  Table as TableIcon,
  SquareCode,
  Sigma,
  BookMarked,
  Paperclip,
  CalendarClock,
  Blocks,
} from 'lucide-react';
import type { BlockType } from '@drawpaper/core';

/**
 * 斜杠菜单（Notion 式）：行首输入 `/` 弹出浮动命令菜单。
 * - 块类型：文本 / 标题1-3 / 待办 / 列表 / 图片 / 便签 / 分组
 * - 行内格式：粗 / 斜 / 下划线 / 高亮 / 链接
 * - 方向键 + Enter 选择、Esc 关闭、输入过滤。
 */

export type SlashCommand =
  | { kind: 'block'; blockType: BlockType }
  | { kind: 'inline'; action: 'bold' | 'italic' | 'underline' | 'highlight' | 'link' }
  // Wave20：弹出跨画布目标选择器，把当前块改造成只读块嵌入。
  | { kind: 'embed-pick' };

interface SlashItem {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  command: SlashCommand;
}

const ITEMS: SlashItem[] = [
  { id: 'text', label: '文本', icon: <Type size={14} />, command: { kind: 'block', blockType: 'text' } },
  { id: 'h1', label: '标题 1', icon: <Heading1 size={14} />, command: { kind: 'block', blockType: 'heading' } },
  { id: 'h2', label: '标题 2', icon: <Heading2 size={14} />, command: { kind: 'block', blockType: 'heading' } },
  { id: 'h3', label: '标题 3', icon: <Heading3 size={14} />, command: { kind: 'block', blockType: 'heading' } },
  { id: 'todo', label: '待办', icon: <CheckSquare size={14} />, command: { kind: 'block', blockType: 'todo' } },
  { id: 'bullet', label: '无序列表', icon: <List size={14} />, command: { kind: 'block', blockType: 'bullet' } },
  { id: 'image', label: '图片', icon: <Image size={14} />, command: { kind: 'block', blockType: 'image' } },
  { id: 'note', label: '便签', icon: <StickyNote size={14} />, command: { kind: 'block', blockType: 'note' } },
  { id: 'group', label: '分组', icon: <Group size={14} />, command: { kind: 'block', blockType: 'group' } },
  { id: 'table', label: '表格', icon: <TableIcon size={14} />, command: { kind: 'block', blockType: 'table' } },
  { id: 'code', label: '代码块', icon: <SquareCode size={14} />, command: { kind: 'block', blockType: 'code' } },
  { id: 'equation', label: '数学公式', icon: <Sigma size={14} />, command: { kind: 'block', blockType: 'equation' } },
  { id: 'bookmark', label: '网页书签', icon: <BookMarked size={14} />, command: { kind: 'block', blockType: 'bookmark' } },
  { id: 'attachment', label: '附件', icon: <Paperclip size={14} />, command: { kind: 'block', blockType: 'attachment' } },
  { id: 'reminder', label: '日期/提醒', icon: <CalendarClock size={14} />, command: { kind: 'block', blockType: 'reminder' } },
  { id: 'embed', label: '嵌入其他画布的块', icon: <Blocks size={14} />, command: { kind: 'embed-pick' } },
  { id: 'bold', label: '粗体', icon: <Bold size={14} />, command: { kind: 'inline', action: 'bold' } },
  { id: 'italic', label: '斜体', icon: <Italic size={14} />, command: { kind: 'inline', action: 'italic' } },
  { id: 'underline', label: '下划线', icon: <UnderlineIcon size={14} />, command: { kind: 'inline', action: 'underline' } },
  { id: 'highlight', label: '高亮', icon: <Highlighter size={14} />, command: { kind: 'inline', action: 'highlight' } },
  { id: 'link', label: '链接', hint: 'Cmd+K', icon: <Link2 size={14} />, command: { kind: 'inline', action: 'link' } },
];

export function filterSlashItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return ITEMS;
  return ITEMS.filter((i) => i.label.toLowerCase().includes(q) || i.id.includes(q));
}

interface SlashMenuProps {
  editor: Editor;
  onCommand: (cmd: SlashCommand) => void;
}

export function SlashMenu({ editor, onCommand }: SlashMenuProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [active, setActive] = useState(0);
  const slashFrom = useRef<number | null>(null);

  const items = useMemo(() => filterSlashItems(query), [query]);

  // 监听编辑器事务：在行首发现 / 唤起菜单。
  useEffect(() => {
    const update = () => {
      const { state } = editor.view;
      const $head = state.selection.$head;
      if (!$head.parent.isTextblock) {
        setOpen(false);
        slashFrom.current = null;
        return;
      }
      const textBefore = $head.parent.textBetween(0, $head.parentOffset);
      const m = /^\s*\/([^\s/]*)$/.exec(textBefore);
      if (!m) {
        setOpen(false);
        slashFrom.current = null;
        return;
      }
      const from = $head.start() + textBefore.length - m[0].length;
      slashFrom.current = from;
      setQuery(m[1] ?? '');
      setActive(0);
      // jsdom / 零尺寸容器下 coordsAtPos 可能抛错，兜底 (0,0)，浮层仍可用（与 {{ 触发器同约定）。
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

  // 菜单打开期间接管键盘。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // IME 组词期（拼音/注音等）一律让路：回车确认候选、上下键翻候选、数字选字、
      // Esc 关候选窗都不得触发菜单命令或删除 `/query` 触发文本。keyCode===229 兜底个别
      // 浏览器首个组词 keydown 先于 compositionstart 触发、isComposing 尚未置位。
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

  const close = () => {
    setOpen(false);
    slashFrom.current = null;
  };

  const apply = (item: SlashItem) => {
    // 删除 `/query` 文本。
    const from = slashFrom.current;
    if (from !== null) {
      const to = editor.state.selection.from;
      if (to > from) {
        editor.view.dispatch(editor.view.state.tr.delete(from, to));
      }
    }
    close();
    onCommand(item.command);
  };

  if (!open) return null;

  return createPortal(
    <div
      className="fixed z-50 w-56 overflow-hidden rounded-lg border bg-[hsl(var(--popover))] text-[hsl(var(--popover-foreground))] shadow-lg"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="max-h-64 overflow-y-auto py-1">
        {items.length === 0 && <div className="px-3 py-2 text-xs text-slate-400">无匹配</div>}
        {items.map((item, i) => (
          <button
            key={item.id}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
              i === active ? 'bg-[hsl(var(--accent))]' : ''
            }`}
            onMouseEnter={() => setActive(i)}
            onClick={() => apply(item)}
          >
            <span className="text-[hsl(var(--muted-foreground))]">{item.icon}</span>
            <span className="flex-1">{item.label}</span>
            {item.hint && <span className="text-[10px] text-[hsl(var(--muted-foreground))]">{item.hint}</span>}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
