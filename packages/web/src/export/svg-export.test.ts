import { describe, it, expect } from 'vitest';
import type { KBNoteDoc } from '@drawpaper/core';
import type { PaginateResult, PageSheet } from '@drawpaper/core';
import { buildPagesSvg } from './svg-export';

function doc(): KBNoteDoc {
  return {
    format: 'knowledge-block-notes',
    version: 1,
    id: 'doc_1',
    title: 't',
    board: { createdAt: 0, updatedAt: 0 },
    tags: [],
    layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
    viewport: { x: 0, y: 0, zoom: 1 },
    page: { size: 'A4', orientation: 'portrait', marginMm: 15, mode: 'tiles', showPageBreak: true, colorMode: 'color', header: true, footer: true, showPageNumbers: true, edgeLabels: true, pageBreaks: [] },
    assetRefs: [],
    nodes: [
      { id: 'n1', type: 'text', x: 0, y: 0, width: 200, height: 100, content: { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '节点一文本' }] }] } }, parentId: null, pinned: false, locked: false, collapsed: false, tags: [], style: {} },
      { id: 'n2', type: 'text', x: 300, y: 0, width: 200, height: 100, content: { format: 'tiptap-json', data: { type: 'doc', content: [] } }, parentId: null, pinned: false, locked: false, collapsed: false, tags: [], style: {} },
    ],
    edges: [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'right', targetHandle: 'left', label: '', directed: true, style: { color: '#93C5FD' } }],
  } as unknown as KBNoteDoc;
}

function result(): PaginateResult {
  const sheet: PageSheet = {
    index: 0,
    pageNumber: 0,
    worldRect: { x: 0, y: 0, width: 700, height: 1000 },
    nodeIds: ['n1', 'n2'],
    edgeIds: ['e1'],
    continuations: [{ token: 'cont:e1x', edgeId: 'e1x', pageIndex: 0, x: 10, y: 10, peerPageIndex: 1, angle: 0, role: 'out' }],
    scale: 1,
    nodeDrawOffsets: { n1: { x: 60, y: 60 }, n2: { x: 360, y: 60 } },
    headerText: '页眉',
    footerText: '页脚',
  };
  return { pages: [sheet], orphans: [], totalPages: 1, notes: [] };
}

describe('buildPagesSvg', () => {
  it('包含节点文本、箭头 marker、续接圆圈、页眉页脚', () => {
    const [svg] = buildPagesSvg(result(), doc(), { orientation: 'portrait' });
    expect(svg).toContain('<svg');
    expect(svg).toContain('节点一文本');
    expect(svg).toContain('url(#arrow)');
    expect(svg).toContain('<marker id="arrow"');
    expect(svg).toContain('<circle');
    expect(svg).toContain('页眉');
    expect(svg).toContain('页脚');
    expect(svg).toContain('data-node-id="n1"');
  });

  it('无 points 时 edge 为贝塞尔 path', () => {
    const [svg] = buildPagesSvg(result(), doc(), { orientation: 'portrait' });
    expect(svg).toMatch(/d="M [^"]*C/);
  });

  it('有 points：SVG path 含页本地弯折坐标（世界点经偏移换算）', () => {
    const d = doc();
    // 世界弯折点 (200,200)；source 节点世界(0,0)→页本地(60,60)，delta=(60,60)
    // → 页本地点 = (260,260)
    (d.edges[0] as { points?: { x: number; y: number }[] }).points = [{ x: 200, y: 200 }];
    const [svg] = buildPagesSvg(result(), d, { orientation: 'portrait' });
    expect(svg).toContain('260 260');
  });
});

describe('buildPagesSvg 图片内嵌（Wave7 P2.1）', () => {
  function imageDoc(): KBNoteDoc {
    const d = doc();
    (d.nodes[0] as { image?: { src: string; alt: string } }).image = {
      src: 'asset_abc',
      alt: '图',
    };
    return d;
  }

  it('imageHrefs 提供 data: URI 时，SVG 内联 <image href="data:...">', () => {
    const [svg] = buildPagesSvg(result(), imageDoc(), {
      orientation: 'portrait',
      imageHrefs: { n1: 'data:image/webp;base64,QUJD' },
    });
    expect(svg).toContain('<image');
    expect(svg).toContain('href="data:image/webp;base64,QUJD"');
  });

  it('image.src 本身是 data: 且未预解析时也能内联（旧文档兼容）', () => {
    const d = imageDoc();
    (d.nodes[0] as { image: { src: string } }).image.src = 'data:image/png;base64,RAw';
    const [svg] = buildPagesSvg(result(), d, { orientation: 'portrait' });
    expect(svg).toContain('href="data:image/png;base64,RAw"');
  });

  it('assetRef 未预解析时不写坏引用（不出现裸 asset_abc href）', () => {
    const [svg] = buildPagesSvg(result(), imageDoc(), { orientation: 'portrait' });
    expect(svg).not.toContain('href="asset_abc"');
  });
});

describe('buildPagesSvg 非 Tiptap 块型文本提取', () => {
  function equationDoc(): KBNoteDoc {
    const d = doc();
    (d.nodes[0] as { type: string }).type = 'equation';
    (d.nodes[0] as { content: { data: unknown } }).content.data = { kind: 'equation', source: 'E=mc^2' };
    return d;
  }

  it('equation 块导出 LaTeX 源码文本（不空白）', () => {
    const [svg] = buildPagesSvg(result(), equationDoc(), { orientation: 'portrait' });
    expect(svg).toContain('E=mc^2');
  });

  it('空 source 的 equation 块不崩溃', () => {
    const d = equationDoc();
    (d.nodes[0] as { content: { data: unknown } }).content.data = { kind: 'equation', source: '' };
    const [svg] = buildPagesSvg(result(), d, { orientation: 'portrait' });
    expect(svg).toContain('<svg');
  });
});
