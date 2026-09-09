import { MOTION, RIPPLE_LEVELS, SENTENCE_ALPHA } from "../config";
import { approach } from "../motion";
import type { EditorFrame } from "../types";
import { resolveRangeTextPoint } from "../utils/rangeTextPoint";
import { splitSentences, resolveActiveSentenceRanges, type SentenceRange } from "./ripple/sentenceModel";
import { projectText, sentenceRange, mapUnchangedBoundaries, type TextEntry } from "./ripple/textProjection";

type BlockPaint = { value: number; target: number; from: number; animation: Animation | null; original: string; written: string; hadClass: boolean };
type SentencePaint = SentenceRange & { range: Range; value: number; target: number };

function collectTargets(block: HTMLElement, editor: HTMLElement): Map<HTMLElement, number> {
  const targets = new Map<HTMLElement, number>();
  let branch = block;
  let depth = 0;
  while (branch !== editor && branch.parentElement) {
    // Bound the visible neighborhood without scanning every block in a large document.
    for (const direction of ["previousElementSibling", "nextElementSibling"] as const) {
      let sibling = branch[direction];
      for (let distance = 1; sibling && distance <= 48; sibling = sibling[direction]) {
        if (!(sibling instanceof HTMLElement) || !sibling.matches("[data-node-id], .protyle-action")) continue;
        targets.set(sibling, RIPPLE_LEVELS[Math.min(sibling.classList.contains("protyle-action") ? depth : depth + distance, RIPPLE_LEVELS.length - 1)]);
        distance++;
      }
    }
    if (branch.parentElement.dataset.type === "NodeListItem") depth++;
    branch = branch.parentElement;
  }
  return targets;
}

function paintKey(element: HTMLElement): string | undefined {
  return element.dataset.nodeId ?? (element.classList.contains("protyle-action") && element.parentElement?.dataset.nodeId
    ? element.parentElement.dataset.nodeId + ":action" : undefined);
}

