import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEditorStore } from './store.js';
import type { EditorStoreApi } from './store.js';
import type { BlockNode, Edge, KBNoteDoc } from '../model/index.js';
import { deriveLinkId } from '../links/index.js';

let store: EditorStoreApi;

function mkNode(id: string, x = 0, y = 0): BlockNode {
  return {
    id,
    type: 'text',
    x,
    y,
    width: 220,
    height: 80,
    content: { format: 'tiptap-json', data: { type: 'doc', content: [] } },
    parentId: null,
    pinned: false,
    locked: false,
    collapsed: false,
    tags: [],
    style: {},
  };
}

function mkEdge(id: string, source: string, target: string): Edge {
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

function baseDoc(nodes: BlockNode[], edges: Edge[]): KBNoteDoc {
  return {
    format: 'knowledge-block-notes',
    version: 1,
    id: 'doc1',
    title: 't',
    board: { createdAt: 0, updatedAt: 0 },
    nodes,
    edges,
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
  };
}

/** 无冲突 analyzer（默认）：避免命中未实现的 graph.detectConflicts。 */
function noopAnalyzer() {
  return () => ({ multiParents: [], cycles: [] });
}

/** 简单多父检测 stub：入边 >1 即多父。 */
function multiParentAnalyzer() {
  return (nodes: BlockNode[], edges: Edge[]) => {
    const incoming = new Map<string, string[]>();
    for (const e of edges) {
      const list = incoming.get(e.target) ?? [];
      list.push(e.id);
      incoming.set(e.target, list);
    }
    const multiParents = [...incoming.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([nodeId, parentEdgeIds]) => ({
        nodeId,
        parentEdgeIds,
        parentIds: parentEdgeIds
          .map((id) => edges.find((e) => e.id === id)?.source)
          .filter((x): x is string => Boolean(x)),
      }));
    return { multiParents, cycles: [] };
  };
}

describe('EditorStore 节点 CRUD', () => {
  beforeEach(() => {
    store = createEditorStore(baseDoc([mkNode('a')], []), { analyzer: noopAnalyzer() });
  });

  it('addNode / deleteNode cascades edges', () => {
    const id = store.getState().addNode('text', 10, 10);
    expect(store.getState().doc.nodes.map((n) => n.id)).toContain(id);
    store.getState().addEdge('a', id);
    expect(store.getState().doc.edges).toHaveLength(1);
    store.getState().deleteNode(id);
    expect(store.getState().doc.nodes.map((n) => n.id)).not.toContain(id);
    expect(store.getState().doc.edges).toHaveLength(0);
  });

  it('move/resize/content coalesce and undo restores original', () => {
    store.getState().setSelection(['a']);
    store.getState().moveNode('a', 100, 100);
    store.getState().moveNode('a', 120, 120);
    store.getState().resizeNode('a', 300, 200);
    store.getState().updateContent('a', { text: 'v2' });
    store.getState().updateContent('a', { text: 'v3' });
    const node = () => store.getState().doc.nodes.find((n) => n.id === 'a')!;
    expect(node().x).toBe(120);
    expect(node().width).toBe(300);
    expect(node().content.data).toEqual({ text: 'v3' });
    // undo content（coalesced：一次回到编辑前）
    store.getState().undo();
    expect(node().content.data).toEqual({ type: 'doc', content: [] });
    // undo resize
    store.getState().undo();
    expect(node().width).toBe(220);
    // undo move (coalesced) -> back to 0,0
    store.getState().undo();
    expect(node().x).toBe(0);
    expect(node().y).toBe(0);
  });
});

describe('Tab / Enter / Shift+Tab', () => {
  it('builds and rewires tree structure', () => {
    store = createEditorStore(baseDoc([mkNode('root')], []), { analyzer: noopAnalyzer() });
    store.getState().setEditingNode('root');
    store.getState().tabAddChild();
    const child = store.getState().doc.nodes.find((n) => n.id !== 'root')!;
    expect(store.getState().doc.edges.map((e) => [e.source, e.target])).toEqual([['root', child.id]]);

    store.getState().setEditingNode(child.id);
    store.getState().enterAddSibling();
    expect(store.getState().doc.edges).toHaveLength(2);

    // Shift+Tab on child: remove root->child (root has no parent, so child becomes root)
    store.getState().setEditingNode(child.id);
    store.getState().shiftTabDemote();
    expect(store.getState().doc.edges.find((e) => e.target === child.id)).toBeUndefined();
  });
});

describe('冲突裁决（多父 / 成环 / 取消）', () => {
  it('multi-parent resolution keeps chosen primary and deletes others; undo restores', async () => {
    const resolver = vi.fn().mockResolvedValue({ choosePrimaryParent: { c: 'e1' }, breakEdgeIds: [] });
    store = createEditorStore(
      baseDoc([mkNode('a'), mkNode('b'), mkNode('c')], [mkEdge('e1', 'a', 'c')]),
      { analyzer: multiParentAnalyzer(), resolveConflictUi: resolver },
    );
    store.getState().addEdge('b', 'c');
    expect(resolver).toHaveBeenCalledTimes(1);
    // 等待 promise 结算
    await vi.waitFor(() => {
      expect(store.getState().doc.edges.map((e) => e.id)).toEqual(['e1']);
    });
    // undo 裁决宏，恢复 b->c
    store.getState().undo();
    expect(store.getState().doc.edges).toHaveLength(2);
  });

  it('cancel resolution rolls back the triggered edge', async () => {
    const resolver = vi.fn().mockResolvedValue(null);
    store = createEditorStore(
      baseDoc([mkNode('a'), mkNode('b'), mkNode('c')], [mkEdge('e1', 'a', 'c')]),
      { analyzer: multiParentAnalyzer(), resolveConflictUi: resolver },
    );
    store.getState().addEdge('b', 'c');
    await vi.waitFor(() => {
      expect(store.getState().doc.edges.map((e) => e.id)).toEqual(['e1']);
    });
  });

  it('cycle resolution breaks chosen edge', async () => {
    const resolver = vi.fn().mockResolvedValue({ choosePrimaryParent: {}, breakEdgeIds: ['ey'] });
    store = createEditorStore(
      baseDoc([mkNode('a'), mkNode('b')], [mkEdge('ey', 'a', 'b'), mkEdge('ex', 'b', 'a')]),
      {
        analyzer: () => ({ multiParents: [], cycles: [{ nodeIds: ['a', 'b'], edgeIds: ['ex', 'ey'] }] }),
        resolveConflictUi: resolver,
      },
    );
    store.getState().addEdge('a', 'b'); // duplicate -> ignored, but trigger conflict path manually
    // 直接调 resolveConflicts 触发断边
    store.setState((s) => {
      s.pendingConflicts = { multiParents: [], cycles: [{ nodeIds: ['a', 'b'], edgeIds: ['ex', 'ey'] }], triggerEdgeIds: [] };
    });
    store.getState().resolveConflicts({ choosePrimaryParent: {}, breakEdgeIds: ['ey'] });
    expect(store.getState().doc.edges.map((e) => e.id)).toEqual(['ex']);
  });
});

describe('布局预览 / 确认（宏单次 undo）', () => {
  it('confirmLayout places nodes and a single undo restores all', () => {
    store = createEditorStore(baseDoc([mkNode('a', 0, 0)], []), {
      analyzer: noopAnalyzer(),
      layoutEngine: () => ({ positions: { a: { x: 500, y: 300 } } }),
    });
    store.getState().setMeasuredSizes({ a: { width: 220, height: 80 } });
    store.getState().previewLayout();
    expect(store.getState().layoutPreview).toEqual({ a: { x: 500, y: 300 } });
    store.getState().confirmLayout();
    const node = store.getState().doc.nodes[0]!;
    expect(node.x).toBe(500);
    expect(store.getState().layoutPreview).toBeNull();
    store.getState().undo();
    expect(store.getState().doc.nodes[0]!.x).toBe(0);
  });
});

describe('自动保存 500ms 防抖', () => {
  it('saves only once after burst of mutations and sets savedAt', async () => {
    vi.useFakeTimers();
    const saveDoc = vi.fn().mockResolvedValue(undefined);
    const t = 1000;
    store = createEditorStore(baseDoc([mkNode('a')], []), {
      analyzer: noopAnalyzer(),
      storage: { saveDoc, loadDoc: vi.fn(), listDocs: vi.fn().mockResolvedValue([]), deleteDoc: vi.fn(), getAsset: vi.fn(), putAsset: vi.fn(), deleteAsset: vi.fn() },
      now: () => t,
    });
    store.getState().addNode('text', 1, 1);
    store.getState().moveNode('a', 5, 5);
    store.getState().updateContent('a', { t: 1 });
    expect(saveDoc).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    await vi.waitFor(() => expect(saveDoc).toHaveBeenCalledTimes(1));
    expect(store.getState().saveState).toBe('saved');
    expect(store.getState().savedAt).toBe(1000);
    vi.useRealTimers();
  });
});

describe('剪贴板 / 导入导出', () => {
  it('paste remaps ids with no leftover references', () => {
    store = createEditorStore(
      baseDoc([mkNode('n1', 0, 0), mkNode('n2', 300, 0)], [mkEdge('e1', 'n1', 'n2')]),
      { analyzer: noopAnalyzer() },
    );
    store.getState().setSelection(['n1', 'n2']);
    store.getState().copy();
    store.getState().paste();
    const ids = store.getState().doc.nodes.map((n) => n.id);
    expect(ids).toHaveLength(4);
    // 新粘贴的边不引用旧 id（保留原边 e1）
    const oldIds = new Set(['n1', 'n2']);
    const newEdges = store.getState().doc.edges.filter((e) => e.id !== 'e1');
    for (const e of newEdges) {
      expect(oldIds.has(e.source)).toBe(false);
      expect(oldIds.has(e.target)).toBe(false);
    }
  });

  it('export/import round-trips through serialize', () => {
    store = createEditorStore(baseDoc([mkNode('a')], []), { analyzer: noopAnalyzer() });
    store.getState().addNode('heading', 20, 20);
    const text = store.getState().exportKBNoteText();
    store.getState().importKBNoteText(text);
    expect(store.getState().doc.nodes.map((n) => n.id)).toHaveLength(2);
  });
});

describe('P2.1 弯折点随块移动 / 多选清空宏', () => {
  it('拖动 source 块 → 该边弯折点按位移平移；undo 一并回退', () => {
    const a = mkNode('a', 0, 0);
    const b = mkNode('b', 300, 0);
    const e = mkEdge('e1', 'a', 'b');
    e.points = [{ x: 100, y: 50 }];
    store = createEditorStore(baseDoc([a, b], [e]), { analyzer: noopAnalyzer() });
    // source(a) 从 (0,0) 拖到 (50,20) → 弯折点 (100,50) 平移到 (150,70)
    store.getState().moveNode('a', 50, 20);
    let pts = store.getState().doc.edges.find((ed) => ed.id === 'e1')!.points!;
    expect(pts).toEqual([{ x: 150, y: 70 }]);
    // undo：节点与弯折点同时回到原点
    store.getState().undo();
    pts = store.getState().doc.edges.find((ed) => ed.id === 'e1')!.points!;
    expect(pts).toEqual([{ x: 100, y: 50 }]);
    expect(store.getState().doc.nodes.find((n) => n.id === 'a')!.x).toBe(0);
  });

  it('只拖动 target 块 → 弯折点不动（刚性锚定 source）', () => {
    const a = mkNode('a', 0, 0);
    const b = mkNode('b', 300, 0);
    const e = mkEdge('e1', 'a', 'b');
    e.points = [{ x: 100, y: 50 }];
    store = createEditorStore(baseDoc([a, b], [e]), { analyzer: noopAnalyzer() });
    store.getState().moveNode('b', 360, 80);
    const pts = store.getState().doc.edges.find((ed) => ed.id === 'e1')!.points!;
    expect(pts).toEqual([{ x: 100, y: 50 }]);
  });

  it('两端同移（多选手势）→ 弯折点只随 source 平移一次，不重复平移', () => {
    const a = mkNode('a', 0, 0);
    const b = mkNode('b', 300, 0);
    const e = mkEdge('e1', 'a', 'b');
    e.points = [{ x: 100, y: 50 }];
    store = createEditorStore(baseDoc([a, b], [e]), { analyzer: noopAnalyzer() });
    // 模拟多选手势：两端各 +60,+10（source 平一次，target 不平）
    store.getState().moveNode('a', 60, 10);
    store.getState().moveNode('b', 360, 10);
    const pts = store.getState().doc.edges.find((ed) => ed.id === 'e1')!.points!;
    expect(pts).toEqual([{ x: 160, y: 60 }]);
  });

  it('clearEdgesPoints：多选边一次宏清空，undo 一次恢复全部', () => {
    const a = mkNode('a', 0, 0);
    const b = mkNode('b', 300, 0);
    const c = mkNode('c', 600, 0);
    const e1 = mkEdge('e1', 'a', 'b');
    e1.points = [{ x: 100, y: 50 }, { x: 200, y: 50 }];
    const e2 = mkEdge('e2', 'b', 'c');
    e2.points = [{ x: 400, y: 50 }];
    const e3 = mkEdge('e3', 'a', 'c'); // 无弯折点，应被跳过
    store = createEditorStore(baseDoc([a, b, c], [e1, e2, e3]), { analyzer: noopAnalyzer() });
    store.getState().clearEdgesPoints(['e1', 'e2', 'e3']);
    expect(store.getState().doc.edges.find((e) => e.id === 'e1')!.points).toBeUndefined();
    expect(store.getState().doc.edges.find((e) => e.id === 'e2')!.points).toBeUndefined();
    // 一次 undo 恢复 e1/e2 的原弯折点（宏 = 一个撤销单元）
    store.getState().undo();
    expect(store.getState().doc.edges.find((e) => e.id === 'e1')!.points).toEqual([
      { x: 100, y: 50 },
      { x: 200, y: 50 },
    ]);
    expect(store.getState().doc.edges.find((e) => e.id === 'e2')!.points).toEqual([{ x: 400, y: 50 }]);
  });
});

describe('applyRemoteDoc（Wave9 协作：远端合并落库）', () => {
  beforeEach(() => {
    store = createEditorStore(baseDoc([mkNode('a')], []), { analyzer: noopAnalyzer() });
  });

  it('把远端 doc 作为新基线落库，且不进 undo 栈', () => {
    // 本地先做一次可撤销编辑。
    store.getState().moveNode('a', 50, 50);
    expect(store.getState().canUndo).toBe(true);

    // 远端合并：换一份含远端节点 b 的 doc。
    const remote = baseDoc([mkNode('a'), mkNode('b', 300, 0)], []);
    store.getState().applyRemoteDoc(remote);

    expect(store.getState().doc.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(store.getState().doc.nodes.find((n) => n.id === 'b')!.x).toBe(300);
    // 远端 op 不进 undo：撤销栈基线已重置，不能再撤销到本地 move。
    expect(store.getState().canUndo).toBe(false);
  });
});

describe('Wave30 undo/redo correctness', () => {
  beforeEach(() => {
    store = createEditorStore(baseDoc([mkNode('a'), mkNode('b')], []), { analyzer: noopAnalyzer() });
  });

  it('renameDoc undo restores old title and redo re-applies', () => {
    expect(store.getState().doc.title).toBe('t');
    store.getState().renameDoc('新标题');
    expect(store.getState().doc.title).toBe('新标题');
    expect(store.getState().canUndo).toBe(true);
    store.getState().undo();
    expect(store.getState().doc.title).toBe('t'); // 修复前：undo 是恒等，标题仍为「新标题」且白耗一步
    expect(store.getState().canRedo).toBe(true);
    store.getState().redo();
    expect(store.getState().doc.title).toBe('新标题');
  });

  it('two renames undo in reverse order', () => {
    store.getState().renameDoc('v1');
    store.getState().renameDoc('v2');
    store.getState().undo();
    expect(store.getState().doc.title).toBe('v1');
    store.getState().undo();
    expect(store.getState().doc.title).toBe('t');
  });

  it('link-cleanup macro undo/redo roundtrips docRef marks and cascade edges', () => {
    // 'a' 正文带一条指向外部块的 docRef mark；删除带连线的 b 时级联摘除该 mark。
    const td = 'docX';
    const tn = 'nX';
    const withMark = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '见下', marks: [{ type: 'docRef', attrs: { targetDocId: td, targetNodeId: tn, targetTitle: '目标' } }] },
          ],
        },
      ],
    };
    store.getState().updateContent('a', withMark);
    const linkId = deriveLinkId('doc1', 'a', td, tn);
    const aData = () => store.getState().doc.nodes.find((n) => n.id === 'a')!.content.data;
    const hasMark = () => JSON.stringify(aData()).includes('docRef');
    expect(hasMark()).toBe(true);

    store.getState().addEdge('a', 'b');
    store.getState().deleteNodesWithLinkCleanup(['b'], new Set([linkId]));
    // mark 被摘、b 与边被删
    expect(hasMark()).toBe(false);
    expect(store.getState().doc.nodes.map((n) => n.id)).not.toContain('b');
    expect(store.getState().doc.edges).toHaveLength(0);

    // undo：mark 与 b/边整体还原
    store.getState().undo();
    expect(hasMark()).toBe(true);
    expect(store.getState().doc.nodes.map((n) => n.id)).toContain('b');
    expect(store.getState().doc.edges).toHaveLength(1);

    // redo：strip 子命令基于当前输入重算（不再硬编码 capture 快照），mark 再摘、b 再删
    store.getState().redo();
    expect(hasMark()).toBe(false);
    expect(store.getState().doc.nodes.map((n) => n.id)).not.toContain('b');
    expect(store.getState().doc.edges).toHaveLength(0);
  });

  it('link-cleanup macro redo without drift equals normal deletion', () => {
    store.getState().addEdge('a', 'b');
    store.getState().deleteNodesWithLinkCleanup(['b'], new Set());
    store.getState().undo();
    expect(store.getState().doc.edges).toHaveLength(1);
    store.getState().redo();
    expect(store.getState().doc.nodes.map((n) => n.id)).not.toContain('b');
    expect(store.getState().doc.edges).toHaveLength(0);
  });
});

