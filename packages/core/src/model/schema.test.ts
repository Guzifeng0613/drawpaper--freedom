import { describe, it, expect } from 'vitest';
import {
  parseKBNoteDoc,
  safeParseKBNoteDoc,
  validateGraph,
  KBNoteParseError,
  DOC_FORMAT,
  CURRENT_DOC_VERSION,
  DEFAULT_EDGE_COLOR,
} from './index.js';
import type { BlockNode, Edge } from './index.js';

function rawNode(over: Partial<BlockNode> = {}): Record<string, unknown> {
  return {
    id: 'n_1',
    type: 'text',
    x: 0,
    y: 0,
    width: 260,
    height: 80,
    content: { format: 'tiptap-json', data: { type: 'doc' } },
    parentId: null,
    pinned: false,
    locked: false,
    collapsed: false,
    tags: [],
    style: {},
    ...over,
  };
}

function doc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: DOC_FORMAT,
    version: CURRENT_DOC_VERSION,
    id: 'doc_1',
    title: 't',
    board: { createdAt: 0, updatedAt: 0 },
    nodes: [],
    edges: [],
    tags: [],
    layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
    viewport: { x: 0, y: 0, zoom: 1 },
    page: {
      size: 'A4',
      orientation: 'portrait',
      marginMm: 15,
      mode: 'fit',
      showPageBreak: true,
      colorMode: 'color',
      header: false,
      footer: false,
      showPageNumbers: false,
      pageBreaks: [],
    },
    assetRefs: [],
    ...over,
  };
}

describe('parseKBNoteDoc: happy path & defaults', () => {
  it('accepts a minimal valid doc', () => {
    const d = parseKBNoteDoc(doc({ nodes: [rawNode()] }));
    expect(d.id).toBe('doc_1');
    expect(d.nodes).toHaveLength(1);
  });

  it('fills defaults for omitted optional node/edge fields', () => {
    const d = parseKBNoteDoc(
      doc({
        nodes: [{ id: 'n_1', type: 'text', x: 0, y: 0, width: 260, height: 80, content: { format: 'tiptap-json', data: {} } }],
        edges: [{ id: 'e_1', source: 'n_1', target: 'n_1' }],
      }),
    );
    const n = d.nodes[0]!;
    expect(n.pinned).toBe(false);
    expect(n.locked).toBe(false);
    expect(n.collapsed).toBe(false);
    expect(n.tags).toEqual([]);
    expect(n.parentId).toBeNull();
    const e = d.edges[0]!;
    expect(e.label).toBe('');
    expect(e.directed).toBe(true);
    expect(e.sourceHandle).toBe('right');
    expect(e.targetHandle).toBe('left');
    expect(e.style.color).toBe(DEFAULT_EDGE_COLOR.hex);
  });

  it('strips unknown fields', () => {
    const d = parseKBNoteDoc(
      doc({
        unknownTopLevel: 42,
        nodes: [{ ...rawNode(), mysteryField: 'x', bogus: 1 }],
      }),
    );
    expect((d as Record<string, unknown>)['unknownTopLevel']).toBeUndefined();
    const n = d.nodes[0] as Record<string, unknown>;
    expect(n['mysteryField']).toBeUndefined();
    expect(n['bogus']).toBeUndefined();
  });

  it('Wave20 块嵌入：v4 schema 宽容承载 doc-embed payload，不升版本、不迁移', () => {
    // 嵌入块 host 在既有 type='note' 上，payload 挂 content.data（z.unknown 透传）。
    const d = parseKBNoteDoc(
      doc({
        version: 4,
        nodes: [
          rawNode({
            type: 'note',
            content: {
              format: 'tiptap-json',
              data: { kind: 'doc-embed', targetDocId: 'doc_B', targetNodeId: 'n_B1', titleSnapshot: '目标块' },
            },
          }),
        ],
      }),
    );
    expect(d.version).toBe(4);
    const data = d.nodes[0]!.content.data as { kind: string; targetDocId: string };
    expect(data.kind).toBe('doc-embed');
    expect(data.targetDocId).toBe('doc_B');
  });

  it('Wave21 layout.mode：枚举附加 flow-layered，未知/非法 mode 宽容回退 mindmap-down', () => {
    // 合法新值原样承载（不升版本、不迁移）。
    const d1 = parseKBNoteDoc(
      doc({ layout: { mode: 'flow-layered', rankSpacing: 90, nodeSpacing: 28 } }),
    );
    expect(d1.layout.mode).toBe('flow-layered');
    // 未知未来值/脏值不炸文档打开，宽容回退 mindmap-down。
    const d2 = parseKBNoteDoc(
      doc({ layout: { mode: 'some-future-mode', rankSpacing: 90, nodeSpacing: 28 } }),
    );
    expect(d2.layout.mode).toBe('mindmap-down');
  });
});

