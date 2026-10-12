import * as React from 'react';
import {
  FilePlus2,
  FolderOpen,
  Save,
  Undo2,
  Redo2,
  ArrowRightFromLine,
  ArrowDownFromLine,
  Network,
  SlidersHorizontal,
  Search,
  FileDown,
  LayoutTemplate,
  Camera,
  Trash2,
  Tag,
  Sun,
  Moon,
  Monitor,
  Focus,
  X,
  Radar,
  Sparkles,
  ListTree,
  ArrowLeftRight,
  Waypoints,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Toolbar, ToolbarSeparator } from '@/components/ui/toolbar';
import { Toggle } from '@/components/ui/toggle';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Check } from 'lucide-react';
import type { PanelsApi } from './panels-api';
import { TemplatesDialog } from './TemplatesDialog';
import { SnapshotsDialog } from './SnapshotsDialog';
import { TrashDialog } from './TrashDialog';
import { TagManagerDialog } from './TagManagerDialog';
import { useThemeStore, type ThemeMode } from './lib/theme';
import { useWiringUi } from '@/wiring/ui-store';
import { isFsaSupported } from '@/storage/fsa';

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** 文档标题行内重命名。 */
function TitleRename({ api }: { api: PanelsApi }) {
  const title = api.doc?.title ?? '';
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(title);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (editing) {
      setValue(title);
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [editing, title]);

  const commit = () => {
    const t = value.trim();
    if (t && api.currentDocId) api.renameDoc(api.currentDocId, t);
    setEditing(false);
  };

  if (!api.currentDocId) return null;
  if (!editing) {
    return (
      <button
        type="button"
        className="max-w-[200px] truncate rounded px-1 text-sm font-semibold hover:bg-accent max-sm:max-w-[38vw]"
        title="重命名文档"
        onDoubleClick={() => setEditing(true)}
      >
        {title || '未命名'}
      </button>
    );
  }
  return (
    <Input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setEditing(false);
      }}
      className="h-7 w-40 text-sm"
    />
  );
}

function SaveStatus({ api }: { api: PanelsApi }) {
  // 活动文件权限丢失：写盘已暂停（Dexie 主保存继续），提示用户手势内重新授权。
  if (api.activeFile?.name && api.activeFile.needsAuth) {
    return (
      <button
        type="button"
        onClick={() => void api.relinkActiveFile()}
        title="浏览器重启后文件写入权限已失效，点击重新授权写回本地文件"
        className="rounded border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-600 hover:bg-amber-500/20"
      >
        {api.activeFile.name} · 需重新授权
      </button>
    );
  }
  // 本地自动保存失败：显式错误态 + 重试。
  if (api.saveState === 'error') {
    return (
      <button
        type="button"
        onClick={() => api.retrySave()}
        title="自动保存失败（可能是浏览器存储已满），点击重试"
        className="rounded border border-destructive/50 bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive hover:bg-destructive/20"
      >
        保存失败 · 重试
      </button>
    );
  }
  // 已绑定本地文件时显示「已保存到 xxx.kbnote」；否则显示自动保存时间。
  if (api.activeFile?.name) {
    return (
      <span className="text-xs text-muted-foreground" title="已绑定本地 .kbnote 文件">
        已保存到 {api.activeFile.name}
      </span>
    );
  }
  if (api.saveState === 'saving') {
    return <span className="text-xs text-muted-foreground">保存中…</span>;
  }
  if (api.saveState === 'saved' && api.savedAt) {
    return (
      <span className="text-xs text-muted-foreground">已自动保存 {formatTime(api.savedAt)}</span>
    );
  }
  return null;
}

const THEME_ICON: Record<ThemeMode, React.ComponentType<{ className?: string }>> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

