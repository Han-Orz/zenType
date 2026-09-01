import { TYPEWRITER_CONFIG } from "../../config";
import {
  claimInlineStyle,
  restoreOwnedInlineStyle,
  setOwnedInlineStyle,
  type OwnedInlineStyle,
} from "../../utils/inlineStyleOwnership";
import { prefersReducedMotion } from "../../utils/reducedMotion";

const { SCROLL_CURVE } = TYPEWRITER_CONFIG;
const FLIP_BLOCK_RADIUS = 30;

type DeferredFrameScheduler = (callback: FrameRequestCallback) => number;

let activeFLIPTimer: ReturnType<typeof setTimeout> | null = null;
let lastFLIPElements: HTMLElement[] = [];
const ownedFLIPStyles = new WeakMap<HTMLElement, OwnedInlineStyle>();
let flipGeneration = 0;

function clearActiveFLIPTimer(): void {
  if (activeFLIPTimer === null) return;
  clearTimeout(activeFLIPTimer);
  activeFLIPTimer = null;
}

function clearLastFLIPElements(): void {
  for (const el of lastFLIPElements) {
    const owned = ownedFLIPStyles.get(el);
    if (owned) restoreOwnedInlineStyle(el.style, owned);
    ownedFLIPStyles.delete(el);
  }
  lastFLIPElements = [];
}

function setOwnedFLIPStyle(el: HTMLElement, property: string, value: string): void {
  let owned = ownedFLIPStyles.get(el);
  if (!owned) {
    owned = claimInlineStyle(el.style, ["transform", "transition"]);
    ownedFLIPStyles.set(el, owned);
  }
  setOwnedInlineStyle(el.style, owned, property, value);
}

function isBlockElement(el: Element | null): el is HTMLElement {
  return el instanceof HTMLElement && el.hasAttribute("data-node-id");
}

function addSiblingWindow(block: HTMLElement, blocks: Set<HTMLElement>): void {
  blocks.add(block);

  let prev = block.previousElementSibling;
  let prevCount = 0;
  while (prev && prevCount < FLIP_BLOCK_RADIUS) {
    if (isBlockElement(prev)) {
      blocks.add(prev);
      prevCount++;
    }
    prev = prev.previousElementSibling;
  }

  let next = block.nextElementSibling;
  let nextCount = 0;
  while (next && nextCount < FLIP_BLOCK_RADIUS) {
    if (isBlockElement(next)) {
      blocks.add(next);
      nextCount++;
    }
    next = next.nextElementSibling;
  }
}

function addFlipWindowsFromBlock(block: HTMLElement, editor: HTMLElement, blocks: Set<HTMLElement>): void {
  let current: HTMLElement | null = block;
  while (current && current !== editor && editor.contains(current)) {
    if (isBlockElement(current)) addSiblingWindow(current, blocks);

    const parent: HTMLElement | null = current.parentElement;
    if (!parent || parent === editor) break;

    const ancestor = parent.closest("[data-node-id]") as HTMLElement | null;
    if (!ancestor || ancestor === current || !editor.contains(ancestor)) break;
    current = ancestor;
  }
}

function elementFromNode(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement;
}

function collectFlipBlocks(editor: HTMLElement, range: Range): HTMLElement[] {
  const blocks = new Set<HTMLElement>();
  const startBlock = elementFromNode(range.startContainer)?.closest("[data-node-id]") as HTMLElement | null;
  if (startBlock && editor.contains(startBlock)) {
    addFlipWindowsFromBlock(startBlock, editor, blocks);
  }

  if (!range.collapsed) {
    const endBlock = elementFromNode(range.endContainer)?.closest("[data-node-id]") as HTMLElement | null;
    if (endBlock && endBlock !== startBlock && editor.contains(endBlock)) {
      addFlipWindowsFromBlock(endBlock, editor, blocks);
    }
  }

  // Rare fallback for unexpected selection containers: keep the old behavior.
  return blocks.size > 0
    ? Array.from(blocks)
    : Array.from(editor.querySelectorAll<HTMLElement>("[data-node-id]"));
}

/** Cancel the current FLIP generation, cleanup timer, and owned inline styles. */
export function reset(): void {
  flipGeneration += 1;
  clearActiveFLIPTimer();
  clearLastFLIPElements();
}

/** Whether the latest completed Invert phase found any shifted blocks. */
export function hasShiftedBlocks(): boolean {
  return lastFLIPElements.length > 0;
}

/**
 * Start the existing three-stage FLIP sequence. The Typewriter supplies its
 * shared deferred-frame scheduler so frame ownership and lifecycle stay there.
 */
export function start(
  editor: HTMLElement,
  range: Range,
  requestDeferredFrame: DeferredFrameScheduler,
): void {
  if (prefersReducedMotion()) {
    reset();
    return;
  }
  const token = ++flipGeneration;

  // Cancel the previous cleanup before a new FLIP can own these styles.
  clearActiveFLIPTimer();
  clearLastFLIPElements();

  // Capture the nearby blocks before SiYuan's bubble handler changes the DOM.
  const first = new Map<HTMLElement, number>();
  collectFlipBlocks(editor, range).forEach((el) => {
    first.set(el, el.getBoundingClientRect().top);
  });

  // Wait one frame for SiYuan to finish the DOM change.
  requestDeferredFrame(() => {
    if (token !== flipGeneration) return;

    const modifiedElements: HTMLElement[] = [];

    // Phase 1 (Invert): batch all writes without an intermediate reflow.
    for (const [el, y0] of first) {
      if (!el.isConnected) continue;
      const y1 = el.getBoundingClientRect().top;
      const delta = y0 - y1;
      if (Math.abs(delta) < 2) continue;

      setOwnedFLIPStyle(el, "transform", `translateY(${delta}px)`);
      setOwnedFLIPStyle(el, "transition", "none");
      modifiedElements.push(el);
    }

    lastFLIPElements = modifiedElements;

    if (modifiedElements.length === 0) return;

    // Phase 2 (Commit): the single forced layout.
    void editor.offsetHeight;

    // Phase 3 (Play): start every transition in one deferred frame.
    requestDeferredFrame(() => {
      if (token !== flipGeneration) return;

      for (const el of modifiedElements) {
        setOwnedFLIPStyle(el, "transition", `transform 250ms ${SCROLL_CURVE}`);
        setOwnedFLIPStyle(el, "transform", "");
      }
      clearActiveFLIPTimer();
      activeFLIPTimer = setTimeout(() => {
        if (token !== flipGeneration || activeFLIPTimer === null) return;
        activeFLIPTimer = null;
        modifiedElements.forEach((el) => {
          const owned = ownedFLIPStyles.get(el);
          if (owned) restoreOwnedInlineStyle(el.style, owned);
          ownedFLIPStyles.delete(el);
        });
      }, 300);
    });
  });
}
