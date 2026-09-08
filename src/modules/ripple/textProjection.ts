import type { SentenceRange } from "./sentenceModel";

export interface TextEntry { node: Text; start: number; end: number }
export function projectText(editable: HTMLElement): { text: string; entries: TextEntry[] } | null {
  const entries: TextEntry[] = [];
  let text = "";
  const walker = document.createTreeWalker(editable, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node instanceof Element && node.matches("[contenteditable='false'], .protyle-attr, .protyle-action, [data-node-id]")) return NodeFilter.FILTER_REJECT;
      return node.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const value = node.nodeValue ?? "";
    if (text.length + value.length > 32768 || entries.length >= 2048) return null;
    entries.push({ node: node as Text, start: text.length, end: text.length + value.length });
    text += value;
  }
  return { text, entries };
}

export function sentenceRange(entries: TextEntry[], sentence: SentenceRange): Range | null {
  const first = entries.find(entry => entry.end > sentence.start);
  const last = entries.find(entry => entry.end >= sentence.end && entry.start < sentence.end);
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first.node, sentence.start - first.start);
  range.setEnd(last.node, sentence.end - last.start);
  return range;
}

// Only boundaries outside a single changed interval can retain presentation.
// This deliberately has no cross-block or replacement identity recovery.
export function mapUnchangedBoundaries(before: string, after: string, ranges: readonly SentenceRange[]): Array<SentenceRange | null> {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > prefix && newEnd > prefix && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  const delta = after.length - before.length;
  return ranges.map(range => {
    const start = range.start <= prefix ? range.start : range.start >= oldEnd ? range.start + delta : null;
    const end = range.end >= oldEnd ? range.end + delta : range.end <= prefix ? range.end : null;
    return start === null || end === null ? null : { start, end };
  });
}
