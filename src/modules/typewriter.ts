import { MOTION } from "../config";
import { clamp, stepCritical, type CriticalState } from "../motion";
import type { EditorFrame } from "../types";

export function createTypewriter() {
  let target: number | null = null;
  let motion: CriticalState | null = null;
  let anchor = 0.48;
  let previousTime = 0;
  let expected: number | null = null;
  let yieldedInput = -Infinity;
  let locating = false;
  let response = MOTION.scrollResponse95Ms;

  function cancel() {
    target = null;
    motion = null;
    expected = null;
    previousTime = 0;
    locating = false;
  }

  function next(frame: EditorFrame, now: number, enabled: boolean, lastInput: number, locate = false): number {
    if (!enabled || !frame.caret) { cancel(); return frame.scrollTop; }
    const { caret, scrollTop, maxScroll, scrollViewport: viewport } = frame;
    if (!locate && expected !== null && Math.abs(scrollTop - expected) > 1) {
      // Host scrolling and scroll anchoring supersede an outstanding comfort target.
      // The next target will start from this realized actuator value.
      cancel();
      yieldedInput = lastInput;
      return scrollTop;
    }
    if (!locate && !locating && lastInput <= yieldedInput) return scrollTop;
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
          motion = { value: scrollTop, velocity: 0 };
          previousTime = 0;
          response = MOTION.scrollResponse95Ms + Math.min(70, Math.abs(nextTarget - scrollTop) * 0.12) +
            (locating ? 30 : 0);
        }
        if (target === null || Math.abs(nextTarget - target) >= 1) target = nextTarget;
      }
    }
    if (target === null || !motion) return scrollTop;

    const elapsed = previousTime ? Math.min(MOTION.maxFrameDeltaMs, now - previousTime) : 16;
    previousTime = now;
    const settled = stepCritical(motion, target, elapsed, frame.reducedMotion ? 0 : response,
      MOTION.scrollPositionEpsilonPx);
    let result = clamp(motion.value, 0, maxScroll);
    if (caret.y < viewport.top) result = Math.min(result, scrollTop + caret.y - viewport.top);
    if (caret.y + caret.height > viewport.bottom) {
      result = Math.max(result, scrollTop + caret.y + caret.height - viewport.bottom);
    }
    result = clamp(result, 0, maxScroll);
    if (result !== motion.value) {
      // Bounds and edge protection are actuator constraints, not a new motion
      // origin. Keep the virtual value at the constrained point for the next step.
      motion.value = result;
      motion.velocity = 0;
    }
    if (settled && Math.abs(target - result) <= MOTION.scrollPositionEpsilonPx) {
      result = target;
      target = null;
      motion = null;
      previousTime = 0;
      locating = false;
    }
    return result;
  }

  return {
    next,
    cancel,
    written(value: number) { expected = value; },
    isMoving: () => target !== null,
    isLocating: () => locating,
    motionTelemetry() {
      return { target, motionValue: motion?.value ?? null, motionVelocity: motion?.velocity ?? null };
    },
    /** True while this module owns the last actuator write. */
    ownsScroll(value: number): boolean {
      return target !== null && expected !== null && Math.abs(value - expected) <= 1;
    },
  };
}
