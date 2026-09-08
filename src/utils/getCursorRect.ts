import type { CursorRect } from "../types";
import { resolveRangeTextPoint } from "./rangeTextPoint";

function firstRect(range: Range): DOMRect | undefined {
  return Array.from(range.getClientRects()).find(rect => rect.height > 0 && Number.isFinite(rect.x) && Number.isFinite(rect.y));
}

export function getCursorRect(range: Range, editable: HTMLElement): CursorRect | null {
  const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const style = getComputedStyle(element ?? editable);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.625 || 26;
  const height = lineHeight * 1.05;
  let rect = Array.from(range.getClientRects()).filter(rect => rect.height > 0).at(-1);
  let x = rect?.right;

  if (!rect) {
    const point = resolveRangeTextPoint(range.startContainer, range.startOffset);
    if (point && editable.contains(point.textNode) && point.textNode.parentElement?.isContentEditable) {
      const probe = document.createRange();
      probe.setStart(point.textNode, point.offset);
      probe.collapse(true);
      rect = firstRect(probe);
      x = rect?.right;
      if (!rect && point.textNode.length) {
        // Adjacent glyph fallback is limited to a directional text run.
        const value = point.textNode.data;
        const start = point.offset === 0 ? 0 :
          point.offset >= 2 && /[\uDC00-\uDFFF]/.test(value[point.offset - 1]) ? point.offset - 2 : point.offset - 1;
        const end = point.offset === 0 ? (value.codePointAt(0)! > 0xffff ? 2 : 1) : point.offset;
        probe.setStart(point.textNode, start);
        probe.setEnd(point.textNode, end);
        rect = firstRect(probe);
        if (rect) x = (point.offset === 0) !== (style.direction === "rtl") ? rect.left : rect.right;
      }
      if (!rect && point.textNode.length === 0) {
        const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            return node.parentElement?.isContentEditable && node.nodeValue?.length
              ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
          },
        });
        walker.currentNode = point.textNode;
        const before = walker.previousNode();
        walker.currentNode = point.textNode;
        const after = walker.nextNode();
        for (const candidate of [before, after]) {
          if (!candidate) continue;
          probe.setStart(candidate, candidate === before ? candidate.nodeValue!.length : 0);
          probe.collapse(true);
          rect = firstRect(probe);
          if (rect) { x = rect.right; break; }
        }
      }
    }
    if (!rect && !(editable.textContent ?? "").replace(/[\u200B\uFEFF]/g, "").length &&
        !editable.querySelector("img, iframe, video, svg, [contenteditable='false']")) {
      const box = editable.getBoundingClientRect();
      const emptyStyle = getComputedStyle(editable);
      const left = box.left + (parseFloat(emptyStyle.borderLeftWidth) || 0) + (parseFloat(emptyStyle.paddingLeft) || 0);
      const right = box.right - (parseFloat(emptyStyle.borderRightWidth) || 0) - (parseFloat(emptyStyle.paddingRight) || 0);
      x = emptyStyle.textAlign === "center" ? (left + right) / 2 :
        emptyStyle.textAlign === "right" || emptyStyle.textAlign === "end" && emptyStyle.direction !== "rtl" ||
        emptyStyle.textAlign === "start" && emptyStyle.direction === "rtl" ? right : left;
      rect = new DOMRect(x, box.top + (parseFloat(emptyStyle.paddingTop) || 0) +
        (parseFloat(emptyStyle.borderTopWidth) || 0), 0, lineHeight);
    }
  }
  if (!rect || x === undefined) return null;
  const y = rect.top + (rect.height - height) / 2;
  return Number.isFinite(x) && Number.isFinite(y) && height > 0 ? { x, y, height } : null;
}
