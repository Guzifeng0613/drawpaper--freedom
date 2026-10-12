import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import type { CSSProperties } from 'react';
import { computeKeyboardInset, useSoftKeyboardInset } from './use-soft-keyboard-inset';

/**
 * Wave31 Phase B：visualViewport 软键盘适配几何测试。
 * - 纯函数 computeKeyboardInset：可视高度被压缩 → 底部 inset 增大；收起 → 0；算上 offsetTop。
 * - Hook 集成：派发 visualViewport resize（height 缩小）→ 容器底部 padding 随几何增大，
 *   编辑区不被键盘遮挡；无 visualViewport 时安全降级不抛错。
 */

describe('computeKeyboardInset 纯几何', () => {
  it('键盘未弹起（可视高=屏高）→ 0', () => {
    expect(computeKeyboardInset({ height: 800, offsetTop: 0 }, 800)).toBe(0);
  });
  it('可视高度被键盘压缩 300 → 底部遮挡 300', () => {
    expect(computeKeyboardInset({ height: 500, offsetTop: 0 }, 800)).toBe(300);
  });
  it('浏览器把可视视头上移 offsetTop=120 时从屏底里扣除', () => {
    expect(computeKeyboardInset({ height: 500, offsetTop: 120 }, 800)).toBe(180);
  });
  it('可视区超出屏高（地址栏收起动画）时钳到 0，不负数', () => {
    expect(computeKeyboardInset({ height: 900, offsetTop: 0 }, 800)).toBe(0);
  });
});

/** 可手动改 height/offsetTop、可派发 resize/scroll 事件的假 visualViewport。 */
class FakeVisualViewport {
  height: number;
  offsetTop: number;
  private listeners = new Map<string, Set<() => void>>();
  constructor(height: number, offsetTop = 0) {
    this.height = height;
    this.offsetTop = offsetTop;
  }
  addEventListener(t: string, cb: () => void) {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t)!.add(cb);
  }
  removeEventListener(t: string, cb: () => void) {
    this.listeners.get(t)?.delete(cb);
  }
  fire(t: string) {
    this.listeners.get(t)?.forEach((cb) => cb());
  }
  get listenerCount(): number {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0);
  }
}

function Harness() {
  const bottom = useSoftKeyboardInset();
  const style: CSSProperties = { paddingBottom: bottom };
  return <div data-testid="canvas-pad" style={style} />;
}

describe('useSoftKeyboardInset 几何与降级', () => {
  const origVV = window.visualViewport;
  const origInner = window.innerHeight;

  beforeEach(() => {
    window.innerHeight = 800;
  });
  afterEach(() => {
    window.visualViewport = origVV;
    window.innerHeight = origInner;
  });

  it('派发 resize（可视高缩小）→ 容器底部 padding 同步增大，编辑区留在键盘上方', () => {
    const vv = new FakeVisualViewport(800, 0);
    window.visualViewport = vv as unknown as VisualViewport;
    const { getByTestId, unmount } = render(<Harness />);
    const el = getByTestId('canvas-pad');
    // 初始：键盘未弹起
    expect(el.style.paddingBottom).toBe('0px');

    // 软键盘弹起：可视高度 800→500，底部被遮 300
    vv.height = 500;
    act(() => vv.fire('resize'));
    expect(el.style.paddingBottom).toBe('300px');

    // scroll（浏览器调整可视视位）同样重算
    vv.offsetTop = 100;
    vv.height = 500;
    act(() => vv.fire('scroll'));
    expect(el.style.paddingBottom).toBe('200px');

    // 键盘收起：恢复 0
    vv.height = 800;
    vv.offsetTop = 0;
    act(() => vv.fire('resize'));
    expect(el.style.paddingBottom).toBe('0px');
    unmount();
  });

  it('卸载后移除监听（不泄漏到 window.visualViewport）', () => {
    const vv = new FakeVisualViewport(800, 0);
    window.visualViewport = vv as unknown as VisualViewport;
    const { unmount } = render(<Harness />);
    expect(vv.listenerCount).toBe(2); // resize + scroll
    unmount();
    expect(vv.listenerCount).toBe(0);
  });

  it('无 visualViewport 环境安全降级：不抛错、padding 恒为 0、不挂监听', () => {
    Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true });
    let el: HTMLElement;
    expect(() => {
      const r = render(<Harness />);
      el = r.getByTestId('canvas-pad');
    }).not.toThrow();
    expect(el!.style.paddingBottom).toBe('0px');
  });
});
