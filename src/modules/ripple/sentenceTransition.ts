/**
 * Sentence transition / presentation engine for Ripple sentence focus.
 *
 * This module owns the *presentation* side of sentence focus only. It answers
 * "what color does every sentence currently show", while ripple.ts owns the
 * *semantic* side: block DOM / selection → sentence ranges → active set →
 * theme colors → reduced-motion gate. This module never reads the selection,
 * never touches inputMode / structuralEdit / current block lookup and never
 * calls the Segmenter.
 *
 * Layer 1 — DOM-free core (`createSentenceTransitionCore`):
 *   one transition slot per in-flight sentence. Each slot keeps its own
 *   from/to/current color, duration and (frame-anchored) start time, so a
 *   retarget always resumes from the last *rendered* color — never from the
 *   old endpoint, never by inheriting the old start time, never by settling
 *   first. Stable dim sentences are tracked as geometry, not as slots.
 *
 * Layer 2 — presentation shell (`createSentenceTransitionEngine`):
 *   the single shared rAF driver plus the CSS Custom Highlight / CSS variable
 *   writes. Idle cost is zero: the driver runs only while a slot is in
 *   flight. Bounded slot pool → bounded highlight names / CSS variables.
 *
 * Sentence identity is deliberately simple (see ripple.ts docs):
 *   - no text change            → same geometry, same sentence keys;
 *   - text change, stable count → ordinal rebind keeps continuity;
 *   - count change (topology)   → settle to the final semantic state.
 */

import {
  claimInlineStyle,
  restoreOwnedInlineStyle,
  setOwnedInlineStyle,
  type OwnedInlineStyle,
} from "../../utils/inlineStyleOwnership";
import type { SentenceRange } from "./sentenceModel";

// --- Visual parameters (kept from the v2.6.1 asymmetric timing) ---

/** dim → text / focus acquisition. */
export const SENTENCE_ACQUIRE_MS = 400;
/** text → dim / context release. */
export const SENTENCE_RELEASE_MS = 600;

/** Bounded slot pool. Active sets are ≤ 2 and only members of the previous ∪
 *  current active set ever animate, so 4 covers the normal transitions plus a
 *  transient overlap during fast flapping. */
export const SENTENCE_SLOT_COUNT = 4;

/** Stable dim highlight channel owned by this engine (ripple.ts reads the
 *  channel name only to detect external clears). */
export const SENTENCE_DIM_HIGHLIGHT = "zt-sentence-dim";

const SLOT_HIGHLIGHT_PREFIX = "zt-sentence-transition";
const SLOT_VAR_PREFIX = "--zt-sentence-transition";
const SLOT_VAR_SUFFIX = "-color";
const SENTENCE_DIM_VAR = "--zt-sentence-dim-color";

// --- Pure color / timing helpers ---

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function mixColor(from: Rgba, to: Rgba, t: number): Rgba {
  return {
    r: from.r + (to.r - from.r) * t,
    g: from.g + (to.g - from.g) * t,
    b: from.b + (to.b - from.b) * t,
    a: from.a + (to.a - from.a) * t,
  };
}

export function colorToCss(color: Rgba): string {
  return `rgba(${Math.round(color.r)},${Math.round(color.g)},${Math.round(color.b)},${Math.max(0, Math.min(1, color.a))})`;
}

export function parseRgbColor(value: string): Rgba | null {
  const match = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/);
  if (!match) return null;
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: match[4] === undefined ? 1 : Number(match[4]),
  };
}

export function sameColor(a: Rgba, b: Rgba): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

// --- Core model types ---

export type SentencePresentationTarget = "active" | "dim";

export interface SentenceTransitionSlot {
  index: number;
  key: string;
  range: SentenceRange;
  target: SentencePresentationTarget;
  from: Rgba;
  to: Rgba;
  current: Rgba;
  duration: number;
  /** Frame-anchored; null until the first advance so rAF timestamps are never
   *  mixed with performance.now(). */
  startTime: number | null;
}

