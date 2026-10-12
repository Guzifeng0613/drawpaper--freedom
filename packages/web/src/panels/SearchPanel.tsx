import * as React from 'react';
import { Search, X, FileText, Heading, CheckSquare, List, Image as ImageIcon, StickyNote, Folder } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { PanelsApi, SearchResultItem } from './panels-api';
import type { BlockType } from '@drawpaper/core';

const TYPE_ICON: Record<BlockType, React.ComponentType<{ className?: string }>> = {
  text: FileText,
  heading: Heading,
  todo: CheckSquare,
  bullet: List,
  image: ImageIcon,
  note: StickyNote,
  group: Folder,
  table: FileText,
  code: FileText,
  equation: FileText,
  bookmark: FileText,
  attachment: FileText,
  reminder: FileText,
};

/** 把 snippet 中 matchStart..matchStart+matchLength 包成 <mark>。 */
function HighlightedSnippet({ item }: { item: SearchResultItem }) {
  const { snippet, matchStart, matchLength } = item;
  const start = Math.max(0, Math.min(matchStart, snippet.length));
  const end = Math.max(start, Math.min(start + matchLength, snippet.length));
  return (
    <span className="text-xs text-muted-foreground">
      {snippet.slice(0, start)}
      <mark className="bg-yellow-200 text-foreground">{snippet.slice(start, end)}</mark>
      {snippet.slice(end)}
    </span>
  );
}

/**
 * 全文搜索浮层。
 * - 打开时聚焦输入框；↑↓ 移动 activeSearchIndex，Enter 飞到该块并高亮。
 * - Esc 关闭（由画布快捷键调 api.openSearch 打开）。
 */
export const SearchPanel = React.memo(function SearchPanel({ api }: { api: PanelsApi }) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (api.searchOpen) requestAnimationFrame(() => inputRef.current?.focus());
  }, [api.searchOpen]);

  React.useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const child = el.querySelector<HTMLElement>(`[data-index="${api.activeSearchIndex}"]`);
    child?.scrollIntoView({ block: 'nearest' });
  }, [api.activeSearchIndex]);

  if (!api.searchOpen) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      api.closeSearch();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const n = api.searchResults.length;
      if (n > 0) api.selectSearchResult((api.activeSearchIndex + 1) % n);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const n = api.searchResults.length;
      if (n > 0) api.selectSearchResult((api.activeSearchIndex - 1 + n) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (api.activeSearchIndex >= 0) api.selectSearchResult(api.activeSearchIndex);
      else if (api.searchResults.length > 0) api.selectSearchResult(0);
    }
  };

  return (
    <>
      {/* Wave22 窄屏（≤639px）遮罩：点击关闭搜索；桌面无此层。 */}
      <div
        className="narrow-backdrop fixed inset-0 z-20 bg-black/40 sm:hidden"
        onClick={() => api.closeSearch()}
      />
      <div
        data-testid="search-panel"
        className="absolute right-4 top-14 z-30 flex w-96 flex-col rounded-lg border bg-card shadow-lg max-sm:left-2 max-sm:right-2 max-sm:w-[min(18rem,90vw)]"
      >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Search className="h-4 w-4 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={api.searchQuery}
          onChange={(e) => api.setSearchQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="搜索块内文字…  (↑↓ 选择 · Enter 定位 · Esc 关闭)"
          className="h-8 border-0 px-1 shadow-none focus-visible:ring-0"
        />
        <button
          type="button"
          aria-label="关闭搜索"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => api.closeSearch()}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <ScrollArea className="max-h-80">
        <div ref={listRef} className="p-1">
          {api.searchQuery.trim() === '' ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              输入关键词开始搜索
            </div>
          ) : !api.searchReady ? (
            // Wave30：rIC 分片喂入期间索引不完整，不能把空/部分结果误报为「无匹配结果」。
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              正在建立索引…
            </div>
          ) : api.searchResults.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">无匹配结果</div>
          ) : (
            api.searchResults.map((r, i) => {
              const Icon = TYPE_ICON[r.nodeType] ?? FileText;
              return (
                <button
                  key={r.nodeId + i}
                  type="button"
                  data-index={i}
                  className={cn(
                    'flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left',
                    i === api.activeSearchIndex ? 'bg-accent' : 'hover:bg-accent/60',
                  )}
                  onMouseEnter={() => api.selectSearchResult(i)}
                  onClick={() => api.flyToNode(r.nodeId)}
                >
                  <span className="flex items-center gap-1.5 text-sm">
                    <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="truncate">
                      <HighlightedSnippet item={r} />
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </ScrollArea>
      </div>
    </>
  );
});
