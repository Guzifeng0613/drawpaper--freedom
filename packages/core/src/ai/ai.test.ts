import { describe, it, expect } from 'vitest';
import { validateAiOutput, buildAiMessages, applyAiSuggestions, detectAiGaps, extractNodePlainText } from './index.js';
import { createDoc, createNode, createEdge } from '../model/factory.js';
import type { KBNoteDoc } from '../model/index.js';

function makeDoc(): KBNoteDoc {
  const doc = createDoc('测试画布');
  const mk = (id: string, type: 'heading' | 'text') => {
    const n = createNode(type, 0, 0);
    n.id = id;
    return n;
  };
  const root = mk('n_root', 'heading');
  const a = mk('n_a', 'text');
  const b = mk('n_b', 'text');
  doc.nodes = [root, a, b];
  doc.edges = [createEdge('n_root', 'n_a', { id: 'e1' })];
  return doc;
}

describe('validateAiOutput', () => {
  const ids = new Set(['n_root', 'n_a', 'n_b']);

  it('接受全部 5 类合法建议', () => {
    const raw = [
      { kind: 'add-edge', reason: 'a 应是 b 的父', source: 'n_a', target: 'n_b' },
      { kind: 'set-root', reason: 'root 是根', rootNodeId: 'n_root' },
      { kind: 'group', reason: 'a/b 同类', memberNodeIds: ['n_a', 'n_b'], title: '小节' },
      { kind: 'split-block', reason: 'a 太长', targetNodeId: 'n_a', afterText: '第二段' },
      { kind: 'summarize', reason: 'a 啰嗦', targetNodeId: 'n_a', newText: '摘要' },
    ];
    const r = validateAiOutput(raw, ids);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.suggestions).toHaveLength(5);
  });

  it('丢弃臆造 id 的条目，保留合法条', () => {
    const raw = [
      { kind: 'add-edge', reason: 'ok', source: 'n_a', target: 'n_b' },
      { kind: 'add-edge', reason: 'bad', source: 'n_a', target: 'n_ghost' },
    ];
    const r = validateAiOutput(raw, ids);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.suggestions).toHaveLength(1);
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });

  it('丢弃缺 reason / 自环', () => {
    const r = validateAiOutput(
      [
        { kind: 'add-edge', reason: '', source: 'n_a', target: 'n_b' },
        { kind: 'add-edge', reason: 'self', source: 'n_a', target: 'n_a' },
      ],
      ids,
    );
    expect(r.ok).toBe(false);
  });

  it('坏 JSON（非数组/空）返回 ok:false', () => {
    expect(validateAiOutput('not json' as never, ids).ok).toBe(false);
    expect(validateAiOutput([], ids).ok).toBe(false);
  });
});

describe('applyAiSuggestions', () => {
  it('add-edge 去重建边，未勾选丢弃，幂等', () => {
    const doc = makeDoc();
    const suggestions = [
      { kind: 'add-edge' as const, reason: 'x', source: 'n_a', target: 'n_b' },
      { kind: 'add-edge' as const, reason: 'dup', source: 'n_root', target: 'n_a' },
    ];
    const r = applyAiSuggestions(doc, suggestions, new Set([0]));
    expect(r.applied).toBe(1);
    expect(r.doc.edges.some((e) => e.source === 'n_a' && e.target === 'n_b')).toBe(true);
    // 幂等：再合入同一条不重复建边
    const r2 = applyAiSuggestions(r.doc, suggestions, new Set([0]));
    expect(r2.skipped.length).toBeGreaterThan(0);
  });

  it('group 建 group 块并 reparent', () => {
    const doc = makeDoc();
    const r = applyAiSuggestions(
      doc,
      [{ kind: 'group', reason: 'g', memberNodeIds: ['n_a', 'n_b'], title: '组' }],
      new Set([0]),
    );
    const groupNode = r.doc.nodes.find((n) => n.type === 'group');
    expect(groupNode).toBeDefined();
    expect(r.doc.nodes.find((n) => n.id === 'n_a')!.parentId).toBe(groupNode!.id);
  });

  it('split-block 建兄弟块；summarize 替换文本；set-root 只标注', () => {
    const doc = makeDoc();
    const r = applyAiSuggestions(
      doc,
      [
        { kind: 'split-block', reason: 's', targetNodeId: 'n_a', afterText: '新段落' },
        { kind: 'summarize', reason: 'm', targetNodeId: 'n_b', newText: '凝练' },
        { kind: 'set-root', reason: 'r', rootNodeId: 'n_root' },
      ],
      new Set([0, 1, 2]),
    );
    expect(r.doc.nodes.some((n) => n.type === 'text' && extractNodePlainText(n.content.data) === '新段落')).toBe(true);
    expect(extractNodePlainText(r.doc.nodes.find((n) => n.id === 'n_b')!.content.data)).toBe('凝练');
    expect(r.notes.some((n) => n.includes('n_root'))).toBe(true);
  });
});

