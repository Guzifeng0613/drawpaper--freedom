import type { KBNoteDoc, BlockNode, Edge } from '@drawpaper/core';
import type { PageSheet, PaginateResult } from '@drawpaper/core';
import { extractNodePlainText, parseDocEmbedData } from '@drawpaper/core';
import { pagePixelSize } from '@drawpaper/core';
import { buildEdgePath, type EdgeEnd } from '../editor/edges/edge-geometry';
import { assetRefToDataUri, isAssetRefSrc } from '../storage/opfs';
import { db } from '../storage/db';

/**
 * SVG 矢量导出：把每页序列化为独立 .svg（不引第三方依赖）。
 *  - 节点：<rect> + 纯文本（取块内纯文本前几行）；图片块内联 <image href="data:...">；
 *  - 边：三次贝塞尔 + 箭头 marker；
 *  - 续接标记：<circle> + token 编号；
 *  - 页眉/页脚文本。
 * 多页 = 多个 .svg 文件分别下载（不打 zip）。
 *
 * Wave7 P2.1：OPFS 图片以自包含 data: URI 内嵌进 SVG（导出前由 buildPagesSvgAsync
 * 把 assetRef 读成 data URI），离线 .svg 双击即可看到图。
 * Wave20：块嵌入节点按「来源标题 caption + 目标正文」静态渲染（embedInfo 由
 * buildPagesSvgAsync 从全量文档预解析；目标已删 → 悬挂占位行）。
 */

/** 一个嵌入节点的导出解析结果（caption + 正文行；dangling=目标已删）。 */
export interface SvgEmbedInfo {
  docTitle: string;
  lines: string[];
  dangling: boolean;
}

export interface SvgExportOptions {
  orientation: 'portrait' | 'landscape';
  gray?: boolean;
  /** nodeId → 自包含 data: URI（图片节点）。缺省时若 image.src 已是 data: 也能内联。 */
  imageHrefs?: Record<string, string>;
  /** embed 节点 id → 预解析的来源标题 + 正文行（buildPagesSvgAsync 填充）。 */
  embedInfo?: Record<string, SvgEmbedInfo>;
}

function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 提取块的纯文本（适配 Tiptap JSON 与非 Tiptap 块型的自定义 data 形状）。 */
function nodePlainText(node: BlockNode): string {
  // 非 Tiptap 块型：直接按已知 data 形状取文本。
  if (node.type === 'equation') {
    const d = node.content.data as { source?: string } | undefined;
    return d?.source ?? '';
  }
  if (node.type === 'bookmark') {
    const d = node.content.data as { url?: string; title?: string } | undefined;
    return d?.title ?? d?.url ?? '';
  }
  if (node.type === 'attachment') {
    const d = node.content.data as { name?: string } | undefined;
    return d?.name ?? '';
  }
  if (node.type === 'reminder') {
    const d = node.content.data as { note?: string; dueAt?: number } | undefined;
    return d?.note ?? '';
  }
  // 默认：Tiptap JSON 递归提取。
  return extractNodePlainText(node.content.data);
}

/** 把块内文本按行切成最多 `maxLines` 行（近似宽度，按字符数折行）。 */
function textLines(node: BlockNode, maxLines = 4, charsPerLine = 18): string[] {
  const text = nodePlainText(node);
  if (!text) return [];
  const lines: string[] = [];
  let rest = text;
  while (lines.length < maxLines && rest.length > 0) {
    lines.push(rest.slice(0, charsPerLine));
    rest = rest.slice(charsPerLine);
  }
  if (rest.length > 0) lines[lines.length - 1] = (lines[lines.length - 1] ?? '') + '…';
  return lines;
}

function nodeColor(node: BlockNode, gray?: boolean): { fill: string; stroke: string } {
  if (gray) return { fill: '#ffffff', stroke: '#999999' };
  if (node.type === 'note') return { fill: '#FEF9C3', stroke: '#EAB308' };
  if (node.type === 'group') return { fill: '#F1F5F9', stroke: '#94A3B8' };
  return { fill: '#ffffff', stroke: '#CBD5E1' };
}


