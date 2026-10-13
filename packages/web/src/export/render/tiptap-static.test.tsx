import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { TiptapStatic, renderNode } from './tiptap-static';

describe('TiptapStatic codeBlock 渲染', () => {
  it('codeBlock 节点输出 <pre><code> 包裹（不空白）', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'typescript' },
          content: [{ type: 'text', text: 'const x: number = 42;' }],
        },
      ],
    };
    const { container } = render(<TiptapStatic doc={doc} />);
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    const code = pre!.querySelector('code');
    expect(code).not.toBeNull();
    expect(code!.className).toContain('hljs');
    expect(code!.textContent).toContain('const x: number = 42;');
  });

  it('codeBlock 无语言时仍渲染纯文本 pre/code', () => {
    const node = { type: 'codeBlock', content: [{ type: 'text', text: 'hello' }] };
    const el = renderNode(node, false);
    expect(el).toBeTruthy();
  });

  it('基本段落节点正常渲染（回归）', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }],
    };
    const { container } = render(<TiptapStatic doc={doc} />);
    expect(container.textContent).toContain('Hello world');
  });
});