describe('buildAiMessages', () => {
  it('包含全部节点 id 与现有边', () => {
    const doc = makeDoc();
    const msgs = buildAiMessages(doc, 'organize');
    const user = msgs[1]!.content;
    expect(user).toContain('n_root');
    expect(user).toContain('n_a');
    expect(user).toContain('n_b');
    expect(user).toContain('n_root -> n_a');
  });
});

describe('detectAiGaps', () => {
  it('找出空叶子块与游离块', () => {
    const doc = makeDoc();
    // n_b 无文字（空 content），且没有任何边连它
    doc.nodes.find((n) => n.id === 'n_b')!.content = { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph' }] } };
    const gaps = detectAiGaps(doc);
    expect(gaps.some((g) => g.kind === 'empty-leaf' && g.nodeIds.includes('n_b'))).toBe(true);
    expect(gaps.some((g) => g.kind === 'orphan-node' && g.nodeIds.includes('n_b'))).toBe(true);
  });
});

describe('extractNodePlainText 非 Tiptap 块型鸭子类型', () => {
  it('equation 数据提取 source 字段', () => {
    expect(extractNodePlainText({ kind: 'equation', source: 'E=mc^2' })).toBe('E=mc^2');
  });

  it('bookmark 数据优先取 url，其次 title', () => {
    expect(extractNodePlainText({ url: 'https://example.com', title: '示例页面' })).toBe('https://example.com');
    expect(extractNodePlainText({ title: '仅标题' })).toBe('仅标题');
  });

  it('attachment 数据取 name 字段', () => {
    expect(extractNodePlainText({ assetRef: 'abc', name: '报告.pdf' })).toBe('报告.pdf');
  });

  it('reminder 数据取 note 字段', () => {
    expect(extractNodePlainText({ dueAt: 1700000000, note: '周一开会' })).toBe('周一开会');
  });

  it('Tiptap 文本节点提取结果不变（回归）', () => {
    const tiptapDoc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }] },
      ],
    };
    expect(extractNodePlainText(tiptapDoc)).toBe('Hello world');
  });

  it('Tiptap 纯文本叶子节点提取结果不变（回归）', () => {
    expect(extractNodePlainText({ type: 'text', text: '单行文字' })).toBe('单行文字');
  });

  it('空对象 / null / 非对象安全返回空串', () => {
    expect(extractNodePlainText({})).toBe('');
    expect(extractNodePlainText(null)).toBe('');
    expect(extractNodePlainText(undefined)).toBe('');
    expect(extractNodePlainText('字符串')).toBe('');
    expect(extractNodePlainText(42)).toBe('');
  });

  it('空字符串字段不被收集', () => {
    expect(extractNodePlainText({ source: '', url: 'https://ok.com' })).toBe('https://ok.com');
    expect(extractNodePlainText({ source: '   ' })).toBe('');
  });
});
