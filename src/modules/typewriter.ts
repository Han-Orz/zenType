import { MOTION } from "../config";
import { approach, clamp } from "../motion";
import type { EditorFrame } from "../types";

export function createTypewriter() {
  let target: number | null = null;
  let anchor = 0.48;
  let previousTime = 0;
  let expected: number | null = null;

  function cancel() { target = expected = null; previousTime = 0; }

  function next(frame: EditorFrame, now: number, enabled: boolean, lastInput: number): number {
    if (!enabled || !frame.caret) { cancel(); return frame.scrollTop; }
    if (expected !== null && Math.abs(frame.scrollTop - expected) > 1) {
      // Host scrolling and scroll anchoring supersede an outstanding comfort target.
      cancel();
      return frame.scrollTop;
    }
    const { caret, scrollTop, maxScroll, scrollViewport: viewport } = frame;
    const height = viewport.bottom - viewport.top;
    const position = (caret.y + caret.height / 2 - viewport.top) / height;
    const margin = Math.min(caret.height * 1.5, height / 4);
    const nearEdge = caret.y < viewport.top + margin || caret.y + caret.height > viewport.bottom - margin;
    if (nearEdge || target !== null || now - lastInput >= MOTION.typingPauseMs) {
      if (position < 0.34) anchor = 0.40;
      else if (position > 0.54) anchor = 0.48;
      if (position < 0.34 || position > 0.54 || target !== null) {
        const desired = viewport.top + height * anchor - caret.height / 2;
        target = clamp(scrollTop + caret.y - desired, 0, maxScroll);
      }
    }
    if (target === null) return scrollTop;
    const elapsed = previousTime ? Math.min(64, now - previousTime) : 16;
    previousTime = now;
    let result = approach(scrollTop, target, elapsed, frame.reducedMotion ? 0 : MOTION.scrollResponseMs);
    if (caret.y < viewport.top) result = Math.min(result, scrollTop + caret.y - viewport.top);
    if (caret.y + caret.height > viewport.bottom) result = Math.max(result, scrollTop + caret.y + caret.height - viewport.bottom);
    result = clamp(result, 0, maxScroll);
    if (Math.abs(target - result) < 0.5) { result = target; target = null; }
    return result;
  }

  return { next, cancel, written(value: number) { expected = value; }, isMoving: () => target !== null };
}
