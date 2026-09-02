import { TYPEWRITER_CONFIG } from "../../config";

export interface ScrollTargetPolicy {
  triggerLow: number;
  triggerHigh: number;
  settleLow: number;
  settleHigh: number;
  minMovementPx: number;
}

export const DEFAULT_SCROLL_TARGET_POLICY: ScrollTargetPolicy = {
  triggerLow: TYPEWRITER_CONFIG.SCROLL_TRIGGER_ZONE[0],
  triggerHigh: TYPEWRITER_CONFIG.SCROLL_TRIGGER_ZONE[1],
  settleLow: TYPEWRITER_CONFIG.SCROLL_SETTLE_ZONE[0],
  settleHigh: TYPEWRITER_CONFIG.SCROLL_SETTLE_ZONE[1],
  minMovementPx: 1,
};

export interface ScrollTargetInput {
  cursorY: number;
  editorTop: number;
  editorBottom: number;
  currentScrollTop: number;
  maxScrollTop: number;
}

export type ScrollTargetResolution =
  | {
    action: "hold";
    reason: "within-trigger-zone" | "invalid-geometry" | "clamped-noop";
    cursorPct: number | null;
  }
  | {
    action: "move";
    reason: "above-trigger" | "below-trigger";
    cursorPct: number;
    targetPct: number;
    targetScrollTop: number;
    deltaY: number;
  };

function hold(
  reason: "within-trigger-zone" | "invalid-geometry" | "clamped-noop",
  cursorPct: number | null,
): ScrollTargetResolution {
  return { action: "hold", reason, cursorPct };
}

/**
 * Resolve a trusted caret/editor geometry sample into an absolute scroll
 * endpoint. This module deliberately has no DOM or motion-controller access.
 */
export function resolveScrollTarget(
  input: ScrollTargetInput,
  policy: ScrollTargetPolicy = DEFAULT_SCROLL_TARGET_POLICY,
): ScrollTargetResolution {
  const {
    cursorY,
    editorTop,
    editorBottom,
    currentScrollTop,
    maxScrollTop,
  } = input;

  if (
    !Number.isFinite(cursorY)
    || !Number.isFinite(editorTop)
    || !Number.isFinite(editorBottom)
    || !Number.isFinite(currentScrollTop)
    || !Number.isFinite(maxScrollTop)
  ) {
    return hold("invalid-geometry", null);
  }

  const editorHeight = editorBottom - editorTop;
  if (!Number.isFinite(editorHeight) || editorHeight <= 0 || maxScrollTop < 0) {
    return hold("invalid-geometry", null);
  }

  const cursorPct = (cursorY - editorTop) / editorHeight;
  if (!Number.isFinite(cursorPct)) {
    return hold("invalid-geometry", null);
  }
  if (cursorPct >= policy.triggerLow && cursorPct <= policy.triggerHigh) {
    return hold("within-trigger-zone", cursorPct);
  }

  const isAbove = cursorPct < policy.triggerLow;
  const targetPct = isAbove ? policy.settleLow : policy.settleHigh;
  const desiredDelta = (cursorPct - targetPct) * editorHeight;
  const desiredScrollTop = currentScrollTop + desiredDelta;
  const targetScrollTop = Math.max(0, Math.min(desiredScrollTop, maxScrollTop));
  const deltaY = targetScrollTop - currentScrollTop;

  if (Math.abs(deltaY) < policy.minMovementPx) {
    return hold("clamped-noop", cursorPct);
  }

  return {
    action: "move",
    reason: isAbove ? "above-trigger" : "below-trigger",
    cursorPct,
    targetPct,
    targetScrollTop,
    deltaY,
  };
}