describe('parseKBNoteDoc: rejection', () => {
  it('throws KBNoteParseError with path info on wrong format', () => {
    expect(() => parseKBNoteDoc(doc({ format: 'nope' }))).toThrow(KBNoteParseError);
    try {
      parseKBNoteDoc(doc({ format: 'nope' }));
    } catch (e) {
      expect(e).toBeInstanceOf(KBNoteParseError);
      const err = e as KBNoteParseError;
      expect(err.issues.length).toBeGreaterThan(0);
      expect(err.issues[0]!.path).toContain('format');
    }
  });

  it('rejects negative width', () => {
    expect(() => parseKBNoteDoc(doc({ nodes: [rawNode({ width: -5 })] }))).toThrow(KBNoteParseError);
  });

  it('rejects NaN dimensions', () => {
    expect(() => parseKBNoteDoc(doc({ nodes: [rawNode({ width: NaN })] }))).toThrow(KBNoteParseError);
  });

  it('safeParseKBNoteDoc returns discriminated result', () => {
    const ok = safeParseKBNoteDoc(doc());
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.doc.id).toBe('doc_1');

    const bad = safeParseKBNoteDoc({ format: 'bad' });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error).toBeInstanceOf(KBNoteParseError);
  });
});

// ---- validateGraph ----

function node(id: string, parentId: string | null = null): BlockNode {
  return {
    id,
    type: 'text',
    x: 0,
    y: 0,
    width: 260,
    height: 80,
    content: { format: 'tiptap-json', data: {} },
    parentId,
    pinned: false,
    locked: false,
    collapsed: false,
    tags: [],
    style: {},
  };
}

function edge(id: string, source: string, target: string): Edge {
  return {
    id,
    source,
    target,
    sourceHandle: 'right',
    targetHandle: 'left',
    label: '',
    directed: true,
    style: { color: '#94A3B8' },
  };
}

describe('validateGraph: issue codes', () => {
  it('detects self-loop', () => {
    const issues = validateGraph([node('a')], [edge('e1', 'a', 'a')]);
    const self = issues.filter((i) => i.code === 'self-loop');
    expect(self).toHaveLength(1);
    expect(self[0]).toMatchObject({ edgeId: 'e1', nodeId: 'a' });
  });

  it('detects dangling-edge (missing source & target)', () => {
    const issues = validateGraph([node('a')], [edge('e1', 'a', 'ghost'), edge('e2', 'ghost', 'a')]);
    const dangling = issues.filter((i) => i.code === 'dangling-edge');
    expect(dangling).toHaveLength(2);
  });

  it('detects duplicate-edge', () => {
    const issues = validateGraph([node('a'), node('b')], [edge('e1', 'a', 'b'), edge('e2', 'a', 'b')]);
    const dup = issues.filter((i) => i.code === 'duplicate-edge');
    expect(dup).toHaveLength(1);
    expect(dup[0]).toMatchObject({ edgeId: 'e2', firstEdgeId: 'e1', source: 'a', target: 'b' });
  });

  it('detects multi-parent', () => {
    const issues = validateGraph(
      [node('p1'), node('p2'), node('c')],
      [edge('e1', 'p1', 'c'), edge('e2', 'p2', 'c')],
    );
    const mp = issues.filter((i) => i.code === 'multi-parent');
    expect(mp).toHaveLength(1);
    expect(mp[0]).toMatchObject({ nodeId: 'c', parentEdgeIds: ['e1', 'e2'], parentIds: ['p1', 'p2'] });
  });

  it('detects 2-node cycle, 3-node cycle, and self-loop as cycle', () => {
    const two = validateGraph([node('a'), node('b')], [edge('e1', 'a', 'b'), edge('e2', 'b', 'a')]);
    const cyc2 = two.filter((i) => i.code === 'cycle');
    expect(cyc2).toHaveLength(1);
    expect(cyc2[0]!.edgeIds.sort()).toEqual(['e1', 'e2']);

    const three = validateGraph(
      [node('a'), node('b'), node('c')],
      [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'c', 'a')],
    );
    const cyc3 = three.filter((i) => i.code === 'cycle');
    expect(cyc3).toHaveLength(1);
    expect(cyc3[0]!.edgeIds.sort()).toEqual(['e1', 'e2', 'e3']);

    const self = validateGraph([node('a')], [edge('e1', 'a', 'a')]);
    expect(self.some((i) => i.code === 'cycle' && i.edgeIds.includes('e1'))).toBe(true);
  });

  it('detects parentid-mismatch', () => {
    // declared parentId = 'declared' but edge derives parent = 'p1'
    const issues = validateGraph([node('p1'), node('c', 'declared')], [edge('e1', 'p1', 'c')]);
    const m = issues.filter((i) => i.code === 'parentid-mismatch');
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ nodeId: 'c', declaredParentId: 'declared', derivedParentId: 'p1' });
  });

  it('reports no mismatch when declared parent matches first incoming edge', () => {
    const issues = validateGraph([node('p1'), node('c', 'p1')], [edge('e1', 'p1', 'c')]);
    expect(issues.filter((i) => i.code === 'parentid-mismatch')).toHaveLength(0);
  });
});