export interface SentenceTransitionUpdate {
  blockKey: string | null;
  sentenceRanges: readonly SentenceRange[];
  activeRanges: readonly SentenceRange[];
  textChanged: boolean;
  textColor: Rgba;
  dimColor: Rgba;
  /** false = reduced motion / zero durations / no rAF → settle instantly. */
  animate: boolean;
}

export interface SentenceTransitionUpdateResult {
  /** This update settled to the final semantic state without transitions. */
  settled: boolean;
  anyTransition: boolean;
  slots: readonly SentenceTransitionSlot[];
  stableRanges: readonly SentenceRange[];
}

export interface SentenceTransitionCompletion {
  index: number;
  key: string;
  range: SentenceRange;
  target: SentencePresentationTarget;
}

export interface SentenceTransitionAdvanceResult {
  completed: readonly SentenceTransitionCompletion[];
  stableChanged: boolean;
  anyTransition: boolean;
  slots: readonly SentenceTransitionSlot[];
}

interface CoreOptions {
  slotCount: number;
  acquireMs: number;
  releaseMs: number;
}

// --- DOM-free core ---

export interface SentenceTransitionCore {
  update(input: SentenceTransitionUpdate): SentenceTransitionUpdateResult;
  advance(now: number): SentenceTransitionAdvanceResult;
  clear(): void;
  slots(): readonly SentenceTransitionSlot[];
  stableRanges(): readonly SentenceRange[];
  hasAnimating(): boolean;
  hasStable(): boolean;
}

