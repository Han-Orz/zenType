import { TYPEWRITER_CONFIG } from "../../config";
import {
  claimInlineStyle,
  restoreOwnedInlineStyle,
  setOwnedInlineStyle,
  type OwnedInlineStyle,
} from "../../utils/inlineStyleOwnership";
import { prefersReducedMotion } from "../../utils/reducedMotion";
import * as inputMode from "../inputMode";
import { RIPPLE_BLOCK_CLASS } from "../ripple/structuralCarryover";
import { getStructuralEditSnapshot } from "../structuralEdit";

const { SCROLL_CURVE } = TYPEWRITER_CONFIG;
const FLIP_BLOCK_RADIUS = 30;
// Fail-open ceilings for the geometry readiness loop, not latency: an armed
// generation inverts on its first ready frame. Real-machine worst ready is
// ~31ms after keydown (Backspace merge, 3rd rAF), so 150ms ≈ 5× headroom and
// the frame cap only matters under frame starvation.
const READINESS_TIMEOUT_MS = 150;
const READINESS_MAX_FRAMES = 12;

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
  | "flip-geometry"
  | "flip-write-blocked"
  | "flip-transition-probe";

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

// Dev-only readiness forensics: sample tracked-block geometry every rAF for a
// bounded window after the First snapshot, recording viewport and
// content-frame coordinates separately. contentTop is measured against the
// scroll container's own rect, so plain scrollTop changes cancel out. This
// observes only; the production FLIP timeline is untouched.
const FLIP_GEOMETRY_SAMPLE_FRAMES = 6;

function startGeometrySampler(
  editor: HTMLElement,
  token: number,
  first: Map<HTMLElement, number>,
  firstViewport: Map<HTMLElement, number>,
): void {
  const round2 = (value: number): number => Math.round(value * 100) / 100;
  // `first` already stores content-space tops; the sampler re-derives the same
  // quantity per frame from the live container rect and scrollTop.

  const mutationLog: Array<Record<string, unknown>> = [];
  let samplerObserver: MutationObserver | null = null;
  if (typeof MutationObserver === "function") {
    samplerObserver = new MutationObserver((records) => {
      if (mutationLog.length >= 8) return;
      let childList = 0;
      let added = 0;
      let removed = 0;
      for (const record of records) {
        if (record.type !== "childList") continue;
        childList += 1;
        added += record.addedNodes.length;
        removed += record.removedNodes.length;
      }
      if (childList === 0) return;
      mutationLog.push({
        t: Math.round(performance.now()),
        childList,
        added,
        removed,
      });
    });
    samplerObserver.observe(editor, { childList: true, subtree: true });
  }

  const startedAt = performance.now();
  let frame = 0;

  const finish = (phase: "dead" | "window-exhausted"): void => {
    samplerObserver?.disconnect();
    samplerObserver = null;
    emitDebug({
      name: "flip-geometry",
      phase,
      token,
      frames: frame,
      mutations: [...mutationLog],
    });
  };

  const sampleTick = (): void => {
    if (token !== flipGeneration) {
      finish("dead");
      return;
    }
    frame += 1;
    const container = findScrollContainer(editor);
    const containerRect = container ? container.getBoundingClientRect() : null;
    const scrollTop = container ? container.scrollTop : 0;
    const blocks: Array<Record<string, unknown>> = [];
    for (const [el, contentBase] of first) {
      const viewportTop = el.getBoundingClientRect().top;
      const contentTop = containerRect
        ? viewportTop - containerRect.top + scrollTop
        : null;
      blocks.push({
        id: el.getAttribute("data-node-id"),
        elToken: elementToken(el),
        connected: el.isConnected,
        viewportTop: round2(viewportTop),
        contentTop: contentTop === null ? null : round2(contentTop),
        dViewportFromFirst: round2(viewportTop - (firstViewport.get(el) ?? viewportTop)),
        dContentFromFirst: contentTop === null
          ? null
          : round2(contentTop - contentBase),
        offsetTop: el.offsetTop,
      });
    }
    emitDebug({
      name: "flip-geometry",
      phase: "sample",
      token,
      frame,
      elapsedMs: Math.round(performance.now() - startedAt),
      container: container && containerRect
        ? {
          token: elementToken(container),
          scrollTop: round2(scrollTop),
          rectTop: round2(containerRect.top),
        }
        : null,
      mutations: [...mutationLog],
      blocks,
    });
    if (frame >= FLIP_GEOMETRY_SAMPLE_FRAMES) {
      finish("window-exhausted");
      return;
    }
    requestAnimationFrame(sampleTick);
  };

  requestAnimationFrame(sampleTick);
}