describe('v2: edge.points', () => {
  it('accepts a points array of finite coordinates, strips unknown keys', () => {
    const d = parseKBNoteDoc(
      doc({
        edges: [
          {
            id: 'e1',
            source: 'n1',
            target: 'n2',
            points: [{ x: 10, y: 20, bogus: 'x' }],
          },
        ],
      }),
    );
    expect(d.edges[0]!.points).toEqual([{ x: 10, y: 20 }]);
  });

  it('rejects non-finite point coordinate', () => {
    expect(() =>
      parseKBNoteDoc(
        doc({ edges: [{ id: 'e1', source: 'n1', target: 'n2', points: [{ x: NaN, y: 0 }] }] }),
      ),
    ).toThrow(KBNoteParseError);
  });

  it('rejects more than 64 points', () => {
    const points = Array.from({ length: 65 }, (_, i) => ({ x: i, y: 0 }));
    expect(() =>
      parseKBNoteDoc(doc({ edges: [{ id: 'e1', source: 'n1', target: 'n2', points }] })),
    ).toThrow(KBNoteParseError);
  });

  it('accepts 64 points', () => {
    const points = Array.from({ length: 64 }, (_, i) => ({ x: i, y: 0 }));
    const d = parseKBNoteDoc(doc({ edges: [{ id: 'e1', source: 'n1', target: 'n2', points }] }));
    expect(d.edges[0]!.points).toHaveLength(64);
  });
});

describe('v2: links', () => {
  it('defaults links to [] when absent', () => {
    const d = parseKBNoteDoc(doc());
    expect(d.links).toEqual([]);
  });

  it('accepts a valid DocRefLink', () => {
    const d = parseKBNoteDoc(
      doc({
        links: [
          {
            id: 'ln_1',
            sourceDocId: 'doc1',
            sourceNodeId: 'n1',
            targetDocId: 'doc2',
            targetNodeId: 'n2',
            targetTitle: '目标',
            createdAt: 1,
          },
        ],
      }),
    );
    expect(d.links).toHaveLength(1);
    expect(d.links[0]!.targetTitle).toBe('目标');
  });

  it('rejects a malformed link (missing createdAt)', () => {
    expect(() =>
      parseKBNoteDoc(
        doc({
          links: [{ id: 'ln_1', sourceDocId: 'a', sourceNodeId: 'n', targetDocId: 'a', targetNodeId: 'n', targetTitle: 'x' }],
        }),
      ),
    ).toThrow(KBNoteParseError);
  });
});

describe('forward-compat: unknown enum values degrade instead of rejecting the doc', () => {
  it('unknown node.type falls back to text and preserves content/data and other fields', () => {
    const customData = { type: 'doc', content: [{ type: 'paragraph', text: '未来块' }] };
    const d = parseKBNoteDoc(
      doc({
        nodes: [rawNode({ type: 'future-widget', content: { format: 'tiptap-json', data: customData }, x: 42, y: 7 })],
      }),
    );
    expect(d.nodes).toHaveLength(1);
    expect(d.nodes[0]!.type).toBe('text');
    // 其余字段原样保留：位置 + 不透明正文 data
    expect(d.nodes[0]!.x).toBe(42);
    expect(d.nodes[0]!.y).toBe(7);
    expect(d.nodes[0]!.content).toEqual({ format: 'tiptap-json', data: customData });
  });

  it('unknown page enum values fall back to their existing defaults', () => {
    const d = parseKBNoteDoc(
      doc({
        page: {
          size: 'A4',
          orientation: 'reverse',
          marginMm: 12,
          mode: 'scroll',
          showPageBreak: true,
          colorMode: 'sepia',
        },
      }),
    );
    expect(d.page.orientation).toBe('portrait');
    expect(d.page.marginMm).toBe(15);
    expect(d.page.mode).toBe('fit');
    expect(d.page.colorMode).toBe('color');
  });

  it('keeps every legal enum value unchanged (including P1-reserved node types)', () => {
    const types = ['text', 'heading', 'todo', 'bullet', 'image', 'note', 'group', 'table', 'code', 'equation', 'bookmark', 'attachment', 'reminder'];
    const d = parseKBNoteDoc(doc({ nodes: types.map((t, i) => rawNode({ id: `n_${i}`, type: t })) }));
    expect(d.nodes.map((n) => n.type)).toEqual(types);
    const p = parseKBNoteDoc(
      doc({ page: { size: 'A4', orientation: 'landscape', marginMm: 20, mode: 'tiles', showPageBreak: false, colorMode: 'gray' } }),
    );
    expect(p.page.orientation).toBe('landscape');
    expect(p.page.marginMm).toBe(20);
    expect(p.page.mode).toBe('tiles');
    expect(p.page.colorMode).toBe('gray');
  });
});
