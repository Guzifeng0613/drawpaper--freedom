import { useEffect, useState } from 'react';

/**
 * Wave31 Phase B：触屏软键盘遮挡适配（visualViewport）。
 *
 * 这是个自由布局画布（ReactFlow），不是可滚动文档。触屏点进块里编辑时，软键盘从
 * 底部弹起会直接盖住正在编辑的块与 hover 工具条——桌面端窗口不变高所以无感，只有
 * 移动 webview 才露馅。接入 `window.visualViewport`：键盘弹起时其 `height` 被压缩，
 * 监听它的 resize/scroll，算出「底部被键盘遮挡的高度」（inset），交给外层画布容器
 * 补一条底部安全 padding——ReactFlow 感知到容器可用高度变小后会重新约束可视区，
 * 当前编辑块自然留在键盘上方。
 *
 * 无 visualViewport 的环境（旧浏览器 / 隐私模式 / jsdom 默认未挂）：特性检测后直接
 * 返回 0、不挂任何监听、绝不抛错——桌面与测试环境行为完全不变（安全降级）。
 */

/**
 * 纯几何：给定可视视口尺寸与布局视口高度，算底部被遮挡的 CSS 像素。
 * 可视视口底边距布局视口顶 = offsetTop + height；屏幕底部 `innerHeight - 该值`
 * 即被键盘（或地址栏外的不可见区）盖住的高度，钳到 ≥0。
 */
export function computeKeyboardInset(
  vv: { height: number; offsetTop: number },
  innerHeight: number,
): number {
  return Math.max(0, innerHeight - vv.offsetTop - vv.height);
}

/**
 * 返回当前软键盘底部遮挡高度（px）。键盘收起 / 不支持 visualViewport 时恒为 0。
 */
export function useSoftKeyboardInset(): number {
  const [bottom, setBottom] = useState<number>(0);

  useEffect(() => {
    const vv = window.visualViewport;
    // 特性检测：无 API 安全降级，零监听零报错。
    if (!vv) return;
    const update = () => setBottom(computeKeyboardInset(vv, window.innerHeight));
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return bottom;
}