// Dev-only transition probe: sample each modified block's inline and computed
// transition state at Invert, immediately after the Play writes, and for three
// frames afterwards. This observes whether the FLIP transform transition
// actually interpolates, or is suppressed by a stylesheet-level important
// transition on the same element (Ripple block dimming class, which must keep
// its Marker fix). Observes only; the production FLIP timeline is untouched.
function transitionProbeSample(el: HTMLElement): Record<string, unknown> {
  const computed = window.getComputedStyle(el);
  return {
    id: el.getAttribute("data-node-id"),
    elToken: elementToken(el),
    connected: el.isConnected,
    hasRippleClass: el.classList.contains("zentype-ripple-block"),
    inlineTransition: el.style.getPropertyValue("transition"),
    inlineTransitionPriority: el.style.getPropertyPriority("transition"),
    inlineTransform: el.style.getPropertyValue("transform"),
    computedTransitionProperty: computed.transitionProperty,
    computedTransitionDuration: computed.transitionDuration,
    computedTransitionTimingFunction: computed.transitionTimingFunction,
    computedTransform: computed.transform,
    viewportTop: Math.round(el.getBoundingClientRect().top * 100) / 100,
  };
}

function emitTransitionProbe(token: number, phase: string, elements: HTMLElement[]): void {
  if (elements.length === 0) return;
  emitDebug({
    name: "flip-transition-probe",
    token,
    phase,
    modifiedCount: elements.length,
    blocks: elements.map(transitionProbeSample),
  });
}

