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
 *   edits preserve the rendered color. A new navigation target ends the old
 *   handoff before starting another. Stable dim sentences are tracked as
 *   geometry, not as slots.
 *
 * Layer 2 — presentation shell (`createSentenceTransitionEngine`):
 *   the single shared rAF driver plus the CSS Custom Highlight / color rule
 *   writes. Idle cost is zero: the driver runs only while a slot is in
 *   flight. Bounded slot pool → bounded highlight names / color rules.
 *
 * Sentence identity is deliberately simple (see ripple.ts docs):
 *   - no text change            → same geometry, same sentence keys;
 *   - text change, stable count → ordinal rebind keeps continuity;
 *   - count change (topology)   → identity by start anchor. In-flight slots
 *     survive rebind (a running release never snaps), release/acquire between
 *     persisted sentences keep animating. Inserted/replaced active content
 *     snaps bright, while deletion-driven activation still acquires normally.
 */

import { performanceRecordingActive, recordPerformance } from "../../debug/performance";
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
export type SentenceTextChange = "none" | "insert" | "delete" | "replace";

export interface SentenceTransitionSlot {
  index: number;
  key: string;
  range: SentenceRange;
  target: SentencePresentationTarget;
  from: Rgba;
  to: Rgba;
  current: Rgba;
  duration: number;
  easing: "smooth" | "linear";
  /** Frame-anchored; null until the first advance so rAF timestamps are never
   *  mixed with performance.now(). */
  startTime: number | null;
}

export interface SentenceTransitionUpdate {
  blockKey: string | null;
  sentenceRanges: readonly SentenceRange[];
  activeRanges: readonly SentenceRange[];
  textChange: SentenceTextChange;
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

