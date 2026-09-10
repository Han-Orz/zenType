import { MOTION, SENTENCE_ALPHA } from "../config";
import { clamp, stepCritical } from "../motion";
import { visualKey } from "../structure";
import type { EditorFrame } from "../types";
import type { DebugRecorder } from "../debug/types";
import { resolveRangeTextPoint } from "../utils/rangeTextPoint";
import { splitSentences, resolveActiveSentenceRanges, type SentenceRange } from "./ripple/sentenceModel";
import { projectText, sentenceRange, mapUnchangedBoundaries, type TextEntry } from "./ripple/textProjection";

import { collectTargets } from "./ripple/blockPlan";
import { createBlockPainter } from "./ripple/blockPainter";

type SentencePaint = SentenceRange & { range: Range; value: number; velocity: number; target: number };

export function createRipple(debug?: DebugRecorder) {
  const style = document.createElement("style");
  document.head.append(style);
  // `currentColor` here is deliberate, not a leftover: the generated rule uses a
  // private variable, but a var() in the probe would make the declaration
  // pending-substitution, so CSS.supports would accept the syntax even in an
  // engine without relative colors.
  const supported = typeof Highlight !== "undefined" && !!CSS.highlights &&
    CSS.supports("color", "rgb(from currentColor r g b / calc(alpha * 0.6))");
  const names = Array.from({ length: 65 }, (_, i) => "zentype-remake-sentence-" + i);
  style.textContent = supported ? names.map((name, i) =>
    "::highlight(" + name + ") { color: rgb(from var(--zentype-text-color) r g b / calc(alpha * " + (i / 64) + ")); }").join("\n") : "";
  const painter = createBlockPainter(debug);
  const colors = new Map<HTMLElement, { original: string; written: string }>();
  let editable: HTMLElement | null = null;
  let block: HTMLElement | null = null;
  let text = "";
  let entries: TextEntry[] = [];
  let sentences: SentencePaint[] = [];
  let lastTime: number | null = null;
  let registered: Range[][] = Array.from({ length: names.length }, () => []);
  let scratch: Range[][] = Array.from({ length: names.length }, () => []);

  function sentenceFloor() {
    return sentences.reduce((value, paint) => Math.min(value, paint.value), 1);
  }

  function clearColors() {
    for (const [element, color] of colors) {
      if (element.style.getPropertyValue("--zentype-text-color") !== color.written) continue;
      if (color.original) element.style.setProperty("--zentype-text-color", color.original);
      else element.style.removeProperty("--zentype-text-color");
    }
    colors.clear();
  }

  function clearSentences() {
    for (let bucket = 0; bucket < registered.length; bucket++) {
      if (supported && registered[bucket].length) CSS.highlights.delete(names[bucket]);
      registered[bucket].length = scratch[bucket].length = 0;
    }
    sentences = [];
    entries = [];
    text = "";
    editable = null;
    clearColors();
  }
  function sample(frame: EditorFrame, contentDirty: boolean, structureDirty: boolean, enabled: boolean) {
    painter.bind(frame.editor);
    const writes: Array<() => void> = [];
    const commit = () => { for (const write of writes) write(); painter.resume(frame.reducedMotion); };
    ZENTYPE_DEBUG: debug?.record("ripple", "prepare", {
      enabled,
      contentDirty,
      structureDirty,
      hasBlock: frame.block !== null,
      selection: frame.selection,
    });
    if (!enabled) {
      writes.push(painter.prepare(new Map(), frame.editor, frame.reducedMotion));
      for (const paint of sentences) paint.target = 1;
      block = null;
      return commit;
    }
    if (!frame.block || !frame.editable || !frame.range) {
      ZENTYPE_DEBUG: debug?.record("ripple", "prepare-skipped", {
        reason: "missing-frame-data",
        hasBlock: frame.block !== null,
        hasEditable: frame.editable !== null,
        hasRange: frame.range !== null,
      });
      // Invalid live ranges are never retained across a structural replacement.
      if (contentDirty || structureDirty) writes.push(clearSentences);
      return commit;
    }
    const commitBlocks = block !== frame.block || structureDirty
      ? painter.prepare(collectTargets(frame.block, frame.editor), frame.editor, frame.reducedMotion) : null;
    // Read phase. Text projection, sentence boundaries and text colors are
    // resolved before any presentation write, so this frame never forces a style
    // recalc of the invalidation it is about to make.
    let sentenceReady = false;
    if (!supported) {
      // Block focus only.
    } else if (editable !== frame.editable || contentDirty) {
      const sameContent = editable === frame.editable || !!editable && !editable.isConnected &&
        editable.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId === frame.block.dataset.nodeId;
      const clones: HTMLElement[] = [];
      const projection = projectText(frame.editable, colors, clones);
      writes.push(() => { for (const element of clones) element.style.removeProperty("--zentype-text-color"); });
      if (projection) {
        // Boundaries are a pure function of the text: an inline re-render that keeps
        // the same text must not re-run Intl.Segmenter over the whole block.
        const sameText = editable === frame.editable && projection.text === text;
        const boundaries = sameText ? sentences : splitSentences(projection.text);
        if (boundaries.length <= 256) {
          const reusable = sameText ? sentences
            : sameContent ? mapUnchangedBoundaries(text, projection.text, sentences) : [];
          const deleting = sameContent && projection.text.length < text.length;
          const previous = sentences;
          sentences = boundaries.flatMap(boundary => {
            const range = sentenceRange(projection.entries, boundary);
            if (!range) return [];
            const index = reusable.findIndex(old => old?.start === boundary.start && (old.end === boundary.end || deleting));
            const old = index < 0 ? undefined : previous[index];
            return [{ ...boundary, range, value: old?.value ?? 1, velocity: old?.velocity ?? 0, target: 1 }];
          });
          entries = projection.entries;
          text = projection.text;
          editable = frame.editable;
          const parents = new Set(entries.map(entry => entry.node.parentElement).filter((element): element is HTMLElement => !!element));
          const fresh = [...parents].filter(element => !colors.has(element));
          const clonedParents = new Set(clones);
          const sampled = fresh.map(element => ({ element, written: getComputedStyle(element).color,
            original: clonedParents.has(element) ? "" : element.style.getPropertyValue("--zentype-text-color") }));
          writes.push(() => {
            for (const [element, color] of colors) if (!parents.has(element)) {
              if (element.style.getPropertyValue("--zentype-text-color") === color.written) {
                if (color.original) element.style.setProperty("--zentype-text-color", color.original);
                else element.style.removeProperty("--zentype-text-color");
              }
              colors.delete(element);
            }
            for (const { element, ...color } of sampled) {
              colors.set(element, color);
              element.style.setProperty("--zentype-text-color", color.written);
            }
          });
          sentenceReady = true;
        } else writes.push(clearSentences);
      } else writes.push(clearSentences);
    } else {
      sentenceReady = true;
    }
    // Commit an owner plan only when bindings/focus change; ordinary text work
    // never reconstructs structural handoff history.
    if (commitBlocks) writes.push(commitBlocks);
    block = frame.block;
    if (!sentenceReady) return commit;
    const point = resolveRangeTextPoint(frame.range.startContainer, frame.range.startOffset);
    // The caret can resolve to a text node the projection excludes: a boundary
    // next to an inline non-editable element (reference, tag, image) or a nested
    // block. Fall back to the nearest preceding projected text node instead of
    // dropping the sentence state, which would flicker the highlights and force a
    // color re-sample on every frame.
    let offset = -1;
    if (point) {
      const entry = entries.find(item => item.node === point.textNode);
      if (entry) offset = entry.start + point.offset;
      else {
        // Entries are in document order: take the last one before the caret and
        // stop at the first one after it. A caret before all projected text
        // anchors to the block start.
        offset = 0;
        for (const item of entries) {
          if (point.textNode.compareDocumentPosition(item.node) & Node.DOCUMENT_POSITION_FOLLOWING) break;
          offset = item.end;
        }
      }
    }
    if (offset < 0) { writes.push(clearSentences); return commit; }
    const active = resolveActiveSentenceRanges(sentences, offset, text.length);
    for (const paint of sentences) paint.target = active.includes(paint) ? 1 : SENTENCE_ALPHA;
    return commit;
  }

  function render(now: number, reducedMotion: boolean): boolean {
    const elapsed = lastTime === null ? 16 : Math.max(0, now - lastTime);
    lastTime = now;
    let moving = false;
    if (!supported) {
      ZENTYPE_DEBUG: debug?.record("ripple", "render", { supported: false, moving: false, sentenceCount: sentences.length, blockCount: painter.size() });
      if (!moving) lastTime = null;
      return moving;
    }
    for (const ranges of scratch) ranges.length = 0;
    for (const paint of sentences) {
      const settled = stepCritical(paint, paint.target, elapsed,
        reducedMotion ? 0 : (paint.target === 1 ? MOTION.focusEnterResponse95Ms : MOTION.focusLeaveResponse95Ms),
        MOTION.sentenceSettleEpsilon);
      if (paint.value < SENTENCE_ALPHA || paint.value > 1) {
        paint.value = clamp(paint.value, SENTENCE_ALPHA, 1);
        paint.velocity = 0;
      }
      if (!settled) moving = true;
      const bucket = Math.round(paint.value * 64);
      if (bucket === 64) continue;
      scratch[bucket].push(paint.range);
    }
    for (let bucket = 0; bucket < scratch.length; bucket++) {
      const ranges = scratch[bucket];
      const old = registered[bucket];
      if (!ranges.length) {
        if (old.length) CSS.highlights.delete(names[bucket]);
      } else if (old.length !== ranges.length || ranges.some((range, i) => old[i] !== range)) {
        CSS.highlights.set(names[bucket], new Highlight(...ranges));
      }
    }
    const previous = registered;
    registered = scratch;
    scratch = previous;
    if (!block && !moving) clearSentences();
    if (!moving) lastTime = null;
    ZENTYPE_DEBUG: debug?.record("ripple", "render", {
      supported: true,
      moving,
      sentenceCount: sentences.length,
      blockCount: painter.size(),
      now,
    });
    return moving;
  }

  function clear() {
    ZENTYPE_DEBUG: debug?.record("ripple", "clear", { blockCount: painter.size(), sentenceCount: sentences.length });
    painter.clear();
    clearSentences();
    block = null;
    lastTime = null;
  }
  return { sample, prepare(frame: EditorFrame, contentDirty: boolean, structureDirty: boolean, enabled: boolean) {
      sample(frame, contentDirty, structureDirty, enabled)();
    }, render, clear, invalidateColors: clearColors, freeze: painter.freeze,
    rebind(added: readonly HTMLElement[]) {
      const floor = sentenceFloor();
      const key = block && !block.isConnected && floor < 1 ? visualKey(block) : undefined;
      return painter.rebind(added, key ? { key, value: floor } : undefined);
    },
    destroy() { clear(); style.remove(); } };
}
