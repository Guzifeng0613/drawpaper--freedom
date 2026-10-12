import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { createBlockEditor } from './createBlockEditor';
import { DocRefMention } from './doc-ref-mention';
import type { DocRefTarget } from '../../storage/doc-ref-search';

/**
 * Wave31 Phase B：`[[` 双链提及浮层 IME 组合守卫。
 * 组词中回车确认候选 / Esc 关候选窗一律让路——不选定、不删 `[[query` 触发文本。
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
const textDoc = { type: 'doc', content: [{ type: 'paragraph' }] };

function caretEnd(ed: Editor): void {
  ed.commands.setTextSelection(ed.state.doc.content.size);
}
function typeAt(ed: Editor, text: string): void {
  act(() => {
    ed.view.dispatch(ed.view.state.tr.insertText(text));
  });
}
function composeKey(key: string, keyCode229 = false): void {
  const ev = new KeyboardEvent('keydown', { key, cancelable: true, isComposing: true });
  if (keyCode229) Object.defineProperty(ev, 'keyCode', { value: 229 });
  act(() => window.dispatchEvent(ev));
}
function plainKey(key: string): void {
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true })));
}

describe('DocRefMention IME 组合守卫', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('组词中 Enter 不选定、不删 `[[`；组合结束后正常选定并插入双链', async () => {
    const ed = await createBlockEditor({ content: textDoc });
    caretEnd(ed);
    render(<DocRefMention editor={ed} />);
    typeAt(ed, '[[');
    await waitFor(() => expect(bodyHas('目标块一')).toBe(true));

    // 组词中回车 → 让路
    composeKey('Enter');
    expect(bodyHas('目标块一')).toBe(true); // 浮层仍在
    expect(ed.getText()).toBe('[['); // 触发文本保留
    expect(bodyHas('[[目标块一]]')).toBe(false);

    // 普通 Enter → 选定首项、插入双链、删触发文本
    plainKey('Enter');
    await waitFor(() => expect(ed.getText()).toContain('目标块一'));
    // 触发串 `[[` 被替换为双链 `[[目标块一]]`（而非残留 `[[` + 标题两段）
    expect(ed.getText()).toBe('[[目标块一]]');
    ed.destroy();
  });

  it('keyCode===229 的组词 keydown 也让路', async () => {
    const ed = await createBlockEditor({ content: textDoc });
    caretEnd(ed);
    render(<DocRefMention editor={ed} />);
    typeAt(ed, '[[');
    await waitFor(() => expect(bodyHas('目标块一')).toBe(true));

    composeKey('Enter', true);
    expect(ed.getText()).toBe('[[');
    expect(bodyHas('[[目标块一]]')).toBe(false);

    plainKey('Enter');
    await waitFor(() => expect(ed.getText()).toContain('目标块一'));
    ed.destroy();
  });

  it('组词中 Esc 不关浮层；普通 Esc 关闭且不插入', async () => {
    const ed = await createBlockEditor({ content: textDoc });
    caretEnd(ed);
    render(<DocRefMention editor={ed} />);
    typeAt(ed, '[[');
    await waitFor(() => expect(bodyHas('目标块一')).toBe(true));

    composeKey('Escape');
    expect(bodyHas('目标块一')).toBe(true);
    expect(ed.getText()).toBe('[[');

    plainKey('Escape');
    expect(bodyHas('目标块一')).toBe(false);
    expect(ed.getText()).toBe('[['); // 取消，触发文本原样留着
    ed.destroy();
  });
});
