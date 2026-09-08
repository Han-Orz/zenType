import { MOTION, RIPPLE_LEVELS, SENTENCE_ALPHA } from "../config";
import { approach } from "../motion";
import type { EditorFrame } from "../types";
import { resolveRangeTextPoint } from "../utils/rangeTextPoint";
import { splitSentences, resolveActiveSentenceRanges, type SentenceRange } from "./ripple/sentenceModel";
import { projectText, sentenceRange, mapUnchangedBoundaries, type TextEntry } from "./ripple/textProjection";

type BlockPaint = { value: number; target: number; original: string; written: string; hadClass: boolean };
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

export function createRipple() {
  const style = document.createElement("style");
  document.head.append(style);
  const supported = typeof Highlight !== "undefined" && !!CSS.highlights &&
    CSS.supports("color", "rgb(from currentColor r g b / calc(alpha * 0.6))");
  const names = Array.from({ length: 65 }, (_, i) => "zentype-remake-sentence-" + i);
  if (supported) style.textContent = names.map((name, i) =>
    "::highlight(" + name + ") { color: rgb(from currentColor r g b / calc(alpha * " + (i / 64) + ")); }").join("\n");
  const blocks = new Map<HTMLElement, BlockPaint>();
  let editable: HTMLElement | null = null;
  let block: HTMLElement | null = null;
  let text = "";
  let entries: TextEntry[] = [];
  let sentences: SentencePaint[] = [];
  let lastTime = 0;
  let registered = new Map<number, Range[]>();

  function clearSentences() {
    if (supported) for (const bucket of registered.keys()) CSS.highlights.delete(names[bucket]);
    registered.clear();
    sentences = [];
    entries = [];
    text = "";
    editable = null;
  }
  function release(element: HTMLElement, paint: BlockPaint) {
    if (element.style.getPropertyValue("--zentype-dim") === paint.written) {
      if (paint.original) element.style.setProperty("--zentype-dim", paint.original);
      else element.style.removeProperty("--zentype-dim");
    }
    if (!paint.hadClass) element.classList.remove("zentype-ripple-block");
    blocks.delete(element);
  }
  function prepare(frame: EditorFrame, contentDirty: boolean, structureDirty: boolean, enabled: boolean) {
    if (!enabled) {
      for (const paint of blocks.values()) paint.target = 1;
      for (const paint of sentences) paint.target = 1;
      block = null;
      return;
    }
    if (!frame.block || !frame.editable || !frame.range) {
      // Invalid live ranges are never retained across a structural replacement.
      if (contentDirty || structureDirty) clearSentences();
      return;
    }
    const changed = block !== frame.block;
    if (changed || structureDirty) {
      const targets = collectTargets(frame.block, frame.editor);
      for (const [element, paint] of blocks) {
        let covered = false;
        for (let parent = element.parentElement; parent && parent !== frame.editor; parent = parent.parentElement) {
          if (targets.has(parent)) { covered = true; break; }
        }
        if (!element.isConnected || element.contains(frame.block) || covered) release(element, paint);
        else paint.target = targets.get(element) ?? 1;
      }
      for (const [element, target] of targets) {
        const paint = blocks.get(element);
        if (paint) paint.target = target;
        else blocks.set(element, { value: 1, target, original: element.style.getPropertyValue("--zentype-dim"),
          written: "", hadClass: element.classList.contains("zentype-ripple-block") });
      }
      block = frame.block;
    }
    if (!supported) return;
    if (editable !== frame.editable || contentDirty || structureDirty) {
      const projection = projectText(frame.editable);
      if (!projection) { clearSentences(); return; }
      const boundaries = splitSentences(projection.text);
      if (boundaries.length > 256) { clearSentences(); return; }
      const reusable = editable === frame.editable
        ? mapUnchangedBoundaries(text, projection.text, sentences) : [];
      const previous = sentences;
      sentences = boundaries.flatMap(boundary => {
        const range = sentenceRange(projection.entries, boundary);
        if (!range) return [];
        const index = reusable.findIndex(old => old?.start === boundary.start && old.end === boundary.end);
        return [{ ...boundary, range, value: index < 0 ? 1 : previous[index].value, target: 1 }];
      });
      entries = projection.entries;
      text = projection.text;
      editable = frame.editable;
    }
    const point = resolveRangeTextPoint(frame.range.startContainer, frame.range.startOffset);
    const entry = point ? entries.find(item => item.node === point.textNode) : null;
    if (!entry || !point) { clearSentences(); return; }
    const active = resolveActiveSentenceRanges(sentences, entry.start + point.offset, text.length);
    for (const paint of sentences) paint.target = active.includes(paint) ? 1 : SENTENCE_ALPHA;
  }

  function render(now: number, reducedMotion: boolean): boolean {
    const elapsed = lastTime ? Math.min(64, now - lastTime) : 16;
    lastTime = now;
    let moving = false;
    for (const [element, paint] of blocks) {
      if (!element.isConnected) { release(element, paint); continue; }
      paint.value = approach(paint.value, paint.target, elapsed, reducedMotion ? 0 : 80);
      if (Math.abs(paint.value - paint.target) < 0.002) paint.value = paint.target;
      else moving = true;
      if (paint.value === 1 && paint.target === 1) { release(element, paint); continue; }
      const value = paint.value.toFixed(4);
      if (value !== paint.written || !element.classList.contains("zentype-ripple-block")) {
        paint.written = value;
        element.style.setProperty("--zentype-dim", value);
        element.classList.add("zentype-ripple-block");
      }
    }
    if (!supported) return moving;
    const buckets = new Map<number, Range[]>();
    for (const paint of sentences) {
      paint.value = approach(paint.value, paint.target, elapsed,
        reducedMotion ? 0 : (paint.target === 1 ? MOTION.focusEnterMs : MOTION.focusLeaveMs) / 3);
      if (Math.abs(paint.value - paint.target) < 0.002) paint.value = paint.target;
      else moving = true;
      const bucket = Math.round(paint.value * 64);
      if (bucket === 64) continue;
      const ranges = buckets.get(bucket) ?? [];
      ranges.push(paint.range);
      buckets.set(bucket, ranges);
    }
    for (const bucket of registered.keys()) if (!buckets.has(bucket)) CSS.highlights.delete(names[bucket]);
    for (const [bucket, ranges] of buckets) {
      const old = registered.get(bucket);
      if (!old || old.length !== ranges.length || ranges.some((range, i) => old[i] !== range)) {
        CSS.highlights.set(names[bucket], new Highlight(...ranges));
      }
    }
    registered = buckets;
    if (!block && !moving) clearSentences();
    return moving;
  }

  function clear() {
    for (const [element, paint] of blocks) release(element, paint);
    clearSentences();
    block = null;
    lastTime = 0;
  }
  return { prepare, render, clear, owns: (element: HTMLElement) => blocks.has(element),
    destroy() { clear(); style.remove(); } };
}