function renderNode(node: BlockNode, offset: { x: number; y: number }, opts: SvgExportOptions): string {
  const { fill, stroke } = nodeColor(node, opts.gray);
  const w = node.width;
  const h = node.height;

  // Wave20 块嵌入：caption（来源标题）+ 目标正文行；悬挂则占位。
  const emb = parseDocEmbedData(node.content.data);
  if (emb) {
    const info = opts.embedInfo?.[node.id];
    const cap = `嵌入自「${info?.docTitle ?? (emb.titleSnapshot || '未知画布')}」`;
    const bodyLines = info?.dangling
      ? ['原块已删除 / 不可用']
      : (info?.lines ?? []).slice(0, 4);
    const capTspan = `<tspan x="${offset.x + 8}" y="${offset.y + 18}" font-style="italic" fill="#0284c7">${escXml(cap)}</tspan>`;
    const bodyTspans = bodyLines
      .map((l, i) => `<tspan x="${offset.x + 8}" y="${offset.y + 36 + i * 16}">${escXml(l)}</tspan>`)
      .join('');
    return `<g class="node" data-node-id="${escXml(node.id)}">` +
      `<rect x="${offset.x}" y="${offset.y}" width="${w}" height="${h}" rx="8" fill="#f0f9ff" stroke="#7dd3fc" stroke-width="1"/>` +
      `<text font-size="11">${capTspan}${bodyTspans}</text>` +
      `</g>`;
  }

  const lines = textLines(node);
  const tspans = lines
    .map((l, i) => `<tspan x="${offset.x + 8}" y="${offset.y + 20 + i * 16}">${escXml(l)}</tspan>`)
    .join('');

  // 图片块：内联 <image>。href 优先取预解析好的 data: URI（assetRef 已读出），
  // 否则若 src 本身就是 data:/blob: 直接用；assetRef 且未预解析则跳过（不写坏引用）。
  let imageSvg = '';
  const rawSrc = node.image?.src;
  if (rawSrc) {
    const href = opts.imageHrefs?.[node.id] ?? (isAssetRefSrc(rawSrc) ? '' : rawSrc);
    if (href) {
      imageSvg = `<image x="${offset.x + 2}" y="${offset.y + 2}" width="${Math.max(0, w - 4)}" height="${Math.max(0, h - 4)}" preserveAspectRatio="xMidYMid meet" href="${escXml(href)}"/>`;
    }
  }

  return `<g class="node" data-node-id="${escXml(node.id)}">` +
    `<rect x="${offset.x}" y="${offset.y}" width="${w}" height="${h}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="1"/>` +
    (imageSvg ? imageSvg : '') +
    (tspans ? `<text font-size="12" fill="#334155">${tspans}</text>` : '') +
    `</g>`;
}

