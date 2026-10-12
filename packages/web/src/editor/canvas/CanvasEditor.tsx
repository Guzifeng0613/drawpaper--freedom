import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  MarkerType,
  useReactFlow,
  type Connection,
  type IsValidConnection,
  type NodeChange,
  type EdgeChange,
  type Edge,
} from '@xyflow/react';
import type { BlockNode, Edge as CoreEdge } from '@drawpaper/core';
import type { EditorApi } from '../editor-api';
import { EditorApiContext, useEditorSnapshot } from './editor-context';
import { useHydrationScheduler } from './use-hydration-scheduler';
import { applyHydrationDelta } from './hydration-store';
import { nodeTypes, resolveNodeType } from '../nodes';
import { edgeTypes } from '../edges';
import { useKeyboardShortcuts } from '../state/useKeyboardShortcuts';
import { registerViewActionHandler } from '../state/view-bus';
import { mark } from '@/wiring/cold-starts';
import { useCoarsePointer } from '../state/use-coarse-pointer';
import { useSoftKeyboardInset } from '../state/use-soft-keyboard-inset';
import { computeSnap } from '../lib/geometry';
import { collectFocusSet, collectConnectedSet, collectEdgeChain, applyManualFixed } from '../lib/graph-trace';
import { classifyFile, dropOffset } from './drop-classify';
import { isOpfsAvailable } from '@/storage/opfs';
import { nodeMatchesFilter } from '../lib/filter-match';
import { insertBendPoint, type EdgeEnd } from '../edges/edge-geometry';
import { ConflictDialog } from '../ui/ConflictDialog';
import { ConnectTargetPicker } from '../connect/ConnectTargetPicker';
import { toast } from '../ui/toast';
import { setActiveBendAnchor } from '../edges/bend-active';
import { PaneContextMenu, type PaneContextMenuProps } from './PaneContextMenu';
import { MousePointer2, Spline, Hand } from 'lucide-react';
import { useUiShell } from '@/store/ui-shell-store';
import { cn } from '@/lib/utils';

