import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { createBlockEditor } from './createBlockEditor';
import { DocEmbedTrigger, isInCodeContext, matchEmbedTrigger } from './doc-embed-trigger';
import type { DocRefTarget } from '../../storage/doc-ref-search';

/**
 * Wave22 A：`{{` 块嵌入触发器单测。
 * 纯逻辑（触发匹配 / 代码上下文守卫）+ 组件行为（弹层弹出 / 查询过滤 / Esc 取消 /
 * Enter 确认并删触发文本 / 代码块不触发 / IME 组合期不接管 / 空库空态不崩）。
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

import { searchDocRefTargets } from '../../storage/doc-ref-search';

const bodyHas = (t: string) => document.body.textContent?.includes(t) ?? false;

const textDoc = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
};

const codeDoc = {
  type: 'doc',
  content: [{ type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'code' }] }],
};

/** 把光标移到文档末尾。 */
function caretEnd(ed: Editor): void {
  ed.commands.setTextSelection(ed.state.doc.content.size);
}

/** 在光标处插入文本（包进 act，触发事务监听）。 */
function typeAt(ed: Editor, text: string): void {
  act(() => {
    ed.view.dispatch(ed.view.state.tr.insertText(text));
  });
}

describe('matchEmbedTrigger 纯逻辑', () => {
  it('刚打出两个 { 也匹配（空查询词）', () => {
    expect(matchEmbedTrigger('abc{{', false)).toBe('');
  });
  it('带查询词匹配', () => {
    expect(matchEmbedTrigger('abc{{目标', false)).toBe('目标');
  });
  it('单个 { 不匹配', () => {
    expect(matchEmbedTrigger('abc{', false)).toBeNull();
  });
  it('无触发串不匹配', () => {
    expect(matchEmbedTrigger('abc', false)).toBeNull();
  });
  it('闭合 } 后的触发串不算（{{q}} 不匹配）', () => {
    expect(matchEmbedTrigger('abc{{q}}', false)).toBeNull();
  });
  it('代码上下文一律不匹配', () => {
    expect(matchEmbedTrigger('abc{{', true)).toBeNull();
    expect(matchEmbedTrigger('abc{{q', true)).toBeNull();
  });
});

describe('isInCodeContext', () => {
  it('普通段落为 false', async () => {
    const ed = await createBlockEditor({ content: textDoc });
    caretEnd(ed);
    expect(isInCodeContext(ed.state.selection.$head)).toBe(false);
    ed.destroy();
  });
  it('代码块内为 true', async () => {
    const ed = await createBlockEditor({ content: codeDoc });
    caretEnd(ed);
    expect(isInCodeContext(ed.state.selection.$head)).toBe(true);
    ed.destroy();
  });
  it('行内 code mark 内为 true', async () => {
    const ed = await createBlockEditor({
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'pre ' },
              { type: 'text', text: 'x', marks: [{ type: 'code' }] },
            ],
          },
        ],
      },
    });
    caretEnd(ed);
    expect(isInCodeContext(ed.state.selection.$head)).toBe(true);
    ed.destroy();
  });
});

