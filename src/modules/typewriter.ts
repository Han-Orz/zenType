import { MOTION } from "../config";
import type { EditorFrame } from "../types";

export function createTypewriter() {
  let target: number | null = null;
  let previousTime: number | null = null;

  function cancel() {
    target = null;
    previousTime = null;
  }

  function next(frame: EditorFrame, now: number, enabled: boolean, lastInput: number, retarget: boolean) {
    if (!enabled) { cancel(); return frame.scrollTop; }
    const { scrollViewport: viewport, caret, scrollTop, maxScroll } = frame;
    const height = viewport.bottom - viewport.top;
    const clamp = (value: number) => Math.max(0, Math.min(maxScroll, value));
    const margin = Math.min(24, height / 4);
    const nearEdge = caret.y < viewport.top + margin || caret.y + caret.height > viewport.bottom - margin;
    if (nearEdge) {
      // Visibility is immediate; comfort centering may wait until typing pauses.
      const safeY = Math.max(viewport.top + margin, Math.min(viewport.bottom - margin - caret.height, caret.y));
      cancel();
      return clamp(scrollTop + caret.y - safeY);
    }
    if ((retarget || target === null) && (target !== null || now - lastInput >= MOTION.typingPauseMs)) {
      const position = (caret.y - viewport.top) / height;
      if (position < 0.34 || position > 0.54) {
        const nextTarget = clamp(scrollTop + caret.y - (viewport.top + height * (position < 0.34 ? 0.40 : 0.48)));
        if (target === null || Math.abs(nextTarget - target) > 1) target = nextTarget;
      }
    }
    if (target === null) return scrollTop;
    target = clamp(target);
    const elapsed = previousTime === null ? 16 : Math.min(64, Math.max(0, now - previousTime));
    previousTime = now;
    const next = frame.reducedMotion ? target : scrollTop + (target - scrollTop) * (1 - Math.exp(-elapsed / MOTION.scrollResponseMs));
    if (Math.abs(target - next) < 0.5) {
      const end = target;
      cancel();
      return end;
    }
    return next;
  }

  return { next, cancel, isMoving: () => target !== null };
}
