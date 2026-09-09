import { MOTION } from "../config";
import { approach, clamp } from "../motion";
import type { EditorFrame } from "../types";

export function createTypewriter() {
  let target: number | null = null;
  let anchor = 0.48;
  let previousTime = 0;
  let expected: number | null = null;
  let yieldedInput = -Infinity;
  let locating = false;
  let response: number = MOTION.scrollResponseMs;

  function cancel() { target = expected = null; previousTime = 0; locating = false; }

  function next(frame: EditorFrame, now: number, enabled: boolean, lastInput: number, locate = false): number {
    if (!enabled || !frame.caret) { cancel(); return frame.scrollTop; }
    if (!locate && expected !== null && Math.abs(frame.scrollTop - expected) > 1) {
      // Host scrolling and scroll anchoring supersede an outstanding comfort target.
      cancel();
      yieldedInput = lastInput;
      return frame.scrollTop;
    }
    if (!locate && !locating && lastInput <= yieldedInput) return frame.scrollTop;
    const { caret, scrollTop, maxScroll, scrollViewport: viewport } = frame;
    const height = viewport.bottom - viewport.top;
    const position = (caret.y + caret.height / 2 - viewport.top) / height;
    if (locate) {
      cancel();
      if (position >= 0.25 && position <= 0.75) return scrollTop;
      locating = true;
      anchor = 0.5;
    }
    const margin = Math.min(caret.height * 1.5, height / 4);
    const nearEdge = caret.y < viewport.top + margin || caret.y + caret.height > viewport.bottom - margin;
    if (locating || nearEdge || target !== null || now - lastInput >= MOTION.typingPauseMs) {
      if (!locating && target === null) anchor = position < 0.34 ? 0.40 : 0.48;
      if (locating || position < 0.34 || position > 0.54 || target !== null) {
        const desired = viewport.top + height * anchor - caret.height / 2;
        const nextTarget = clamp(scrollTop + caret.y - desired, 0, maxScroll);
        if (!locating && target !== null && Math.abs(nextTarget - target) >= 1 &&
            !nearEdge && position >= 0.34 && position <= 0.54) {
          cancel();
          return scrollTop;
        }
        if (target === null) {
          previousTime = 0;
          response = MOTION.scrollResponseMs + Math.min(70, Math.abs(nextTarget - scrollTop) * 0.12) + (locating ? 30 : 0);
        }
        if (target === null || Math.abs(nextTarget - target) >= 1) target = nextTarget;
      }
    }
    if (target === null) return scrollTop;
    const elapsed = previousTime ? Math.min(MOTION.maxFrameDeltaMs, now - previousTime) : 16;
    previousTime = now;
    let result = approach(scrollTop, target, elapsed, frame.reducedMotion ? 0 : response);
    if (caret.y < viewport.top) result = Math.min(result, scrollTop + caret.y - viewport.top);
    if (caret.y + caret.height > viewport.bottom) result = Math.max(result, scrollTop + caret.y + caret.height - viewport.bottom);
    result = clamp(result, 0, maxScroll);
    if (Math.abs(target - result) < 1) { result = target; target = null; previousTime = 0; locating = false; }
    return result;
  }

  return { next, cancel, written(value: number) { expected = value; }, isMoving: () => target !== null,
    isLocating: () => locating,
    /**
     * True while this module is the one moving the container and the observed
     * scrollTop still matches the value it wrote. The session uses it to tell its
     * own scroll events from host scrolling, which is the only case that
     * invalidates sampled host geometry.
     */
    ownsScroll(value: number): boolean {
      return target !== null && expected !== null && Math.abs(value - expected) <= 1;
    } };
}
