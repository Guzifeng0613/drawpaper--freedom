import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { DocEmbedPicker } from './doc-embed-picker';
import type { DocRefTarget } from '../../storage/doc-ref-search';

/**
 * Wave31 Phase B：斜杠「嵌入其他画布的块」目标选择器 IME 组合守卫。
 * 选择器自带搜索 input，组词中回车确认拼音候选时不得连带选定浮层候选。
 */

const CANDIDATES: DocRefTarget[] = [
  { docId: 'doc_A', nodeId: 'n_A1', docTitle: '目标画布A', nodeTitle: '目标块一', snippet: '' },
  { docId: 'doc_B', nodeId: 'n_B2', docTitle: '引用画布B', nodeTitle: '目标块二', snippet: '' },
];

vi.mock('../../storage/doc-ref-search', () => ({
  searchDocRefTargets: vi.fn(async (_doc: unknown, query: string, _limit: number) => {
    const q = query.trim();
    if (!q) return CANDIDATES;
    return CANDIDATES.filter((c) => c.nodeTitle.includes(q));
  }),
}));

const bodyHas = (t: string) => document.body.textContent?.includes(t) ?? false;

function composeKey(key: string, keyCode229 = false): void {
  const ev = new KeyboardEvent('keydown', { key, cancelable: true, isComposing: true });
  if (keyCode229) Object.defineProperty(ev, 'keyCode', { value: 229 });
  act(() => window.dispatchEvent(ev));
}
function plainKey(key: string): void {
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true })));
}

describe('DocEmbedPicker IME 组合守卫', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('组词中 Enter 不选定；普通 Enter 正常选定', async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<DocEmbedPicker currentDoc={null} onPick={onPick} onClose={onClose} />);
    await waitFor(() => expect(bodyHas('目标块一')).toBe(true));

    composeKey('Enter');
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    plainKey('Enter');
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]![0]).toMatchObject({ docId: 'doc_A', nodeId: 'n_A1' });
  });

  it('keyCode===229 的组词 Enter 也不选定', async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<DocEmbedPicker currentDoc={null} onPick={onPick} onClose={onClose} />);
    await waitFor(() => expect(bodyHas('目标块一')).toBe(true));

    composeKey('Enter', true);
    expect(onPick).not.toHaveBeenCalled();

    plainKey('Enter');
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('组词中 Esc 不关闭选择器；普通 Esc 仍关闭', async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<DocEmbedPicker currentDoc={null} onPick={onPick} onClose={onClose} />);
    await waitFor(() => expect(bodyHas('目标块一')).toBe(true));

    composeKey('Escape');
    expect(onClose).not.toHaveBeenCalled();

    plainKey('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