/** 主题三态切换（light/dark/system），持久化 localStorage。 */
function ThemeToggle() {
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);
  const Icon = THEME_ICON[mode];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" title="主题：浅色 / 深色 / 跟随系统">
          <Icon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>主题</DropdownMenuLabel>
        {(['light', 'dark', 'system'] as ThemeMode[]).map((m) => {
          const Icon = THEME_ICON[m];
          return (
            <DropdownMenuItem key={m} onSelect={() => setMode(m)}>
              <Icon className="h-3.5 w-3.5" />
              {m === 'light' ? '浅色' : m === 'dark' ? '深色' : '跟随系统'}
              {mode === m ? <Check className="ml-auto h-3.5 w-3.5" /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 左侧大纲面板开关。 */
function OutlineToggle() {
  const open = useWiringUi((s) => s.outlineOpen);
  return (
    <Button
      variant={open ? 'default' : 'ghost'}
      size="icon"
      onClick={() => useWiringUi.getState().setOutlineOpen(!open)}
      title="大纲面板"
    >
      <ListTree className="h-4 w-4" />
    </Button>
  );
}

/** 右侧 AI 辅助面板开关。 */
function AiToggle() {
  const open = useWiringUi((s) => s.aiPanelOpen);
  return (
    <Button
      variant={open ? 'default' : 'ghost'}
      size="icon"
      onClick={() => useWiringUi.getState().setAiPanelOpen(!open)}
      title="AI 辅助"
    >
      <Sparkles className="h-4 w-4" />
    </Button>
  );
}

/** 右侧反链面板开关。 */
function BacklinksToggle() {
  const open = useWiringUi((s) => s.backlinksOpen);
  return (
    <Button
      variant={open ? 'default' : 'ghost'}
      size="icon"
      onClick={() => useWiringUi.getState().setBacklinksOpen(!open)}
      title="反向链接"
    >
      <ArrowLeftRight className="h-4 w-4" />
    </Button>
  );
}

/** 全局知识图谱总览入口。 */
function OverviewToggle() {
  const open = useWiringUi((s) => s.overviewOpen);
  return (
    <Button
      variant={open ? 'default' : 'ghost'}
      size="icon"
      onClick={() => useWiringUi.getState().setOverviewOpen(!open)}
      title="全局知识图谱"
    >
      <Waypoints className="h-4 w-4" />
    </Button>
  );
}

/**
 * 顶部工具栏：文档标题 / 保存状态 / 文档操作 / 撤销重做 / 布局 / 间距 / 导出 / 搜索 /
 * 标签 / 主题 / 聚焦分支（Wave3-H 新增活动文件状态、模板/快照/回收站入口）。
 */
export const TopToolbar = React.memo(function TopToolbar({ api }: { api: PanelsApi }) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [templatesOpen, setTemplatesOpen] = React.useState(false);
  const [snapshotsOpen, setSnapshotsOpen] = React.useState(false);
  const [trashOpen, setTrashOpen] = React.useState(false);
  const [tagsOpen, setTagsOpen] = React.useState(false);
  const { layoutPrefs } = api;

  const pickLayout = (mode: PanelsApi['layoutPrefs']['mode']) => {
    api.setLayoutMode(mode);
    api.previewLayout();
  };

  const focusRoot = api.selectedNodeIds.length === 1 ? api.selectedNodeIds[0]! : null;

  return (
    <header className="topbar-shell absolute left-0 right-0 top-0 z-20 flex h-12 items-center gap-2 border-b bg-card/85 px-3 backdrop-blur">
      <span className="text-sm font-bold tracking-tight">drawpaper</span>
      <Separator orientation="vertical" className="!h-5" />

      <TitleRename api={api} />
      <SaveStatus api={api} />

      {/* 文档操作菜单 */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            文档
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>文档</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => api.newDoc()}>
            <FilePlus2 /> 新建文档
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setTemplatesOpen(true)}>
            <LayoutTemplate /> 从模板新建…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              // WebKit/Safari 无 FSA：store.openLocalFile() 内部 pickLocalFile 会因
              // isSupported()=false 直接返回 null、不弹任何选择器（静默无反应）。
              // 此时在本手势调用栈内同步点隐藏 input（与「导入 .kbnote」同一 input），
              // 保住用户激活，避免 WebKit 对 input.click() 的严格用户激活要求。
              // Chromium 有 FSA，仍走 api.openLocalFile()（句柄持久化自动保存），行为不变。
              if (isFsaSupported()) api.openLocalFile();
              else fileInputRef.current?.click();
            }}
          >
            <FolderOpen /> 打开本地 .kbnote…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
            <FolderOpen /> 导入 .kbnote
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => api.currentDocId && api.exportKbnote(api.currentDocId)}>
            <Save /> 导出 .kbnote
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => api.saveAsLocalFile()}>
            <Save /> 另存为本地 .kbnote…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setSnapshotsOpen(true)}>
            <Camera /> 快照历史…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setTrashOpen(true)}>
            <Trash2 /> 回收站…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => api.requestSave()}>
            <FileDown /> 立即保存
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={api.backupEnabled}
            onSelect={(e) => {
              e.preventDefault();
              api.setBackupEnabled(!api.backupEnabled);
            }}
          >
            每 10 分钟自动备份
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={fileInputRef}
        type="file"
        accept=".kbnote,application/json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) api.importKbnote(f);
          e.target.value = '';
        }}
      />

      <ToolbarSeparator />

      {/* 撤销 / 重做 */}
      <Toolbar>
        <Button variant="ghost" size="icon" disabled={!api.canUndo} onClick={() => api.undo()} title="撤销 (Ctrl+Z)">
          <Undo2 className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" disabled={!api.canRedo} onClick={() => api.redo()} title="重做 (Ctrl+Y)">
          <Redo2 className="h-4 w-4" />
        </Button>
      </Toolbar>

      <ToolbarSeparator />

      {/* 布局三模式 */}
      <Toolbar>
        <Toggle
          size="sm"
          pressed={layoutPrefs.mode === 'mindmap-right'}
          onPressedChange={() => pickLayout('mindmap-right')}
          title="思维导图 · 横向"
        >
          <ArrowRightFromLine className="h-4 w-4" /> 横向
        </Toggle>
        <Toggle
          size="sm"
          pressed={layoutPrefs.mode === 'mindmap-down'}
          onPressedChange={() => pickLayout('mindmap-down')}
          title="思维导图 · 纵向"
        >
          <ArrowDownFromLine className="h-4 w-4" /> 纵向
        </Toggle>
        <Toggle
          size="sm"
          pressed={layoutPrefs.mode === 'org-tree'}
          onPressedChange={() => pickLayout('org-tree')}
          title="组织结构树"
        >
          <Network className="h-4 w-4" /> 组织树
        </Toggle>
        <Toggle
          size="sm"
          pressed={layoutPrefs.mode === 'radial'}
          onPressedChange={() => pickLayout('radial')}
          title="放射状布局"
        >
          <Radar className="h-4 w-4" /> 放射
        </Toggle>
        <Toggle
          size="sm"
          pressed={layoutPrefs.mode === 'flow-layered'}
          onPressedChange={() => pickLayout('flow-layered')}
          title="逻辑流分层有向图（自上而下分层）"
        >
          <Waypoints className="h-4 w-4" /> 逻辑流
        </Toggle>
      </Toolbar>

      {/* 间距弹层 */}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" title="布局间距">
            <SlidersHorizontal className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64">
          <div className="grid gap-4">
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label>层级间距</Label>
                <span className="text-xs text-muted-foreground">{layoutPrefs.rankSpacing}px</span>
              </div>
              <Slider
                min={40}
                max={200}
                step={5}
                value={[layoutPrefs.rankSpacing]}
                onValueChange={([v]) => v !== undefined && api.setRankSpacing(v)}
              />
            </div>
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label>同级间距</Label>
                <span className="text-xs text-muted-foreground">{layoutPrefs.nodeSpacing}px</span>
              </div>
              <Slider
                min={10}
                max={80}
                step={2}
                value={[layoutPrefs.nodeSpacing]}
                onValueChange={([v]) => v !== undefined && api.setNodeSpacing(v)}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="branch-only">仅整理选中分支</Label>
              <Switch
                id="branch-only"
                checked={api.branchOnly}
                onCheckedChange={(v) => api.setBranchOnly(v)}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="tighten">折叠后自动收紧</Label>
              <Switch
                id="tighten"
                checked={api.tighten}
                onCheckedChange={(v) => api.setTighten(v)}
              />
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <div className="ml-auto flex items-center gap-2">
        {/* 聚焦分支 */}
        {api.focusNodeId ? (
          <Badge variant="secondary" className="gap-1">
            <Focus className="h-3 w-3" /> 聚焦中
            <button
              type="button"
              aria-label="取消聚焦"
              className="rounded hover:text-destructive"
              onClick={() => api.setFocusNode(null)}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ) : focusRoot ? (
          <Button variant="outline" size="sm" onClick={() => api.setFocusNode(focusRoot)} title="只看这一支，其余淡化">
            <Focus className="h-4 w-4" /> 聚焦此分支
          </Button>
        ) : null}

        <Button variant="ghost" size="icon" onClick={() => setTagsOpen(true)} title="标签管理">
          <Tag className="h-4 w-4" />
        </Button>
        <OutlineToggle />
        <AiToggle />
        <BacklinksToggle />
        <OverviewToggle />
        <ThemeToggle />
        <Button variant="outline" size="sm" onClick={() => api.openSearch()} title="全文搜索 (Ctrl/Cmd+F)">
          <Search className="h-4 w-4" /> 搜索
        </Button>
        <Button size="sm" onClick={() => api.openExport()}>
          <FileDown className="h-4 w-4" /> 导出
        </Button>
        {api.page.showPageBreak ? (
          <Badge variant="warning">分页预览中</Badge>
        ) : null}
      </div>

      {/* Wave3-H 弹层 */}
      <TemplatesDialog open={templatesOpen} onOpenChange={setTemplatesOpen} api={api} />
      <SnapshotsDialog open={snapshotsOpen} onOpenChange={setSnapshotsOpen} api={api} />
      <TrashDialog open={trashOpen} onOpenChange={setTrashOpen} api={api} />
      <TagManagerDialog open={tagsOpen} onOpenChange={setTagsOpen} api={api} />
    </header>
  );
});
