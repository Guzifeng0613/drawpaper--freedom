import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  serializeKBNote,
  parseKBNote,
  parseStoredDoc,
  migrate,
  MIGRATION_REGISTRY,
  MIGRATION_NOTES,
  KBNoteFileError,
  importedDocWithFreshId,
  IMPORT_COPY_SUFFIX,
} from './serialize.js';
import { KBNoteParseError, safeParseKBNoteDoc } from '../model/schema.js';
import { createDoc, createNode } from '../model/factory.js';
import { DOC_FORMAT, CURRENT_DOC_VERSION } from '../model/index.js';
import type { KBNoteDoc } from '../model/index.js';

/** 手工构造一份 v1 文档（无 links 字段），模拟旧版 .kbnote。 */
function v1Doc(): Record<string, unknown> {
  return {
    format: DOC_FORMAT,
    version: 1,
    id: 'doc_v1',
    title: '旧版画布',
    board: { createdAt: 0, updatedAt: 0 },
    nodes: [
      {
        id: 'n_1',
        type: 'text',
        x: 0,
        y: 0,
        width: 260,
        height: 80,
        content: { format: 'tiptap-json', data: { type: 'doc' } },
      },
    ],
    edges: [{ id: 'e_1', source: 'n_1', target: 'n_1' }],
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
      edgeLabels: true,
      pageBreaks: [],
    },
    assetRefs: [],
    // 注意：v1 没有 links 字段
  };
}

describe('serialize / parse round-trip', () => {
  it('round-trips a v2 doc losslessly (incl. links/points)', () => {
    const doc = createDoc('往返');
    doc.nodes.push(createNode('text', 10, 20), createNode('group', 0, 0));
    doc.edges.push({
      id: 'e_x',
      source: doc.nodes[0]!.id,
      target: doc.nodes[1]!.id,
      sourceHandle: 'right',
      targetHandle: 'left',
      label: '父子',
      directed: true,
      style: { color: '#86EFAC' },
      points: [{ x: 100, y: 20 }],
    });
    doc.links.push({
      id: 'ln_1',
      sourceDocId: doc.id,
      sourceNodeId: doc.nodes[0]!.id,
      targetDocId: doc.id,
      targetNodeId: doc.nodes[1]!.id,
      targetTitle: 'g',
      createdAt: 123,
    });
    const text = serializeKBNote(doc);
    const { doc: back, migrationNotes } = parseKBNote(text);
    expect(back.id).toBe(doc.id);
    expect(back.version).toBe(4);
    expect(back.nodes).toHaveLength(2);
    expect(back.edges[0]!.label).toBe('父子');
    expect(back.edges[0]!.points).toEqual([{ x: 100, y: 20 }]);
    expect(back.links).toHaveLength(1);
    expect(migrationNotes).toEqual([]);
  });

  it('emits format/version as the first two keys and includes links', () => {
    const text = serializeKBNote(createDoc());
    const lines = text.split('\n');
    expect(lines[1]).toContain('"format"');
    expect(lines[2]).toContain('"version"');
    expect(lines.some((l) => l.includes('"links"'))).toBe(true);
  });
});

describe('v1 -> v2 -> v3 -> v4 migration', () => {
  it('upgrades a v1 doc: version=4, links=[], edges preserved, sync meta injected, notes recorded', () => {
    const { doc, migrationNotes } = parseKBNote(JSON.stringify(v1Doc()));
    expect(doc.version).toBe(4);
    expect(doc.links).toEqual([]);
    expect(doc.edges).toHaveLength(1);
    // 旧边无 points，缺省即默认贝塞尔（undefined）
    expect(doc.edges[0]!.points).toBeUndefined();
    // v2→v3 注入确定性同步元数据
    expect(doc.sync.vv['seed:doc_v1']).toBe(1);
    expect(Object.keys(doc.sync.nodes ?? {})).toContain('n_1');
    expect(migrationNotes).toEqual([MIGRATION_NOTES[1], MIGRATION_NOTES[2], MIGRATION_NOTES[3]]);
  });

  it('v1 doc without links cannot pass v2 schema directly (must migrate)', () => {
    // 直接喂 v1 对象给 v2 schema：version literal 2 不匹配 → 失败。
    const r = safeParseKBNoteDoc(v1Doc());
    expect(r.success).toBe(false);
  });
});

