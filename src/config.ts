export const BUILD_LABEL = "v2.9.0-remake.2.3-critical.2";

/** Larger response95 values mean slower, softer motion. */
export const MOTION = {
  caretLiftPx: 1,
  recoveryMs: 160,
  switchSettleMs: 700,
  switchStableFrames: 8,
  structureQuietMs: 48,
  structureDeadlineMs: 160,
  cursorAppearResponse95Ms: 120,
  cursorDisappearResponse95Ms: 80,
  cursorSettlePx: 0.15,
  alphaSettleEpsilon: 0.005,
  blockFadeMs: 360,
  breathDownResponse95Ms: 600,
  breathUpResponse95Ms: 220,
  breatheLowAlpha: 0.25,
  breatheLowHoldMs: 120,
  interactionHoldMs: 150,
  edgeFadeMinHeightPx: 12,
  caretTypingResponse95Ms: 55,
  caretNavigationResponse95Ms: 110,
  breatheDelayMs: 1100,
  scrollResponse95Ms: 300,
  scrollPositionEpsilonPx: 2,
  typingPauseMs: 400,
  focusEnterResponse95Ms: 360,
  focusLeaveResponse95Ms: 520,
  sentenceSettleEpsilon: 0.002,
} as const;

export const RIPPLE_LEVELS = [1, 0.4, 0.2, 0.15, 0.1, 0.05] as const;
export const SENTENCE_ALPHA = 0.6;