export function createRipple() {
  const style = document.createElement("style");
  document.head.append(style);
  // `currentColor` here is deliberate, not a leftover: the generated rule uses a
  // private variable, but a var() in the probe would make the declaration
  // pending-substitution, so CSS.supports would accept the syntax even in an
  // engine without relative colors.
  const supported = typeof Highlight !== "undefined" && !!CSS.highlights &&
    CSS.supports("color", "rgb(from currentColor r g b / calc(alpha * 0.6))");
  const names = Array.from({ length: 65 }, (_, i) => "zentype-remake-sentence-" + i);
  if (supported) style.textContent = names.map((name, i) =>
    "::highlight(" + name + ") { color: rgb(from var(--zentype-text-color) r g b / calc(alpha * " + (i / 64) + ")); }").join("\n");
  const blocks = new Map<HTMLElement, BlockPaint>();
  let targets = new Map<HTMLElement, number>();
  const colors = new Map<HTMLElement, { original: string; written: string }>();
  let editable: HTMLElement | null = null;
  let block: HTMLElement | null = null;
  let text = "";
  let entries: TextEntry[] = [];
  let sentences: SentencePaint[] = [];
  let lastTime = 0;
  let registered: Range[][] = Array.from({ length: names.length }, () => []);
  let scratch: Range[][] = Array.from({ length: names.length }, () => []);

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
  function release(element: HTMLElement, paint: BlockPaint) {
    paint.animation?.cancel();
    if (element.style.opacity === paint.written) {
      if (paint.original) element.style.opacity = paint.original;
      else element.style.removeProperty("opacity");
    }
    if (!paint.hadClass) element.classList.remove("zentype-ripple-block");
    blocks.delete(element);
  }
  /**
   * Current displayed value. Invariant: every painted element is sampled before
   * any retarget in the same frame, so a new animation starts from what the user
   * sees instead of from a stale value.
   */
  function sample(paint: BlockPaint): number {
    const time = paint.animation?.currentTime;
    if (typeof time === "number") {
      const progress = Math.min(1, Math.max(0, time / MOTION.blockFadeMs));
      paint.value = paint.from + (paint.target - paint.from) * (1 - Math.pow(1 - progress, 3));
    }
    return paint.value;
  }
  function retarget(element: HTMLElement, paint: BlockPaint, target: number, reducedMotion: boolean) {
    if (paint.written && paint.target === target && (!reducedMotion || !paint.animation)) return;
    paint.animation?.cancel();
    paint.animation = null;
    paint.from = paint.value;
    paint.target = target;
    paint.written = String(target);
    // Plain opacity, not a custom property: an inline custom-property write
    // invalidates the element's whole subtree, so a mass fade used to force a
    // document-scale style recalc (~25k elements, ~140ms in a measured trace).
    // Opacity invalidation stays element-local; nested owners still composite
    // multiplicatively, so ownership handoff must preserve their product.
    element.style.opacity = paint.written;
    element.classList.add("zentype-ripple-block");
    if (reducedMotion || Math.abs(paint.value - target) < 0.002) {
      paint.value = target;
      if (target === 1) release(element, paint);
      return;
    }
    const animation = element.animate([{ opacity: paint.value }, { opacity: target }], {
      duration: MOTION.blockFadeMs, easing: "cubic-bezier(0.333333, 1, 0.666667, 1)",
    });
    paint.animation = animation;
    animation.onfinish = () => {
      if (paint.animation !== animation) return;
      paint.animation = null;
      paint.value = target;
      animation.cancel();
      if (target === 1) release(element, paint);
    };
  }
  function prepare(frame: EditorFrame, contentDirty: boolean, structureDirty: boolean, enabled: boolean) {
    if (!enabled) {
      targets.clear();
      for (const [element, paint] of blocks) {
        if (paint.target === 1 && (!frame.reducedMotion || !paint.animation)) continue;
        sample(paint);
        retarget(element, paint, 1, frame.reducedMotion);
      }
      for (const paint of sentences) paint.target = 1;
      block = null;
      return;
    }
    if (!frame.block || !frame.editable || !frame.range) {
      // Invalid live ranges are never retained across a structural replacement.
      if (contentDirty || structureDirty) clearSentences();
      return;
    }
    // Read phase. Text projection, sentence boundaries and text colors are
    // resolved before any presentation write, so this frame never forces a style
    // recalc of the invalidation it is about to make.
    let sentenceReady = false;
    if (!supported) {
      // Block focus only.
    } else if (editable !== frame.editable || contentDirty) {
      const sameContent = editable === frame.editable || !!editable && !editable.isConnected &&
        editable.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId === frame.block.dataset.nodeId;
      const projection = projectText(frame.editable, colors);
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
            return [{ ...boundary, range, value: index < 0 ? 1 : previous[index].value, target: 1 }];
          });
          entries = projection.entries;
          text = projection.text;
          editable = frame.editable;
          const parents = new Set(entries.map(entry => entry.node.parentElement).filter((element): element is HTMLElement => !!element));
          const fresh = [...parents].filter(element => !colors.has(element));
          const sampled = fresh.map(element => ({ element, written: getComputedStyle(element).color,
            original: element.style.getPropertyValue("--zentype-text-color") }));
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
          sentenceReady = true;
        } else clearSentences();
      } else clearSentences();
    } else {
      sentenceReady = true;
    }
    // Write phase.
    const changed = block !== frame.block;
    if (changed || structureDirty) {
      targets = collectTargets(frame.block, frame.editor);
      targets.set(frame.block, 1);
      const previous = new Map<string, number>();
      for (const [element, paint] of blocks) {
        const key = paintKey(element);
        const value = sample(paint);
        // Carry the local alpha across a same-node-id replacement even while the
        // old element is still connected: the host inserts before it removes.
        if (key) previous.set(key, value);
      }
      // Capture the old branch alpha before releasing an ancestor owner. A
      // replaced ancestor is looked up by node id as well, so a host that inserts
      // the new parent before removing the old one still hands its alpha down.
      // The same walk collects the ancestors of every target, which is what
      // coverage below needs: an element is covered when a target sits above or
      // below it, without any element-pair cross product.
      const baselines = new Map<HTMLElement, number>();
      const targetAncestors = new Set<HTMLElement>();
      for (const element of targets.keys()) {
        let value = blocks.get(element)?.value ?? previous.get(paintKey(element) ?? "") ?? 1;
        for (let parent = element.parentElement; parent && parent !== frame.editor; parent = parent.parentElement) {
          value *= blocks.get(parent)?.value ?? previous.get(paintKey(parent) ?? "") ?? 1;
          targetAncestors.add(parent);
        }
        baselines.set(element, value);
      }
      // A new owner takes the brightest retired alpha b. Each remaining child
      // keeps its displayed alpha a by starting at a/b under that owner. With
      // b equal to the target level, the product then moves monotonically to b.
      const nearestTarget = new Map<HTMLElement, HTMLElement>();
      const handoff = new Map<HTMLElement, { element: HTMLElement; value: number }>();
      for (const [element, paint] of blocks) {
        if (targets.has(element)) continue;
        for (let parent = element.parentElement; parent && parent !== frame.editor; parent = parent.parentElement) {
          if (!targets.has(parent)) continue;
          nearestTarget.set(element, parent);
          if (blocks.has(parent) || previous.has(paintKey(parent) ?? "")) break;
          const best = handoff.get(parent);
          if (!best || best.value < paint.value) handoff.set(parent, { element, value: paint.value });
          break;
        }
      }
      for (const [target, { value }] of handoff) baselines.set(target, (baselines.get(target) ?? 1) * value);
      for (const [element, paint] of blocks) {
        if (targets.has(element)) continue;
        const target = nearestTarget.get(element);
        // The owner whose alpha moved up releases at once; a retired owner that
        // *contains* a target is an ancestor whose alpha the targets' baselines
        // already folded down, so it releases too. Everything else fades.
        const covered = targetAncestors.has(element) || (!!target && handoff.get(target)?.element === element);
        // Folded alpha must be released even mid-fade, otherwise it is applied
        // twice. Sibling residuals are normalized before continuing their fade.
        if (!element.isConnected || covered) {
          release(element, paint);
        } else {
          const transferred = target && handoff.get(target);
          if (transferred) {
            paint.value /= transferred.value;
            paint.written = "";
          }
          retarget(element, paint, 1, frame.reducedMotion);
        }
      }
      for (const [element, target] of targets) {
        let paint = blocks.get(element);
        const value = baselines.get(element)!;
        if (paint && Math.abs(paint.value - value) > 0.002) {
          paint.value = value;
          paint.written = "";
        }
        if (!paint) {
          if (value === 1 && target === 1) continue;
          paint = { value, from: value, target, animation: null, original: element.style.opacity,
            written: "", hadClass: element.classList.contains("zentype-ripple-block") };
          blocks.set(element, paint);
        }
        retarget(element, paint, target, frame.reducedMotion);
      }
      block = frame.block;
    }
    if (!sentenceReady) return;
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
    if (offset < 0) { clearSentences(); return; }
    const active = resolveActiveSentenceRanges(sentences, offset, text.length);
    for (const paint of sentences) paint.target = active.includes(paint) ? 1 : SENTENCE_ALPHA;
  }

  function render(now: number, reducedMotion: boolean): boolean {
    const elapsed = lastTime ? Math.min(MOTION.maxFrameDeltaMs, now - lastTime) : 16;
    lastTime = now;
    let moving = false;
    if (!supported) { if (!moving) lastTime = 0; return moving; }
    for (const ranges of scratch) ranges.length = 0;
    for (const paint of sentences) {
      paint.value = approach(paint.value, paint.target, elapsed,
        reducedMotion ? 0 : (paint.target === 1 ? MOTION.focusEnterMs : MOTION.focusLeaveMs) / 3);
      if (Math.abs(paint.value - paint.target) < 0.002) paint.value = paint.target;
      else moving = true;
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
    if (!moving) lastTime = 0;
    return moving;
  }

  function clear() {
    for (const [element, paint] of blocks) release(element, paint);
    clearSentences();
    block = null;
    targets.clear();
    lastTime = 0;
  }
  return { prepare, render, clear, invalidateColors: clearColors, owns: (element: HTMLElement) => blocks.has(element),
    destroy() { clear(); style.remove(); } };
}
