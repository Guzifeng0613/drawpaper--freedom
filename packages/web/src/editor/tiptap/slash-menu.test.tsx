import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { createBlockEditor } from './createBlockEditor';
import { SlashMenu, type SlashCommand } from './slash-menu';

/**
 * Wave31 Phase B：斜杠菜单 IME 组合守卫。
 * 组词中（isComposing / keyCode===229）回车确认候选、方向翻候选、Esc 关候选窗
 * 一律让路——不触发命令、不删 `/` 触发文本；组合结束后菜单照常选择。
 */

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

/** 派发一个 IME 组词中的 keydown（isComposing=true）；可选把 keyCode 改写成 229。 */
function composeKey(key: string, keyCode229 = false): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key, cancelable: true, isComposing: true });
  if (keyCode229) Object.defineProperty(ev, 'keyCode', { value: 229 });
  act(() => {
    window.dispatchEvent(ev);
  });
  return ev;
}

function plainKey(key: string): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }));
  });
}

describe('SlashMenu IME 组合守卫', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('组词中 Enter 不触发命令、不删 `/` 触发文本；组合结束后正常选定', async () => {
    const ed = await createBlockEditor({ content: textDoc });
    caretEnd(ed);
    const onCommand = vi.fn();
    render(<SlashMenu editor={ed} onCommand={onCommand} />);
    typeAt(ed, '/');
    await waitFor(() => expect(bodyHas('文本')).toBe(true));

    // 组词中回车确认拼音候选 → 让路
    composeKey('Enter');
    expect(onCommand).not.toHaveBeenCalled();
    expect(bodyHas('文本')).toBe(true);
    expect(ed.getText()).toBe('/');

    // 组合结束 → 回车正常选定首项（文本块）
    plainKey('Enter');
    expect(onCommand).toHaveBeenCalledTimes(1);
    const cmd = onCommand.mock.calls[0]![0] as SlashCommand;
    expect(cmd).toMatchObject({ kind: 'block', blockType: 'text' });
    ed.destroy();
  });

  it('keyCode===229 的组词 keydown 也让路（首键先于 compositionstart 的竞态）', async () => {
    const ed = await createBlockEditor({ content: textDoc });
    caretEnd(ed);
    const onCommand = vi.fn();
    render(<SlashMenu editor={ed} onCommand={onCommand} />);
    typeAt(ed, '/');
    await waitFor(() => expect(bodyHas('文本')).toBe(true));

    composeKey('Enter', true);
    expect(onCommand).not.toHaveBeenCalled();
    expect(ed.getText()).toBe('/');

    // 普通 Enter 路径行为不变
    plainKey('Enter');
    expect(onCommand).toHaveBeenCalledTimes(1);
    ed.destroy();
  });

  it('组词中 Esc 不关菜单、不退出；普通 Esc 仍关闭', async () => {
    const ed = await createBlockEditor({ content: textDoc });
    caretEnd(ed);
    const onCommand = vi.fn();
    render(<SlashMenu editor={ed} onCommand={onCommand} />);
    typeAt(ed, '/');
    await waitFor(() => expect(bodyHas('文本')).toBe(true));

    composeKey('Escape');
    expect(bodyHas('文本')).toBe(true); // 菜单仍在
    expect(ed.getText()).toBe('/');

    plainKey('Escape');
    expect(bodyHas('文本')).toBe(false); // 菜单关闭
    ed.destroy();
  });
});