export function createSentenceTransitionCore(
  options: Partial<CoreOptions> = {},
): SentenceTransitionCore {
  const slotCount = options.slotCount ?? SENTENCE_SLOT_COUNT;
  const acquireMs = options.acquireMs ?? SENTENCE_ACQUIRE_MS;
  const releaseMs = options.releaseMs ?? SENTENCE_RELEASE_MS;

  let blockKey: string | null = null;
  let ready = false;
  let geometry: SentenceRange[] = [];
  let activeKeys = new Set<string>();
  let slots: SentenceTransitionSlot[] = [];
  let stable: SentenceRange[] = [];
  let textColor: Rgba = { r: 0, g: 0, b: 0, a: 1 };
  let dimColor: Rgba = { r: 0, g: 0, b: 0, a: 0.6 };
  let lastNow: number | null = null;

  function keyOf(ordinal: number): string {
    return `o:${ordinal}`;
  }

  function targetColor(target: SentencePresentationTarget): Rgba {
    return target === "active" ? textColor : dimColor;
  }

  function durationFor(target: SentencePresentationTarget): number {
    return target === "active" ? acquireMs : releaseMs;
  }

  function clearSlots(): void {
    slots = [];
  }

  function resolveActiveOrdinals(
    sentenceRanges: readonly SentenceRange[],
    activeRanges: readonly SentenceRange[],
  ): Set<number> {
    const ordinals = new Set<number>();
    for (const active of activeRanges) {
      for (let index = 0; index < sentenceRanges.length; index++) {
        const range = sentenceRanges[index];
        if (range.start === active.start && range.end === active.end) {
          ordinals.add(index);
          break;
        }
      }
    }
    return ordinals;
  }

  function freeIndex(): number {
    for (let index = 0; index < slotCount; index++) {
      if (!slots.some((slot) => slot.index === index)) return index;
    }
    return -1;
  }

  /** Rebuild the stable dim set from scratch for the given geometry:
   *  dim sentences that are not currently covered by an in-flight slot. */
  function rebuildStable(
    sentenceRanges: readonly SentenceRange[],
    targetOf: (ordinal: number) => SentencePresentationTarget,
    inFlight: (ordinal: number) => boolean,
  ): SentenceRange[] {
    const result: SentenceRange[] = [];
    for (let index = 0; index < sentenceRanges.length; index++) {
      if (targetOf(index) === "dim" && !inFlight(index)) {
        result.push(sentenceRanges[index]);
      }
    }
    return result;
  }

  function settleUpdate(
    sentenceRanges: readonly SentenceRange[],
    newActiveKeys: Set<string>,
  ): SentenceTransitionUpdateResult {
    clearSlots();
    activeKeys = newActiveKeys;
    geometry = [...sentenceRanges];
    stable = [];
    for (let index = 0; index < sentenceRanges.length; index++) {
      if (!activeKeys.has(keyOf(index))) stable.push(sentenceRanges[index]);
    }
    ready = true;
    return {
      settled: true,
      anyTransition: false,
      slots: [...slots],
      stableRanges: [...stable],
    };
  }

  function reconcileUpdate(
    sentenceRanges: readonly SentenceRange[],
    newActiveKeys: Set<string>,
  ): SentenceTransitionUpdateResult {
    const targetOf = (ordinal: number): SentencePresentationTarget =>
      newActiveKeys.has(keyOf(ordinal)) ? "active" : "dim";

    const inFlight = (ordinal: number): boolean =>
      slots.some((slot) => slot.key === keyOf(ordinal));

    for (let index = 0; index < sentenceRanges.length; index++) {
      const key = keyOf(index);
      const target = targetOf(index);
      const wasActive = activeKeys.has(key);
      const slot = slots.find((candidate) => candidate.key === key);

      if (slot) {
        slot.range = sentenceRanges[index];
        if (slot.target !== target) {
          // Retarget: resume from the last rendered color with a fresh,
          // frame-anchored timeline. Never restart from an endpoint, never
          // inherit the old start time.
          slot.from = slot.current;
          slot.target = target;
          slot.to = targetColor(target);
          slot.duration = durationFor(target);
          slot.startTime = null;
        }
        continue;
      }

      const isActive = target === "active";
      if (wasActive !== isActive) {
        // Target flip from a settled state: start a slot from the settled
        // endpoint color (text color if it was active, dim if it was dim).
        const slotIndex = freeIndex();
        if (slotIndex !== -1) {
          const from = wasActive ? textColor : dimColor;
          slots.push({
            index: slotIndex,
            key,
            range: sentenceRanges[index],
            target,
            from,
            to: targetColor(target),
            current: from,
            duration: durationFor(target),
            startTime: null,
          });
        }
      }
    }

    // Defensive: drop slots whose sentence no longer exists (geometry shrank
    // without a topology flag reaching us).
    const liveKeys = new Set<string>();
    for (let index = 0; index < sentenceRanges.length; index++) {
      liveKeys.add(keyOf(index));
    }
    if (slots.some((slot) => !liveKeys.has(slot.key))) {
      slots = slots.filter((slot) => liveKeys.has(slot.key));
    }

    stable = rebuildStable(sentenceRanges, targetOf, inFlight);
    activeKeys = newActiveKeys;
    geometry = [...sentenceRanges];
    ready = true;
    return {
      settled: false,
      anyTransition: slots.length > 0,
      slots: [...slots],
      stableRanges: [...stable],
    };
  }

  function update(input: SentenceTransitionUpdate): SentenceTransitionUpdateResult {
    textColor = input.textColor;
    dimColor = input.dimColor;

    const blockChanged = input.blockKey !== blockKey;
    if (blockChanged) {
      clearSlots();
      blockKey = input.blockKey;
      // First update for a block settles (like the old "first apply in a
      // block never animates" rule). Subsequent updates in the same block can
      // transition between its sentences.
      ready = false;
    }
    if (!ready) {
      // Fresh presentation domain (engine start / block switch / clear):
      // settle to the final semantic state — no transitions on first paint.
      const freshKeys = keysOfGeometry(input.sentenceRanges, input.activeRanges);
      return settleUpdate(input.sentenceRanges, freshKeys);
    }

    if (input.sentenceRanges.length === 0) {
      return settleUpdate([], new Set<string>());
    }

    const newActiveKeys = keysOfGeometry(input.sentenceRanges, input.activeRanges);

    const prevCount = geometry.length;
    const countStable = prevCount > 0 && prevCount === input.sentenceRanges.length;

    if (!input.animate) {
      return settleUpdate(input.sentenceRanges, newActiveKeys);
    }

    // Topology change (sentence count moved while the text changed): settle /
    // rebuild deterministically. No morph matching; no stale slots.
    if (input.textChanged && !countStable) {
      return settleUpdate(input.sentenceRanges, newActiveKeys);
    }

    // Same geometry, or ordinal-stable text change: reconcile per sentence.
    return reconcileUpdate(input.sentenceRanges, newActiveKeys);
  }

  function keysOfGeometry(
    sentenceRanges: readonly SentenceRange[],
    activeRanges: readonly SentenceRange[],
  ): Set<string> {
    const keys = new Set<string>();
    const ordinals = resolveActiveOrdinals(sentenceRanges, activeRanges);
    for (const ordinal of ordinals) keys.add(keyOf(ordinal));
    return keys;
  }

  function advance(now: number): SentenceTransitionAdvanceResult {
    const current = lastNow !== null && now < lastNow ? lastNow : now;
    lastNow = current;

    const completed: SentenceTransitionCompletion[] = [];
    const remaining: SentenceTransitionSlot[] = [];

    for (const slot of slots) {
      if (slot.startTime === null) {
        // First frame after creation / retarget: anchor the timeline here so
        // elapsed never goes negative from mixing rAF time with event time.
        slot.startTime = current;
        slot.current = slot.from;
        remaining.push(slot);
        continue;
      }

      const progress = (current - slot.startTime) / slot.duration;
      if (progress >= 1) {
        slot.current = slot.to;
        completed.push({
          index: slot.index,
          key: slot.key,
          range: slot.range,
          target: slot.target,
        });
      } else {
        slot.current = mixColor(slot.from, slot.to, easeInOutCubic(progress));
        remaining.push(slot);
      }
    }

    let stableChanged = false;
    for (const completion of completed) {
      if (completion.target === "dim") {
        stable.push(completion.range);
        stableChanged = true;
      }
    }

    slots = remaining;
    return {
      completed,
      stableChanged,
      anyTransition: slots.length > 0,
      slots: [...slots],
    };
  }

  function clear(): void {
    clearSlots();
    stable = [];
    activeKeys = new Set<string>();
    geometry = [];
    ready = false;
    blockKey = null;
    lastNow = null;
  }

  return {
    update,
    advance,
    clear,
    slots: () => [...slots],
    stableRanges: () => [...stable],
    hasAnimating: () => slots.length > 0,
    hasStable: () => stable.length > 0,
  };
}