describe('parseStoredDoc（IndexedDB 行宽容解析）', () => {
  it('v2/v3 旧版 IDB 对象先迁移到 v4 再校验，不再被 strict parse 误判坏档', () => {
    // v1/v2/v3 旧版 IDB 行 = 完整 KBNoteDoc 对象（含 format），只是 version 落后。
    const r = parseStoredDoc(v1Doc());
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.doc.version).toBe(4);
      expect(r.doc.id).toBe('doc_v1');
      expect(r.doc.links).toEqual([]);
    }
  });

  it('当前 v4 对象直接通过（无需迁移）', () => {
    const fresh = createDoc('新档');
    const r = parseStoredDoc(JSON.parse(JSON.stringify(fresh)));
    expect(r.success).toBe(true);
  });

  it('真正结构损坏 / 字段类型错 → success:false（隔离为坏档）', () => {
    expect(parseStoredDoc(null).success).toBe(false);
    expect(parseStoredDoc(42).success).toBe(false);
    expect(parseStoredDoc({ id: 'x', board: { updatedAt: 'not-a-number' } }).success).toBe(false);
    expect(parseStoredDoc({ id: 'x', nodes: 'oops' }).success).toBe(false);
  });
});

describe('parseKBNote rejection', () => {
  it('rejects illegal JSON', () => {
    expect(() => parseKBNote('{not json')).toThrow(KBNoteFileError);
    try {
      parseKBNote('{not json');
    } catch (e) {
      expect((e as KBNoteFileError).kind).toBe('invalid-json');
    }
  });

  it('rejects wrong format', () => {
    const bad = JSON.stringify({ format: 'other', version: 1 });
    expect(() => parseKBNote(bad)).toThrow(KBNoteFileError);
    try {
      parseKBNote(bad);
    } catch (e) {
      expect((e as KBNoteFileError).kind).toBe('wrong-format');
    }
  });

  it('rejects a version higher than current with unsupported-version', () => {
    expect(CURRENT_DOC_VERSION).toBe(4);
    const future = JSON.stringify({ format: DOC_FORMAT, version: 99, id: 'x' });
    expect(() => parseKBNote(future)).toThrow(KBNoteFileError);
    try {
      parseKBNote(future);
    } catch (e) {
      expect((e as KBNoteFileError).kind).toBe('unsupported-version');
    }
  });

  it('bad data after migration throws and does not mutate input', () => {
    // v1 doc with an edge whose points is invalid (NaN x) — migration copies it through,
    // but final v2 schema must reject it.
    const bad = v1Doc();
    (bad as Record<string, unknown>)['edges'] = [
      { id: 'e_1', source: 'n_1', target: 'n_1', points: [{ x: NaN, y: 0 }] },
    ];
    const json = JSON.stringify(bad);
    expect(() => parseKBNote(json)).toThrow(KBNoteParseError);
    // 原始字符串未被改动（迁移只在内存发生，调用方当前文档不被污染）
    expect(() => parseKBNote(JSON.stringify(v1Doc()))).not.toThrow();
  });
});

describe('migrate registry', () => {
  let original: Record<number, (raw: unknown) => unknown>;
  beforeEach(() => {
    original = { ...MIGRATION_REGISTRY };
  });
  afterEach(() => {
    for (const k of Object.keys(MIGRATION_REGISTRY)) delete MIGRATION_REGISTRY[Number(k)];
    Object.assign(MIGRATION_REGISTRY, original);
  });

  it('runs registered steps in order across multiple versions (chainable)', () => {
    const calls: string[] = [];
    // current=4。注册假的 v0->1 与 v1->2（覆盖真实 v1->2），从 v0 迁移观察链式顺序；
    // v2->v3 / v3->v4 真实步仍会执行（不入 calls）。
    MIGRATION_REGISTRY[0] = (raw) => {
      calls.push('step0');
      return { ...(raw as object), v0: true };
    };
    MIGRATION_REGISTRY[1] = (raw) => {
      calls.push('step1');
      return { ...(raw as object), v1: true, version: 2 };
    };
    const res = migrate({ hello: 1, version: 0 }, 0);
    expect(calls).toEqual(['step0', 'step1']);
    // step0 + step1 + 真实 v2->v3 + v3->v4 = 4 步
    expect(res.notes).toHaveLength(4);
    expect((res.value as Record<string, unknown>)['v0']).toBe(true);
    expect((res.value as Record<string, unknown>)['v1']).toBe(true);
  });

  it('is identity when fromVersion equals current', () => {
    const raw = { a: 1 };
    const res = migrate(raw, 4);
    expect(res.value).toBe(raw);
    expect(res.notes).toEqual([]);
  });

  it('restores the registry after each test', () => {
    // afterEach 已还原；此处断言真实 v1->2 仍在。
    expect(typeof MIGRATION_REGISTRY[1]).toBe('function');
  });
});

