import { MOTION, SENTENCE_ALPHA } from "../config";
import { clamp, stepCritical } from "../motion";
import { semanticBlockKey, visualKey } from "../structure";
import type { EditorFrame } from "../types";
import type { DebugRecorder } from "../debug/types";
import { resolveRangeTextPoint } from "../utils/rangeTextPoint";
import { splitSentences, resolveActiveSentenceRanges, type SentenceRange } from "./ripple/sentenceModel";
import { projectText, sentenceRange, mapUnchangedBoundaries, type TextEntry } from "./ripple/textProjection";

import { collectTargets } from "./ripple/blockPlan";
import { createBlockPainter } from "./ripple/blockPainter";

type SentencePaint = SentenceRange & { range: Range; value: number; velocity: number; target: number; fresh: boolean };

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
  // One-shot: the presentation value of the focused replacement whose stale dim
  // block role blockPainter just invalidated, together with its semantic key.
  // The next sentence rebuild for that block continues from it.
  let pendingSentencePresentation: { key: string; value: number } | null = null;

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
  function sample(frame: EditorFrame, contentDirty: boolean, structureDirty: boolean, enabled: boolean,
    sentencesOnly = false) {
    painter.bind(frame.editor);
    const writes: Array<() => void> = [];
    const commit = () => {
      for (const write of writes) write();
      // A sentence-only presentation must not resume the block owners that the
      // structural hold deliberately froze.
      if (!sentencesOnly) painter.resume(frame.reducedMotion);
    };
    ZENTYPE_DEBUG: if (!sentencesOnly) debug?.record("ripple", "prepare", {
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
    const commitBlocks = !sentencesOnly && (block !== frame.block || structureDirty)
      ? painter.prepare(collectTargets(frame.block, frame.editor), frame.editor, frame.reducedMotion) : null;
    // Read phase. Text projection, sentence boundaries and text colors are
    // resolved before any presentation write, so this frame never forces a style
    // recalc of the invalidation it is about to make.
    let sentenceReady = false;
    let inherited: { value: number } | null = null;
    if (!supported) {
      // Block focus only.
    } else if (editable !== frame.editable || contentDirty) {
      const sameContent = editable === frame.editable || !!editable && !editable.isConnected &&
        editable.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId === frame.block.dataset.nodeId;
      // Consumed by whichever rebuild runs next; a rebuild of another block or an
      // ordinary content change simply discards it.
      const pending = pendingSentencePresentation;
      inherited = pending && pending.key === semanticBlockKey(frame.block) ? pending : null;
      pendingSentencePresentation = null;
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
            return [{ ...boundary, range, value: old?.value ?? 1, velocity: old?.velocity ?? 0, target: 1, fresh: !old }];
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
    let seeded = 0;
    let seedMin = 1;
    let seedMax = 0;
    for (const paint of sentences) {
      const isActive = active.includes(paint);
      paint.target = isActive ? 1 : SENTENCE_ALPHA;
      if (!inherited || !paint.fresh) continue;
      if (paint.end <= offset) {
        // A boundary entirely inside the previous block's content continues that
        // block's presentation: start at the value it was actually showing and
        // let Critical Motion move it to the new sentence role.
        paint.value = inherited.value;
        paint.velocity = 0;
        seeded++;
        seedMin = Math.min(seedMin, paint.value);
        seedMax = Math.max(seedMax, paint.value);
      } else {
        // Suffix and boundary-crossing sentences come from the previously
        // focused block, or cannot express two alphas in one Highlight Range, so
        // they enter directly at the new semantic role.
        paint.value = paint.target;
        paint.velocity = 0;
      }
    }
    ZENTYPE_DEBUG: if (sentencesOnly) debug?.record("ripple", "sentence-presentation-ready", {
      blockKey: semanticBlockKey(frame.block), phase: "first-frame",
      sentenceCount: sentences.length, activeCount: active.length,
      movingCount: sentences.filter(paint => paint.value !== paint.target).length,
      seededCount: seeded, seedValueMin: seeded ? seedMin : null, seedValueMax: seeded ? seedMax : null,
    });
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
        reducedMotion ? 0 : (paint.target === 1 ? MOTION.focusEnterResponseMs : MOTION.focusLeaveResponseMs),
        MOTION.sentenceSettleEpsilon);
      // SENTENCE_ALPHA is a semantic target, not a motion floor: a sentence may
      // legitimately start below it when it continues a previous presentation.
      // Only the physical alpha domain is enforced.
      if (paint.value < 0 || paint.value > 1) {
        paint.value = clamp(paint.value, 0, 1);
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
    pendingSentencePresentation = null;
    block = null;
    lastTime = null;
  }
  return { sample, prepare(frame: EditorFrame, contentDirty: boolean, structureDirty: boolean, enabled: boolean) {
      sample(frame, contentDirty, structureDirty, enabled)();
    }, presentSentences(frame: EditorFrame, now: number, reducedMotion: boolean, contentDirty = false) {
      sample(frame, contentDirty, false, true, true)();
      // Highlight registration and sentence motion live in render(); without it
      // the stale buckets of the removed block stay on screen.
      return render(now, reducedMotion);
    },
    render, clear, invalidateColors: clearColors, freeze: painter.freeze,
    rebind(added: readonly HTMLElement[], focusedKey: string | null = null) {
      const floor = sentenceFloor();
      const key = block && !block.isConnected && floor < 1 ? visualKey(block) : undefined;
      // The painter reports back the key whose stale dim role it actually
      // dropped, so only a replacement that previously presented as a dim
      // neighbour seeds the sentence layer.
      return painter.rebind(added, key ? { key, value: floor } : undefined, focusedKey,
        focusedKey ? invalidated => { pendingSentencePresentation = { key: invalidated.key, value: clamp(invalidated.value, 0, 1) }; } : undefined);
    },
    protectFocus(focused: HTMLElement) { painter.protectFocus(focused); },
    destroy() { clear(); style.remove(); } };
}