function renderEdge(
  edge: Edge,
  nodes: Map<string, BlockNode>,
  offsets: Record<string, { x: number; y: number }>,
  gray?: boolean,
): string {
  const s = nodes.get(edge.source);
  const t = nodes.get(edge.target);
  if (!s || !t) return '';
  const so = offsets[edge.source];
  const to = offsets[edge.target];
  if (!so || !to) return '';
  const a = { x: so.x + s.width, y: so.y + s.height / 2 };
  const b = { x: to.x, y: to.y + t.height / 2 };
  // 世界坐标弯折点 → 页本地（按 source 节点的世界→页本地偏移换算）
  const delta = { x: so.x - s.x, y: so.y - s.y };
  const localPoints = (edge.points ?? []).map((p) => ({ x: p.x + delta.x, y: p.y + delta.y }));
  const color = gray ? '#94A3B8' : edge.style.color || '#94A3B8';
  const sEnd: EdgeEnd = { x: a.x, y: a.y, position: 'right' };
  const tEnd: EdgeEnd = { x: b.x, y: b.y, position: 'left' };
  const d = buildEdgePath(sEnd, tEnd, localPoints);
  return `<g class="edge" data-edge-id="${escXml(edge.id)}">` +
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" marker-end="url(#arrow)"/>` +
    `</g>`;
}

function renderSheet(
  sheet: PageSheet,
  doc: KBNoteDoc,
  size: { width: number; height: number },
  opts: SvgExportOptions,
  tokenToNumber?: ReadonlyMap<string, number>,
): string {
  const nodes = new Map(doc.nodes.map((n) => [n.id, n]));
  const edges = new Map(doc.edges.map((e) => [e.id, e]));
  const offsets = sheet.nodeDrawOffsets ?? {};

  const nodeSvg = sheet.nodeIds
    .map((id) => nodes.get(id))
    .filter((n): n is BlockNode => Boolean(n))
    .map((n) => renderNode(n, offsets[n.id]!, opts))
    .join('\n  ');

  const edgeSvg = sheet.edgeIds
    .map((id) => edges.get(id))
    .filter((e): e is Edge => Boolean(e))
    .map((e) => renderEdge(e, nodes, offsets, opts.gray))
    .join('\n  ');

  const contSvg = sheet.continuations
    .map((c) => {
      // 沿边切线方向的小箭头：out 出页朝 peer、in 入页朝目标节点（两侧同角度自洽）。
      const angle = c.angle ?? 0;
      const R = 7;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const px = -dy;
      const py = dx;
      const tipX = c.x + dx * (R + 3);
      const tipY = c.y + dy * (R + 3);
      const b1x = c.x + dx * (R - 2) + px * 3.5;
      const b1y = c.y + dy * (R - 2) + py * 3.5;
      const b2x = c.x + dx * (R - 2) - px * 3.5;
      const b2y = c.y + dy * (R - 2) - py * 3.5;
      const num = tokenToNumber?.get(c.token) ?? escXml(c.token.replace('cont:', ''));
      return `<g class="cont" data-role="${c.role ?? ''}" data-angle="${angle.toFixed(4)}"><path d="M ${tipX.toFixed(1)} ${tipY.toFixed(1)} L ${b1x.toFixed(1)} ${b1y.toFixed(1)} L ${b2x.toFixed(1)} ${b2y.toFixed(1)} Z" fill="#0284c7"/><circle cx="${c.x}" cy="${c.y}" r="${R}" fill="#e0f2fe" stroke="#0284c7"/><text x="${c.x}" y="${c.y + 3}" font-size="8" text-anchor="middle" fill="#075985">${num}</text></g>`;
    })
    .join('\n  ');

  const header = sheet.headerText
    ? `<text x="${size.width / 2}" y="${20}" font-size="11" text-anchor="middle" fill="#64748b">${escXml(sheet.headerText)}</text>`
    : '';
  const footer = sheet.footerText
    ? `<text x="${size.width / 2}" y="${size.height - 10}" font-size="10" text-anchor="middle" fill="#64748b">${escXml(sheet.footerText)} · ${sheet.pageNumber + 1}</text>`
    : `<text x="${size.width / 2}" y="${size.height - 10}" font-size="10" text-anchor="middle" fill="#94a3b8">${sheet.pageNumber + 1}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${opts.gray ? '#94A3B8' : '#64748b'}"/>
    </marker>
  </defs>
  <rect width="${size.width}" height="${size.height}" fill="#ffffff"/>
  ${header}
  ${edgeSvg}
  ${nodeSvg}
  ${contSvg}
  ${footer}
</svg>`;
}

/** 把分页结果逐页构建为 SVG 字符串数组。 */
export function buildPagesSvg(
  result: PaginateResult,
  doc: KBNoteDoc,
  opts: SvgExportOptions,
): string[] {
  const size = pagePixelSize(opts.orientation);
  // 与 PrintSheets 一致：按 token 首次出现顺序分配成对短编号。
  const tokenToNumber = new Map<string, number>();
  for (const sheet of result.pages) {
    for (const c of sheet.continuations) {
      if (!tokenToNumber.has(c.token)) tokenToNumber.set(c.token, tokenToNumber.size + 1);
    }
  }
  return result.pages.map((sheet) => renderSheet(sheet, doc, size, opts, tokenToNumber));
}

/** 逐页下载 .svg（不打 zip）。 */
/** 把多页 SVG 字符串渲染成 (blob, fileName) 列表（不在此处触发下载）。 */
export function renderSvgPages(svgPages: string[], baseFileName: string): { blob: Blob; fileName: string }[] {
  const dot = baseFileName.lastIndexOf('.');
  const stem = dot > 0 ? baseFileName.slice(0, dot) : baseFileName;
  return svgPages.map((svg, i) => ({
    blob: new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }),
    fileName: `${stem}_p${i + 1}.svg`,
  }));
}