describe('DocEmbedTrigger 组件行为', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(searchDocRefTargets).mockImplementation(async (_doc: unknown, query: string) => {
      const q = query.trim();
      return q ? CANDIDATES.filter((c) => c.nodeTitle.includes(q)) : CANDIDATES;
    });
  });

  it('块内输入 {{ 弹出浮层并列出候选', async () => {
    const ed = await createBlockEditor({ content: textDoc });
    const onPick = vi.fn();
    render(<DocEmbedTrigger editor={ed} currentDoc={null} onPick={onPick} />);
    typeAt(ed, '{{');
    await waitFor(() => {
      expect(bodyHas('嵌入其他画布的块')).toBe(true);
      expect(bodyHas('目标块一')).toBe(true);
    });
    ed.destroy();
  });

  it('继续输入查询词过滤候选', async () => {
    const ed = await createBlockEditor({ content: textDoc });
    const onPick = vi.fn();
    render(<DocEmbedTrigger editor={ed} currentDoc={null} onPick={onPick} />);
    typeAt(ed, '{{目标块二');
    await waitFor(() => {
      expect(bodyHas('目标块二')).toBe(true);
      expect(bodyHas('目标块一')).toBe(false);
    });
    expect(searchDocRefTargets).toHaveBeenCalledWith(null, '目标块二', 15);
    ed.destroy();
  });

  it('Esc 取消：浮层关闭，不触发选定', async () => {
    const ed = await createBlockEditor({ content: textDoc });
    const onPick = vi.fn();
    render(<DocEmbedTrigger editor={ed} currentDoc={null} onPick={onPick} />);
    typeAt(ed, '{{');
    await waitFor(() => expect(bodyHas('嵌入其他画布的块')).toBe(true));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    });
    expect(bodyHas('嵌入其他画布的块')).toBe(false);
    expect(onPick).not.toHaveBeenCalled();
    ed.destroy();
  });

  it('Enter 确认：onPick 被调用且 {{ 触发文本从正文删除', async () => {
    const ed = await createBlockEditor({ content: textDoc });
    const onPick = vi.fn();
    render(<DocEmbedTrigger editor={ed} currentDoc={null} onPick={onPick} />);
    typeAt(ed, '{{');
    await waitFor(() => expect(bodyHas('目标块一')).toBe(true));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]![0]).toMatchObject({ docId: 'doc_A', nodeId: 'n_A1' });
    // 触发字符已删除
    expect(ed.getText().replace(/\s/g, '')).not.toContain('{');
    ed.destroy();
  });

  it('IME 组合期间 Enter 不接管候选；组合结束后恢复', async () => {
    const ed = await createBlockEditor({ content: textDoc });
    const onPick = vi.fn();
    render(<DocEmbedTrigger editor={ed} currentDoc={null} onPick={onPick} />);
    typeAt(ed, '{{');
    await waitFor(() => expect(bodyHas('目标块一')).toBe(true));
    // 组合开始 → Enter 被让路
    act(() => {
      window.dispatchEvent(new CompositionEvent('compositionstart'));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    });
    expect(onPick).not.toHaveBeenCalled();
    expect(bodyHas('嵌入其他画布的块')).toBe(true);
    // 组合结束 → Enter 正常选定
    act(() => {
      window.dispatchEvent(new CompositionEvent('compositionend'));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    });
    expect(onPick).toHaveBeenCalledTimes(1);
    ed.destroy();
  });

  it('事件级守卫：未先发 compositionstart、仅 keydown 自带 isComposing/keyCode229 也让路', async () => {
    const ed = await createBlockEditor({ content: textDoc });
    const onPick = vi.fn();
    render(<DocEmbedTrigger editor={ed} currentDoc={null} onPick={onPick} />);
    typeAt(ed, '{{');
    await waitFor(() => expect(bodyHas('目标块一')).toBe(true));
    // 首键先于 compositionstart 的竞态：直接发 isComposing=true 的 keydown。
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, isComposing: true }),
      );
    });
    expect(onPick).not.toHaveBeenCalled();
    expect(ed.getText().replace(/\s/g, '')).toBe('{{');
    // keyCode===229 兜底
    const kd229 = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    Object.defineProperty(kd229, 'keyCode', { value: 229 });
    act(() => window.dispatchEvent(kd229));
    expect(onPick).not.toHaveBeenCalled();
    // 普通路径不变
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    });
    expect(onPick).toHaveBeenCalledTimes(1);
    ed.destroy();
  });

  it('代码块内输入 {{ 不弹浮层', async () => {
    const ed = await createBlockEditor({ content: codeDoc });
    const onPick = vi.fn();
    render(<DocEmbedTrigger editor={ed} currentDoc={null} onPick={onPick} />);
    typeAt(ed, '{{');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(bodyHas('嵌入其他画布的块')).toBe(false);
    expect(onPick).not.toHaveBeenCalled();
    ed.destroy();
  });

  it('空候选时空态渲染不崩', async () => {
    vi.mocked(searchDocRefTargets).mockResolvedValueOnce([]);
    const ed = await createBlockEditor({ content: textDoc });
    const onPick = vi.fn();
    render(<DocEmbedTrigger editor={ed} currentDoc={null} onPick={onPick} />);
    typeAt(ed, '{{');
    // 等搜索真正发起并 resolve（初始 items 本就是空数组，否则 once 队列会泄漏到下个用例）。
    await waitFor(() => expect(searchDocRefTargets).toHaveBeenCalled());
    await waitFor(() => expect(bodyHas('无匹配块')).toBe(true));
    ed.destroy();
  });

  it('excludeNodeId 排除正在编辑的块自身', async () => {
    const ed = await createBlockEditor({ content: textDoc });
    const onPick = vi.fn();
    render(
      <DocEmbedTrigger editor={ed} currentDoc={null} excludeNodeId="n_A1" onPick={onPick} />,
    );
    typeAt(ed, '{{');
    await waitFor(() => expect(bodyHas('目标块二')).toBe(true));
    expect(bodyHas('目标块一')).toBe(false);
    ed.destroy();
  });
});
