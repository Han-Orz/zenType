import { MOTION, RIPPLE_LEVELS, SENTENCE_ALPHA } from "../config";
import type { EditorFrame } from "../types";
import { resolveRangeTextPoint } from "../utils/rangeTextPoint";
import { splitSentences, resolveActiveSentenceRanges, type SentenceRange } from "./ripple/sentenceModel";

type TextEntry = { node: Text; start: number; end: number };
type SentencePlan = { ranges: Range[]; active: number[]; color: string; reset: boolean };
type RipplePlan = { targets: Map<HTMLElement, number> | null; sentences: SentencePlan | null };
const names = ["zentype-sentence-dim", "zentype-sentence-enter", "zentype-sentence-leave"];

function collectTargets(block: HTMLElement, editor: HTMLElement): Map<HTMLElement, number> {
  const targets = new Map<HTMLElement, number>();
  let branch = block;
  let depth = 0;
  while (branch !== editor && branch.parentElement) {
    const parent = branch.parentElement;
    const siblings = Array.from(parent.children).filter((child): child is HTMLElement =>
      child instanceof HTMLElement && (child.hasAttribute("data-node-id") || child.classList.contains("protyle-action")));
    const index = siblings.indexOf(branch);
    for (let i = 0; i < siblings.length; i++) {
      const sibling = siblings[i];
      if (sibling === branch) continue;
      const distance = sibling.classList.contains("protyle-action") ? depth : depth + Math.max(1, Math.abs(i - index));
      targets.set(sibling, RIPPLE_LEVELS[Math.min(distance, RIPPLE_LEVELS.length - 1)]);
    }
    if (parent.dataset.type === "NodeListItem") depth++;
    branch = parent;
  }
  return targets;
}

export function createRipple() {
  const style = document.createElement("style");
  document.head.appendChild(style);
  let applied = new Map<HTMLElement, string>();
  let block: HTMLElement | null = null;
  let entries: TextEntry[] = [];
  let sentences: SentenceRange[] = [];
  let ranges: Range[] = [];
  let active: number[] = [];
  let color = "";
  let transition: { entering: number[]; leaving: number[]; started: number } | null = null;
  const supported = typeof Highlight !== "undefined" && typeof CSS !== "undefined" && !!CSS.highlights &&
    CSS.supports("color", "color-mix(in srgb, black 60%, transparent)");

  function rangeFor(sentence: SentenceRange): Range | null {
    const first = entries.find(entry => entry.end > sentence.start);
    const last = entries.find(entry => entry.end >= sentence.end && entry.start < sentence.end);
    if (!first || !last) return null;
    const range = document.createRange();
    range.setStart(first.node, sentence.start - first.start);
    range.setEnd(last.node, sentence.end - last.start);
    return range;
  }

  function prepare(frame: EditorFrame, dirty: boolean, structureDirty: boolean): RipplePlan {
    const changed = block !== frame.block;
    const targets = changed || structureDirty ? collectTargets(frame.block, frame.editor) : null;
    if (!supported) { block = frame.block; return { targets, sentences: null }; }
    const reset = changed || dirty;
    if (reset) {
      entries = [];
      const walker = document.createTreeWalker(frame.block, NodeFilter.SHOW_TEXT);
      let text = "";
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const value = node.nodeValue ?? "";
        entries.push({ node: node as Text, start: text.length, end: text.length + value.length });
        text += value;
      }
      sentences = splitSentences(text);
      ranges = sentences.map(rangeFor).filter((range): range is Range => range !== null);
      color = getComputedStyle(frame.block).color;
      block = frame.block;
    }
    const point = resolveRangeTextPoint(frame.range.startContainer, frame.range.startOffset);
    const entry = point ? entries.find(entry => entry.node === point.textNode) : null;
    const selected = entry && point
      ? resolveActiveSentenceRanges(sentences, entry.start + point.offset, entries.at(-1)?.end ?? 0)
      : [];
    const nextActive = selected.map(sentence => sentences.indexOf(sentence));
    if (!reset && nextActive.length === active.length && nextActive.every((value, index) => value === active[index])) {
      return { targets, sentences: null };
    }
    return { targets, sentences: { ranges, active: nextActive, color, reset } };
  }

  function highlight(name: string, indexes: number[]) {
    const selected = indexes.map(index => ranges[index]).filter((range): range is Range => !!range);
    if (selected.length) CSS.highlights.set(name, new Highlight(...selected));
    else CSS.highlights.delete(name);
  }

  function register() {
    const moving = [...(transition?.entering ?? []), ...(transition?.leaving ?? [])];
    highlight(names[0], ranges.map((_, index) => index).filter(index => !active.includes(index) && !moving.includes(index)));
    highlight(names[1], transition?.entering ?? []);
    highlight(names[2], transition?.leaving ?? []);
  }

  function clear() {
    if (block === null && applied.size === 0) return;
    for (const [element, value] of applied) {
      if (element.style.getPropertyValue("--zentype-dim") === value) element.style.removeProperty("--zentype-dim");
      element.classList.remove("zentype-ripple-block");
    }
    applied.clear();
    if (supported) names.forEach(name => CSS.highlights.delete(name));
    style.textContent = "";
    block = null;
    entries = [];
    sentences = [];
    ranges = [];
    active = [];
    transition = null;
  }

  function render(plan: RipplePlan, now: number, reducedMotion: boolean): boolean {
    if (plan.targets) {
      for (const [element, value] of applied) {
        if (plan.targets.has(element)) continue;
        if (element.style.getPropertyValue("--zentype-dim") === value) element.style.removeProperty("--zentype-dim");
        element.classList.remove("zentype-ripple-block");
      }
      const next = new Map<HTMLElement, string>();
      for (const [element, opacity] of plan.targets) {
        const value = String(opacity);
        if (applied.get(element) !== value || !element.classList.contains("zentype-ripple-block")) {
          element.style.setProperty("--zentype-dim", value);
          element.classList.add("zentype-ripple-block");
        }
        next.set(element, value);
      }
      applied = next;
    }
    if (!supported) return false;
    if (plan.sentences) {
      const next = plan.sentences;
      const entering = next.active.filter(index => !active.includes(index));
      const leaving = active.filter(index => !next.active.includes(index));
      transition = !next.reset && !reducedMotion && (entering.length || leaving.length)
        ? { entering, leaving, started: now } : null;
      active = next.active;
      ranges = next.ranges;
      color = next.color;
      register();
    }
    let enterAlpha = 1;
    let leaveAlpha = SENTENCE_ALPHA;
    if (transition) {
      const elapsed = now - transition.started;
      const enter = Math.min(1, elapsed / MOTION.focusEnterMs);
      const leave = Math.min(1, elapsed / MOTION.focusLeaveMs);
      enterAlpha = SENTENCE_ALPHA + (1 - SENTENCE_ALPHA) * (1 - Math.pow(1 - enter, 3));
      leaveAlpha = 1 - (1 - SENTENCE_ALPHA) * (1 - Math.pow(1 - leave, 3));
      if (reducedMotion || leave === 1) { transition = null; register(); }
    }
    const cssColor = (alpha: number) => "color-mix(in srgb, " + color + " " + (alpha * 100).toFixed(2) + "%, transparent)";
    if (color) {
      const css = names.map((name, index) => "::highlight(" + name + ") { color: " + cssColor([SENTENCE_ALPHA, enterAlpha, leaveAlpha][index]) + "; }").join("\n");
      if (style.textContent !== css) style.textContent = css;
    }
    return transition !== null;
  }

  return { prepare, render, clear, destroy() { clear(); style.remove(); } };
}
