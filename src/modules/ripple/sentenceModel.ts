/**
 * DOM-independent sentence model for Ripple sentence focus.
 *
 * Intl.Segmenter (granularity: "sentence") is the single sentence boundary
 * source: no regex fallback, no punctuation/whitespace post-processing. When
 * the platform lacks Intl.Segmenter, sentence focus is disabled upstream —
 * the singleton caches the "unsupported" state and splitSentences yields no
 * ranges, so callers clear highlights and keep block-level Ripple only.
 *
 * All offsets are UTF-16 code unit indices into the block text, matching
 * textContent.length, Range offsets and getCaretOffset — Segmenter's
 * segment.index + segment.segment.length live in the same coordinate space,
 * so no code point conversion happens anywhere.
 */

export interface SentenceRange {
  start: number;
  end: number;
}

let sentenceSegmenter: Intl.Segmenter | null | undefined;

/** Lazy module-level singleton; caches the unsupported state instead of polyfilling. */
export function getSentenceSegmenter(): Intl.Segmenter | null {
  if (sentenceSegmenter === undefined) {
    sentenceSegmenter =
      typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "sentence" })
        : null;
  }
  return sentenceSegmenter;
}

/** Segmenter segments tile [0, text.length] contiguously; empty text yields no ranges. */
export function splitSentences(text: string): SentenceRange[] {
  const segmenter = getSentenceSegmenter();
  if (!segmenter) return [];

  const ranges: SentenceRange[] = [];
  for (const segment of segmenter.segment(text)) {
    ranges.push({ start: segment.index, end: segment.index + segment.segment.length });
  }
  return ranges;
}

/**
 * Resolve the caret offset to the set of active sentence ranges. Usually one
 * range; when the caret sits exactly on the shared boundary of two adjacent
 * ranges, both are active (pure position semantics — no direction, input
 * mode or history involvement). BOF keeps the first sentence, EOF the last.
 */
export function resolveActiveSentenceRanges(
  sentenceRanges: readonly SentenceRange[],
  caretOffset: number,
  textLength: number,
): SentenceRange[] {
  if (sentenceRanges.length === 0) return [];

  const caret = Math.min(Math.max(caretOffset, 0), Math.max(textLength, 0));
  const first = sentenceRanges[0];
  const last = sentenceRanges[sentenceRanges.length - 1];
  if (caret <= first.start) return [first];
  if (caret >= last.end) return [last];

  for (let index = 0; index < sentenceRanges.length; index++) {
    const range = sentenceRanges[index];
    if (caret < range.start) return [range];
    if (caret <= range.end) {
      const next = sentenceRanges[index + 1];
      if (caret === range.end && next !== undefined && next.start === caret) {
        return [range, next];
      }
      return [range];
    }
  }
  return [last];
}
