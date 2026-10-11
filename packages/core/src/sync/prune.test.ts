import { describe, it, expect } from 'vitest';
import type { KBNoteDoc, BlockNode } from '../model/index.js';
import { createDoc, createNode } from '../model/index.js';
import {
  pruneTombstones,
  safeTombstoneWatermark,
  DEFAULT_MAX_TOMBSTONES,
  mergeSnapshots,
} from './index.js';
import type { EntitySyncMeta, FMarkTuple } from './types.js';

type Mark = [number, string];

/** 构造一个带指定 vv 与墓碑的文档（节点/边本体均为空，纯测墓碑）。 */
function docWith(opts: {
  vv: Record<string, number>;
  id?: string;
  nodeToms?: Record<string, Mark>;
  edgeToms?: Record<string, Mark>;
}): KBNoteDoc {
  const d = createDoc('墓碑裁剪测试');
  if (opts.id) d.id = opts.id;
  d.sync = { vv: { ...opts.vv } };
  if (opts.nodeToms) {
    d.sync.nodes = Object.fromEntries(
      Object.entries(opts.nodeToms).map(([id, t]) => [id, { t: [...t] as FMarkTuple } as EntitySyncMeta]),
    );
  }
  if (opts.edgeToms) {
    d.sync.edges = Object.fromEntries(
      Object.entries(opts.edgeToms).map(([id, t]) => [id, { t: [...t] as FMarkTuple } as EntitySyncMeta]),
    );
  }
  return d;
}

/** 统计墓碑总数。 */
function tombCount(d: KBNoteDoc): number {
  const n = d.sync?.nodes ? Object.values(d.sync.nodes).filter((m) => m.t).length : 0;
  const e = d.sync?.edges ? Object.values(d.sync.edges).filter((m) => m.t).length : 0;
  return n + e;
}

// ---------------------------------------------------------------------------

describe('safeTombstoneWatermark', () => {
  it('取 vv 逐分量最小值', () => {
    expect(safeTombstoneWatermark({ cA: 10, cB: 5, cC: 12 })).toBe(5);
  });
  it('空 vv / null / 全非数 → 0（不裁）', () => {
    expect(safeTombstoneWatermark({})).toBe(0);
    expect(safeTombstoneWatermark(undefined)).toBe(0);
    expect(safeTombstoneWatermark(null)).toBe(0);
    expect(safeTombstoneWatermark({ cA: NaN as unknown as number })).toBe(0);
  });
});

describe('pruneTombstones: 安全第一语义', () => {
  it('未被全部已知客户端 VV 覆盖的墓碑绝不被裁（缺一个 client 覆盖）', () => {
    // cB 停在 5，未覆盖 lamport 10 / 9 的删除 → watermark = min(10,5) = 5。
    const d = docWith({
      vv: { cA: 10, cB: 5 },
      nodeToms: { n1: [10, 'cA'], n2: [9, 'cA'] },
    });
    // 超阈值，逼它裁；但两条墓碑 lamport(10/9) > watermark(5)，均不安全。
    const r = pruneTombstones(d, { maxTombstones: 1 });
    expect(r.watermark).toBe(5);
    expect(r.prunedCount).toBe(0);
    expect(tombCount(r.doc)).toBe(2);
    expect(r.doc.sync!.nodes!.n1!.t).toEqual([10, 'cA']);
    expect(r.doc.sync!.nodes!.n2!.t).toEqual([9, 'cA']);
  });

  it('全覆盖后安全集合内的墓碑可裁', () => {
    // cA=10, cB=12 → watermark = 10；lamport ≤10 的墓碑全部安全。
    const d = docWith({
      vv: { cA: 10, cB: 12 },
      nodeToms: { old: [5, 'cA'], fresh: [10, 'cA'] },
    });
    const r = pruneTombstones(d, { maxTombstones: 1 });
    expect(r.watermark).toBe(10);
    expect(r.prunedCount).toBe(1);
    // 最老优先：old(5) 被裁，fresh(10) 保留。
    expect(r.prunedNodes).toEqual(['old']);
    expect(r.doc.sync!.nodes!.fresh!.t).toEqual([10, 'cA']);
    expect(r.doc.sync!.nodes!.old).toBeUndefined();
  });

  it('lamport 恰等于 watermark 仍算安全（边界）', () => {
    const d = docWith({
      vv: { cA: 10, cB: 10 },
      nodeToms: { n1: [10, 'cA'] },
    });
    const r = pruneTombstones(d, { maxTombstones: 0 });
    expect(r.prunedNodes).toEqual(['n1']);
  });
});

