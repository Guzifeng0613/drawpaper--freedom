import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Position, NodeResizer, NodeToolbar, type NodeProps } from '@xyflow/react';
import { EditorContent, type Editor } from '@tiptap/react';
import type { BlockNode } from '@drawpaper/core';
import { extractPlainText } from '@drawpaper/core';
import { useEditorApi, useEditingNodeId, useChildCount } from '../canvas/editor-context';
import { useIsHydrated } from '../canvas/hydration-store';
import { createBlockEditor } from '../tiptap/createBlockEditor';
import { SlashMenu, type SlashCommand } from '../tiptap/slash-menu';
import { DocRefMention } from '../tiptap/doc-ref-mention';
import { DocEmbedPicker } from '../tiptap/doc-embed-picker';
import { DocEmbedTrigger } from '../tiptap/doc-embed-trigger';
import type { DocRefTarget } from '../../storage/doc-ref-search';
import type { DocEmbedData } from '../content-defaults';
import { BlockHoverToolbar } from './block-hover-toolbar';
import { TableToolbar } from './table-toolbar';
import { SourceHandles as ConnectHandles, TargetHandles } from './ConnectHandle';
import type { AppNode } from './types';

/**
 * BlockShell —— 所有块类型的通用外壳：
 * 选中描边 / hover 工具条 / 四角+右边缩放（最小宽 160，文字回流，高度实测上报）/
 * 双击进入 Tiptap 编辑（nodrag + nowheel + stopPropagation）/ 四向 Handle /
 * 折叠角标 / pinned 指示。
 */

const PAD_Y = 14;

interface BlockShellProps {
  block: BlockNode;
  selected: boolean;
  /** 静态（非编辑）内容渲染。 */
  renderStatic: () => ReactNode;
  /** 额外 chrome 类名（便签暖色底 / 分组视觉底色等）。 */
  shellClassName?: string;
  contentClassName?: string;
  /** 图片块：四角等比缩放。 */
  keepAspectRatio?: boolean;
  /**
   * 自定义编辑 UI（P1 特殊块：公式/书签/附件/提醒）。
   * 提供后，双击进入编辑时渲染它而非 Tiptap（这些块不是富文本）。
   */
  renderEditor?: () => ReactNode;
}

/**
 * BlockShellSkeleton —— 离屏块的轻量占位壳（Wave8 渐进水化）。
 *
 * 首 commit 时 ReactFlow 会把全部节点挂载（视口尺寸未测得前不裁剪），若每个都挂
 * 完整 chrome（4 个 Handle / NodeResizer / ResizeObserver / 工具条 / generateHTML），
 * 10000 块就是十几秒长任务。未水合的离屏块只渲染这个零 hook（除纯 memo）的占位壳：
 * 同色外壳 + 纯文本摘要，保留外壳高度（h-full），不实例化 Tiptap、不跑 generateHTML。
 */
const BlockShellSkeleton = memo(function BlockShellSkeleton({ block }: { block: BlockNode }) {
  const text = useMemo(() => extractPlainText(block.content.data, 120), [block.content.data]);
  return (
    <div
      className="flex h-full w-full flex-col rounded-lg border text-sm shadow-sm"
      style={{
        background: block.style.bg ?? 'hsl(var(--node-bg))',
        borderColor: block.style.border ?? 'hsl(var(--node-border))',
      }}
    >
      <div className="min-h-6 flex-1 overflow-hidden px-3 py-3 leading-5 text-slate-400">
        <span className="line-clamp-2">{text || '…'}</span>
      </div>
    </div>
  );
});

/**
 * BlockShell —— ReactFlow 节点外壳入口。
 * 仅订阅「水合态 + 编辑态」两个细粒度切片；未水合且未编辑时直接渲染轻量骨架，
 * 视口邻近升级后才挂载完整 BlockShellFull（Handles/缩放/RO/工具条/完整静态 HTML）。
 */
export const BlockShell = memo(function BlockShell(props: BlockShellProps) {
  const hydrated = useIsHydrated(props.block.id);
  const editingNodeId = useEditingNodeId();
  const isEditing = editingNodeId === props.block.id;
  if (!hydrated && !isEditing) return <BlockShellSkeleton block={props.block} />;
  return <BlockShellFull {...props} />;});