  function colorDistance(a: Rgba, b: Rgba): number {
    return Math.max(
      Math.abs(a.r - b.r) / 255,
      Math.abs(a.g - b.g) / 255,
      Math.abs(a.b - b.b) / 255,
      Math.abs(a.a - b.a),
    );
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

  /**
   * Reconcile the presentation against a new geometry. Identity across the
   * change is ordinal when the sentence count is stable, otherwise by start
   * anchor (a sentence persists while its first code unit stays put).
   *
   * Existing in-flight slots are kept and rebound whenever their sentence
   * persists, so a running release never snaps to full dim on a later edit.
   * A persisted dim sentence that becomes active acquires normally for caret
   * movement and deletion. Inserted/replaced active content snaps bright so
   * typing never dims what the user just wrote.
   */
  function remapUpdate(
    sentenceRanges: readonly SentenceRange[],
    newActiveKeys: Set<string>,
    useStartIdentity: boolean,
    textChangeAllowsAcquire: boolean,
  ): SentenceTransitionUpdateResult {
    const prevGeometry = geometry;
    const prevActive = activeKeys;
    const count = sentenceRanges.length;

    // identity[index] = previous ordinal this sentence continues, or -1 if it
    // is newborn (its start anchor did not exist in the previous geometry).
    const identity = new Array<number>(count).fill(-1);
    if (useStartIdentity) {
      const byStart = new Map<number, number>();
      prevGeometry.forEach((range, index) => byStart.set(range.start, index));
      sentenceRanges.forEach((range, index) => {
        const prevIndex = byStart.get(range.start);
        if (prevIndex !== undefined) identity[index] = prevIndex;
      });
    } else {
      const limit = Math.min(count, prevGeometry.length);
      for (let index = 0; index < limit; index++) identity[index] = index;
    }

    const prevOrdinalToNew = new Map<number, number>();
    sentenceRanges.forEach((_, index) => {
      const prevOrdinal = identity[index];
      if (prevOrdinal !== -1 && !prevOrdinalToNew.has(prevOrdinal)) {
        prevOrdinalToNew.set(prevOrdinal, index);
      }
    });

    // Keep in-flight slots whose sentence persisted; drop the vanished ones.
    const kept = new Array<SentenceTransitionSlot | null>(count).fill(null);
    for (const slot of slots) {
      const prevOrdinal = ordinalOfKey(slot.key);
      const newIndex = prevOrdinal === null ? undefined : prevOrdinalToNew.get(prevOrdinal);
      if (newIndex === undefined) continue;
      const key = keyOf(newIndex);
      const target = newActiveKeys.has(key) ? "active" : "dim";
      slot.key = key;
      slot.range = sentenceRanges[newIndex];
      if (slot.target !== target) {
        // Reverse from the rendered color at a constant speed, without
        // restarting the slow entrance of the initial transition.
        slot.from = slot.current;
        slot.target = target;
        slot.to = targetColor(target);
        const fullDistance = colorDistance(textColor, dimColor);
        slot.duration = fullDistance === 0 ? 0 : durationFor(target) *
          Math.min(1, colorDistance(slot.from, slot.to) / fullDistance);
        slot.easing = "linear";
        slot.startTime = lastNow;
      }
      kept[newIndex] = slot;
    }

    const usedIndexes = new Set<number>();
    for (const slot of kept) {
      if (slot !== null) usedIndexes.add(slot.index);
    }
    const created: SentenceTransitionSlot[] = [];

    for (let index = 0; index < count; index++) {
      if (kept[index] !== null) continue;
      const prevOrdinal = identity[index];
      const key = keyOf(index);
      const target = newActiveKeys.has(key) ? "active" : "dim";
      const wasActive = prevOrdinal !== -1 && prevActive.has(keyOf(prevOrdinal));
      const prevRange = prevOrdinal === -1 ? null : prevGeometry[prevOrdinal];

      if (target === "dim") {
        // Bright -> dim: a persisted active sentence left the active set.
        if (wasActive) {
          const slotIndex = nextFreeIndex(usedIndexes);
          if (slotIndex !== -1) {
            usedIndexes.add(slotIndex);
            created.push({
              index: slotIndex,
              key,
              range: sentenceRanges[index],
              target: "dim",
              from: textColor,
              to: dimColor,
              current: textColor,
              duration: releaseMs,
              easing: "smooth",
              startTime: null,
            });
          }
        }
        continue;
      }

      // target === "active": persisted dim sentences acquire on caret movement
      // and deletion. Inserted/replaced active content snaps bright.
      if (
        !wasActive &&
        prevRange !== null &&
        (textChangeAllowsAcquire || sameRange(prevRange, sentenceRanges[index]))
      ) {
        const slotIndex = nextFreeIndex(usedIndexes);
        if (slotIndex !== -1) {
          usedIndexes.add(slotIndex);
          created.push({
            index: slotIndex,
            key,
            range: sentenceRanges[index],
            target: "active",
            from: dimColor,
            to: textColor,
            current: dimColor,
            duration: acquireMs,
            easing: "smooth",
            startTime: null,
          });
        }
      }
    }

    const nextSlots = kept
      .filter((slot): slot is SentenceTransitionSlot => slot !== null)
      .concat(created);
    slots = nextSlots;

    stable = [];
    const inFlightKeys = new Set<string>();
    for (const slot of slots) inFlightKeys.add(slot.key);
    for (let index = 0; index < count; index++) {
      const key = keyOf(index);
      if (newActiveKeys.has(key) || inFlightKeys.has(key)) continue;
      stable.push(sentenceRanges[index]);
    }

    activeKeys = newActiveKeys;
    geometry = [...sentenceRanges];
    ready = true;
    return {
      settled: slots.length === 0,
      anyTransition: slots.length > 0,
      slots: [...slots],
      stableRanges: [...stable],
    };
  }

  function sameRange(a: SentenceRange, b: SentenceRange): boolean {
    return a.start === b.start && a.end === b.end;
  }

  function nextFreeIndex(used: Set<number>): number {
    for (let index = 0; index < slotCount; index++) {
      if (!used.has(index)) return index;
    }
    return -1;
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

    if (!input.animate) {
      return settleUpdate(input.sentenceRanges, newActiveKeys);
    }

    const navigationChanged = input.textChange === "none" && (
      newActiveKeys.size !== activeKeys.size ||
      [...newActiveKeys].some((key) => !activeKeys.has(key))
    );
    if (navigationChanged) clearSlots();

    // Ordinal identity when the sentence count is stable, start-anchor
    // identity when the count moved (topology change).
    const prevCount = geometry.length;
    const countStable = prevCount > 0 && prevCount === input.sentenceRanges.length;
    return remapUpdate(
      input.sentenceRanges,
      newActiveKeys,
      input.textChange !== "none" && !countStable,
      input.textChange === "none" || input.textChange === "delete",
    );
  }

  function ordinalOfKey(key: string): number | null {
    const parsed = /^o:(\d+)$/.exec(key);
    return parsed ? Number(parsed[1]) : null;
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

      const progress = slot.duration === 0 ? 1 : (current - slot.startTime) / slot.duration;
      if (progress >= 1) {
        slot.current = slot.to;
        completed.push({
          index: slot.index,
          key: slot.key,
          range: slot.range,
          target: slot.target,
        });
      } else {
        const eased = slot.easing === "linear" ? progress : easeInOutCubic(progress);
        slot.current = mixColor(slot.from, slot.to, eased);
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
  lastColorValue: string | null;
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
    slotVisuals.push({ range: null, registered: false, lastColorValue: null });
  }
  let stableRangeRefs: Range[] = [];
  let stableGeometry: SentenceRange[] = [];
  let stableTextNodeMap: TextNodeMapEntry[] = [];
  let lastDimVarValue: string | null = null;
  const ownedRootVars = new Map<string, OwnedInlineStyle>();
  let frameHandle: number | null = null;
  let slotStyle: HTMLStyleElement | null = null;
  const slotRules: CSSStyleRule[] = [];

  function ensureSlotRules(): void {
    if (slotStyle) return;
    slotStyle = document.createElement("style");
    slotStyle.textContent = Array.from({ length: SENTENCE_SLOT_COUNT }, (_, index) =>
      `::highlight(${slotHighlightName(index)}) { color: transparent; }`,
    ).join("\n");
    document.head.appendChild(slotStyle);
    const sheet = slotStyle.sheet!;
    for (let index = 0; index < SENTENCE_SLOT_COUNT; index++) {
      slotRules.push(sheet.cssRules[index] as CSSStyleRule);
    }
  }

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

  function writeSlotColor(index: number, color: Rgba): void {
    const value = colorToCss(color);
    const visual = slotVisuals[index];
    if (visual.lastColorValue === value) return;
    // Keep animated colors out of inherited root custom properties.
    ensureSlotRules();
    slotRules[index].style.color = value;
    visual.lastColorValue = value;
  }

  function releaseSlot(index: number): void {
    const visual = slotVisuals[index];
    if (visual.registered) {
      if (cssHighlightApiSupported()) CSS.highlights.delete(slotHighlightName(index));
      visual.registered = false;
    }
    visual.lastColorValue = null;
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

  function sameGeometry(
    a: readonly SentenceRange[],
    b: readonly SentenceRange[],
  ): boolean {
    return a.length === b.length && a.every((range, index) => {
      const other = b[index];
      return range.start === other.start && range.end === other.end;
    });
  }

  function sameTextNodeMap(
    a: readonly TextNodeMapEntry[],
    b: readonly TextNodeMapEntry[],
  ): boolean {
    return a.length === b.length && a.every((entry, index) => {
      const other = b[index];
      return (
        entry.node === other.node &&
        entry.start === other.start &&
        entry.len === other.len
      );
    });
  }

  function syncStable(): void {
    if (!cssHighlightApiSupported()) return;
    const nextGeometry = core.stableRanges();
    const hasRegisteredHighlight = CSS.highlights.has(SENTENCE_DIM_HIGHLIGHT);
    const registrationMatches = nextGeometry.length > 0
      ? hasRegisteredHighlight
      : !hasRegisteredHighlight;
    if (
      registrationMatches &&
      sameGeometry(nextGeometry, stableGeometry) &&
      sameTextNodeMap(textNodeMap, stableTextNodeMap)
    ) return;

    stableRangeRefs = resolveRanges(nextGeometry);
    registerHighlight(SENTENCE_DIM_HIGHLIGHT, stableRangeRefs);
    stableGeometry = nextGeometry.map((range) => ({ ...range }));
    stableTextNodeMap = textNodeMap.map((entry) => ({ ...entry }));
  }

  function syncSlots(slots: readonly SentenceTransitionSlot[], bindingsChanged: boolean): void {
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
      if (!visual.registered || geometryChanged || bindingsChanged) {
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
      writeSlotColor(index, slot.current);
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
    const traceStart = __ZENTYPE_DEV__ && performanceRecordingActive() ? performance.now() : null;
    const result = core.advance(now);

    for (const completion of result.completed) {
      releaseSlot(completion.index);
    }
    for (const slot of result.slots) {
      writeSlotColor(slot.index, slot.current);
    }
    if (result.stableChanged) {
      syncStable();
    }
    if (result.anyTransition) ensureDriver();
    if (__ZENTYPE_DEV__ && traceStart !== null) recordPerformance("sentence", "sentence-frame", {
      frameTimestamp: now, slots: result.slots.length, completed: result.completed.length,
      durationMs: performance.now() - traceStart,
    });
  }

  function update(input: SentenceTransitionEngineUpdate): void {
    const traceStart = __ZENTYPE_DEV__ && performanceRecordingActive() ? performance.now() : null;
    const bindingsChanged = !sameTextNodeMap(textNodeMap, input.textNodeMap);
    if (bindingsChanged) {
      textNodeMap = input.textNodeMap.map((entry) => ({ ...entry }));
    }
    const canAnimate =
      input.animate &&
      cssHighlightApiSupported() &&
      typeof requestAnimationFrame === "function";

    const result = core.update({ ...input, animate: canAnimate });

    if (cssHighlightApiSupported()) {
      syncStable();
      syncSlots(result.slots, bindingsChanged);
      syncDimVar(input.dimColor);
    }
    if (result.anyTransition && canAnimate) {
      ensureDriver();
    } else if (frameHandle !== null) {
      cancelAnimationFrame(frameHandle);
      frameHandle = null;
    }
    if (__ZENTYPE_DEV__ && traceStart !== null) recordPerformance("sentence", "sentence-update", {
      sentences: input.sentenceRanges.length, activeRanges: input.activeRanges.length,
      slots: result.slots.length, textChange: input.textChange, bindingsChanged,
      durationMs: performance.now() - traceStart,
    });
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
    slotStyle?.remove();
    slotStyle = null;
    slotRules.length = 0;
    if (cssHighlightApiSupported()) {
      CSS.highlights.delete(SENTENCE_DIM_HIGHLIGHT);
    }
    stableRangeRefs = [];
    stableGeometry = [];
    stableTextNodeMap = [];
    textNodeMap = [];
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