describe('pruneTombstones: 阈值边界', () => {
  const mk = () => docWith({
    vv: { cA: 100, cB: 100 },
    nodeToms: { a: [1, 'cA'], b: [2, 'cA'], c: [3, 'cA'] },
  });

  it('恰好等于阈值 → 不裁', () => {
    const r = pruneTombstones(mk(), { maxTombstones: 3 });
    expect(r.prunedCount).toBe(0);
    expect(tombCount(r.doc)).toBe(3);
  });

  it('超过阈值一条 → 只裁最老的一条', () => {
    const r = pruneTombstones(mk(), { maxTombstones: 2 });
    expect(r.prunedCount).toBe(1);
    expect(r.prunedNodes).toEqual(['a']); // 最老
    expect(tombCount(r.doc)).toBe(2);
  });

  it('不足阈值 → 不裁', () => {
    const d = docWith({ vv: { cA: 100, cB: 100 }, nodeToms: { a: [1, 'cA'] } });
    const r = pruneTombstones(d, { maxTombstones: 5 });
    expect(r.prunedCount).toBe(0);
  });

  it('安全集合不足时，宁可超阈值也不裁不安全墓碑', () => {
    // watermark=5；两条墓碑都 lamport>5 不安全；maxTombstones=1 但无可裁。
    const d = docWith({
      vv: { cA: 10, cB: 5 },
      nodeToms: { a: [10, 'cA'], b: [9, 'cA'] },
    });
    const r = pruneTombstones(d, { maxTombstones: 1 });
    expect(r.prunedCount).toBe(0);
    expect(tombCount(r.doc)).toBe(2);
  });
});

describe('pruneTombstones: 最老优先顺序', () => {
  it('跨节点/边混合，按 lamport 升序裁，同 lamport 按 clientId 升序', () => {
    const d = docWith({
      vv: { cA: 100, cB: 100 },
      nodeToms: { n_mid: [50, 'cA'], n_old: [10, 'cA'] },
      edgeToms: { e_old: [10, 'cB'], e_fresh: [90, 'cA'] },
    });
    // 共 4 条，maxTombstones=1 → 需裁 3 条最老。
    // 候选：n_old[10,cA], e_old[10,cB], n_mid[50,cA], e_fresh[90,cA]
    const r = pruneTombstones(d, { maxTombstones: 1 });
    expect(r.prunedNodes).toEqual(['n_old', 'n_mid']);
    expect(r.prunedEdges).toEqual(['e_old']);
    // 最年轻 e_fresh[90] 保留。
    expect(r.doc.sync!.edges!.e_fresh!.t).toEqual([90, 'cA']);
    expect(tombCount(r.doc)).toBe(1);
  });
});

describe('pruneTombstones: 幂等与不可变', () => {
  it('重复裁剪结果不变（幂等）', () => {
    const d = docWith({
      vv: { cA: 100, cB: 100 },
      nodeToms: { a: [1, 'cA'], b: [2, 'cA'], c: [3, 'cA'], d: [4, 'cA'] },
    });
    const r1 = pruneTombstones(d, { maxTombstones: 2 });
    expect(r1.prunedCount).toBe(2);
    const r2 = pruneTombstones(r1.doc, { maxTombstones: 2 });
    expect(r2.prunedCount).toBe(0);
    expect(r2.doc).toEqual(r1.doc);
  });

  it('不改入参文档（不可变）', () => {
    const d = docWith({
      vv: { cA: 100, cB: 100 },
      nodeToms: { a: [1, 'cA'], b: [2, 'cA'] },
    });
    const snapshot = JSON.parse(JSON.stringify(d));
    pruneTombstones(d, { maxTombstones: 1 });
    expect(d).toEqual(snapshot);
  });
});