/**
 * 遍历文档图片节点，把 assetRef 读成自包含 data: URI（供 SVG 内嵌）。
 * data: 内联图片原样收集；assetRef 读不到则跳过（不写坏引用）。
 */
export async function resolveImageHrefs(doc: KBNoteDoc): Promise<Record<string, string>> {
  const hrefs: Record<string, string> = {};
  await Promise.all(
    doc.nodes.map(async (n) => {
      const src = n.image?.src;
      if (!src) return;
      if (!isAssetRefSrc(src)) {
        hrefs[n.id] = src;
        return;
      }
      const dataUri = await assetRefToDataUri(src);
      if (dataUri) hrefs[n.id] = dataUri;
    }),
  );
  return hrefs;
}

/**
 * 预解析当前文档全部嵌入节点：目标 doc/block → { docTitle, lines, dangling }。
 * 只在 buildPagesSvgAsync 里跑（需要 Dexie 全量文档）；同步 buildPagesSvg 不解析（无 info 时渲染 caption 降级行）。
 */
async function buildEmbedInfo(doc: KBNoteDoc): Promise<Record<string, SvgEmbedInfo>> {
  const embeds = doc.nodes
    .map((n) => ({ n, emb: parseDocEmbedData(n.content.data) }))
    .filter((x): x is { n: BlockNode; emb: NonNullable<ReturnType<typeof parseDocEmbedData>> } => !!x.emb);
  if (embeds.length === 0) return {};
  let all: KBNoteDoc[] = [];
  try {
    all = await db.docs.toArray();
  } catch {
    all = [];
  }
  const byId = new Map(all.map((d) => [d.id, d]));
  const out: Record<string, SvgEmbedInfo> = {};
  for (const { n, emb } of embeds) {
    const targetDoc = byId.get(emb.targetDocId);
    const target = targetDoc?.nodes.find((x) => x.id === emb.targetNodeId);
    if (!targetDoc || !target) {
      out[n.id] = { docTitle: emb.titleSnapshot || '已删除的画布', lines: [], dangling: true };
      continue;
    }
    const text = extractNodePlainText(target.content.data);
    out[n.id] = {
      docTitle: targetDoc.title || '未命名画布',
      lines: text ? [text.slice(0, 60)] : ['（空块）'],
      dangling: false,
    };
  }
  return out;
}

/** 异步版：先把 OPFS 图片解析成 data: URI，再逐页构建 SVG。 */
export async function buildPagesSvgAsync(
  result: PaginateResult,
  doc: KBNoteDoc,
  opts: SvgExportOptions,
): Promise<string[]> {
  const [imageHrefs, embedInfo] = await Promise.all([resolveImageHrefs(doc), buildEmbedInfo(doc)]);
  return buildPagesSvg(result, doc, { ...opts, imageHrefs, embedInfo });
}