/** 折叠节点的后代集合（折叠后映射给 React Flow 时剔除）。 */
function hiddenAfterCollapse(doc: { nodes: BlockNode[]; edges: CoreEdge[] }): Set<string> {
  const children = new Map<string, string[]>();
  for (const e of doc.edges) {
    children.set(e.source, [...(children.get(e.source) ?? []), e.target]);
  }
  const hidden = new Set<string>();
  for (const n of doc.nodes) {
    if (!n.collapsed) continue;
    const stack = [...(children.get(n.id) ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      if (hidden.has(id)) continue;
      hidden.add(id);
      stack.push(...(children.get(id) ?? []));
    }
  }
  return hidden;
}

/** 一键整理幽灵节点（半透明 ghost 矩形，不动真节点）。 */
const LayoutGhostNode = memo(function LayoutGhostNode() {
  return (
    <div className="absolute inset-0 rounded-lg border-2 border-dashed border-blue-400 bg-blue-300/20" />
  );
});

const allNodeTypes = { ...nodeTypes, 'layout-ghost': LayoutGhostNode };

// ── 大规模画布渲染预算（Wave21 标定）────────────────────────
//  所有阈值按「2k 块日常流畅 / 10k 块不崩」标定，见 docs/wave21/large-doc-perf.md。

/**
 * MiniMap 节点数硬上限：超过则不挂载 MiniMap 组件。
 *
 * MiniMap 为每个节点渲染一个独立 SVG `<circle>` 元素；300 节点 ≈ 300 SVG DOM
 * 挂载成本可忽略（<5ms），但 2000+ 节点时 MiniMap 自身的每次 zoom/pan 重渲染
 * 会成为主线程瓶颈（全量 diff 2000 SVG 元素）。
 *
 * 标定依据：
 *  - ≤300 节点：MiniMap 全开（pannable + zoomable），渲染 ~300 SVG 元素 < 10ms；
 *  - 301–2000 节点：MiniMap 关闭，用户用右下角自建缩放控件导航（无 SVG 开销）；
 *  - ≥2000 节点：同 301–2000 策略，MiniMap 关闭。
 *
 * 为什么不做「节点抽样缩略」：MiniMap 的价值是全局位置感知，抽样后缩略图与
 * 实际节点密度不符反而误导；直接关闭 + 提供缩放控件更诚实。
 */
const MINIMAP_NODE_LIMIT = 300;

/**
 * 边渲染无额外抽样：ReactFlow 的 `onlyRenderVisibleElements` 已按视口裁剪
 * 屏幕外边（只渲染与可见节点相连的边），无需应用层再做几何抽样。
 * 实测 2000 节点（~1999 边）下，视口内可见边通常 < 50 条，BaseEdge 成本可忽略。
 * 若未来开启 MiniMap edgeColor，需另加 MINIMAP_EDGE_LIMIT 同类阈值。
 */

function CanvasInner({ api }: { api: EditorApi }) {
  const snap = useEditorSnapshot();
  const rf = useReactFlow();
  useKeyboardShortcuts(api);

  const [selectedEdgeIds, setSelectedEdgeIds] = useState<Set<string>>(new Set());
  const [guideLines, setGuideLines] = useState<{ orientation: 'vertical' | 'horizontal'; pos: number }[]>([]);
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);
  const [hoverEdgeId, setHoverEdgeId] = useState<string | null>(null);
  const rafRef = useRef<number>(0);
  const coarse = useCoarsePointer();
  // Wave31 Phase B：触屏软键盘弹起时画布容器补底部安全 padding，编辑块留在键盘上方。
  const keyboardBottom = useSoftKeyboardInset();
  const docsCollapsed = useUiShell((st) => st.docsCollapsed);
  const [dragOver, setDragOver] = useState(false);
  // 【Wave14 D】空白处上下文菜单：鼠标右键 / 触屏长按共用这一个受控菜单。
  const [menu, setMenu] = useState<{ x: number; y: number; flowX: number; flowY: number } | null>(null);

  // 桌面端文件拖入画布建块（§P2）
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (!files.length) return;
    const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      const kind = classifyFile(f.name, f.type);
      const dx = dropOffset(i).dx;
      const dy = dropOffset(i).dy;
      try {
        if (kind === 'text') {
          const text = await f.text();
          const lines = text.split(/\r?\n/);
          const doc = {
            type: 'doc',
            content: lines.map((l) => ({ type: 'paragraph', content: l ? [{ type: 'text', text: l }] : [] })),
          };
          const id = api.addNode('text', pos.x + dx, pos.y + dy);
          api.updateContent(id, doc);
        } else if (kind === 'image') {
          // 统一管线：压缩 → OPFS（src 存 assetRef）→ 不可用降级 dataURL。
          await api.ingestImage(f, pos.x + dx, pos.y + dy);
        } else if (kind === 'attachment') {
          // OPFS 不可用（非安全上下文/旧浏览器/隐私模式）：附件无内联降级契约，
          // 直接 toast 且不建块、不落盘，避免产生引用空 assetRef 的坏附件块。
          // 两种不可用形态：
          //  (A) 能力检测直接 false（navigator.storage 不存在）→ 提前 toast；
          //  (B) getDirectory 存在但运行时抛 NotAllowedError（隐私模式）→
          //      putImageAsset 内部兜底返回 data: URL（wiring 层降级），
          //      这里识别 data: 前缀 = OPFS 落盘失败 → 同样 toast 不建块。
          if (!isOpfsAvailable() || !api.putImageAsset) {
            toast('当前浏览器不支持附件本地存储（OPFS 不可用），请改用图片或文本');
            continue;
          }
          const r = await api.putImageAsset(f);
          if (r.assetRef.startsWith('data:')) {
            toast('当前浏览器不支持附件本地存储（OPFS 不可用），请改用图片或文本');
            continue;
          }
        }
        // unsupported：不建块
      } catch {
        toast(`「${f.name}」导入失败`);
      }
    }
  };

  // 折叠过滤
  const hidden = useMemo(() => hiddenAfterCollapse(snap.doc), [snap.doc]);

  // P1 高亮/降透明度集合：悬停逻辑链优先，否则聚焦分支，再否则标签筛选。
  const dimSet = useMemo<Set<string> | null>(() => {
    // 1) 悬停一条边/节点 → 高亮整条连通逻辑链，其余降透明
    if (hoverEdgeId) return collectEdgeChain(snap.doc.edges, hoverEdgeId);
    if (hoverNodeId) return collectConnectedSet(snap.doc.edges, hoverNodeId);
    // 2) 聚焦分支：非「祖先链+子树」降透明
    if (snap.focusNodeId) return collectFocusSet(snap.doc.edges, snap.focusNodeId);
    // 3) 标签筛选：非命中节点降透明（空筛选 = 不筛）
    const filter = snap.tagFilter;
    if (filter && filter.tagIds.length) {
      const set = new Set<string>();
      for (const n of snap.doc.nodes) {
        if (nodeMatchesFilter(n.tags, filter)) set.add(n.id);
      }
      return set;
    }
    return null;
  }, [snap.doc, snap.focusNodeId, snap.tagFilter, hoverNodeId, hoverEdgeId]);

  // 真节点 → RF nodes
  const rfNodes = useMemo(() => {
    const real = snap.doc.nodes
      .filter((n) => !hidden.has(n.id))
      .map((n) => ({
        id: n.id,
        type: resolveNodeType(n.type),
        position: { x: n.x, y: n.y },
        data: { block: n },
        selected: snap.selection.has(n.id),
        width: n.width,
        height: n.height,
        style: dimSet ? { opacity: dimSet.has(n.id) ? 1 : 0.2 } : undefined,
      }));
    // 一键整理预览 ghost（叠加在世界坐标上）；manualFixed（手动移动过）不画 ghost
    const ghosts = Object.entries(applyManualFixed(snap.layoutPreview ?? {}, snap.manualFixed ?? new Set()))
      .map(([id, g]) => ({
        id: `ghost:${id}`,
        type: 'layout-ghost',
        position: { x: g.x, y: g.y },
        data: {},
        width: g.width,
        height: g.height,
      }));
    return [...real, ...ghosts];
  }, [snap.doc, snap.selection, hidden, snap.layoutPreview, snap.manualFixed, dimSet]);

  // 真边 → RF edges
  const rfEdges = useMemo(() => {
    return snap.doc.edges
      .filter((e) => !hidden.has(e.source) && !hidden.has(e.target))
      .map((e) => {
        // 高亮集合内的边才不透明；两端都在集合内才算「逻辑链上的边」
        const onChain = dimSet ? dimSet.has(e.source) && dimSet.has(e.target) : true;
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle,
          targetHandle: e.targetHandle,
          sourcePosition: e.sourceHandle,
          targetPosition: e.targetHandle,
          type: 'parent',
          selected: selectedEdgeIds.has(e.id),
          label: e.label,
          data: { dimmed: !onChain, points: e.points },
          style: { stroke: e.style.color, opacity: onChain ? 1 : 0.15 },
          markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: e.style.color },
        };
      });
  }, [snap.doc, hidden, selectedEdgeIds, dimSet]);

  // 飞块：搜索/大纲/Alt+方向键 lastFocus → setCenter + 高亮 + 键盘焦点落到块 DOM。
  // Wave9：离屏 Skeleton 先强制水合再居中；reduced-motion 时相机动画即时。
  useEffect(() => {
    const f = snap.lastFocus;
    if (!f) return;
    const n = snap.doc.nodes.find((x) => x.id === f.nodeId);
    if (!n) return;
    // 强制水合（视口调度器可能还没轮到离屏块）。
    applyHydrationDelta([n.id], []);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    rf.setCenter(n.x + n.width / 2, n.y + n.height / 2, {
      zoom: Math.max(rf.getZoom(), 0.8),
      duration: reduce ? 0 : 300,
    });
    // 两帧后 RF 已提交挂载，把键盘焦点落到块外壳（:focus-visible 环出现）。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(
          `.react-flow__node[data-id="${CSS.escape(n.id)}"] .block-shell`,
        );
        el?.focus({ preventScroll: true });
      });
    });
  }, [snap.lastFocus]); // eslint-disable-line react-hooks/exhaustive-deps

  // 一键整理落位后：ghost 消失（应用/取消）时 fitView 让布局结果进入视野。
  const wasPreviewing = useRef(false);
  useEffect(() => {
    const previewing = !!snap.layoutPreview;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (wasPreviewing.current && !previewing) {
      // 等 250ms 落位动画结束再 fit。
      timer = setTimeout(() => rf.fitView({ padding: 0.2, duration: 300 }), 280);
    }
    wasPreviewing.current = previewing;
    return () => {
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.layoutPreview]);

  // 宏撤销（一键整理 confirm-layout / 对齐 / 裁决删边等全局位移）后回位相机：
  // 节点可能被 onlyRenderVisibleElements 卸载导致视野空，fitView 让结果重新入画。
  const lastHistoryNonce = useRef(0);
  useEffect(() => {
    const h = snap.historyEvent;
    if (!h || h.nonce === lastHistoryNonce.current) return;
    lastHistoryNonce.current = h.nonce;
    // 仅对全局位移类宏回位；单块增删/打字不跳相机。
    const macroNames = ['confirm-layout', 'align-selection', 'distribute-selection', 'resolve-conflicts'];
    if (h.kind === 'undo' && macroNames.includes(h.name)) {
      const timer = setTimeout(() => rf.fitView({ padding: 0.2, duration: 300 }), 60);
      return () => clearTimeout(timer);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.historyEvent]);

  // Wave14：原生「视图」菜单（适应屏幕/放大/缩小）转发到同一批 rf 动作——
  // 与工具栏按钮、Ctrl+0/Ctrl+=/Ctrl+- 快捷键同一个入口，不新写缩放算法。
  useEffect(() => {
    registerViewActionHandler((action) => {
      if (action === 'fit') rf.fitView({ duration: 200 });
      else if (action === 'zoom-in') void rf.zoomIn();
      else void rf.zoomOut();
    });
    return () => registerViewActionHandler(null);
  }, [rf]);

  // ---- 连接校验 ----
  const isValidConnection: IsValidConnection = (conn) => {
    if (conn.source && conn.target && conn.source === conn.target) return false;
    return true;
  };

  const onConnect = (conn: Connection) => {
    if (!conn.source || !conn.target) return;
    if (conn.source === conn.target) {
      toast('不能自己连自己');
      return;
    }
    const dup = snap.doc.edges.find((e) => e.source === conn.source && e.target === conn.target);
    if (dup) {
      setSelectedEdgeIds(new Set([dup.id]));
      toast('该父子关系已存在，已选中');
      return;
    }
    api.addEdge(conn.source, conn.target, {
      sourceHandle: (conn.sourceHandle as CoreEdge['sourceHandle']) ?? undefined,
      targetHandle: (conn.targetHandle as CoreEdge['targetHandle']) ?? undefined,
    });
  };

  const onConnectEnd = (event: MouseEvent | TouchEvent, connectionState: { fromNode?: { id: string } | null } | null) => {
    if (!connectionState?.fromNode) return;
    // 松手到空白：在松手坐标建新块并自动连父子边（串联爽点）
    const pos = rf.screenToFlowPosition({
      x: (event as MouseEvent).clientX,
      y: (event as MouseEvent).clientY,
    });
    const newId = api.addNode('text', pos.x - 110, pos.y - 30);
    api.addEdge(connectionState.fromNode.id, newId);
  };

  // ---- 节点变更（拖拽 / 选择）----
  const onNodesChange = (changes: NodeChange[]) => {
    for (const ch of changes) {
      if (ch.type === 'position' && ch.position && !ch.dragging) {
        api.moveNode(ch.id, ch.position.x, ch.position.y);
      } else if (ch.type === 'position' && ch.position && ch.dragging) {
        // 拖拽中：磁吸 + 参考线
        const others = snap.doc.nodes
          .filter((n) => n.id !== ch.id && !snap.selection.has(n.id))
          .map((n) => ({ id: n.id, x: n.x, y: n.y, width: n.width, height: n.height }));
        const moving = {
          x: ch.position.x,
          y: ch.position.y,
          width: snap.doc.nodes.find((n) => n.id === ch.id)?.width ?? 200,
          height: snap.doc.nodes.find((n) => n.id === ch.id)?.height ?? 60,
        };
        const snapRes = computeSnap(moving, others, { gridSnap: snap.prefs.gridSnap });
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => setGuideLines(snapRes.lines));
        api.moveNode(ch.id, ch.position.x + snapRes.dx, ch.position.y + snapRes.dy);
      } else if (ch.type === 'select') {
        const next = new Set(snap.selection);
        if (ch.selected) next.add(ch.id);
        else next.delete(ch.id);
        api.setSelection(next);
      }
    }
  };

  const onEdgesChange = (changes: EdgeChange[]) => {
    for (const ch of changes) {
      if (ch.type === 'select') {
        setSelectedEdgeIds((prev) => {
          const next = new Set(prev);
          if (ch.selected) next.add(ch.id);
          else next.delete(ch.id);
          return next;
        });
      }
    }
  };

  // RF 原生 deleteKeyCode（Delete/Backspace）在用户删边时回调；落库到 store。
  // 仅在「未选中锚点、未选中块」时走到这里（全局快捷键已先拦截这两种情形）。
  const onEdgesDelete = (edges: Edge[]) => {
    for (const e of edges) api.deleteEdge(e.id);
    setSelectedEdgeIds((prev) => {
      const next = new Set(prev);
      for (const e of edges) next.delete(e.id);
      return next;
    });
  };

  // 【P2.1】双击边路径在光标世界坐标处插入弯折点：见下方 wrap dblclick 原生监听。

  const mode = snap.mode;
  const selectionOnDrag = mode === 'select';
  const panOnDrag = mode === 'pan' ? true : [1, 2];

  // RF v22 不把 onDoubleClick/onContextMenu 透传到 pane；改用包装 div 上的原生监听。
  const wrapRef = useRef<HTMLDivElement>(null);
  const [paneEl, setPaneEl] = useState<HTMLElement | null>(null);

  // 【Wave8】大规模文档渐进水化：视口邻近升级/远离降级 + 分批调度。
  useHydrationScheduler(api, snap.doc, snap.viewport, paneEl);

  // Wave24 路 3：首画布首帧 = 挂载后双 rAF（浏览器已完成首次绘制）。
  // StrictMode 双跑：cleanup 取消首帧未燃的 rAF，二次 effect 重新武装，最终只落一个 mark。
  const coldFrameRef = useRef(false);
  useEffect(() => {
    if (coldFrameRef.current) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        coldFrameRef.current = true;
        mark('canvas-frame');
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onDbl = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // 【P2.1】双击边路径（非锚点）：在光标世界坐标处插入弯折点。
      // 锚点手柄在 EdgeLabelRenderer HTML 浮层里，不在 .react-flow__edge SVG 组内，天然不冲突。
      const edgeG = target.closest('.react-flow__edge') as HTMLElement | null;
      if (edgeG) {
        const edgeId = edgeG.getAttribute('data-id') ?? edgeG.getAttribute('data-edgeid');
        const cur = api.getState().doc;
        const docEdge = edgeId ? cur.edges.find((ed) => ed.id === edgeId) : undefined;
        if (!docEdge) return;
        const sNode = cur.nodes.find((n) => n.id === docEdge.source);
        const tNode = cur.nodes.find((n) => n.id === docEdge.target);
        if (!sNode || !tNode) return;
        const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
        const s: EdgeEnd = { x: sNode.x + sNode.width, y: sNode.y + sNode.height / 2, position: 'right' };
        const t: EdgeEnd = { x: tNode.x, y: tNode.y + tNode.height / 2, position: 'left' };
        api.setEdgePoints?.(docEdge.id, insertBendPoint(docEdge.points ?? [], pos, s, t));
        return;
      }
      if (!target.closest('.react-flow__pane')) return;
      if (target.closest('.react-flow__node')) return;
      const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const id = api.addNode('text', pos.x - 110, pos.y - 30);
      api.setEditingNode(id);
    };
    el.addEventListener('dblclick', onDbl, true);

    // 【Wave14 D】空白处上下文菜单：鼠标 contextmenu 与触屏 longpress 共用同一菜单。
    // target 判定与原 onCtx 一致：边浮层 / 节点 / 非 pane 不弹空白菜单。
    const isBlankPaneTarget = (target: EventTarget | null): boolean => {
      const t = target as HTMLElement | null;
      if (!t || !t.closest) return false;
      if (t.closest('.react-flow__node')) return false;
      if (t.closest('.react-flow__edgelabel-renderer')) return false;
      if (t.closest('.react-flow__edge')) return false;
      if (t.closest('[data-testid^="edge-bend"]')) return false;
      if (!t.closest('.react-flow__pane')) return false;
      return true;
    };

    const openPaneMenuAt = (clientX: number, clientY: number) => {
      const pos = rf.screenToFlowPosition({ x: clientX, y: clientY });
      setMenu({ x: clientX, y: clientY, flowX: pos.x, flowY: pos.y });
    };

    const onCtx = (e: MouseEvent) => {
      if (!isBlankPaneTarget(e.target)) return;
      e.preventDefault();
      openPaneMenuAt(e.clientX, e.clientY);
    };
    el.addEventListener('contextmenu', onCtx, true);

    // ---- 触屏长按空白 → 同一菜单（粗指针 PointerType=touch）----
    // 自包含手势：pointerdown(touch) 起 500ms 定时器；移动 >8px 取消（退化为平移）；
    // 静止到点且 target 为空白 pane → vibrate(15) + 弹菜单。与 ConnectHandle 同时序/同反馈。
    let lpTimer: ReturnType<typeof setTimeout> | null = null;
    let lpStart: { x: number; y: number; cx: number; cy: number } | null = null;
    let lpFired = false;
    const LONGPRESS_MS = 500;
    const MOVE_SLOP = 8;

    const cancelLongPress = () => {
      if (lpTimer) clearTimeout(lpTimer);
      lpTimer = null;
      lpStart = null;
    };

    const onLpDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      if (!isBlankPaneTarget(e.target)) return; // 块/连接点/边/浮层长按不归这里
      lpFired = false;
      lpStart = { x: e.clientX, y: e.clientY, cx: e.clientX, cy: e.clientY };
      lpTimer = setTimeout(() => {
        lpTimer = null;
        lpFired = true;
        if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(15);
        openPaneMenuAt(lpStart!.cx, lpStart!.cy);
      }, LONGPRESS_MS);
    };
    const onLpMove = (e: PointerEvent) => {
      if (!lpStart || lpFired) return;
      if (Math.hypot(e.clientX - lpStart.x, e.clientY - lpStart.y) > MOVE_SLOP) cancelLongPress();
    };
    const onLpUp = () => {
      // 长按后抬起：不触发平移/点击（菜单已开；RF 无位移不 pan）。
      cancelLongPress();
    };
    el.addEventListener('pointerdown', onLpDown, true);
    window.addEventListener('pointermove', onLpMove, { passive: true });
    window.addEventListener('pointerup', onLpUp, true);
    window.addEventListener('pointercancel', onLpUp, true);

    return () => {
      el.removeEventListener('dblclick', onDbl, true);
      el.removeEventListener('contextmenu', onCtx, true);
      cancelLongPress();
      el.removeEventListener('pointerdown', onLpDown, true);
      window.removeEventListener('pointermove', onLpMove);
      window.removeEventListener('pointerup', onLpUp, true);
      window.removeEventListener('pointercancel', onLpUp, true);
    };
  }, [api, rf, snap.doc.page.showPageBreak]);

  // 菜单项动作（鼠标右键 / 触屏长按共用）。
  const menuActions: Omit<PaneContextMenuProps, 'x' | 'y' | 'pageBreakMode'> | null = menu
    ? {
        onNewBlock: () => {
          const id = api.addNode('text', menu.flowX - 110, menu.flowY - 30);
          api.setEditingNode(id);
          setMenu(null);
        },
        onPaste: () => {
          api.paste();
          setMenu(null);
        },
        onFit: () => {
          rf.fitView({ duration: 200 });
          setMenu(null);
        },
        onInsertPageBreak: () => {
          api.addManualPageBreak('pb_' + Math.random().toString(36).slice(2, 8), menu.flowX, menu.flowY);
          setMenu(null);
        },
        onClose: () => setMenu(null),
      }
    : null;

  // Wave22（docs/wave9 §9 挂账）：React Flow Controls 四按钮补中文 aria-label。
  // RF v12 自带英文 aria-label（Zoom in / Zoom out / Fit view / Lock view），
  // 这里按按钮 class 覆写为中文；按钮随 ReactFlow 一次性挂载，MutationObserver
  // 兜底后续挂载（仅 childList 变化触发，不监听属性，不干扰交互锁定态切换）。
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const LABELS: Array<[RegExp, string]> = [
      [/controls-zoomin/, '放大'],
      [/controls-zoomout/, '缩小'],
      [/controls-fitview/, '适应视图'],
      [/controls-interactive/, '锁定视口'],
    ];
    const applyLabels = () => {
      el.querySelectorAll<HTMLButtonElement>('.react-flow__controls-button').forEach((b) => {
        const hit = LABELS.find(([re]) => re.test(b.className));
        if (hit) b.setAttribute('aria-label', hit[1]);
      });
    };
    applyLabels();
    const mo = new MutationObserver(applyLabels);
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);

  return (
    <div
      className={`relative h-full w-full ${dragOver ? 'ring-2 ring-inset ring-blue-400' : ''}`}
      style={{ paddingBottom: keyboardBottom }}
      role="application"
      aria-label="画布"
      ref={(el) => {
        (wrapRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
        setPaneEl(el);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={allNodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onEdgesDelete={onEdgesDelete}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onPaneClick={(event) => {
          // 点在边浮层（弯折锚点/中点手柄/右键菜单/边色板）上时不清空激活锚点、
          // 也不清选择——否则锚点 pointerdown 刚登记的激活态会被随后的 pane click 清掉，
          // 且边被取消选中导致锚点手柄消失。
          const t = event.target as HTMLElement;
          const inEdgeOverlay = !!t.closest?.('[data-testid="edge-bend-anchor"], [data-testid="edge-bend-midpoint"], [data-testid="edge-clear-bends"]');
          if (inEdgeOverlay) return;
          setActiveBendAnchor(null);
          api.setSelection([]);
          if (snap.editingNodeId) api.setEditingNode(null);
        }}
        onNodeClick={(_, node) => {
          if (snap.editingNodeId && snap.editingNodeId !== node.id) api.setEditingNode(null);
        }}
        onNodeMouseEnter={(_, node) => setHoverNodeId(node.id)}
        onNodeMouseLeave={() => setHoverNodeId(null)}
        onEdgeMouseEnter={(_, edge) => setHoverEdgeId(edge.id)}
        onEdgeMouseLeave={() => setHoverEdgeId(null)}
        onMove={(_, vp) => api.setViewport(vp)}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        onlyRenderVisibleElements
        selectionOnDrag={selectionOnDrag}
        panOnDrag={panOnDrag}
        panOnScroll={false}
        zoomOnScroll
        zoomOnPinch
        proOptions={{ hideAttribution: false }}
        defaultViewport={snap.viewport}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="var(--editor-grid, #cbd5e1)" />
        <Controls
          position="bottom-left"
          className={cn(docsCollapsed ? 'ml-[72px]' : 'ml-[248px] max-sm:ml-[72px]')}
        />

        {/* 粗指针（触屏/手写笔）：显式工具按钮组（选择/连线/平移），≥44px 触控热区 */}
        {coarse && (
          <Panel position="top-left" className="flex gap-1 rounded-lg border bg-[hsl(var(--popover))]/90 text-[hsl(var(--popover-foreground))] p-1 shadow">
            <button
              className={`flex h-11 w-11 items-center justify-center rounded ${snap.mode === 'select' ? 'bg-blue-100 text-blue-600' : 'text-slate-500'}`}
              title="选择 (V)"
              aria-label="选择工具"
              aria-pressed={snap.mode === 'select'}
              onClick={() => api.setMode('select')}
            >
              <MousePointer2 size={20} />
            </button>
            <button
              className={`flex h-11 w-11 items-center justify-center rounded ${snap.mode === 'connect' ? 'bg-blue-100 text-blue-600' : 'text-slate-500'}`}
              title="连线 (C)"
              aria-label="连线工具"
              aria-pressed={snap.mode === 'connect'}
              onClick={() => api.setMode('connect')}
            >
              <Spline size={20} />
            </button>
            <button
              className={`flex h-11 w-11 items-center justify-center rounded ${snap.mode === 'pan' ? 'bg-blue-100 text-blue-600' : 'text-slate-500'}`}
              title="平移"
              aria-label="平移工具"
              aria-pressed={snap.mode === 'pan'}
              onClick={() => api.setMode('pan')}
            >
              <Hand size={20} />
            </button>
          </Panel>
        )}

        {snap.doc.nodes.length <= MINIMAP_NODE_LIMIT && (
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            bgColor="hsl(var(--canvas-bg))"
            maskColor="hsl(var(--background) / 0.7)"
            nodeColor={(n) => (n.type === 'layout-ghost' ? '#93c5fd' : 'hsl(var(--node-border))')}
          />
        )}

        {/* 对齐参考线 */}
        {guideLines.map((l, i) =>
          l.orientation === 'vertical' ? (
            <div key={i} className="pointer-events-none absolute top-0 bottom-0 w-px bg-blue-400" style={{ left: l.pos }} />
          ) : (
            <div key={i} className="pointer-events-none absolute left-0 right-0 h-px bg-blue-400" style={{ top: l.pos }} />
          ),
        )}

        {/* 右下角自建缩放控件（百分比 + 适应/100%） */}
        <Panel position="bottom-right" className={cn("mr-2 flex items-center gap-1 rounded border bg-[hsl(var(--popover))] text-[hsl(var(--popover-foreground))] px-1 py-0.5 text-[10px] shadow", snap.doc.nodes.length <= MINIMAP_NODE_LIMIT ? "!mb-[168px] max-sm:!mb-[180px]" : "!mb-2")}>
          <button className="px-1" title="缩小" onClick={() => rf.zoomOut()}>
            −
          </button>
          <button className="w-12 text-center" onClick={() => rf.fitView({ duration: 200 })} title="适应屏幕">
            {Math.round(snap.viewport.zoom * 100)}%
          </button>
          <button className="px-1" title="放大" onClick={() => rf.zoomIn()}>
            +
          </button>
          <button className="px-1" onClick={() => rf.setViewport({ x: snap.viewport.x, y: snap.viewport.y, zoom: 1 }, { duration: 200 })} title="实际大小">
            1:1
          </button>
        </Panel>
      </ReactFlow>

      <ConflictDialog />

      {/* Wave23 纯键盘连线目标选择器：确认时复用同一 onConnect 校验（自环/重复边/addEdge）。 */}
      <ConnectTargetPicker
        onConfirm={(source, target) =>
          onConnect({ source, target, sourceHandle: 'right', targetHandle: 'left' } as Connection)
        }
      />

      {menu && menuActions && (
        <PaneContextMenu
          x={menu.x}
          y={menu.y}
          pageBreakMode={snap.doc.page.showPageBreak}
          {...menuActions}
        />
      )}
    </div>
  );
}

/**
 * CanvasEditor —— 画布编辑主组件（Wave1-D）。
 * 用法：<CanvasEditor api={createMockEditorApi()} />
 */
export function CanvasEditor({ api }: { api: EditorApi }) {
  return (
    <EditorApiContext.Provider value={api}>
      <ReactFlowProvider>
        <CanvasInner api={api} />
      </ReactFlowProvider>
    </EditorApiContext.Provider>
  );
}
