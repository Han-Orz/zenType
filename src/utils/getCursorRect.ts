import type { CursorRect } from "../types";
import { resolveRangeTextPoint } from "./rangeTextPoint";

export function getCursorRect(range: Range, editable: HTMLElement): CursorRect | null {
  const rects = Array.from(range.getClientRects()).filter(rect => rect.height > 0);
  let rect = rects.at(-1);
  let atStart = true;
  if (!rect) {
    const point = resolveRangeTextPoint(range.startContainer, range.startOffset);
    if (point && editable.contains(point.textNode) && point.textNode.length > 0) {
      const probe = document.createRange();
      const start = point.offset === 0 ? 0 : point.offset - 1;
      probe.setStart(point.textNode, start);
      probe.setEnd(point.textNode, start + 1);
      rect = Array.from(probe.getClientRects()).find(candidate => candidate.height > 0);
      atStart = point.offset === 0;
    } else if (!(editable.textContent ?? "").trim() && !editable.querySelector("img, iframe, video, svg")) {
      rect = editable.getClientRects()[0];
    }
  }
  if (!rect) return null;
  const style = getComputedStyle(editable);
  const height = (parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.625 || 26) * 1.05;
  const x = atStart ? rect.left : rect.right;
  const y = rect.top + (Math.min(rect.height, height) - height) / 2 - 2;
  return Number.isFinite(x) && Number.isFinite(y) && height > 0 ? { x, y, height } : null;
}
