import { TYPEWRITER_CONFIG } from "../../config";
import {
  claimInlineStyle,
  restoreOwnedInlineStyle,
  setOwnedInlineStyle,
  type OwnedInlineStyle,
} from "../../utils/inlineStyleOwnership";
import { prefersReducedMotion } from "../../utils/reducedMotion";
import * as inputMode from "../inputMode";
import { getStructuralEditSnapshot } from "../structuralEdit";

const { SCROLL_CURVE } = TYPEWRITER_CONFIG;
const FLIP_BLOCK_RADIUS = 30;

type DeferredFrameScheduler = (callback: FrameRequestCallback) => number;

let activeFLIPTimer: ReturnType<typeof setTimeout> | null = null;
let lastFLIPElements: HTMLElement[] = [];
const ownedFLIPStyles = new WeakMap<HTMLElement, OwnedInlineStyle>();
let flipGeneration = 0;

// ── Development-only FLIP forensics (production builds are no-ops) ──────

const DEBUG_ENABLED = __ZENTYPE_DEV__;

export type FlipDebugEventName =
  | "flip-start"
  | "flip-invert"
  | "flip-play"
  | "flip-cleanup"
  | "flip-reset"
  | "flip-frame-dead"
  | "flip-write-blocked";

export interface FlipDebugEvent {
  name: FlipDebugEventName;
  [key: string]: unknown;
}

type FlipDebugSink = (event: FlipDebugEvent) => void;
let debugSink: FlipDebugSink | null = null;
const elementTokens = new WeakMap<object, number>();
let elementTokenSequence = 0;
let invertDebugBlocks: Array<Record<string, unknown>> | null = null;

export function setFlipDebugSink(next: FlipDebugSink | null): void {
  if (!DEBUG_ENABLED) return;
  debugSink = next;
}

function elementToken(el: Element | null | undefined): number | null {
  if (!el) return null;
  let token = elementTokens.get(el);
  if (token === undefined) {
    token = ++elementTokenSequence;
    elementTokens.set(el, token);
  }
  return token;
}

function structuralSnapshot(): Record<string, unknown> {
  const snapshot = getStructuralEditSnapshot();
  return { generation: snapshot.generation, phase: snapshot.phase, kind: snapshot.kind };
}

function inputModeSnapshot(): Record<string, unknown> {
  return { typewriterActive: inputMode.isTypewriterActive(), focusActive: inputMode.isFocusActive() };
}

