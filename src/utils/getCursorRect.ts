import type { CursorRect } from "../types";
import { resolveRangeTextPoint } from "./rangeTextPoint";

function firstRect(range: Range): DOMRect | undefined {
  return Array.from(range.getClientRects()).find(rect => rect.height > 0 && Number.isFinite(rect.x) && Number.isFinite(rect.y));
}

/** Blocks with no text position of their own: an invented rectangle would show a
 *  cursor where the user cannot type (a separator, an image, a table). */
const STRUCTURAL_BLOCK = /^Node(ThematicBreak|Image|Video|Audio|Widget|IFrame|HTMLBlock|Table|QueryEmbed|AttributeView|MathBlock)$/;

export function isStructuralBlock(element: HTMLElement | null): boolean {
  return !!element && STRUCTURAL_BLOCK.test(element.dataset.type ?? "");
}

/** A block with no content of its own: the caret sits on its first line. */
function isEmptyBlock(block: HTMLElement): boolean {
  // Only real content counts. Block chrome (marker/attr icons) is svg and must
  // not disqualify an otherwise empty block.
  return !(block.textContent ?? "").replace(/[\u200B\uFEFF\u00A0]/g, "").trim() &&
    !block.querySelector('img, iframe, [data-type^="NodeMathBlock"], [data-type^="NodeCodeBlock"]');
}

export function getCursorRect(range: Range, editable: HTMLElement): CursorRect | null {
  const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const block = element?.closest<HTMLElement>("[data-node-id]") ?? null;
  const style = getComputedStyle(element ?? editable);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.625 || 26;
  const height = lineHeight * 1.05;
  let rect = Array.from(range.getClientRects()).filter(rect => rect.height > 0).at(-1);
  let x = rect?.right;

  if (!rect) {
    if (isStructuralBlock(block)) return null;
    // A collapsed range at a block boundary has no client rect. Every recovery
    // below is scoped to the caret's own block: the editable root spans the whole
    // document, so measuring it would read another block's line, its text is
    // never empty, and a probe there can resolve to an unrelated glyph.
    const scope = block ?? editable;
    const point = resolveRangeTextPoint(range.startContainer, range.startOffset);
    if (point && scope.contains(point.textNode)) {
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
        const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            return node.nodeValue?.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
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
    if (!rect && isEmptyBlock(scope)) {
      // Prefer the caret's content host when it sits inside the block: its box is
      // the text area, so the cursor lands where typing would start instead of at
      // the block's outer edge (which includes a list marker or gutter).
      const host = editable !== scope && scope.contains(editable) ? editable : scope;
      const box = host.getBoundingClientRect();
      const emptyStyle = getComputedStyle(host);
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