// --- Presentation shell ---

/** Text node map entry consumed by the shell to build Range objects. */
export interface TextNodeMapEntry {
  node: Text;
  start: number;
  len: number;
}

export interface SentenceTransitionEngineUpdate extends SentenceTransitionUpdate {
  textNodeMap: readonly TextNodeMapEntry[];
}

export interface SentenceTransitionEngine {
  update(input: SentenceTransitionEngineUpdate): void;
  hasAnimatingTransitions(): boolean;
  hasStableDimRanges(): boolean;
  hasActiveVisualState(): boolean;
  /** Snapshot of the Range objects currently registered in the stable dim
   *  channel (used by ripple.ts to hold the outgoing block's dim during the
   *  cross-block opacity handoff). */
  currentStableRanges(): Range[];
  clear(): void;
  destroy(): void;
}

interface SlotVisual {
  range: SentenceRange | null;
  registered: boolean;
  lastVarValue: string | null;
}

function cssHighlightApiSupported(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight !== "undefined"
  );
}

function slotHighlightName(index: number): string {
  return `${SLOT_HIGHLIGHT_PREFIX}-${index}`;
}

function slotVarName(index: number): string {
  return `${SLOT_VAR_PREFIX}-${index}${SLOT_VAR_SUFFIX}`;
}