describe('pruneTombstones: 与 mergeSnapshots 协同不复活', () => {
  it('裁剪后合入仍含该墓碑的远端 → 墓碑由远端恢复，不复活', () => {
    // 本端：n1 已删（墓碑 [10,cA]），全部已知客户端已观测 → 裁剪。
    const us = docWith({
      id: 'shared_doc',
      vv: { cA: 10, cB: 20 },
      nodeToms: { n1: [10, 'cA'] },
    });
    const pruned = pruneTombstones(us, { maxTombstones: 0 });
    expect(pruned.prunedNodes).toEqual(['n1']);
    expect(pruned.doc.sync!.nodes?.n1).toBeUndefined();

    // 对端：仍保留 n1 墓碑（尚未被裁剪），节点本体已不在数组。
    const remote = docWith({
      id: 'shared_doc',
      vv: { cA: 10, cB: 20 },
      nodeToms: { n1: [10, 'cA'] },
    });

    const merged = mergeSnapshots(pruned.doc, remote);
    // n1 仍应是删除态：节点本体不存在，墓碑被远端恢复。
    expect(merged.doc.nodes.find((x) => x.id === 'n1')).toBeUndefined();
    expect(merged.doc.sync!.nodes!.n1!.t).toEqual([10, 'cA']);
  });

  it('删除-新建二义：裁剪后对端以更新 lamport 重建同名节点 → 取较新本，不复活旧版', () => {
    // 本端已裁剪掉 n1 的旧删除墓碑。
    const us = docWith({
      id: 'shared_doc',
      vv: { cA: 10, cB: 20 },
      nodeToms: { n1: [10, 'cA'] },
    });
    const pruned = pruneTombstones(us, { maxTombstones: 0 });

    // 对端在更高 lamport(20) 重建了同名 n1（新内容）。
    const remote = docWith({ id: 'shared_doc', vv: { cA: 10, cB: 20 } });
    const node: BlockNode = createNode('text', 0, 0);
    node.id = 'n1';
    node.content = { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', text: '重建后' }] } };
    remote.nodes.push(node);
    remote.sync.nodes = { n1: { f: { content: [20, 'cB'] } } };

    const merged = mergeSnapshots(pruned.doc, remote);
    const n1 = merged.doc.nodes.find((x) => x.id === 'n1');
    // 重建生效（较新写入胜出），且不是被删状态。
    expect(n1).toBeDefined();
    expect(n1!.content.data.content[0].text).toBe('重建后');
  });
});

describe('pruneTombstones: 空状态 / 无墓碑 / 坏输入', () => {
  it('空文档（vv={}）不报错、不裁', () => {
    const d = createDoc('空');
    const r = pruneTombstones(d);
    expect(r.prunedCount).toBe(0);
    expect(r.watermark).toBe(0);
  });

  it('有活节点但无墓碑 → 不裁、不碰正文', () => {
    const d = createDoc('无墓碑');
    const node = createNode('text', 0, 0);
    node.id = 'live';
    d.nodes.push(node);
    d.sync = { vv: { cA: 5 }, nodes: { live: { f: { content: [5, 'cA'] } } } };
    const r = pruneTombstones(d, { maxTombstones: 0 });
    expect(r.prunedCount).toBe(0);
    expect(r.doc.nodes).toHaveLength(1);
  });

  it('坏 vv（NaN/负数/字符串）不抛，水位按 0 处理', () => {
    const d = docWith({ vv: { cA: NaN as unknown as number }, nodeToms: { n1: [5, 'cA'] } });
    expect(() => pruneTombstones(d, { maxTombstones: 0 })).not.toThrow();
    const r = pruneTombstones(d, { maxTombstones: 0 });
    expect(r.prunedCount).toBe(0);
  });

  it('坏 options：负数/NaN 回退默认阈值 1000（1500 条合格墓碑 → 裁 500 留 1000）', () => {
    // vv.cA=1500 → watermark=1500；造 1500 条 lamport 1..1500 的墓碑，全部安全可裁。
    // 真回退到默认 1000：1500>1000 → 最老优先裁到 1000（裁 500）。
    // 若回退失效（把 -5/NaN 当真值），会裁光 1500 条；此用例双向锁死回退语义。
    const tombs: Record<string, Mark> = {};
    for (let i = 1; i <= 1500; i++) tombs[`n${i}`] = [i, 'cA'];
    const d = docWith({ vv: { cA: 1500 }, nodeToms: tombs });
    for (const bad of [-5, NaN as unknown as number]) {
      const r = pruneTombstones(d, { maxTombstones: bad });
      expect(r.watermark).toBe(1500);
      expect(r.prunedCount).toBe(500);
      expect(r.retainedCount).toBe(1000);
    }
    expect(DEFAULT_MAX_TOMBSTONES).toBe(1000);
  });

  it('坏 options：负数/NaN 回退默认阈值 1000（500 条合格墓碑 → 阈值内一条不裁）', () => {
    // 正向锁：500 ≤ 回退后的 1000 → 不裁；若回退失效把 -5 当真值，500>-5 会裁光。
    const tombs: Record<string, Mark> = {};
    for (let i = 1; i <= 500; i++) tombs[`n${i}`] = [i, 'cA'];
    const d = docWith({ vv: { cA: 500 }, nodeToms: tombs });
    for (const bad of [-5, NaN as unknown as number]) {
      const r = pruneTombstones(d, { maxTombstones: bad });
      expect(r.prunedCount).toBe(0);
      expect(r.retainedCount).toBe(500);
    }
  });

  it('options=0 按字面阈值 0 处理（裁光全部合格墓碑，不回退默认）', () => {
    // 与回退分支区分：0 是合法阈值（= 裁到 0），不是坏输入。锁死双分支。
    const tombs: Record<string, Mark> = {};
    for (let i = 1; i <= 1500; i++) tombs[`n${i}`] = [i, 'cA'];
    const d = docWith({ vv: { cA: 1500 }, nodeToms: tombs });
    const r = pruneTombstones(d, { maxTombstones: 0 });
    expect(r.prunedCount).toBe(1500);
    expect(r.retainedCount).toBe(0);
  });

  it('doc.sync 缺失时按空块处理，不抛', () => {
    const d = createDoc('no-sync');
    delete (d as unknown as { sync?: unknown }).sync;
    const r = pruneTombstones(d);
    expect(r.prunedCount).toBe(0);
  });
});