describe('v3 -> v4 migration (asset ref normalization)', () => {
  /** 手工构造一份 v3 文档（带同步块 + 重复/空 assetRefs）。 */
  function v3Doc(): Record<string, unknown> {
    return {
      format: DOC_FORMAT,
      version: 3,
      id: 'doc_v3',
      title: 'v3 旧档',
      board: { createdAt: 1000, updatedAt: 2000 },
      nodes: [
        {
          id: 'n_1',
          type: 'image',
          x: 0, y: 0, width: 200, height: 120,
          content: { format: 'tiptap-json', data: { type: 'doc' } },
        },
      ],
      edges: [],
      tags: [],
      layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
      viewport: { x: 0, y: 0, zoom: 1 },
      page: { size: 'A4', orientation: 'portrait', marginMm: 15, mode: 'fit', showPageBreak: true, colorMode: 'color' },
      // 故意：重复 ref、空串、旧 nanoid、内容 hash 混在一起。
      assetRefs: ['V1StGXR8_Z5jdHi6B-myT', 'V1StGXR8_Z5jdHi6B-myT', '', 'a'.repeat(64)],
      links: [],
      sync: { vv: { cA: 3 }, nodes: { n_1: { f: { content: [3, 'cA'] } } } },
    };
  }

  it('v3 档升级到 v4：assetRefs 去重去空、保留顺序，其余字段不丢', () => {
    const { doc, migrationNotes } = parseKBNote(JSON.stringify(v3Doc()));
    expect(doc.version).toBe(4);
    expect(doc.assetRefs).toEqual(['V1StGXR8_Z5jdHi6B-myT', 'a'.repeat(64)]);
    expect(doc.sync.vv).toEqual({ cA: 3 });
    expect(doc.nodes).toHaveLength(1);
    expect(migrationNotes).toEqual([MIGRATION_NOTES[3]]);
  });

  it('迁移幂等：v4 档再 parse 不改变 assetRefs', () => {
    const { doc: v4 } = parseKBNote(JSON.stringify(v3Doc()));
    const text = serializeKBNote(v4);
    const { doc: again, migrationNotes } = parseKBNote(text);
    expect(again.assetRefs).toEqual(v4.assetRefs);
    expect(again.version).toBe(4);
    expect(migrationNotes).toEqual([]);
  });

  it('往返：v3 → v4 → 导出 v4 → 再 parse，资产 ref 不丢', () => {
    const { doc: v4 } = parseKBNote(JSON.stringify(v3Doc()));
    const text = serializeKBNote(v4);
    const { doc: back } = parseKBNote(text);
    expect(back.assetRefs).toEqual(['V1StGXR8_Z5jdHi6B-myT', 'a'.repeat(64)]);
  });

  it('assetRefs 缺失/非数组时兜底为空数组，不抛', () => {
    const raw = v3Doc();
    delete (raw as Record<string, unknown>)['assetRefs'];
    const { doc } = parseKBNote(JSON.stringify(raw));
    expect(doc.assetRefs).toEqual([]);
  });
});

