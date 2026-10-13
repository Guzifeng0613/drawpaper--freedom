import { describe, it, expect } from 'vitest';
import type { KBNoteDoc, BlockNode, Edge } from '../model/index.js';
import { createDoc, createNode, createEdge } from '../model/index.js';
import {
  mergeSnapshots,
  manifestFromDoc,
  diffManifests,
  planBundle,
  advanceWatermark,
  emptyCursor,
  hasUnsyncedChanges,
  canonicalHash,
  canonicalStringify,
  maxPersistedLamport,
} from './index.js';
import type { EntitySyncMeta } from './types.js';
import { migrateV2ToV3, seedClientIdFor, migrationLamport } from './migrate.js';
import { parseKBNote } from '../serialize/serialize.js';

/** 构造一个带文本的节点。 */
function n(id: string, text: string, x = 0, y = 0): BlockNode {
  const node = createNode('text', x, y);
  node.id = id;
  node.content = { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', text }] } };
  return node;
}

/** 构造一条边。 */
function e(id: string, source: string, target: string): Edge {
  const edge = createEdge(source, target);
  edge.id = id;
  return edge;
}

type Mark = [number, string];

/** JSON 深拷贝（core 禁 structuredClone）。 */
function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/** 把节点挂进 doc，并按提供的字段戳登记进 sync.nodes。 */
function addNode(doc: KBNoteDoc, node: BlockNode, fieldStamps: Record<string, Mark>, tomb?: Mark): void {
  doc.nodes.push(node);
  const meta: EntitySyncMeta = { f: { ...fieldStamps } };
  if (tomb) meta.t = tomb;
  doc.sync.nodes ??= {};
  doc.sync.nodes[node.id] = meta;
}

function addEdge(doc: KBNoteDoc, edge: Edge, fieldStamps: Record<string, Mark>, tomb?: Mark): void {
  doc.edges.push(edge);
  const meta: EntitySyncMeta = { f: { ...fieldStamps } };
  if (tomb) meta.t = tomb;
  doc.sync.edges ??= {};
  doc.sync.edges[edge.id] = meta;
}

function baseDoc(id = 'doc_1'): KBNoteDoc {
  const d = createDoc('同步测试');
  d.id = id;
  return d;
}

// ---------------------------------------------------------------------------

describe('mergeSnapshots: 独立编辑自动合并', () => {
  it('双方编辑不同节点互不冲突，结果并集', () => {
    // 共同基线（base）：n_a / n_b 内容都是「原文」，戳为 seed。
    const base = baseDoc();
    addNode(base, n('n_a', '原文'), { content: [5, 'seed:doc_1'] });
    addNode(base, n('n_b', '原文'), { content: [5, 'seed:doc_1'] });

    // A 改 n_a
    const A = clone(base) as KBNoteDoc;
    A.nodes[0]!.content = { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', text: 'A-改' }] } };
    A.sync.nodes!.n_a!.f!.content = [10, 'cA'];
    A.sync.vv = { cA: 10 };

    // B 改 n_b
    const B = clone(base) as KBNoteDoc;
    B.nodes[1]!.content = { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', text: 'B-改' }] } };
    B.sync.nodes!.n_b!.f!.content = [11, 'cB'];
    B.sync.vv = { cB: 11 };

    const r = mergeSnapshots(A, B, base);
    expect(r.conflicts).toHaveLength(0);
    expect(r.doc.nodes.find((x) => x.id === 'n_a')!.content.data.content[0].text).toBe('A-改');
    expect(r.doc.nodes.find((x) => x.id === 'n_b')!.content.data.content[0].text).toBe('B-改');
    expect(Object.keys(r.doc.sync.vv).sort()).toEqual(['cA', 'cB']);
  });

  it('不同字段并发写同时生效（content 与 y，三方快进）', () => {
    const base = baseDoc();
    addNode(base, n('n1', '旧正文'), { content: [5, 'seed'], y: [5, 'seed'] });
    const A = clone(base) as KBNoteDoc;
    A.nodes[0]!.content = { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', text: '新正文' }] } };
    A.sync.nodes!.n1!.f!.content = [20, 'cA'];
    const B = clone(base) as KBNoteDoc;
    B.nodes[0]!.y = 200;
    B.sync.nodes!.n1!.f!.y = [20, 'cB'];
    const r = mergeSnapshots(A, B, base);
    expect(r.conflicts).toHaveLength(0);
    const node = r.doc.nodes.find((x) => x.id === 'n1')!;
    expect(node.content.data.content[0].text).toBe('新正文');
    expect(node.y).toBe(200);
  });
});

describe('mergeSnapshots: 同字段并发 LWW', () => {
  // base 原始值「旧」，双方都把它改成不同值 → 真并发。
  const baseN1 = (): KBNoteDoc => {
    const d = baseDoc();
    addNode(d, n('n1', '旧'), { content: [5, 'seed'] });
    return d;
 };

  it('lamport 大者胜（local 较新）', () => {
    const base = baseN1();
    const A = clone(base) as KBNoteDoc;
    A.nodes[0]!.content = { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', text: 'A' }] } };
    A.sync.nodes!.n1!.f!.content = [20, 'cA'];
    const B = clone(base) as KBNoteDoc;
    B.sync.nodes!.n1!.f!.content = [10, 'cB']; // 值仍为「旧」但 stamp 升到 cB → 视为改
    B.nodes[0]!.content = { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', text: 'B' }] } };
    const r = mergeSnapshots(A, B, base);
    expect(r.doc.nodes.find((x) => x.id === 'n1')!.content.data.content[0].text).toBe('A');
    expect(r.conflicts).toHaveLength(1);
    expect(r.summary[0]).toContain('块内容');
  });

  it('lamport 大者胜（remote 较新）', () => {
    const base = baseN1();
    const A = clone(base) as KBNoteDoc;
    A.nodes[0]!.content = { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', text: 'A' }] } };
    A.sync.nodes!.n1!.f!.content = [10, 'cA'];
    const B = clone(base) as KBNoteDoc;
    B.nodes[0]!.content = { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', text: 'B' }] } };
    B.sync.nodes!.n1!.f!.content = [30, 'cB'];
    const r = mergeSnapshots(A, B, base);
    expect(r.doc.nodes.find((x) => x.id === 'n1')!.content.data.content[0].text).toBe('B');
    expect(r.conflicts).toHaveLength(1);
  });

  it('同 lamport 平局：clientId 字典序小者胜', () => {
    const base = baseN1();
    const A = clone(base) as KBNoteDoc;
    A.nodes[0]!.content = { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', text: 'A' }] } };
    A.sync.nodes!.n1!.f!.content = [100, 'a-client'];
    const B = clone(base) as KBNoteDoc;
    B.nodes[0]!.content = { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', text: 'B' }] } };
    B.sync.nodes!.n1!.f!.content = [100, 'b-client'];
    const r = mergeSnapshots(A, B, base);
    expect(r.doc.nodes.find((x) => x.id === 'n1')!.content.data.content[0].text).toBe('A');
    expect(r.conflicts).toHaveLength(1);
  });

  it('两边写同值 → 不记冲突', () => {
    const base = baseN1();
    const A = clone(base) as KBNoteDoc;
    A.nodes[0]!.content = { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', text: '相同' }] } };
    A.sync.nodes!.n1!.f!.content = [20, 'cA'];
    const B = clone(base) as KBNoteDoc;
    B.nodes[0]!.content = { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', text: '相同' }] } };
    B.sync.nodes!.n1!.f!.content = [10, 'cB'];
    const r = mergeSnapshots(A, B, base);
    expect(r.conflicts).toHaveLength(0);
  });

  it('parentId 并发 reparent → kind=reparent', () => {
    const base = baseDoc();
    addNode(base, { ...n('child', 'c'), parentId: null }, { parentId: [5, 'seed'], content: [1, 'seed'] });
    const A = clone(base) as KBNoteDoc;
    A.nodes[0]!.parentId = 'pA';
    A.sync.nodes!.child!.f!.parentId = [20, 'cA'];
    const B = clone(base) as KBNoteDoc;
    B.nodes[0]!.parentId = 'pB';
    B.sync.nodes!.child!.f!.parentId = [10, 'cB'];
    const r = mergeSnapshots(A, B, base);
    expect(r.conflicts[0]!.kind).toBe('reparent');
    expect(r.doc.nodes.find((x) => x.id === 'child')!.parentId).toBe('pA');
  });
});

describe('mergeSnapshots: 墓碑', () => {
  it('一方删除、另一方编辑 → 墓碑胜且冲突可见', () => {
    const A = baseDoc();
    addNode(A, n('n1', 'A 在编辑'), { content: [50, 'cA'] });
    const B = baseDoc();
    B.sync.nodes = { n1: { t: [60, 'cB'] } };

    const r = mergeSnapshots(A, B);
    expect(r.doc.nodes.find((x) => x.id === 'n1')).toBeUndefined();
    expect(r.doc.sync.nodes!.n1!.t).toEqual([60, 'cB']);
    expect(r.conflicts.length).toBeGreaterThanOrEqual(1);
    // 冲突记录携带删除语义的 reason（summarizeConflicts 产出中文摘要）
    expect(r.conflicts.some((c) => c.reason.includes('删除'))).toBe(true);
    expect(r.summary.length).toBeGreaterThan(0);
  });

  it('墓碑防止旧写入复活', () => {
    // A：节点已删（墓碑 lamport 100），且后来没有新增
    const A = baseDoc();
    A.sync.nodes = { n1: { t: [100, 'cA'] } };
    // B：还在持有的旧节点（lamport 50 < 100）
    const B = baseDoc();
    addNode(B, n('n1', '旧'), { content: [50, 'cB'] });
    const r = mergeSnapshots(A, B);
    expect(r.doc.nodes.find((x) => x.id === 'n1')).toBeUndefined();
  });

  it('两侧都新增、对方无墓碑 → 保留双方', () => {
    const A = baseDoc();
    addNode(A, n('onlyA', 'A'), { content: [5, 'cA'] });
    const B = baseDoc();
    addNode(B, n('onlyB', 'B'), { content: [5, 'cB'] });
    const r = mergeSnapshots(A, B);
    const ids = r.doc.nodes.map((x) => x.id).sort();
    expect(ids).toEqual(['onlyA', 'onlyB']);
  });

  it('节点删除级联的边墓碑传播', () => {
    const A = baseDoc();
    A.sync.edges = { e1: { t: [10, 'cA'] } };
    const B = baseDoc();
    addEdge(B, e('e1', 'n1', 'n2'), { source: [5, 'cB'], target: [5, 'cB'], color: [5, 'cB'] });
    const r = mergeSnapshots(A, B);
    expect(r.doc.edges.find((x) => x.id === 'e1')).toBeUndefined();
    expect(r.doc.sync.edges!.e1!.t).toEqual([10, 'cA']);
  });
});

describe('mergeSnapshots: 悬挂边裁剪（Wave33 Phase B）', () => {
  it('B 给 A 已墓碑删除的节点加边 → 合并后无悬挂边、记 edge-orphaned 冲突', () => {
    // A：节点 X 已删除（墓碑 lamport 60），Y 存活。
    const A = baseDoc();
    addNode(A, n('Y', '存活'), { content: [5, 'cA'] });
    A.sync.nodes!.X = { t: [60, 'cA'] };

    // B：仍持有旧节点 X，并给 X→Y 加了一条边 e1。
    const B = baseDoc();
    addNode(B, n('X', '旧X'), { content: [50, 'cB'] });
    addNode(B, n('Y', '存活'), { content: [5, 'cA'] });
    addEdge(B, e('e1', 'X', 'Y'), { source: [55, 'cB'], target: [55, 'cB'] });

    const r = mergeSnapshots(A, B);
    // 节点 X 被墓碑压制，不在存活集。
    expect(r.doc.nodes.find((x) => x.id === 'X')).toBeUndefined();
    // 边 e1 被丢弃。
    expect(r.doc.edges.find((x) => x.id === 'e1')).toBeUndefined();
    // 结果 edges 只引用存在节点。
    const alive = new Set(r.doc.nodes.map((n) => n.id));
    for (const ed of r.doc.edges) {
      expect(alive.has(ed.source)).toBe(true);
      expect(alive.has(ed.target)).toBe(true);
    }
    // 记了 edge-orphaned 冲突。
    const c = r.conflicts.find((x) => x.entity === 'edge' && x.entityId === 'e1');
    expect(c).toBeDefined();
    expect(c!.kind).toBe('edge-orphaned');
    expect(c!.field).toBe('source'); // X 是 source 端点
    expect(c!.reason).toContain('X');
  });

  it('两端都在存活集合的边保留、不产生冲突', () => {
    const A = baseDoc();
    addNode(A, n('X', 'x'), { content: [5, 'cA'] });
    addNode(A, n('Y', 'y'), { content: [5, 'cA'] });
    const B = clone(A) as KBNoteDoc;
    addEdge(B, e('e1', 'X', 'Y'), { source: [10, 'cB'], target: [10, 'cB'] });

    const r = mergeSnapshots(A, B);
    expect(r.doc.edges.find((x) => x.id === 'e1')).toBeDefined();
    expect(r.conflicts.find((x) => x.entity === 'edge')).toBeUndefined();
  });

  it('自环边（source=target 且节点存活）不被误删', () => {
    const A = baseDoc();
    addNode(A, n('N', 'n'), { content: [5, 'cA'] });
    const B = clone(A) as KBNoteDoc;
    addEdge(B, e('self', 'N', 'N'), { source: [10, 'cB'], target: [10, 'cB'] });

    const r = mergeSnapshots(A, B);
    const self = r.doc.edges.find((x) => x.id === 'self');
    expect(self).toBeDefined();
    expect(self!.source).toBe('N');
    expect(self!.target).toBe('N');
    expect(r.conflicts.find((x) => x.entity === 'edge')).toBeUndefined();
  });

  it('多条边部分悬挂 → 只丢悬挂的，正常边保留', () => {
    const A = baseDoc();
    addNode(A, n('Y', 'y'), { content: [5, 'cA'] });
    A.sync.nodes!.X = { t: [60, 'cA'] }; // X 被删
    const B = baseDoc();
    addNode(B, n('X', '旧X'), { content: [50, 'cB'] });
    addNode(B, n('Y', 'y'), { content: [5, 'cA'] });
    addNode(B, n('Z', 'z'), { content: [5, 'cB'] });
    // e1 悬挂（source=X 已删）；e2 正常（Y→Z 都存活）。
    addEdge(B, e('e1', 'X', 'Y'), { source: [55, 'cB'], target: [55, 'cB'] });
    addEdge(B, e('e2', 'Y', 'Z'), { source: [55, 'cB'], target: [55, 'cB'] });

    const r = mergeSnapshots(A, B);
    expect(r.doc.edges.find((x) => x.id === 'e1')).toBeUndefined();
    expect(r.doc.edges.find((x) => x.id === 'e2')).toBeDefined();
    const orphaned = r.conflicts.filter((x) => x.entity === 'edge');
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0]!.kind).toBe('edge-orphaned');
    expect(orphaned[0]!.entityId).toBe('e1');
  });

  it('端点从未存在（幽灵引用）→ 记 edge-dropped 冲突', () => {
    const A = baseDoc();
    addNode(A, n('Y', 'y'), { content: [5, 'cA'] });
    const B = baseDoc();
    addNode(B, n('Y', 'y'), { content: [5, 'cA'] });
    // B 加了一条边指向从未存在的节点 ghost。
    addEdge(B, e('e_ghost', 'ghost', 'Y'), { source: [10, 'cB'], target: [10, 'cB'] });

    const r = mergeSnapshots(A, B);
    expect(r.doc.edges.find((x) => x.id === 'e_ghost')).toBeUndefined();
    const c = r.conflicts.find((x) => x.entity === 'edge' && x.entityId === 'e_ghost');
    expect(c).toBeDefined();
    expect(c!.kind).toBe('edge-dropped');
    expect(c!.field).toBe('source');
  });

  it('正常无冲突合并不回归（无悬挂边时 conflicts 不增项）', () => {
    const A = baseDoc();
    addNode(A, n('X', 'x'), { content: [5, 'cA'] });
    addNode(A, n('Y', 'y'), { content: [5, 'cA'] });
    addEdge(A, e('e1', 'X', 'Y'), { source: [5, 'cA'], target: [5, 'cA'] });
    const B = clone(A) as KBNoteDoc;
    // B 只改 Y 的内容，不动边。
    B.nodes[1]!.content = { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', text: 'B改' }] } };
    B.sync.nodes!.Y!.f!.content = [10, 'cB'];

    const r = mergeSnapshots(A, B, A);
    expect(r.doc.edges.find((x) => x.id === 'e1')).toBeDefined();
    expect(r.conflicts.filter((x) => x.entity === 'edge')).toHaveLength(0);
  });
});

describe('mergeSnapshots: 幂等与收敛', () => {
  it('重复合入同一 remote 结果文档不变（幂等）', () => {
    const base = baseDoc();
    addNode(base, n('n1', '旧'), { content: [5, 'seed'] });
    const A = clone(base) as KBNoteDoc;
    A.nodes[0]!.content = { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', text: 'A' }] } };
    A.sync.nodes!.n1!.f!.content = [20, 'cA'];
    const B = clone(base) as KBNoteDoc;
    B.nodes[0]!.content = { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', text: 'B' }] } };
    B.sync.nodes!.n1!.f!.content = [10, 'cB'];
    const once = mergeSnapshots(A, B, base);
    const twice = mergeSnapshots(once.doc, B, base);
    // 关键：合入结果文档逐字段不变
    expect(twice.doc).toEqual(once.doc);
  });

  it('合并交换律：merge(A,B) ≡ merge(B,A)', () => {
    const A = baseDoc();
    addNode(A, n('n1', 'A'), { content: [20, 'cA'] });
    addNode(A, n('n2', 'x'), { content: [5, 'seed'] });
    const B = baseDoc();
    addNode(B, n('n1', 'B'), { content: [10, 'cB'] });
    addNode(B, n('n2', 'y'), { content: [30, 'cB'] });

    const ab = mergeSnapshots(A, B);
    const ba = mergeSnapshots(B, A);
    expect(ab.doc).toEqual(ba.doc);
  });

  it('A→B→A 环回收敛', () => {
    // 起点共同
    const seed = baseDoc();
    addNode(seed, n('n1', '共同'), { content: [1, 'seed:doc_1'] });
    addNode(seed, n('n2', '共同'), { content: [1, 'seed:doc_1'] });

    // A 改 n1，B 改 n2
    const A = clone(seed) as KBNoteDoc;
    A.nodes[0]!.content = { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', text: 'A版n1' }] } };
    A.sync.nodes!.n1!.f!.content = [10, 'cA'];
    A.sync.vv = { cA: 10 };

    const B = clone(seed) as KBNoteDoc;
    B.nodes[1]!.content = { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', text: 'B版n2' }] } };
    B.sync.nodes!.n2!.f!.content = [20, 'cB'];
    B.sync.vv = { cB: 20 };

    // A 拉 B
    const A2 = mergeSnapshots(A, B).doc;
    // B 拉 A2
    const B2 = mergeSnapshots(B, A2).doc;
    // A 再拉 B2（环回收尾）
    const A3 = mergeSnapshots(A2, B2).doc;
    expect(A3).toEqual(B2);
    expect(A3.nodes.find((x) => x.id === 'n1')!.content.data.content[0].text).toBe('A版n1');
    expect(A3.nodes.find((x) => x.id === 'n2')!.content.data.content[0].text).toBe('B版n2');
  });
});

describe('mergeSnapshots: 文档/分页字段', () => {
  it('title 并发 LWW', () => {
    const A = baseDoc();
    A.title = 'A标题';
    A.sync.docF = { title: [20, 'cA'] };
    const B = baseDoc();
    B.title = 'B标题';
    B.sync.docF = { title: [10, 'cB'] };
    const r = mergeSnapshots(A, B);
    expect(r.doc.title).toBe('A标题');
    expect(r.conflicts).toHaveLength(1);
  });

  it('assetRefs / links / tags 取并集不丢', () => {
    const A = baseDoc();
    A.assetRefs = ['a1'];
    const B = baseDoc();
    B.assetRefs = ['a2'];
    const r = mergeSnapshots(A, B);
    expect(r.doc.assetRefs.sort()).toEqual(['a1', 'a2']);
  });
});

describe('v2→v3 确定性迁移', () => {
  function v2Doc(): Record<string, unknown> {
    return {
      format: 'knowledge-block-notes',
      version: 2,
      id: 'doc_deterministic',
      title: '迁移',
      board: { createdAt: 1000, updatedAt: 1696000000000 },
      nodes: [
        { id: 'n1', type: 'text', x: 0, y: 0, width: 260, height: 80, content: { format: 'tiptap-json', data: {} } },
        { id: 'n2', type: 'todo', x: 0, y: 0, width: 260, height: 60, content: { format: 'tiptap-json', data: {} }, todo: { checked: true } },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'right', targetHandle: 'left', label: '', directed: true, style: { color: '#888' } }],
      tags: [],
      layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
      viewport: { x: 0, y: 0, zoom: 1 },
      page: { size: 'A4', orientation: 'portrait', marginMm: 15, mode: 'fit', showPageBreak: true, colorMode: 'color', header: false, footer: false, showPageNumbers: false, edgeLabels: true, pageBreaks: [] },
      assetRefs: [],
      links: [],
    };
  }

  it('同一 v2 档迁移两次结果 deep-equal（确定性）', () => {
    const a = migrateV2ToV3(v2Doc());
    const b = migrateV2ToV3(v2Doc());
    expect(a).toEqual(b);
  });

  it('两设备从同一 v2 档升级后戳完全一致', () => {
    const devA = parseKBNote(JSON.stringify(v2Doc())).doc;
    const devB = parseKBNote(JSON.stringify(v2Doc())).doc;
    expect(devA.sync).toEqual(devB.sync);
    expect(devA.sync.nodes!.n1!.f!.content).toEqual([1696000000000, 'seed:doc_deterministic']);
  });

  it('迁移后两端直接合并不产生假冲突', () => {
    const devA = parseKBNote(JSON.stringify(v2Doc())).doc;
    const devB = parseKBNote(JSON.stringify(v2Doc())).doc;
    const r = mergeSnapshots(devA, devB);
    expect(r.conflicts).toHaveLength(0);
    expect(r.doc.nodes).toHaveLength(2);
  });

  it('lamport 取 board.updatedAt，clientId 由 docId 派生', () => {
    expect(migrationLamport({ createdAt: 5, updatedAt: 1696000000000 })).toBe(1696000000000);
    expect(migrationLamport({})).toBe(1);
    expect(seedClientIdFor('doc_x')).toBe('seed:doc_x');
  });

  it('坏输入原样透传，不抛', () => {
    expect(migrateV2ToV3(null)).toBeNull();
    expect(migrateV2ToV3([1, 2])).toEqual([1, 2]);
  });
});

describe('manifest / diff / bundle', () => {
  it('manifestFromDoc 计算 hash/墓碑/资产', () => {
    const d = baseDoc();
    addNode(d, n('n1', 'x'), { content: [1, 'cA'] });
    d.sync.edges = { gone: { t: [5, 'cA'] } };
    d.assetRefs = ['asset_b', 'asset_a'];
    const m = manifestFromDoc(d);
    expect(m.id).toBe('doc_1');
    expect(m.tombstones.edges).toEqual(['gone']);
    expect(m.assets).toEqual(['asset_a', 'asset_b']);
    expect(typeof m.hash).toBe('string');
  });

  it('diffManifests: local-ahead / remote-ahead / concurrent / equal', () => {
    const mk = (vv: Record<string, number>): SyncManifest => ({
      deviceId: 'x',
      docs: {
        d: { id: 'd', title: '', hash: JSON.stringify(vv), version: 3, vv, tombstones: { nodes: [], edges: [] }, assets: [], modifiedAt: 0 },
      },
    });
    expect(diffManifests(mk({ cA: 2 }), mk({ cA: 1 }))['d']).toBe('local-ahead');
    expect(diffManifests(mk({ cA: 1 }), mk({ cA: 2 }))['d']).toBe('remote-ahead');
    expect(diffManifests(mk({ cA: 1 }), mk({ cB: 1 }))['d']).toBe('concurrent');
    expect(diffManifests(mk({ cA: 1 }), mk({ cA: 1 }))['d']).toBe('equal');
  });

  it('diffManifests: local-only / remote-only', () => {
    const local: SyncManifest = { deviceId: 'L', docs: { d: { id: 'd', title: '', hash: 'h', version: 3, vv: {}, tombstones: { nodes: [], edges: [] }, assets: [], modifiedAt: 0 } } };
    const remote: SyncManifest = { deviceId: 'R', docs: { e: { id: 'e', title: '', hash: 'h', version: 3, vv: {}, tombstones: { nodes: [], edges: [] }, assets: [], modifiedAt: 0 } } };
    expect(diffManifests(local, remote)['d']).toBe('local-only');
    expect(diffManifests(local, remote)['e']).toBe('remote-only');
  });

  it('planBundle: 资产按 hash 去重、缺失清单正确', () => {
    const local: SyncManifest = {
      deviceId: 'L',
      docs: {
        d: { id: 'd', title: '', hash: 'h', version: 3, vv: { cA: 1 }, tombstones: { nodes: [], edges: [] }, assets: ['a1'], modifiedAt: 0 },
      },
    };
    const remote: SyncManifest = {
      deviceId: 'R',
      docs: {
        d: { id: 'd', title: '', hash: 'h', version: 3, vv: { cB: 1 }, tombstones: { nodes: [], edges: [] }, assets: ['a1', 'a2'], modifiedAt: 0 },
      },
    };
    const b = planBundle(local, remote);
    expect(b.mergeDocIds).toEqual(['d']);
    expect(b.missingAssets).toEqual(['a2']);
    // a1 已存在，不重复传
    expect(b.missingAssets).not.toContain('a1');
  });

  it('canonicalStringify 键序稳定 / hash 确定性', () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe(canonicalStringify({ a: 2, b: 1 }));
    expect(canonicalHash({ b: 1, a: 2 })).toBe(canonicalHash({ a: 2, b: 1 }));
  });
});

describe('水位 / 收敛判定', () => {
  it('advanceWatermark + hasUnsyncedChanges', () => {
    let cursor = emptyCursor();
    const d = baseDoc();
    addNode(d, n('n1', 'x'), { content: [1, 'cA'] });
    d.sync.vv = { cA: 1 };
    expect(hasUnsyncedChanges(cursor, d)).toBe(true);
    cursor = advanceWatermark(cursor, d);
    expect(hasUnsyncedChanges(cursor, d)).toBe(false);
    // 本地又改了一次
    d.sync.vv = { cA: 2 };
    expect(hasUnsyncedChanges(cursor, d)).toBe(true);
  });

  it('maxPersistedLamport 扫描全部元数据', () => {
    const d = baseDoc();
    addNode(d, n('n1', 'x'), { content: [42, 'cA'] });
    d.sync.edges = { e1: { t: [99, 'cB'] } };
    expect(maxPersistedLamport(d)).toBe(99);
  });
});

describe('坏输入拒绝', () => {
  it('docId 不匹配抛错', () => {
    const A = baseDoc('x');
    const B = baseDoc('y');
    expect(() => mergeSnapshots(A, B)).toThrow(/docId 不匹配/);
  });
});