function resolveTextNodeAt(
  map: readonly TextNodeMapEntry[],
  charOffset: number,
): { node: Text; localOffset: number } | null {
  const count = map.length;
  if (count === 0) return null;
  const last = map[count - 1];
  const total = last.start + last.len;
  if (charOffset >= total) {
    return charOffset === total ? { node: last.node, localOffset: last.len } : null;
  }
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (map[mid].start + map[mid].len > charOffset) hi = mid;
    else lo = mid + 1;
  }
  const entry = map[lo];
  return { node: entry.node, localOffset: charOffset - entry.start };
}

function buildRangeFromMap(
  map: readonly TextNodeMapEntry[],
  start: number,
  end: number,
): Range | null {
  const startLoc = resolveTextNodeAt(map, start);
  const endLoc = resolveTextNodeAt(map, end);
  if (!startLoc || !endLoc) return null;
  try {
    const range = new Range();
    range.setStart(startLoc.node, startLoc.localOffset);
    range.setEnd(endLoc.node, endLoc.localOffset);
    return range;
  } catch {
    return null;
  }
}

function registerHighlight(name: string, ranges: readonly Range[]): void {
  if (ranges.length === 0) {
    CSS.highlights.delete(name);
  } else {
    CSS.highlights.set(name, new Highlight(...ranges));
  }
}

