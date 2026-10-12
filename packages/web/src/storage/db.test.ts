import { describe, expect, it } from 'vitest';
import { describeDocMeta } from './db';

/**
 * 坏档隔离：listDocs 把每条记录映射成元信息时，单条坏记录不得抛出击穿整个列表。
 * describeDocMeta 是纯函数（不触 IndexedDB），这里直接覆盖分类逻辑。
 */
describe('describeDocMeta 坏档隔离', () => {
  it('结构自洽的记录正常列出（快路径，不打 corrupt 标）', () => {
    const meta = describeDocMeta({
      id: 'd1',
      title: '读书笔记',
      board: { updatedAt: 5000, createdAt: 1000 },
    });
    expect(meta).toEqual({ id: 'd1', title: '读书笔记', updatedAt: 5000, createdAt: 1000 });
    expect(meta.corrupt).toBeUndefined();
  });

  it('缺 board 的记录隔离成「损坏」条目并保留原 id（不抛错）', () => {
    const meta = describeDocMeta({ id: 'bad1', title: '半截', nodes: [], edges: [] });
    expect(meta.id).toBe('bad1');
    expect(meta.corrupt).toBe(true);
    expect(meta.title).toBe('（损坏文档）');
  });

  it('完全非法的记录（无 id）不抛错，仍产出一条可删除的损坏条目', () => {
    const meta = describeDocMeta({ garbage: true });
    expect(meta.corrupt).toBe(true);
    expect(typeof meta.id).toBe('string');
    expect(meta.id.length).toBeGreaterThan(0);
  });

  it('null/非对象输入不抛错', () => {
    expect(() => describeDocMeta(null)).not.toThrow();
    expect(() => describeDocMeta(undefined)).not.toThrow();
    expect(() => describeDocMeta(42)).not.toThrow();
  });

  it('旧版本（v2/v3）合法记录不得误标损坏（启动列表正常列出）', () => {
    // 旧档带 version:2 + 合法 board，快路径直接列出；不得出现 corrupt 标。
    const meta = describeDocMeta({
      id: 'legacy1',
      version: 2,
      title: '旧档',
      board: { updatedAt: 3000, createdAt: 100 },
      nodes: [],
      edges: [],
    });
    expect(meta.id).toBe('legacy1');
    expect(meta.corrupt).toBeUndefined();
    expect(meta.title).toBe('旧档');
  });
});
