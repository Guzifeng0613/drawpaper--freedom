import * as React from 'react';
import {
  layoutTree,
  paginateFit,
  paginateTiles,
  paginateFlow,
  type LayoutResult,
  type PaginateResult,
  type MeasuredSize,
  type PaginateSettings,
} from '@drawpaper/core';
import type { PanelsApi } from '@/panels/panels-api';
import { type ExportDialogActions, type ExportScope } from './ExportDialog';
import {
  collectSheetElements,
  renderSheetsAsPdf,
  renderSheetsAsPng,
  runVectorPrint,
} from './print-pipeline';
import { buildPagesSvgAsync, renderSvgPages } from './svg-export';
import { renderVectorPdf, MISSING_GLYPH_MARKER } from './vector-pdf-export';
import { docToMarkdown, markdownBlob } from './markdown-export';
import { buildExportFileName } from './filename';
import { deliverExportFile } from './deliver';
import { pushToast } from '@/panels/lib/toast';
import { db } from '@/storage/db';
import { ensureKatex } from '../editor/tiptap/katex-html';
import { ensureHighlighter } from '../editor/tiptap/highlight';

const EMPTY_RESULT: PaginateResult = { pages: [], orphans: [], totalPages: 0, notes: [] };

/**
 * 独立可复用的分页计算（所见即所得三模式）。导出按钮与画布分页虚线叠加层共用同一逻辑。
 */
export function computePanelsPaginate(api: PanelsApi, scope: 'all' | 'selected' | 'bbox' = 'all'): PaginateResult {
  const doc = api.doc;
  if (!doc) return EMPTY_RESULT;
  try {
    // bbox 范围：仅保留与当前选中节点包围盒相交的节点（含其连接边）。
    let nodes = doc.nodes;
    let edges = doc.edges;
    if (scope === 'bbox') {
      const sel = new Set(api.selectedNodeIds ?? []);
      if (sel.size > 0) {
        const box = {
          minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity,
        };
        for (const n of doc.nodes) {
          if (!sel.has(n.id)) continue;
          box.minX = Math.min(box.minX, n.x);
          box.minY = Math.min(box.minY, n.y);
          box.maxX = Math.max(box.maxX, n.x + n.width);
          box.maxY = Math.max(box.maxY, n.y + n.height);
        }
        nodes = doc.nodes.filter((n) =>
          n.x < box.maxX && n.x + n.width > box.minX && n.y < box.maxY && n.y + n.height > box.minY);
        const ids = new Set(nodes.map((n) => n.id));
        edges = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
      }
    }
    const measured: Record<string, MeasuredSize> = {};
    for (const n of nodes) measured[n.id] = { width: n.width, height: n.height };
    const settings: PaginateSettings = {
      ...doc.page,
      grayScale: doc.page.colorMode === 'gray',
      showEdgeLabels: doc.page.edgeLabels,
    };

    if (doc.page.mode === 'flow') {
      const layout = layoutTree(
        {
          nodes,
          edges,
          rankSpacing: doc.layout.rankSpacing,
          nodeSpacing: doc.layout.nodeSpacing,
          measured,
        },
        'mindmap-down',
      );
      const collapsed: Record<string, boolean> = {};
      for (const n of nodes) if (n.collapsed) collapsed[n.id] = true;
      return paginateFlow({ layout, measured, settings, nodes, edges, collapsed });
    }

    const positions: LayoutResult['positions'] = {};
    for (const n of nodes) positions[n.id] = { x: n.x, y: n.y };
    const layout: LayoutResult = {
      positions,
      collisions: { overlappingPairs: [], detouredNodes: [] },
      notes: [],
    };
    const collapsed: Record<string, boolean> = {};
    for (const n of nodes) if (n.collapsed) collapsed[n.id] = true;
    const fn = doc.page.mode === 'fit' ? paginateFit : paginateTiles;
    return fn({ layout, measured, settings, nodes, edges, collapsed });
  } catch {
    return EMPTY_RESULT;
  }
}

/**
 * 胶水 hook：从 api 取 doc / page 设置，调 core 的 layoutTree + paginate*（Wave2 接真实数据流）。
 *
 * 三模式输入：
 *  - fit / tiles：以当前画布节点坐标（所见即所得）作为 layout 结果输入分页；
 *  - flow：先用 core.layoutTree（mindmap-down）重排，再交 paginateFlow 切纵向打印流。
 *
 * 三条输出按钮（打印 / PNG / PDF）在 afterSheetsRender 内等 <PrintSheets/> 入 DOM 后执行。
 */
