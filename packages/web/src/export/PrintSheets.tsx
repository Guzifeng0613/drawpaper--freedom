import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  BlockNode,
  Edge,
  KBNoteDoc,
  PageSettings,
  PaginateResult,
} from '@drawpaper/core';
import { mmToPx, parseDocEmbedData } from '@drawpaper/core';
import { TiptapStatic } from './render/tiptap-static';
import { sheetSizePx, pageNumberLabel } from './layout-utils';
import { buildEdgePath } from '../editor/edges/edge-geometry';
import { useResolvedImageSrc } from '../editor/nodes/use-resolved-image';
import { renderEquation } from '../editor/tiptap/katex-html';
import { db } from '../storage/db';

/** 打印/PDF 里的图片节点：把 assetRef 解析成 objectURL 后渲染 <img>，
 *  使矢量打印（window.print）与位图（html-to-image）都能抓到 OPFS 图片。 */
function PrintNodeImage({ src, alt }: { src: string; alt?: string }) {
  const resolved = useResolvedImageSrc(src);
  if (!resolved) return null;
  return (
    <img
      src={resolved}
      alt={alt ?? ''}
      style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
      draggable={false}
    />
  );
}

/** 公式块导出渲染：KaTeX 已由 useExportModel 预加载；失败时降级为等宽源码，绝不空白。 */
function PrintEquationBlock({ source, gray }: { source: string; gray?: boolean }) {
  try {
    const html = renderEquation(source);
    return <div className="equation-html w-full py-1 text-center" dangerouslySetInnerHTML={{ __html: html }} />;
  } catch {
    // KaTeX 未加载（导出前预加载失败）：至少展示 LaTeX 源码，绝不空白。
    return (
      <div className="py-2 text-center font-mono text-xs" style={{ color: gray ? '#666' : '#475569' }}>
        {source}
      </div>
    );
  }
}

/** 续接标记圆圈半径（px）。 */
const MARKER_R = 9;

/**
 * Wave20 块嵌入的打印/PNG 渲染：离线解析目标 doc/block（Dexie 全局可读），
 * 顶部来源标题 caption + 目标正文静态渲染；目标已删 → 悬挂占位（不裂图/不报错）。
 */
function PrintEmbedBlock({ embed, gray }: { embed: NonNullable<ReturnType<typeof parseDocEmbedData>>; gray: boolean }) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ok'; docTitle: string; target: BlockNode }
    | { status: 'dangling' }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const doc = await db.docs.get(embed.targetDocId);
        const target = doc?.nodes.find((n) => n.id === embed.targetNodeId);
        if (cancelled) return;
        if (!doc || !target) setState({ status: 'dangling' });
        else setState({ status: 'ok', docTitle: doc.title || '未命名画布', target });
      } catch {
        if (!cancelled) setState({ status: 'dangling' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [embed.targetDocId, embed.targetNodeId]);

  const cap =
    state.status === 'ok'
      ? `嵌入自「${state.docTitle}」`
      : state.status === 'dangling'
        ? `嵌入自「${embed.titleSnapshot || '已删除的画布'}」· 原块已删除`
        : '嵌入加载中…';
  const capColor = gray ? '#555' : '#0284c7';

  return (
    <div className="flex h-full flex-col">
      <div className="mb-1 border-b border-sky-200 pb-0.5 text-[10px] italic" style={{ color: capColor }}>
        {cap}
      </div>
      {state.status === 'ok' ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          {(state.target.content.data as { type?: string })?.type === 'doc' ? (
            <TiptapStatic doc={state.target.content.data} gray={gray} />
          ) : null}
          {state.target.type === 'image' && state.target.image?.src ? (
            <PrintNodeImage src={state.target.image.src} alt={state.target.image.alt ?? ''} />
          ) : null}
        </div>
      ) : (
        <div className="rounded border border-dashed border-slate-300 p-2 text-[10px] text-slate-400">
          {state.status === 'dangling' ? '原块已删除 / 不可用' : ''}
        </div>
      )}
    </div>
  );
}
/** 边标签与标记圆圈中心的安全距离（圆圈半径 + 标签半高 + 间隙）。 */
const LABEL_SAFE_R = 20;

/**
 * 计算边自由标签的落点：贝塞尔中点为基准，沿「推离标记圆圈」方向平移，
 * 避免长标签压住续接标记圆圈/数字；迭代 2~3 次稳定。
 */
function placeEdgeLabel(
  mx: number,
  my: number,
  markers: ReadonlyArray<{ x: number; y: number }>,
): { x: number; y: number } {
  let lx = mx;
  let ly = my - 6;
  for (let iter = 0; iter < 3; iter++) {
    for (const m of markers) {
      const dx = lx - m.x;
      const dy = ly - m.y;
      const d = Math.hypot(dx, dy);
      if (d < LABEL_SAFE_R && d > 1e-6) {
        const push = LABEL_SAFE_R - d;
        lx += (dx / d) * push;
        ly += (dy / d) * push;
      }
    }
  }
  return { x: lx, y: ly };
}

