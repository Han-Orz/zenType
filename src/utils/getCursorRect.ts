/**
 * 顺滑光标定位工具。
 *
 * getCursorRect()    — 应用 lineHeight × CURSOR_CONFIG.HEIGHT_RATIO，返回 CursorRect { x, y, width, height }
 * getCursorElement() — 当前选区所在的 DOM 元素（见 ./getCursorElement.ts）
 *
 * 算法借鉴 Neo-Plus getselection.ts：
 *   1) 浏览器原生 Range.getClientRects()
 *   2) 无有效 rect 时：空块使用内容区的 bounding rect；非空块从相邻真实文本节点
 *      的边界构造 fallback（均不改 DOM）
 *
 * 设计决策：返回精简的 CursorRect 而不是 DOMRect——消费方只需要 x/y/width/height。
 * typewriter.ts / cursor.ts 直接消费，无需额外转换。
 */

import type { CursorRect } from "../types";
import { CURSOR_CONFIG } from "../config";
import { getLineHeight } from "./getLineHeight";
import { resolveRangeTextPoint } from "./rangeTextPoint";

/** 用户可配置：见 src/config.ts :: CURSOR_CONFIG.HEIGHT_RATIO */
export const LINE_HEIGHT_RATIO = CURSOR_CONFIG.HEIGHT_RATIO;

type FallbackCursorRect = {
  rect: DOMRect;
  edge: "start" | "end";
};

/**
 * 获取光标的显示矩形。
 * 已应用 lineHeight × LINE_HEIGHT_RATIO，x/y 是 viewport 坐标。
 */
export function getCursorRect(): CursorRect | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;

  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(true);

  const rects = Array.from(range.getClientRects());
  let baseRect: DOMRect | null = null;
  let caretEdge: "start" | "end" = "end";
  const validRects = rects.filter((rect) => rect.height > 0);
  if (validRects.length > 0) {
    baseRect = validRects[validRects.length - 1];
  } else {
    const fallback = getFallbackCursorRect(range);
    if (!fallback) return null;
    baseRect = fallback.rect;
    caretEdge = fallback.edge;
  }

  const lineHeight = getLineHeight(range.startContainer);
  const height = lineHeight * LINE_HEIGHT_RATIO;

  // 垂直居中：按基础文本矩形的高度计算偏移，让光标位于行高中部
  const gap = (baseRect.height - height) / 2;
  const y = baseRect.top + gap;
  // 光标在字符末尾：right 边缘就是下一个字符的起点
  const x = caretEdge === "start" ? baseRect.left : baseRect.right;

  return { x, y, width: baseRect.width, height };
}

/**
 * 非突变 fallback：当 Range.getClientRects() 返回 0-height rect 时，沿
 * startContainer 向上找 [data-node-id] 块。空块使用内容区 bounding rect +
 * lineHeight；非空块从相邻真实文本节点的边界恢复光标位置。
 *
 * 不插入 DOM，避免触发 selectionchange 级联（参考 PR 之前的 debug log
 * spam 226+ 行的根因）。
 *
 * @param range 已 collapse(true) 的 Range
 * @returns DOMRect 或 null（找不到块时）
 */
function getFallbackCursorRect(range: Range): FallbackCursorRect | null {
  const block = getBlock(range.startContainer);
  if (!block) return null;

  // Only a genuinely empty block should use the block-top fallback. A non-empty
  // block may represent its end caret with an empty Text node whose Range has no
  // client rect; recover that caret from nearby real text instead.
  if (isEmptyBlock(block)) {
    const rect = getEmptyBlockRect(range);
    return rect ? { rect, edge: "start" } : null;
  }

  return getAdjacentTextRect(range, block);
}

function getBlock(node: Node): HTMLElement | null {
  const element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;
  return element?.closest('[data-node-id]') as HTMLElement | null;
}

function isEmptyBlock(block: HTMLElement): boolean {
  const text = (block.textContent ?? "")
    .replace(/[\u200B\uFEFF\u00A0]/g, "")
    .trim();
  return text === "" && !block.querySelector(
    'img, iframe, [data-type^="NodeMathBlock"], [data-type^="NodeCodeBlock"]',
  );
}

function getAdjacentTextRect(range: Range, block: HTMLElement): FallbackCursorRect | null {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    textNodes.push(node as Text);
  }

  const resolved = resolveRangeTextPoint(range.startContainer, range.startOffset);
  const currentNode = resolved?.textNode ?? null;
  const currentIndex = currentNode ? textNodes.indexOf(currentNode) : -1;

  if (currentIndex >= 0 && currentNode && currentNode.data.length > 0 && resolved) {
    const currentRect = getTextBoundaryRect(currentNode, resolved.offset);
    if (currentRect) {
      return {
        rect: currentRect,
        edge: resolved.offset === 0 ? "start" : "end",
      };
    }
  }

  // If the resolved point is at the start of a text node, its previous
  // sibling is the closest backward candidate; otherwise the current node's
  // end is the closest candidate. This preserves element-container offsets.
  const previousStart = currentIndex >= 0
    ? (resolved?.offset === 0 ? currentIndex - 1 : currentIndex)
    : textNodes.length - 1;
  for (let index = previousStart; index >= 0; index -= 1) {
    const textNode = textNodes[index];
    if (textNode.data.length === 0) continue;
    const rect = getTextBoundaryRect(textNode, textNode.data.length);
    if (rect) return { rect, edge: "end" };
  }

  const nextStart = currentIndex >= 0
    ? (resolved?.offset === 0 ? currentIndex : currentIndex + 1)
    : 0;
  for (let index = nextStart; index < textNodes.length; index += 1) {
    const textNode = textNodes[index];
    if (textNode.data.length === 0) continue;
    const rect = getTextBoundaryRect(textNode, 0);
    if (rect) return { rect, edge: "start" };
  }

  return null;
}

function getTextBoundaryRect(textNode: Text, offset: number): DOMRect | null {
  try {
    const range = document.createRange();
    range.setStart(textNode, offset);
    range.collapse(true);
    return Array.from(range.getClientRects()).find((rect) => rect.height > 0) ?? null;
  } catch {
    return null;
  }
}

function getEmptyBlockRect(range: Range): DOMRect | null {
  let node: Node | null = range.startContainer;
  if (node.nodeType !== Node.ELEMENT_NODE) {
    node = node.parentNode;
  }
  if (!node) return null;
  const block = (node as Element).closest('[data-node-id]');
  if (!block) return null;

  // Walk up from startContainer to the direct child of [data-node-id].
  // The direct child's rect reflects the content-area position (accounting for
  // padding / inner containers), not the block's outer edge which may be offset.
  let contentEl: Element = node as Element;
  while (contentEl.parentElement && contentEl.parentElement !== block) {
    contentEl = contentEl.parentElement;
  }

  const rect = contentEl.getBoundingClientRect();
  const lineHeight = getLineHeight(range.startContainer);
  // 空块光标视为在内容区顶部，占据 lineHeight 高度
  return new DOMRect(rect.left, rect.top, 0, lineHeight);
}