export function useExportModel(api: PanelsApi): {
  result: PaginateResult;
  sheetsVisible: boolean;
  actions: ExportDialogActions;
  scope: ExportScope;
  setScope: (s: ExportScope) => void;
  busy: 'png' | 'pdf' | null;
} {
  const [result, setResult] = React.useState<PaginateResult>(EMPTY_RESULT);
  const [sheetsVisible, setSheetsVisible] = React.useState(false);
  const [scope, setScope] = React.useState<ExportScope>('all');
  const [busy, setBusy] = React.useState<'png' | 'pdf' | null>(null);

  const computeResult = React.useCallback((): PaginateResult => computePanelsPaginate(api, scope), [api, scope]);

  const afterSheetsRender = React.useCallback(
    async (job: () => Promise<void>) => {
      // 预加载懒加载资源（KaTeX / 代码高亮），使离屏 PrintSheets 能同步渲染公式与代码块。
      // 失败不阻断导出——PrintSheets 内有降级（公式退化为等宽源码，代码块退化为纯文本 pre）。
      await Promise.allSettled([ensureKatex(), ensureHighlighter()]);
      setSheetsVisible(true);
      // 等 React 把 <PrintSheets/> 提交到 DOM 后再取 sheet 元素。
      await new Promise((res) => requestAnimationFrame(() => setTimeout(res, 80)));
      try {
        await job();
      } finally {
        setSheetsVisible(false);
      }
    },
    [],
  );

  const actions = React.useMemo<ExportDialogActions>(
    () => ({
      onPrint: () => {
        setResult(computeResult());
        void afterSheetsRender(async () => {
          await runVectorPrint(api.page.orientation);
        });
      },
      onExportPng: () => {
        setResult(computeResult());
        void afterSheetsRender(async () => {
          setBusy('png');
          try {
            const sheets = collectSheetElements();
            const name = buildExportFileName({
              title: api.doc?.title ?? '未命名',
              date: new Date(),
              orientation: api.page.orientation,
              ext: 'png',
            });
            const pages = await renderSheetsAsPng(sheets, name);
            for (const p of pages) await deliverExportFile(p.fileName, 'png', p.blob);
          } catch (err) {
            console.error(err);
            pushToast('error', 'PNG 导出失败（图形库加载或渲染出错）');
          } finally {
            setBusy(null);
          }
        });
      },
      onExportPdf: () => {
        const r = computeResult();
        setResult(r);
        void afterSheetsRender(async () => {
          setBusy('pdf');
          try {
            const name = buildExportFileName({
              title: api.doc?.title ?? '未命名',
              date: new Date(),
              orientation: api.page.orientation,
              ext: 'pdf',
            });
            // 矢量主线：SVG（与 .svg 导出同源）→ svg2pdf → 多页矢量 PDF，文本可选可搜索。
            // 任何矢量失败（chunk 加载 / 字体 / 单页渲染）都明确 toast 后自动回退位图链路。
            try {
              if (!api.doc) throw new Error('no doc');
              const { blob, fileName } = await renderVectorPdf(r, api.doc, {
                orientation: api.page.orientation,
                gray: api.page.colorMode === 'gray',
                baseFileName: name,
              });
              await deliverExportFile(fileName, 'pdf', blob);
            } catch (vecErr) {
              console.error('vector pdf failed, falling back to bitmap:', vecErr);
              const msg = vecErr instanceof Error ? vecErr.message : String(vecErr);
              // 缺字形预检命中（生僻字）用专门文案，区别于一般矢量失败。
              pushToast(
                'error',
                msg.includes(MISSING_GLYPH_MARKER)
                  ? '含字体不支持的文字，已回退位图模式'
                  : '矢量导出失败，已回退位图模式',
              );
              const sheets = collectSheetElements();
              const { blob, fileName } = await renderSheetsAsPdf(sheets, name, api.page.orientation);
              await deliverExportFile(fileName, 'pdf', blob);
            }
          } catch (err) {
            console.error(err);
            pushToast('error', 'PDF 合成失败（pdf-lib 加载或渲染出错）');
          } finally {
            setBusy(null);
          }
        });
      },
      onExportSvg: () => {
        if (!api.doc) return;
        const r = computeResult();
        if (r.pages.length === 0) return;
        // 异步：先把 OPFS 图片读成 data: URI 内嵌进 SVG（离线可见）。
        void (async () => {
          try {
            const svgs = await buildPagesSvgAsync(r, api.doc!, {
              orientation: api.page.orientation,
              gray: api.page.colorMode === 'gray',
            });
            const name = buildExportFileName({
              title: api.doc!.title ?? '未命名',
              date: new Date(),
              orientation: api.page.orientation,
              ext: 'svg',
            });
            for (const p of renderSvgPages(svgs, name)) await deliverExportFile(p.fileName, 'svg', p.blob);
          } catch (err) {
            console.error(err);
            pushToast('error', 'SVG 导出失败');
          }
        })();
      },
      onExportMarkdown: () => {
        if (!api.doc) return;
        // Wave20：嵌入块 caption 需要目标画布名——从 Dexie 全量文档注入 docTitles。
        void (async () => {
          let docTitles: Record<string, string> | undefined;
          try {
            const all = await db.docs.toArray();
            docTitles = Object.fromEntries(all.map((d) => [d.id, d.title || '未命名画布']));
          } catch {
            docTitles = undefined;
          }
          const md = docToMarkdown(api.doc!, { docTitles });
          const name = buildExportFileName({
            title: api.doc!.title ?? '未命名',
            date: new Date(),
            orientation: api.page.orientation,
            ext: 'md',
          });
          void deliverExportFile(name, 'md', markdownBlob(md));
        })();
      },
    }),
    [api, afterSheetsRender, computeResult],
  );

  return { result, sheetsVisible, actions, scope, setScope, busy };
}