/**
 * 离屏打印容器（body 下 portal）。
 * - 屏幕上 display:none；打印时 body 加 .drawpaper-printing 后可见（见 index.css）。
 * - 每页一个严格 A4 比例 .sheet；节点按 worldRect 偏移绝对定位；边用 SVG 绘制。
 * - 孤块黄色角标；跨页续接标记画同编号小圆圈；折叠子树不出现（core 已剔除）。
 */
export interface PrintSheetsProps {
  result: PaginateResult;
  doc: KBNoteDoc;
  settings: PageSettings;
  edgeLabelsVisible: boolean;
}

export function PrintSheets({ result, doc, settings, edgeLabelsVisible }: PrintSheetsProps) {
  const sheet = sheetSizePx(settings.orientation);
  const margin = mmToPx(settings.marginMm);
  const gray = settings.colorMode === 'gray';
  const nodeById = new Map<string, BlockNode>(doc.nodes.map((n) => [n.id, n]));
  const edgeById = new Map<string, Edge>(doc.edges.map((e) => [e.id, e]));
  const orphanIds = new Set(result.orphans.map((o) => o.nodeId));

  // 成对续接标记编号：按 token 首次出现顺序分配 1..N（两页共享同一编号）。
  // 圆圈内只显示短数字，不再塞整条 edgeId，避免溢出压住旁边的边标签。
  const tokenToNumber = new Map<string, number>();
  for (const p of result.pages) {
    for (const c of p.continuations) {
      if (!tokenToNumber.has(c.token)) tokenToNumber.set(c.token, tokenToNumber.size + 1);
    }
  }

  return createPortal(
    <div className={gray ? 'drawpaper-print-container tp-gray' : 'drawpaper-print-container'}>
      {result.pages.map((page) => {
        const scale = page.scale || 1;
        // 节点在本页的「绘制矩形」（page-local px，已含 core 的 clamp/居中/缩放）。
        // core 的 nodeDrawOffsets 是唯一真相；缺省时回退到 worldRect 折算。
        const drawnRect = (n: BlockNode): { x: number; y: number; w: number; h: number } => {
          const off = page.nodeDrawOffsets?.[n.id];
          if (off) return { x: off.x, y: off.y, w: n.width * scale, h: n.height * scale };
          return {
            x: margin + (n.x - page.worldRect.x) * scale,
            y: margin + (n.y - page.worldRect.y) * scale,
            w: n.width * scale,
            h: n.height * scale,
          };
        };
        return (
          <div
            key={page.index}
            data-page={page.index}
            className="sheet relative bg-white"
            style={{
              width: sheet.width,
              height: sheet.height,
              pageBreakAfter: 'always',
            }}
          >
            {/* 页眉 */}
            {settings.header ? (
              <div
                className="absolute text-xs text-muted-foreground"
                style={{ left: margin, top: margin / 2, right: margin }}
              >
                {doc.title}
              </div>
            ) : null}

            {/* 内容区（世界 → 内容区左上角） */}
            {settings.mode === 'flow' ? (
              <div className="flow-content absolute" style={{ left: margin, top: margin, right: margin, bottom: margin }}>
                {page.nodeIds.map((id) => {
                  const n = nodeById.get(id);
                  if (!n) return null;
                  const emb = parseDocEmbedData(n.content.data);
                  const eqSource = n.type === 'equation'
                    ? (n.content.data as { source?: string } | undefined)?.source ?? ''
                    : null;
                  return (
                    <div key={id} data-node-id={id} className="mb-3 rounded border p-2">
                      {emb ? (
                        <PrintEmbedBlock embed={emb} gray={gray} />
                      ) : eqSource !== null ? (
                        eqSource ? <PrintEquationBlock source={eqSource} gray={gray} /> : null
                      ) : (
                        <TiptapStatic doc={n.content.data} gray={gray} />
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <>
                {/* 节点 */}
                {page.nodeIds.map((id) => {
                  const n = nodeById.get(id);
                  if (!n) return null;
                  const rect = drawnRect(n);
                  return (
                    <div
                      key={id}
                      data-node-id={id}
                      className="absolute rounded border bg-white p-2"
                      style={{
                        left: rect.x,
                        top: rect.y,
                        width: rect.w,
                        minHeight: rect.h,
                      }}
                    >
                      {(() => {
                        const emb = parseDocEmbedData(n.content.data);
                        if (emb) return <PrintEmbedBlock embed={emb} gray={gray} />;
                        if (n.type === 'equation') {
                          const src = (n.content.data as { source?: string } | undefined)?.source ?? '';
                          return src ? <PrintEquationBlock source={src} gray={gray} /> : null;
                        }
                        return (
                          <>
                            <TiptapStatic doc={n.content.data} gray={gray} />
                            {n.image?.src ? (
                              <div style={{ width: '100%', height: rect.h }}>
                                <PrintNodeImage src={n.image.src} alt={n.image.alt ?? ''} />
                              </div>
                            ) : null}
                          </>
                        );
                      })()}
                      {orphanIds.has(id) ? (
                        <span
                          data-orphan-badge
                          className="absolute -right-1 -top-1 rounded bg-amber-400 px-1 text-[9px] text-amber-900"
                        >
                          孤
                        </span>
                      ) : null}
                    </div>
                  );
                })}

                {/* 边（每页内 SVG） */}
                <svg
                  className="pointer-events-none absolute"
                  style={{ left: 0, top: 0, width: sheet.width, height: sheet.height }}
                >
                  <defs>
                    <marker
                      id={`arrow-${page.index}`}
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="7"
                      markerHeight="7"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 0 L 10 5 L 0 10 z" fill={gray ? '#333' : '#94A3B8'} />
                    </marker>
                  </defs>
                  {(() => {
                    const markers = page.continuations.map((c) => ({ x: c.x, y: c.y }));
                    return page.edgeIds.map((eid) => {
                      const e = edgeById.get(eid);
                      const s = e && nodeById.get(e.source);
                      const t = e && nodeById.get(e.target);
                      if (!e || !s || !t) return null;
                      const sr = drawnRect(s);
                      const tr = drawnRect(t);
                      const x1 = sr.x + sr.w;
                      const y1 = sr.y + sr.h / 2;
                      const x2 = tr.x;
                      const y2 = tr.y + tr.h / 2;
                      // 世界坐标弯折点 → 页本地（按 source 节点换算）
                      const delta = { x: sr.x - s.x, y: sr.y - s.y };
                      const localPoints = (e.points ?? []).map((p) => ({ x: p.x + delta.x, y: p.y + delta.y }));
                      const color = gray ? '#333' : e.style.color;
                      const anchor = edgeLabelsVisible && e.label
                        ? placeEdgeLabel((x1 + x2) / 2, (y1 + y2) / 2, markers)
                        : null;
                      return (
                        <g key={eid}>
                          <path
                            d={buildEdgePath(
                              { x: x1, y: y1, position: 'right' },
                              { x: x2, y: y2, position: 'left' },
                              localPoints,
                            )}
                            fill="none"
                            stroke={color}
                            strokeWidth={1.5}
                            markerEnd={`url(#arrow-${page.index})`}
                          />
                          {anchor ? (
                            <text
                              x={anchor.x}
                              y={anchor.y}
                              fontSize={9}
                              fill={gray ? '#111827' : '#334155'}
                              textAnchor="middle"
                              stroke="#ffffff"
                              strokeWidth={3}
                              paintOrder="stroke"
                            >
                              {e.label}
                            </text>
                          ) : null}
                        </g>
                      );
                    });
                  })()}

                  {/* 跨页续接标记：同编号小圆圈 + 沿切线方向的小箭头 */}
                  {page.continuations.map((c) => {
                    // 边在该续接点的前进方向（页面本地坐标）。
                    const dx = Math.cos(c.angle);
                    const dy = Math.sin(c.angle);
                    // 箭头尖在圆外缘朝外/朝内（out 沿前进方向出页；in 沿前进方向入页朝目标节点）。
                    const tipR = MARKER_R + 3;
                    const baseR = MARKER_R - 2;
                    const tipX = c.x + dx * tipR;
                    const tipY = c.y + dy * tipR;
                    const px = -dy;
                    const py = dx;
                    const halfW = 3.5;
                    const b1x = c.x + dx * baseR + px * halfW;
                    const b1y = c.y + dy * baseR + py * halfW;
                    const b2x = c.x + dx * baseR - px * halfW;
                    const b2y = c.y + dy * baseR - py * halfW;
                    const arrowColor = gray ? '#333' : '#0ea5e9';
                    return (
                      <g
                        key={c.token + c.pageIndex}
                        data-continuation={c.token}
                        data-role={c.role}
                        data-angle={c.angle.toFixed(4)}
                        data-peer-page={c.peerPageIndex}
                      >
                        <path
                          d={`M ${tipX} ${tipY} L ${b1x} ${b1y} L ${b2x} ${b2y} Z`}
                          fill={arrowColor}
                        />
                        <circle
                          cx={c.x}
                          cy={c.y}
                          r={MARKER_R}
                          fill="#fff"
                          stroke={arrowColor}
                          strokeWidth={1.5}
                        />
                        <text
                          x={c.x}
                          y={c.y + 3}
                          fontSize={8}
                          textAnchor="middle"
                          fill={arrowColor}
                        >
                          {tokenToNumber.get(c.token) ?? ''}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </>
            )}

            {/* 页脚 */}
            {settings.footer ? (
              <div
                className="absolute flex items-center justify-between text-xs text-muted-foreground"
                style={{ left: margin, right: margin, bottom: margin / 2 }}
              >
                <span>{settings.header ? '' : doc.title}</span>
                {settings.showPageNumbers ? <span>{pageNumberLabel(page.index, result.totalPages)}</span> : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