export function createSentenceTransitionEngine(): SentenceTransitionEngine {
  const core = createSentenceTransitionCore();
  let textNodeMap: readonly TextNodeMapEntry[] = [];
  const slotVisuals: SlotVisual[] = [];
  for (let index = 0; index < SENTENCE_SLOT_COUNT; index++) {
    slotVisuals.push({ range: null, registered: false, lastVarValue: null });
  }
  let stableRangeRefs: Range[] = [];
  let lastDimVarValue: string | null = null;
  const ownedRootVars = new Map<string, OwnedInlineStyle>();
  let frameHandle: number | null = null;

  function writeRootVar(property: string, value: string): void {
    const rootStyle = document.documentElement.style;
    let owned = ownedRootVars.get(property);
    if (!owned) {
      owned = claimInlineStyle(rootStyle, [property]);
      ownedRootVars.set(property, owned);
    }
    setOwnedInlineStyle(rootStyle, owned, property, value);
  }

  function releaseRootVar(property: string): void {
    const owned = ownedRootVars.get(property);
    if (!owned) return;
    restoreOwnedInlineStyle(document.documentElement.style, owned);
    ownedRootVars.delete(property);
  }

  function writeSlotVar(index: number, color: Rgba): void {
    const value = colorToCss(color);
    const visual = slotVisuals[index];
    if (visual.lastVarValue === value) return;
    writeRootVar(slotVarName(index), value);
    visual.lastVarValue = value;
  }

  function releaseSlot(index: number): void {
    const visual = slotVisuals[index];
    if (visual.registered) {
      if (cssHighlightApiSupported()) CSS.highlights.delete(slotHighlightName(index));
      visual.registered = false;
    }
    if (visual.lastVarValue !== null) {
      releaseRootVar(slotVarName(index));
      visual.lastVarValue = null;
    }
    visual.range = null;
  }

  function resolveRanges(geometry: readonly SentenceRange[]): Range[] {
    const ranges: Range[] = [];
    for (const range of geometry) {
      const resolved = buildRangeFromMap(textNodeMap, range.start, range.end);
      if (resolved) ranges.push(resolved);
    }
    return ranges;
  }

  function syncStable(slots: readonly SentenceTransitionSlot[]): void {
    if (!cssHighlightApiSupported()) return;
    stableRangeRefs = resolveRanges(core.stableRanges());
    registerHighlight(SENTENCE_DIM_HIGHLIGHT, stableRangeRefs);
  }

  function syncSlots(slots: readonly SentenceTransitionSlot[]): void {
    if (!cssHighlightApiSupported()) return;
    for (let index = 0; index < SENTENCE_SLOT_COUNT; index++) {
      const slot = slots.find((candidate) => candidate.index === index);
      if (!slot) {
        releaseSlot(index);
        continue;
      }
      const visual = slotVisuals[index];
      const geometryChanged =
        visual.range === null ||
        visual.range.start !== slot.range.start ||
        visual.range.end !== slot.range.end;
      if (!visual.registered || geometryChanged) {
        const resolved = buildRangeFromMap(textNodeMap, slot.range.start, slot.range.end);
        if (resolved) {
          registerHighlight(slotHighlightName(index), [resolved]);
          visual.registered = true;
        } else if (visual.registered) {
          CSS.highlights.delete(slotHighlightName(index));
          visual.registered = false;
        }
        visual.range = { ...slot.range };
      }
      writeSlotVar(index, slot.current);
    }
  }

  function syncDimVar(dimColor: Rgba): void {
    const value = colorToCss(dimColor);
    if (value === lastDimVarValue) return;
    writeRootVar(SENTENCE_DIM_VAR, value);
    lastDimVarValue = value;
  }

  function ensureDriver(): void {
    if (frameHandle !== null || !core.hasAnimating()) return;
    frameHandle = requestAnimationFrame(step);
  }

  function step(now: number): void {
    frameHandle = null;
    if (!cssHighlightApiSupported()) return;
    const result = core.advance(now);

    for (const completion of result.completed) {
      releaseSlot(completion.index);
    }
    for (const slot of result.slots) {
      writeSlotVar(slot.index, slot.current);
    }
    if (result.stableChanged) {
      stableRangeRefs = resolveRanges(core.stableRanges());
      registerHighlight(SENTENCE_DIM_HIGHLIGHT, stableRangeRefs);
    }
    if (result.anyTransition) ensureDriver();
  }

  function update(input: SentenceTransitionEngineUpdate): void {
    textNodeMap = input.textNodeMap;
    const canAnimate =
      input.animate &&
      cssHighlightApiSupported() &&
      typeof requestAnimationFrame === "function";

    const result = core.update({ ...input, animate: canAnimate });

    if (cssHighlightApiSupported()) {
      syncStable(result.slots);
      syncSlots(result.slots);
      syncDimVar(input.dimColor);
    }
    if (result.anyTransition && canAnimate) {
      ensureDriver();
    } else if (frameHandle !== null) {
      cancelAnimationFrame(frameHandle);
      frameHandle = null;
    }
  }

  function clear(): void {
    if (frameHandle !== null) {
      cancelAnimationFrame(frameHandle);
      frameHandle = null;
    }
    core.clear();
    for (let index = 0; index < SENTENCE_SLOT_COUNT; index++) {
      releaseSlot(index);
    }
    if (cssHighlightApiSupported()) {
      CSS.highlights.delete(SENTENCE_DIM_HIGHLIGHT);
    }
    stableRangeRefs = [];
    if (lastDimVarValue !== null) {
      releaseRootVar(SENTENCE_DIM_VAR);
      lastDimVarValue = null;
    }
  }

  return {
    update,
    hasAnimatingTransitions: () => core.hasAnimating(),
    hasStableDimRanges: () => core.hasStable(),
    hasActiveVisualState: () =>
      core.hasAnimating() ||
      core.hasStable() ||
      ownedRootVars.size > 0 ||
      stableRangeRefs.length > 0,
    currentStableRanges: () => [...stableRangeRefs],
    clear,
    destroy: clear,
  };
}