function findScrollContainer(editor: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = editor;
  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    if (
      (style.overflowY === "auto" || style.overflowY === "scroll")
      && current.scrollHeight > current.clientHeight
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function scrollTopOf(editor: HTMLElement): { container: number | null; scrollTop: number } | null {
  const container = findScrollContainer(editor);
  if (!container) return null;
  return { container: elementToken(container), scrollTop: Math.round(container.scrollTop * 100) / 100 };
}

function blockSample(
  el: HTMLElement,
  viewportTop: number | null,
  scroll: { container: number | null; scrollTop: number } | null,
): Record<string, unknown> {
  return {
    id: el.getAttribute("data-node-id"),
    elToken: elementToken(el),
    connected: el.isConnected,
    viewportTop: viewportTop === null ? null : Math.round(viewportTop * 100) / 100,
    contentTop: viewportTop === null || !scroll
      ? null
      : Math.round((viewportTop + scroll.scrollTop) * 100) / 100,
  };
}

function caretBlockId(): string | null {
  if (typeof window === "undefined" || typeof window.getSelection !== "function") return null;
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  const element = node
    ? (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)
    : null;
  return element?.closest("[data-node-id]")?.getAttribute("data-node-id") ?? null;
}

function emitDebug(event: FlipDebugEvent): void {
  if (!DEBUG_ENABLED) return;
  debugSink?.({
    ...event,
    flipGeneration: event.flipGeneration ?? flipGeneration,
    structural: structuralSnapshot(),
    inputMode: inputModeSnapshot(),
  });
}

function debugWrite(el: HTMLElement, property: string, value: string): void {
  setOwnedFLIPStyle(el, property, value);
}

function clearActiveFLIPTimer(): void {
  if (activeFLIPTimer === null) return;
  clearTimeout(activeFLIPTimer);
  activeFLIPTimer = null;
}

function releaseFLIPElement(el: HTMLElement): void {
  const owned = ownedFLIPStyles.get(el);
  if (owned) restoreOwnedInlineStyle(el.style, owned);
  ownedFLIPStyles.delete(el);
}

function clearLastFLIPElements(): void {
  for (const el of lastFLIPElements) releaseFLIPElement(el);
  lastFLIPElements = [];
}

function setOwnedFLIPStyle(el: HTMLElement, property: string, value: string): boolean {
  let owned = ownedFLIPStyles.get(el);
  if (!owned) {
    owned = claimInlineStyle(el.style, ["transform", "transition"]);
    ownedFLIPStyles.set(el, owned);
  }
  const written = setOwnedInlineStyle(el.style, owned, property, value);
  if (DEBUG_ENABLED && !written) {
    emitDebug({
      name: "flip-write-blocked",
      elToken: elementToken(el),
      id: el.getAttribute("data-node-id"),
      property,
      value,
      hadOwner: true,
    });
  }
  return written;
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

function collectFlipBlocks(editor: HTMLElement, range: Range): HTMLElement[] | null {
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

  // FLIP is an enhancement: do not scan a long editor when the local block
  // boundary cannot be established reliably.
  return blocks.size > 0 ? Array.from(blocks) : null;
}

/** Cancel the current FLIP generation, cleanup timer, and owned inline styles. */
export function reset(): void {
  if (DEBUG_ENABLED) {
    const stack = (new Error().stack ?? "")
      .split("\n")
      .slice(2, 7)
      .map((line) => line.trim().replace(/^at /, ""))
      .join(" <- ");
    emitDebug({
      name: "flip-reset",
      releasedCount: lastFLIPElements.length,
      hadTimer: activeFLIPTimer !== null,
      caller: stack,
    });
  }
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
    if (DEBUG_ENABLED) {
      emitDebug({ name: "flip-reset", reason: "reduced-motion", releasedCount: lastFLIPElements.length });
    }
    reset();
    return;
  }
  const blocks = collectFlipBlocks(editor, range);
  if (!blocks) {
    if (DEBUG_ENABLED) {
      emitDebug({ name: "flip-start", reason: "no-blocks", blockCount: 0, caretBlockId: caretBlockId(), editorToken: elementToken(editor) });
    }
    return;
  }

  const token = ++flipGeneration;
  const scrollAtStart = scrollTopOf(editor);

  // Cancel the previous cleanup before a new FLIP can own these styles.
  const hadPendingCleanup = activeFLIPTimer !== null;
  clearActiveFLIPTimer();

  // Capture nearby blocks before SiYuan's bubble handler changes the DOM.
  // rect.top freezes the rendered viewport position for the invert transform;
  // offsetTop is scroll-immune layout position, so the skip decision cannot
  // mistake Typewriter scroll motion for structural block motion.
  const first = new Map<HTMLElement, { top: number; offsetTop: number }>();
  blocks.forEach((el) => {
    first.set(el, { top: el.getBoundingClientRect().top, offsetTop: el.offsetTop });
  });

  // If an earlier FLIP is still visible, freeze each element at its rendered
  // position and carry that position into the new snapshot. This avoids
  // restoring the old animation to its logical endpoint during interruption.
  const interruptedElements = new Set<HTMLElement>();
  const interruptedVisualTops = new Map<HTMLElement, number>();
  for (const el of lastFLIPElements) {
    if (!el.isConnected) {
      releaseFLIPElement(el);
      continue;
    }
    interruptedElements.add(el);
    const visualTop = first.get(el)?.top ?? el.getBoundingClientRect().top;
    interruptedVisualTops.set(el, visualTop);
    first.set(el, { top: visualTop, offsetTop: el.offsetTop });
  }

  if (DEBUG_ENABLED) {
    const startScrollTop = scrollAtStart?.scrollTop ?? 0;
    emitDebug({
      name: "flip-start",
      token,
      editorToken: elementToken(editor),
      caretBlockId: caretBlockId(),
      blockCount: first.size,
      hadPendingCleanup,
      lastFLIPSize: lastFLIPElements.length,
      scroll: scrollAtStart,
      blocks: Array.from(first.entries()).map(([el, captured]) => blockSample(el, captured.top, scrollAtStart)),
      interrupted: Array.from(interruptedVisualTops.entries()).map(([el, visualTop]) => ({
        ...blockSample(el, visualTop, scrollAtStart),
        contentTop: Math.round((visualTop + startScrollTop) * 100) / 100,
      })),
    });
  }

  // Interruption preparation is deliberately split into read, baseline-write,
  // sync, logical-read, and rebase-write phases. The browser can therefore
  // satisfy all logical reads from one synchronized layout instead of flushing
  // once per interrupted element.
  for (const el of interruptedElements) {
    setOwnedFLIPStyle(el, "transition", "none");
  }
  for (const el of interruptedElements) {
    setOwnedFLIPStyle(el, "transform", "");
  }
  if (interruptedElements.size > 0) {
    void editor.offsetHeight;
  }
  const interruptedLogicalTops = new Map<HTMLElement, number>();
  for (const el of interruptedElements) {
    if (el.isConnected) interruptedLogicalTops.set(el, el.getBoundingClientRect().top);
  }
  for (const [el, visualTop] of interruptedVisualTops) {
    const logicalTop = interruptedLogicalTops.get(el);
    if (logicalTop === undefined) {
      releaseFLIPElement(el);
      continue;
    }
    setOwnedFLIPStyle(el, "transform", `translateY(${visualTop - logicalTop}px)`);
  }

  // SiYuan applies the structural DOM change asynchronously after the keydown
  // (a merge lands ~20ms later, past the next animation frame). Inverting on a
  // fixed frame reads pre-change layout, finds no delta, and the blocks snap.
  // Invert on the first childList mutation instead — the same signal the
  // structural-edit coordinator uses — with a bounded frame fallback so a
  // no-op edit cannot leave interrupted elements frozen forever.
  let invertDone = false;
  let invertObserver: MutationObserver | null = null;
  let fallbackFramesLeft = 3;
  let fallbackFrame: number | null = null;

  const detachInvertTriggers = (): void => {
    invertObserver?.disconnect();
    invertObserver = null;
    if (fallbackFrame !== null) {
      cancelAnimationFrame(fallbackFrame);
      fallbackFrame = null;
    }
  };

  const runInvert = (trigger: "mutation" | "fallback"): void => {
    if (invertDone) return;
    invertDone = true;
    detachInvertTriggers();
    if (token !== flipGeneration) {
      if (DEBUG_ENABLED) {
        emitDebug({ name: "flip-frame-dead", phase: "invert", token, currentGeneration: flipGeneration, trigger });
      }
      return;
    }

    const interruptedConnected = Array.from(interruptedElements).filter((el) => el.isConnected);
    for (const el of interruptedConnected) {
      setOwnedFLIPStyle(el, "transition", "none");
    }
    for (const el of interruptedConnected) {
      setOwnedFLIPStyle(el, "transform", "");
    }

    const deltas = new Map<HTMLElement, number>();
    const scrollAtInvert = DEBUG_ENABLED ? scrollTopOf(editor) : null;
    if (DEBUG_ENABLED) invertDebugBlocks = [];

    // Phase 1 (Invert): read every new position before writing any invert.
    for (const [el, before] of first) {
      if (!el.isConnected) continue;
      const y1 = el.getBoundingClientRect().top;
      // Structural delta comes from scroll-immune layout positions; the
      // transform itself keeps the viewport delta so the element stays at its
      // exact pre-edit rendered position while the transition runs.
      const structuralDelta = before.offsetTop - el.offsetTop;
      const viewportDelta = before.top - y1;
      if (DEBUG_ENABLED && invertDebugBlocks && invertDebugBlocks.length < 80) {
        invertDebugBlocks.push({
          ...blockSample(el, y1, scrollAtInvert),
          viewportDelta: Math.round(viewportDelta * 100) / 100,
          layoutDelta: Math.round(structuralDelta * 100) / 100,
          scrollDelta: scrollAtInvert && scrollAtStart
            ? Math.round((scrollAtInvert.scrollTop - scrollAtStart.scrollTop) * 100) / 100
            : null,
          contentDelta: scrollAtInvert && scrollAtStart
            ? Math.round(((y1 + scrollAtInvert.scrollTop) - (before.top + scrollAtStart.scrollTop)) * 100) / 100
            : null,
          skipped: Math.abs(structuralDelta) < 2,
          capturedTop: Math.round(before.top * 100) / 100,
        });
      }
      if (Math.abs(structuralDelta) < 2) continue;

      deltas.set(el, viewportDelta);
    }

    // Then batch every invert write together.
    const modifiedElements: HTMLElement[] = [];
    for (const [el, delta] of deltas) {
      setOwnedFLIPStyle(el, "transform", `translateY(${delta}px)`);
      setOwnedFLIPStyle(el, "transition", "none");
      modifiedElements.push(el);
    }

    lastFLIPElements = modifiedElements;
    const modifiedSet = new Set(modifiedElements);
    for (const el of interruptedElements) {
      if (!modifiedSet.has(el)) releaseFLIPElement(el);
    }

    if (DEBUG_ENABLED) {
      const deadSamples: Array<Record<string, unknown>> = [];
      for (const [el] of first) {
        if (el.isConnected || deadSamples.length >= 12) continue;
        const id = el.getAttribute("data-node-id");
        let replacement: Element | null = null;
        try {
          replacement = id ? editor.querySelector(`[data-node-id="${CSS.escape(id)}"]`) : null;
        } catch {
          replacement = null;
        }
        deadSamples.push({
          id,
          elToken: elementToken(el),
          replacementConnected: replacement?.isConnected ?? false,
          replacementToken: elementToken(replacement),
        });
      }
      emitDebug({
        name: "flip-invert",
        token,
        trigger,
        blockCount: first.size,
        deadFirst: Array.from(first.keys()).filter((el) => !el.isConnected).length,
        deadSamples,
        scroll: scrollAtInvert,
        scrollAtStart,
        modifiedCount: modifiedElements.length,
        blocks: invertDebugBlocks ?? [],
      });
      invertDebugBlocks = null;
    }

    if (modifiedElements.length === 0) return;

    // Phase 2 (Commit): the single forced layout.
    void editor.offsetHeight;

    // Phase 3 (Play): start every transition in one deferred frame.
    requestDeferredFrame(() => {
      if (token !== flipGeneration) {
        if (DEBUG_ENABLED) {
          emitDebug({ name: "flip-frame-dead", phase: "play", token, currentGeneration: flipGeneration, modifiedCount: modifiedElements.length });
        }
        return;
      }

      for (const el of modifiedElements) {
        setOwnedFLIPStyle(el, "transition", `transform 250ms ${SCROLL_CURVE}`);
        setOwnedFLIPStyle(el, "transform", "");
      }
      if (DEBUG_ENABLED) {
        emitDebug({
          name: "flip-play",
          token,
          modifiedCount: modifiedElements.length,
          transition: `transform 250ms ${SCROLL_CURVE}`,
          blocks: modifiedElements.slice(0, 40).map((el) => ({
            id: el.getAttribute("data-node-id"),
            elToken: elementToken(el),
            transformFrom: `translateY(${deltas.get(el)}px)`,
          })),
        });
      }
      clearActiveFLIPTimer();
      activeFLIPTimer = setTimeout(() => {
        if (token !== flipGeneration || activeFLIPTimer === null) return;
        activeFLIPTimer = null;
        if (DEBUG_ENABLED) {
          emitDebug({ name: "flip-cleanup", token, releasedCount: modifiedElements.length });
        }
        modifiedElements.forEach(releaseFLIPElement);
        lastFLIPElements = [];
      }, 300);
    });
  };

  if (typeof MutationObserver === "function") {
    invertObserver = new MutationObserver((records) => {
      if (records.some((record) => record.type === "childList")) runInvert("mutation");
    });
    invertObserver.observe(editor, { childList: true, subtree: true });
  }
  const fallbackTick = (): void => {
    if (invertDone || token !== flipGeneration) return;
    fallbackFramesLeft -= 1;
    if (fallbackFramesLeft <= 0) {
      runInvert("fallback");
      return;
    }
    fallbackFrame = requestDeferredFrame(fallbackTick);
  };
  fallbackFrame = requestDeferredFrame(fallbackTick);
}
