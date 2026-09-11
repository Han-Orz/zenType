export const BUILD_LABEL = "v2.9.0-remake.2.6-sentence-first-frame.1";

/** Larger responseMs values mean slower, softer motion. */
export const MOTION = {
  caretLiftPx: 1,
  recoveryMs: 160,
  switchSettleMs: 700,
  switchStableFrames: 8,
  structureQuietMs: 48,
  structureDeadlineMs: 160,
  cursorAppearResponseMs: 370,
  cursorDisappearResponseMs: 80,
  cursorSettlePx: 0.15,
  alphaSettleEpsilon: 0.005,
  blockFadeMs: 360,
  breathDownResponseMs: 900,
  breathUpResponseMs: 600,
  breatheLowAlpha: 0,
  breatheLowHoldMs: 0,
  interactionHoldMs: 150,
  edgeFadeMinHeightPx: 12,
  caretTypingResponseMs: 55,
  caretNavigationResponseMs: 110,
  breatheIdleDelayMs: 3000,
  breatheRestMs: 2000,
  scrollResponseMs: 300,
  scrollPositionEpsilonPx: 0.21,
  typingPauseMs: 400,
  focusEnterResponseMs: 360,
  focusLeaveResponseMs: 520,
  sentenceSettleEpsilon: 0.002,
} as const;

export const RIPPLE_LEVELS = [1, 0.4, 0.2, 0.15, 0.1, 0.05] as const;
export const SENTENCE_ALPHA = 0.6;