describe('importedDocWithFreshId（导入碰撞副本）', () => {
  /** 一份带连线的最小合法 v4 文档。 */
  function wiredDoc(): KBNoteDoc {
    const text = JSON.stringify({
      format: DOC_FORMAT,
      version: 4,
      id: 'doc_collide',
      title: '我的画布',
      board: { createdAt: 111, updatedAt: 222 },
      nodes: [
        { id: 'n_1', type: 'text', x: 0, y: 0, width: 260, height: 80, parentId: null, content: { format: 'tiptap-json', data: { type: 'doc' } } },
        { id: 'n_2', type: 'text', x: 300, y: 0, width: 260, height: 80, parentId: 'n_1', content: { format: 'tiptap-json', data: { type: 'doc' } } },
      ],
      edges: [{ id: 'e_1', source: 'n_1', target: 'n_2' }],
      tags: [{ id: 't_1', name: 'a', color: '#fff' }],
      layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
      viewport: { x: 0, y: 0, zoom: 1 },
      page: {
        size: 'A4', orientation: 'portrait', marginMm: 15, mode: 'fit',
        showPageBreak: true, colorMode: 'color', header: false, footer: false,
        showPageNumbers: false, edgeLabels: true, pageBreaks: [],
      },
      assetRefs: ['a'.repeat(64)],
      links: [
        {
          id: 'ln_1',
          sourceDocId: 'doc_collide',
          sourceNodeId: 'n_1',
          targetDocId: 'doc_collide',
          targetNodeId: 'n_2',
          targetTitle: '块二',
          createdAt: 500,
        },
        {
          id: 'ln_2',
          sourceDocId: 'doc_collide',
          sourceNodeId: 'n_2',
          targetDocId: 'doc_other',
          targetNodeId: 'n_x',
          targetTitle: '他文档块',
          createdAt: 600,
        },
      ],
      sync: { vv: { cA: 5 }, nodes: { n_1: { f: { x: [5, 'cA'] } } }, edges: { e_1: { t: [4, 'cB'] } } },
    });
    return parseKBNote(text).doc;
  }

  it('分配新 doc id：不与原 id 撞，带 doc_ 前缀', () => {
    const src = wiredDoc();
    const copy = importedDocWithFreshId(src);
    expect(copy.id).not.toBe(src.id);
    expect(copy.id).toMatch(/^doc_[A-Za-z0-9_-]{10,}$/);
  });

  it('标题追加导入副本后缀', () => {
    const copy = importedDocWithFreshId(wiredDoc());
    expect(copy.title).toBe(`我的画布${IMPORT_COPY_SUFFIX}`);
  });

  it('内部节点/边/标签 id 集合原样保留', () => {
    const src = wiredDoc();
    const copy = importedDocWithFreshId(src);
    expect(copy.nodes.map((n) => n.id)).toEqual(src.nodes.map((n) => n.id));
    expect(copy.edges.map((e) => e.id)).toEqual(src.edges.map((e) => e.id));
    expect(copy.tags.map((t) => t.id)).toEqual(src.tags.map((t) => t.id));
  });

  it('边 source/target 与节点 parentId 引用仍闭合', () => {
    const copy = importedDocWithFreshId(wiredDoc());
    const nodeIds = new Set(copy.nodes.map((n) => n.id));
    for (const e of copy.edges) {
      expect(nodeIds.has(e.source)).toBe(true);
      expect(nodeIds.has(e.target)).toBe(true);
    }
    for (const n of copy.nodes) {
      if (n.parentId) expect(nodeIds.has(n.parentId)).toBe(true);
    }
  });

  it('其余字段（board/assetRefs/sync）原样保留', () => {
    const src = wiredDoc();
    const copy = importedDocWithFreshId(src);
    expect(copy.board).toEqual(src.board);
    expect(copy.assetRefs).toEqual(src.assetRefs);
    expect(copy.sync).toEqual(src.sync);
  });

  it('fork 后所有 link.sourceDocId 改写为新 doc id', () => {
    const copy = importedDocWithFreshId(wiredDoc());
    for (const l of copy.links) {
      expect(l.sourceDocId).toBe(copy.id);
      expect(l.sourceDocId).not.toBe('doc_collide');
    }
  });

  it('文档内 link（targetDocId===旧 id）targetDocId 同步改写为新 id', () => {
    const copy = importedDocWithFreshId(wiredDoc());
    const intra = copy.links.find((l) => l.id === 'ln_1');
    expect(intra?.targetDocId).toBe(copy.id);
  });

  it('跨文档 link（targetDocId!==旧 id）targetDocId 保持不变', () => {
    const copy = importedDocWithFreshId(wiredDoc());
    const cross = copy.links.find((l) => l.id === 'ln_2');
    expect(cross?.targetDocId).toBe('doc_other');
  });

  it('link 自身 id / sourceNodeId / targetNodeId / targetTitle / createdAt 保留', () => {
    const src = wiredDoc();
    const copy = importedDocWithFreshId(src);
    expect(copy.links.map((l) => l.id)).toEqual(src.links.map((l) => l.id));
    for (const [i, l] of copy.links.entries()) {
      const s = src.links[i];
      expect(l.sourceNodeId).toBe(s.sourceNodeId);
      expect(l.targetNodeId).toBe(s.targetNodeId);
      expect(l.targetTitle).toBe(s.targetTitle);
      expect(l.createdAt).toBe(s.createdAt);
    }
  });

  it('连续两次 fork 得到两个互不相同的新 id', () => {
    const src = wiredDoc();
    const c1 = importedDocWithFreshId(src);
    const c2 = importedDocWithFreshId(src);
    expect(c1.id).not.toBe(src.id);
    expect(c2.id).not.toBe(src.id);
    expect(c1.id).not.toBe(c2.id);
  });
});
