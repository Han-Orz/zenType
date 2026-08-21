/**
 * 编辑器边界检测（共享工具）。
 *
 * 3 重检测：
 *   1) getActiveEditor() 校验 —— 选区是否属于当前活跃编辑器
 *   2) AV 数据库块排除 —— .av / .av__mask / .av__cursor
 *   3) AABB 碰撞 —— 光标坐标是否在 .protyle-content 可视范围内
 *      + 嵌套滚动容器回退
 *
 * 从早期 cursor boundary 模块迁移至 utils，
 * 供 cursor / typewriter 等模块共享，解除 typewriter → cursor 硬依赖。
 *
 * 参考：legacy 顺滑光标.js isInAllowElements()、Neo-Plus getselection.ts。
 */

import { getActiveEditor } from "siyuan";
import { getCursorElement } from "./getCursorElement";
import { findClosestScrollableElement } from "./scroll";

export interface AllowResult {
  allowed: boolean;
  cursorElement: Element | null;
  isOuterElement: boolean;
  /** protyle-content 的 bounding rect（若找到）。供 getEdgeProximity 对齐淡出边界到编辑器内容区。 */
  editorRect?: { top: number; bottom: number; left: number; right: number };
  reason?: string; // 调试用，不参与 UI
}

/**
 * 判断指定 viewport 坐标处的光标是否应被显示。
 * 第 1 重：getActiveEditor() 校验 → 第 2 重：AV 排除 → 第 3 重：AABB
 */
export function isInAllowElements(pos: { x: number; y: number }): AllowResult {
  // 第 1 重：getActiveEditor() 校验
  const activeEditor = getActiveEditor();
  if (!activeEditor) {
    return {
      allowed: false,
      cursorElement: null,
      isOuterElement: true,
      reason: "no active editor",
    };
  }

  const cursorElement = getCursorElement();
  if (!cursorElement) {
    return {
      allowed: false,
      cursorElement: null,
      isOuterElement: true,
      reason: "no cursor element",
    };
  }

  // 额外校验：选区必须真的属于当前活跃编辑器
  // （避免分屏 A 焦点时，B 的 WS 更新触发的 updateCursor 把光标定位到 B）
  // siyuan.d.ts 中 Protyle 类未声明 element，但其持有的 IProtyle 数据上有
  if (!activeEditor.protyle.element.contains(cursorElement)) {
    return {
      allowed: false,
      cursorElement,
      isOuterElement: true,
      reason: "selection not in active editor",
    };
  }

  // 第 2 重：AV 数据库块排除
  if (cursorElement.closest(".av, .av__mask, .av__cursor")) {
    return {
      allowed: false,
      cursorElement,
      isOuterElement: true,
      reason: "inside AV database",
    };
  }

  // 第 3 重：AABB 碰撞 + 嵌套滚动容器回退
  const protyleContent = cursorElement.closest(
    ".protyle:not(.fn__none) .protyle-content",
  ) as HTMLElement | null;

  // 标题区域特殊处理：返回最近的 protyle-content rect 作为 editorRect，使 typewriter 能滚动标题区域
  if (!protyleContent) {
    if (cursorElement.closest(".protyle-title__input")) {
      const fallbackProtyle = cursorElement.closest(".protyle") as HTMLElement | null;
      let titleEditorRect: { top: number; bottom: number; left: number; right: number } | undefined;
      if (fallbackProtyle) {
        const fallbackContent = fallbackProtyle.querySelector(".protyle-content") as HTMLElement | null;
        if (fallbackContent) {
          const r = fallbackContent.getBoundingClientRect();
          titleEditorRect = { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
        }
      }
      return { allowed: true, cursorElement, isOuterElement: false, editorRect: titleEditorRect };
    }
    return {
      allowed: false,
      cursorElement,
      isOuterElement: true,
      reason: "no protyle-content",
    };
  }

  const editorRect = protyleContent.getBoundingClientRect();
  const isInEditor =
    pos.x >= editorRect.left &&
    pos.x <= editorRect.right &&
    pos.y >= editorRect.top &&
    pos.y <= editorRect.bottom;

  if (!isInEditor) {
    // 嵌套滚动容器回退：在嵌套滚动场景下还要检查 scrollEl
    const scrollEl = findClosestScrollableElement(cursorElement);
    if (scrollEl && scrollEl !== protyleContent) {
      const scrollRect = scrollEl.getBoundingClientRect();
      const isInScroll =
        pos.x >= scrollRect.left &&
        pos.x <= scrollRect.right &&
        pos.y >= scrollRect.top &&
        pos.y <= scrollRect.bottom;
      return {
        allowed: isInScroll,
        cursorElement,
        isOuterElement: false,
        editorRect: {
          top: editorRect.top,
          bottom: editorRect.bottom,
          left: editorRect.left,
          right: editorRect.right,
        },
        reason: isInScroll ? undefined : "out of nested scroll container",
      };
    }

    return {
      allowed: false,
      cursorElement,
      isOuterElement: false,
      editorRect: {
        top: editorRect.top,
        bottom: editorRect.bottom,
        left: editorRect.left,
        right: editorRect.right,
      },
      reason: "out of editor rect",
    };
  }

  return {
    allowed: true,
    cursorElement,
    isOuterElement: false,
    editorRect: {
      top: editorRect.top,
      bottom: editorRect.bottom,
      left: editorRect.left,
      right: editorRect.right,
    },
  };
}