const BlockShellFull = memo(function BlockShellFull({
  block,
  selected,
  renderStatic,
  shellClassName = '',
  contentClassName = '',
  keepAspectRatio = false,
  renderEditor,
}: BlockShellProps) {
  const api = useEditorApi();
  const editingNodeId = useEditingNodeId();
  const childCount = useChildCount(block.id);
  const isEditing = editingNodeId === block.id;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  // 斜杠菜单「图片」：隐藏文件选择器，选中后走统一压缩+OPFS 管线。
  const pickImageRef = useRef<HTMLInputElement>(null);
  // Wave20：斜杠「嵌入其他画布的块」目标选择器开关。
  const [embedPickerOpen, setEmbedPickerOpen] = useState(false);

  // 进入编辑：挂载真实 Tiptap Editor（特殊块提供 renderEditor 时跳过）
  useEffect(() => {
    if (!isEditing || renderEditor) return;
    let cancelled = false;
    let ed: Editor | null = null;
    // createBlockEditor 现可异步（代码块内容时懒加载 lowlight）；加载完再挂载。
    void createBlockEditor({
      content: block.content.data,
      autofocus: 'end',
      onUpdate: (json) => api.updateContent(block.id, json),
    }).then((editor) => {
      if (cancelled) {
        editor.destroy();
        return;
      }
      ed = editor;
      const dom = ed.view.dom;

      const onPaste = (ev: ClipboardEvent) => {
        const item = Array.from(ev.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'));
        if (item) {
          ev.preventDefault();
          ev.stopPropagation();
          const file = item.getAsFile();
          if (file) {
            // 统一管线：压缩 → OPFS（src 存 assetRef）→ 不可用降级 dataURL。
            void api.ingestImage(file, block.x + block.width + 48, block.y);
          }
        }
      };
      const onKey = (ev: KeyboardEvent) => {
        // IME 组词期按 Esc 只是关输入法候选窗，不得连带退出节点编辑。
        if (ev.isComposing || ev.keyCode === 229) return;
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          api.setEditingNode(null);
        }
      };
      dom.addEventListener('paste', onPaste, true);
      dom.addEventListener('keydown', onKey, true);
      setEditor(ed);
    });
    return () => {
      cancelled = true;
      ed?.destroy();
      setEditor(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, block.id, block.type]);

  // ResizeObserver：实测内容高度 → 上报派生尺寸（高度自动回流）
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const report = () => {
      api.setMeasuredSizes({ [block.id]: { height: Math.max(32, el.scrollHeight + PAD_Y * 2) } });
    };
    const ro = new ResizeObserver(report);
    ro.observe(el);
    // 不在这里同步 read el.scrollHeight：大文档首屏 N 个节点会各触发一次强制
    // reflow（O(N) 同步布局）。ResizeObserver 自身在 observe 后会异步回调一次，
    // 高度经 create-editor-api 的 rAF 合并批量上报，语义一致。
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block.id, isEditing]);

  const onSlashCommand = (cmd: SlashCommand) => {
    if (cmd.kind === 'inline' && editor) {
      const chain = editor.chain().focus();
      switch (cmd.action) {
        case 'bold':
          chain.toggleBold().run();
          break;
        case 'italic':
          chain.toggleItalic().run();
          break;
        case 'underline':
          chain.toggleUnderline().run();
          break;
        case 'highlight':
          chain.toggleHighlight().run();
          break;
        case 'link': {
          const url = window.prompt('链接地址', 'https://');
          if (url) chain.setLink({ href: url }).run();
          break;
        }
      }
    } else if (cmd.kind === 'block') {
      if (cmd.blockType === 'image') {
        // 斜杠插入图片：与粘贴/拖入共用 ingestImage 管线（选文件后压缩→OPFS）。
        api.setEditingNode(null);
        pickImageRef.current?.click();
        return;
      }
      api.setEditingNode(null);
      api.setBlockType(block.id, cmd.blockType);
    } else if (cmd.kind === 'embed-pick') {
      // Wave20：退出编辑态，弹跨画布目标选择器；选定后把本块改造成 doc-embed 嵌入块。
      api.setEditingNode(null);
      setEmbedPickerOpen(true);
    }
  };

  // 选定嵌入目标：host type 切 note，content.data 写入嵌入 payload（只存引用）。
  // 斜杠菜单「嵌入其他画布的块」与块内 `{{` 触发共用同一条插入路径，不另造 payload 结构。
  const applyEmbedTarget = (target: DocRefTarget) => {
    api.setBlockType(block.id, 'note');
    const payload: DocEmbedData = {
      kind: 'doc-embed',
      targetDocId: target.docId,
      targetNodeId: target.nodeId,
      titleSnapshot: target.nodeTitle,
    };
    api.updateContent(block.id, payload);
  };

  const onPickEmbed = (target: DocRefTarget) => {
    setEmbedPickerOpen(false);
    applyEmbedTarget(target);
  };

  // Wave22：块内 `{{` 浮层选定后——`{{query` 触发文本已由 DocEmbedTrigger 内部删除，
  // 先退出编辑态（斜杠路径在 onSlashCommand 里已退过），再走与斜杠完全相同的 payload 写入。
  const onPickEmbedFromBrace = (target: DocRefTarget) => {
    api.setEditingNode(null);
    applyEmbedTarget(target);
  };

  const shellStyle: React.CSSProperties = {
    background: block.style.bg ?? 'hsl(var(--node-bg))',
    borderColor: selected ? '#3b82f6' : block.style.border ?? 'hsl(var(--node-border))',
  };

  // Wave9 无障碍：块外壳可聚焦（键盘 Tab / Alt+方向键落到块上）。
  // 编辑中（Tiptap 接管焦点）tabIndex=-1，避免双层 Tab 停点。
  // role=article：画布是自由布局的 application，块不是 RF 托管的 tree widget，
  // 用 article + aria-label 描述内容比伪 tree/treeitem 更诚实（见 docs/wave9/a11y-keyboard.md）。
  const text = extractPlainText(block.content.data, 60);
  const ariaLabel = `${block.type === 'heading' ? '标题块' : block.type === 'todo' ? '待办块' : block.type === 'image' ? '图片块' : '块'}${text ? '：' + text : ''}`;

  return (
    <div
      className={`block-shell relative flex h-full w-full flex-col rounded-lg border text-[hsl(var(--node-text))] shadow-sm transition-shadow ${
        selected ? 'shadow-md ring-2 ring-blue-400/40' : ''
      } ${isEditing ? 'nodrag nowheel is-editing' : ''} ${shellClassName}`}
      style={shellStyle}
      role="article"
      aria-label={ariaLabel}
      tabIndex={isEditing ? -1 : 0}
      onFocus={() => {
        if (!isEditing) api.setSelection([block.id]);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!isEditing) api.setEditingNode(block.id);
      }}
      onMouseDown={(e) => {
        if (isEditing) e.stopPropagation();
      }}
    >
      {/* 缩放手柄：文字块只允许横向调宽；图片块四角等比 */}
      <NodeResizer
        isVisible={selected}
        minWidth={160}
        keepAspectRatio={keepAspectRatio}
        lineClassName="!bg-blue-400"
        onResize={(_, params) => {
          api.resizeNode(block.id, params.width, keepAspectRatio ? params.height : block.height);
        }}
      />

      {/* 四向 Handle：右/下出（source）、左/上入（target），均支持长按拖连 */}
      <ConnectHandles nodeId={block.id} />
      <TargetHandles nodeId={block.id} />

      {/* hover / 选中工具条 */}
      <NodeToolbar position={Position.Top} align="start" isVisible={selected} className="absolute -top-9 left-0">
        <BlockHoverToolbar block={block} childCount={childCount} />
      </NodeToolbar>

      {/* pinned 指示 */}
      {block.pinned && (
        <div className="absolute -right-1 -top-1 z-10 rounded-full bg-amber-400 px-1 text-[9px] text-white">
          钉
        </div>
      )}
      {/* 折叠角标 */}
      {childCount > 0 && (
        <button
          className="absolute -bottom-2 right-2 z-10 flex h-5 min-w-5 items-center justify-center rounded-full bg-slate-700 px-1 text-[10px] text-white"
          title={block.collapsed ? '展开子分支' : '折叠子分支'}
          onClick={(e) => {
            e.stopPropagation();
            api.toggleCollapse(block.id);
          }}
        >
          {childCount}
        </button>
      )}

      {/* 内容区 */}
      <div ref={bodyRef} className={`min-h-6 flex-1 overflow-hidden px-3 py-0 text-sm leading-5 ${contentClassName}`}>
        {isEditing && renderEditor ? (
          renderEditor()
        ) : isEditing && editor ? (
          <>
            {block.type === 'table' && <TableToolbar editor={editor} />}
            <div className="tiptap-content" data-nodeeditor>
              <EditorContent editor={editor} />
            </div>
            <SlashMenu editor={editor} onCommand={onSlashCommand} />
            <DocRefMention editor={editor} />
            <DocEmbedTrigger
              editor={editor}
              currentDoc={api.getState().doc}
              excludeNodeId={block.id}
              onPick={onPickEmbedFromBrace}
            />
          </>
        ) : (
          renderStatic()
        )}
      </div>
      <input
        ref={pickImageRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void api.ingestImage(f, block.x, block.y);
          e.target.value = '';
        }}
      />
      {embedPickerOpen && (
        <DocEmbedPicker
          currentDoc={api.getState().doc}
          onPick={onPickEmbed}
          onClose={() => setEmbedPickerOpen(false)}
        />
      )}
    </div>
  );
});

export type BlockShellNodeProps = NodeProps<AppNode>;