function startTransitionPostProbe(token: number, elements: HTMLElement[]): void {
  let completedFrames = 0;
  const postTick = (): void => {
    if (token !== flipGeneration) {
      emitDebug({
        name: "flip-transition-probe",
        token,
        phase: "aborted",
        completedFrames,
        blocks: [],
      });
      return;
    }
    completedFrames += 1;
    emitTransitionProbe(token, `post${completedFrames}`, elements);
    if (completedFrames < 3) requestAnimationFrame(postTick);
  };
  requestAnimationFrame(postTick);
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

function setOwnedFLIPStyle(el: HTMLElement, property: string, value: string, priority = ""): boolean {
  let owned = ownedFLIPStyles.get(el);
  if (!owned) {
    owned = claimInlineStyle(el.style, ["transform", "transition"]);
    ownedFLIPStyles.set(el, owned);
  }
  const written = setOwnedInlineStyle(el.style, owned, property, value, priority);
  if (DEBUG_ENABLED && !written) {
    emitDebug({
      name: "flip-write-blocked",
      elToken: elementToken(el),
      id: el.getAttribute("data-node-id"),
      property,
      value,
      priority,
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
  // First is stored in content space (block rect relative to the scroll
  // container's own origin plus its scrollTop), so Typewriter viewport
  // scrolling cancels out and only structural movement changes the value.
  const container0 = findScrollContainer(editor);
  const containerTop0 = container0 ? container0.getBoundingClientRect().top : 0;
  const scrollTop0 = container0 ? container0.scrollTop : 0;
  const first = new Map<HTMLElement, number>();
  const firstViewport = new Map<HTMLElement, number>();
  blocks.forEach((el) => {
    const top = el.getBoundingClientRect().top;
    firstViewport.set(el, top);
    first.set(el, top - containerTop0 + scrollTop0);
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
    const visualTop = firstViewport.get(el) ?? el.getBoundingClientRect().top;
    interruptedVisualTops.set(el, visualTop);
    first.set(el, visualTop - containerTop0 + scrollTop0);
  }

  if (DEBUG_ENABLED) {
    emitDebug({
      name: "flip-start",
      token,
      editorToken: elementToken(editor),
      caretBlockId: caretBlockId(),
      blockCount: first.size,
      hadPendingCleanup,
      lastFLIPSize: lastFLIPElements.length,
      scroll: scrollAtStart,
      blocks: Array.from(first.entries()).map(([el, contentTop]) => ({
        id: el.getAttribute("data-node-id"),
        elToken: elementToken(el),
        connected: el.isConnected,
        viewportTop: Math.round((firstViewport.get(el) ?? 0) * 100) / 100,
        contentTop: Math.round(contentTop * 100) / 100,
      })),
      interrupted: Array.from(interruptedVisualTops.entries()).map(([el, visualTop]) => ({
        id: el.getAttribute("data-node-id"),
        elToken: elementToken(el),
        connected: el.isConnected,
        viewportTop: Math.round(visualTop * 100) / 100,
        contentTop: Math.round((first.get(el) ?? 0) * 100) / 100,
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

  if (DEBUG_ENABLED) {
    startGeometrySampler(editor, token, first, firstViewport);
  }

  // Wait for SiYuan's structural change to actually reach geometry instead of
  // guessing one fixed frame ahead: poll tracked blocks every rAF and invert
  // on the first frame where any connected block's content position moved.
  // Content-space comparison cancels Typewriter viewport scrolling, so only a
  // structural shift arms the gate. Fail open: if nothing moves within the
  // bounds the loop inverts anyway and the ~0 deltas skip, matching the old
  // fixed-frame behavior.
  let readinessFrames = 0;
  const readinessStartedAt = performance.now();
  const runInvert = (expired: boolean): void => {
    if (token !== flipGeneration) {
      if (DEBUG_ENABLED) {
        emitDebug({ name: "flip-frame-dead", phase: "readiness", token, currentGeneration: flipGeneration });
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

    const container = container0 && container0.isConnected ? container0 : null;
    const containerTop = container ? container.getBoundingClientRect().top : 0;
    const scrollTop = container ? container.scrollTop : 0;
    const deltas = new Map<HTMLElement, number>();
    const scrollAtInvert = DEBUG_ENABLED ? scrollTopOf(editor) : null;
    if (DEBUG_ENABLED) invertDebugBlocks = [];

    // Phase 1 (Invert): read every new position before writing any invert.
    // The structural delta is First contentTop − current contentTop; viewport
    // motion owned by the Typewriter cancels out of the comparison.
    for (const [el, y0] of first) {
      if (!el.isConnected) continue;
      const rectTop = el.getBoundingClientRect().top;
      const y1 = container ? rectTop - containerTop + scrollTop : rectTop;
      const delta = y0 - y1;
      if (DEBUG_ENABLED && invertDebugBlocks && invertDebugBlocks.length < 80) {
        invertDebugBlocks.push({
          ...blockSample(el, rectTop, scrollAtInvert),
          viewportDelta: Math.round((rectTop - (firstViewport.get(el) ?? rectTop)) * 100) / 100,
          contentDelta: Math.round(delta * 100) / 100,
          skipped: Math.abs(delta) < 2,
          capturedContentTop: Math.round(y0 * 100) / 100,
        });
      }
      if (Math.abs(delta) < 2) continue;

      deltas.set(el, delta);
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
        blockCount: first.size,
        deadFirst: Array.from(first.keys()).filter((el) => !el.isConnected).length,
        deadSamples,
        scroll: scrollAtInvert,
        scrollAtStart,
        modifiedCount: modifiedElements.length,
        readiness: {
          frames: readinessFrames,
          elapsedMs: Math.round(performance.now() - readinessStartedAt),
          expired,
        },
        blocks: invertDebugBlocks ?? [],
      });
      invertDebugBlocks = null;
      emitTransitionProbe(token, "invert", modifiedElements);
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

      const plainTransition = `transform 250ms ${SCROLL_CURVE}`;
      const rippleComposedTransition =
        `opacity var(--zt-ripple-transition-duration) ease, transform 250ms ${SCROLL_CURVE}`;
      for (const el of modifiedElements) {
        // Ripple owns the block transition shorthand at stylesheet level with
        // !important (Marker flicker fix), so on those blocks a plain inline
        // transition loses the cascade and the transform snaps. FLIP composes
        // its transform into one important inline transition instead; the
        // opacity half mirrors Ripple's rule exactly and keeps using the
        // duration custom property so Ripple's 0s handoff still works.
        const rippleOwned = el.classList.contains(RIPPLE_BLOCK_CLASS);
        setOwnedFLIPStyle(
          el,
          "transition",
          rippleOwned ? rippleComposedTransition : plainTransition,
          rippleOwned ? "important" : "",
        );
        setOwnedFLIPStyle(el, "transform", "");
      }
      if (DEBUG_ENABLED) {
        emitDebug({
          name: "flip-play",
          token,
          modifiedCount: modifiedElements.length,
          transition: plainTransition,
          rippleComposedTransition,
          blocks: modifiedElements.slice(0, 40).map((el) => ({
            id: el.getAttribute("data-node-id"),
            elToken: elementToken(el),
            transformFrom: `translateY(${deltas.get(el)}px)`,
          })),
        });
        emitTransitionProbe(token, "play", modifiedElements);
        startTransitionPostProbe(token, modifiedElements);
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

  const readinessTick = (): void => {
    if (token !== flipGeneration) {
      if (DEBUG_ENABLED) {
        emitDebug({ name: "flip-frame-dead", phase: "readiness", token, currentGeneration: flipGeneration });
      }
      return;
    }
    readinessFrames += 1;
    const container = container0 && container0.isConnected ? container0 : null;
    const containerTop = container ? container.getBoundingClientRect().top : 0;
    const scrollTop = container ? container.scrollTop : 0;
    let movedCount = 0;
    for (const [el, y0] of first) {
      if (!el.isConnected) continue;
      const top = el.getBoundingClientRect().top;
      const contentTop = container ? top - containerTop + scrollTop : top;
      if (Math.abs(y0 - contentTop) >= 2) movedCount += 1;
    }
    if (movedCount > 0) {
      runInvert(false);
      return;
    }
    if (
      readinessFrames >= READINESS_MAX_FRAMES
      || performance.now() - readinessStartedAt >= READINESS_TIMEOUT_MS
    ) {
      runInvert(true);
      return;
    }
    requestAnimationFrame(readinessTick);
  };

  requestAnimationFrame(readinessTick);
}