describe('本地自动保存失败不再静默', () => {
  function makeStorage(impl: { saveDoc: ReturnType<typeof vi.fn> }) {
    return {
      saveDoc: impl.saveDoc,
      loadDoc: vi.fn(),
      listDocs: vi.fn().mockResolvedValue([]),
      deleteDoc: vi.fn(),
      getAsset: vi.fn(),
      putAsset: vi.fn(),
      deleteAsset: vi.fn(),
    };
  }

  it('Dexie 主保存遇 QuotaExceededError → saveState=error、onSaveError 收到 quota、重试后 saved', async () => {
    vi.useFakeTimers();
    const onSaveError = vi.fn();
    const saveDoc = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('quota', 'QuotaExceededError'))
      .mockResolvedValueOnce(undefined);
    store = createEditorStore(baseDoc([mkNode('a')], []), {
      analyzer: noopAnalyzer(),
      storage: makeStorage({ saveDoc }),
      onSaveError,
      now: () => 1000,
    });
    store.getState().addNode('text', 1, 1);
    vi.advanceTimersByTime(500);
    await vi.waitFor(() => expect(saveDoc).toHaveBeenCalledTimes(1));
    // 失败：显式 error 态 + 配额钩子（不再吞成 idle）。
    expect(store.getState().saveState).toBe('error');
    expect(onSaveError).toHaveBeenCalledWith('quota', expect.any(String));
    // 手动重试一次 → 成功回 saved。
    store.getState().retrySave();
    await vi.waitFor(() => expect(saveDoc).toHaveBeenCalledTimes(2));
    expect(store.getState().saveState).toBe('saved');
    vi.useRealTimers();
  });

  it('普通写盘错误 → onSaveError 收到 write-failed', async () => {
    vi.useFakeTimers();
    const onSaveError = vi.fn();
    const saveDoc = vi.fn().mockRejectedValue(new Error('IndexedDB vanished'));
    store = createEditorStore(baseDoc([mkNode('a')], []), {
      analyzer: noopAnalyzer(),
      storage: makeStorage({ saveDoc }),
      onSaveError,
      now: () => 1000,
    });
    store.getState().addNode('text', 1, 1);
    vi.advanceTimersByTime(500);
    await vi.waitFor(() => expect(saveDoc).toHaveBeenCalledTimes(1));
    expect(store.getState().saveState).toBe('error');
    expect(onSaveError).toHaveBeenCalledWith('write-failed', expect.any(String));
    vi.useRealTimers();
  });
});
