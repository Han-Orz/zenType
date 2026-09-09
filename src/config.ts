export const BUILD_LABEL = "v2.9.0-remake.2";

/**
 * The `caret*` and `focus*` values are 95%-settle durations; effect modules
 * divide them by 3 to get the exponential time constant `approach()` expects.
 * `scrollResponseMs` is already a time constant and is used directly. In every
 * case a larger number means slower, softer motion.
 */
export const MOTION = {
  caretLiftPx: 1,
  recoveryMs: 160,
  switchSettleMs: 700,
  switchStableFrames: 8,
  structureQuietMs: 48,
  structureDeadlineMs: 160,
  maxFrameDeltaMs: 100,
  caretFadeInMs: 120,
  caretFadeOutMs: 120,
  caretBrightenMs: 200,
  blockFadeMs: 360,
  breatheCycleMs: 4000,
  breatheAnimationDelayMs: 1500,
  breatheHoldPct: 58,
  breatheDipPct: 80,
  breatheDipEndPct: 82,
  breatheMinAlpha: 0,
  breatheWakeMarginMs: 20,
  interactionHoldMs: 150,
  edgeFadeMinHeightPx: 12,
  caretTypingMs: 55,
  caretNavigationMs: 110,
  breatheDelayMs: 1100,
  scrollResponseMs: 100,
  typingPauseMs: 400,
  focusEnterMs: 360,
  focusLeaveMs: 520,
} as const;

/** Generated so the whole breathing envelope lives here, not in the stylesheet. */
export const CURSOR_MOTION_CSS = `#zentype-cursor {
  --zt-breathe-cycle: ${MOTION.breatheCycleMs}ms;
  --zt-breathe-delay: ${MOTION.breatheAnimationDelayMs}ms;
  --zt-breathe-min-alpha: ${MOTION.breatheMinAlpha};
}

@keyframes zentype-breathe {
  0%, ${MOTION.breatheHoldPct}% { opacity: 1; }
  ${MOTION.breatheDipPct}%, ${MOTION.breatheDipEndPct}% { opacity: var(--zt-breathe-min-alpha); }
  100% { opacity: 1; }
}`;

export const RIPPLE_LEVELS = [1, 0.4, 0.2, 0.15, 0.1, 0.05] as const;
export const SENTENCE_ALPHA = 0.6;
