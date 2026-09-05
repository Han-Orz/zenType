import { TYPEWRITER_CONFIG } from "../../config";
import { prefersReducedMotion } from "../../utils/reducedMotion";

const { SCROLL_DURATION_TIERS } = TYPEWRITER_CONFIG;

export interface ScrollOptions {
  deltaY: number;
  duration?: number;
  easing?: (t: number) => number;
}

export type TypewriterScrollDebugEventName =
  | "typewriter-check-gate"
  | "typewriter-scroll-resolve"
  | "typewriter-scroll-start"
  | "typewriter-scroll-frame"
  | "typewriter-scroll-retarget"
  | "typewriter-scroll-resync"
  | "typewriter-scroll-end"
  | "typewriter-scroll-cancel";

export interface TypewriterScrollDebugEvent {
  name: TypewriterScrollDebugEventName;
  target?: HTMLElement | null;
  [key: string]: unknown;
}

export type TypewriterScrollDebugSink = (event: TypewriterScrollDebugEvent) => void;

const DEBUG_ENABLED = __ZENTYPE_DEV__;

let activeScrollFrame: number | null = null;
let activeTarget: HTMLElement | null = null;
let startScroll = 0;
let endScroll = 0;
let startTime: number | null = null;
let duration = 0;
let easing: (t: number) => number = easeOutCubic;
let generation = 0;
let resyncPending = false;
let retargetSettledCallback: (() => void) | null = null;
let debugSink: TypewriterScrollDebugSink | null = null;
let motionSequence = 0;
let activeMotionId: string | null = null;
let frameIndex = 0;
let lastObservedScroll: number | null = null;
let lastIntendedScroll: number | null = null;

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function emitDebug(event: TypewriterScrollDebugEvent): void {
  if (!DEBUG_ENABLED) return;
  debugSink?.(event);
}

export function setDebugSink(next: TypewriterScrollDebugSink | null): void {
  if (!DEBUG_ENABLED) return;
  debugSink = next;
}

export function reportDebugEvent(event: TypewriterScrollDebugEvent): void {
  emitDebug({
    ...event,
    motionId: event.motionId ?? activeMotionId,
  });
}

export function shouldCancelPendingScrollForReducedMotion(
  reducedMotion: boolean,
  hasPendingScroll: boolean,
): boolean {
  return reducedMotion && hasPendingScroll;
}

export function durationForDistance(dist: number): number {
  if (dist < 20) return SCROLL_DURATION_TIERS[0];
  if (dist < 60) return SCROLL_DURATION_TIERS[1];
  if (dist < 150) return SCROLL_DURATION_TIERS[2];
  if (dist < 400) return SCROLL_DURATION_TIERS[3];
  return SCROLL_DURATION_TIERS[4];
}

function clampScrollTop(target: HTMLElement, value: number): number {
  const maxScroll = target.scrollHeight - target.clientHeight;
  return Math.max(0, Math.min(value, maxScroll));
}

function clearActiveScroll(): void {
  if (activeScrollFrame !== null) cancelAnimationFrame(activeScrollFrame);
  activeScrollFrame = null;
  activeTarget = null;
  startScroll = 0;
  endScroll = 0;
  startTime = null;
  duration = 0;
  resyncPending = false;
  retargetSettledCallback = null;
  activeMotionId = null;
  frameIndex = 0;
  lastObservedScroll = null;
  lastIntendedScroll = null;
}

export function isScrolling(): boolean {
  return activeScrollFrame !== null;
}

/** Whether this exact scroll container owns the current animated motion. */
export function ownsActiveScroll(target: EventTarget | null): boolean {
  return activeScrollFrame !== null && activeTarget !== null && activeTarget === target;
}

export function cancel(): void {
  if (DEBUG_ENABLED && activeScrollFrame !== null && activeTarget !== null) {
    emitDebug({
      name: "typewriter-scroll-cancel",
      target: activeTarget,
      motionId: activeMotionId,
      generation,
      startScroll,
      endScroll,
      currentScrollTop: activeTarget.scrollTop,
      elapsedMs: startTime === null ? 0 : performance.now() - startTime,
      resyncPending,
    });
  }
  generation += 1;
  clearActiveScroll();
}

export function reset(): void {
  cancel();
}

export function cancelForReducedMotion(): void {
  if (!shouldCancelPendingScrollForReducedMotion(prefersReducedMotion(), isScrolling())) {
    return;
  }
  cancel();
}

/**
 * Remember that the caret/layout should be checked again after the current
 * motion reaches a safe point. The active loop keeps its existing easing
 * timeline; callers do not need to start a second loop for transient geometry.
 */
export function requestResync(onSettled?: () => void): void {
  const accepted = activeScrollFrame !== null && activeTarget !== null;
  if (accepted) {
    resyncPending = true;
    if (onSettled) retargetSettledCallback = onSettled;
  }
  if (DEBUG_ENABLED) {
    emitDebug({
      name: "typewriter-scroll-resync",
      target: activeTarget,
      motionId: activeMotionId,
      generation,
      accepted,
      hasCallback: Boolean(onSettled),
      currentScrollTop: activeTarget?.scrollTop ?? null,
      resyncPending,
    });
  }
}

function applyImmediately(target: HTMLElement, deltaY: number): void {
  target.scrollTop = clampScrollTop(target, target.scrollTop + deltaY);
}

/**
 * Start or retarget the one active scroll loop. An active loop keeps its
 * current easing timeline while adopting the newest endpoint, so transient
 * caret geometry cannot repeatedly restart the motion from t=0.
 */
export function scrollTo(
  target: HTMLElement,
  options: ScrollOptions,
  onRetargetSettled?: () => void,
): void {
  const { deltaY } = options;

  if (prefersReducedMotion()) {
    cancel();
    applyImmediately(target, deltaY);
    return;
  }

  const nextDuration = options.duration ?? durationForDistance(Math.abs(deltaY));
  const nextEasing = options.easing ?? easeOutCubic;

  if (activeScrollFrame !== null && activeTarget === target) {
    // Keep startScroll/startTime/duration/easing intact. The current motion
    // should finish naturally; only its endpoint and post-settle resync change.
    const previousEndScroll = endScroll;
    endScroll = target.scrollTop + deltaY;
    resyncPending = true;
    if (onRetargetSettled) retargetSettledCallback = onRetargetSettled;
    if (DEBUG_ENABLED) {
      emitDebug({
        name: "typewriter-scroll-retarget",
        target,
        motionId: activeMotionId,
        generation,
        startScroll,
        previousEndScroll,
        endScroll,
        deltaY,
        duration,
        easing: easing.name || "anonymous",
        startTime,
        elapsedMs: startTime === null ? 0 : performance.now() - startTime,
        currentScrollTop: target.scrollTop,
        resyncPending,
        hasCallback: Boolean(onRetargetSettled),
      });
    }
    return;
  }

  if (activeScrollFrame !== null) cancel();

  const token = ++generation;
  activeTarget = target;
  startScroll = target.scrollTop;
  endScroll = target.scrollTop + deltaY;
  startTime = null;
  duration = nextDuration;
  easing = nextEasing;
  resyncPending = false;
  if (DEBUG_ENABLED) {
    activeMotionId = `tw${++motionSequence}`;
    frameIndex = 0;
    lastObservedScroll = startScroll;
    lastIntendedScroll = startScroll;
  }
  // An initial scroll has no resynchronization callback. Only an active-loop
  // retarget carries a callback for the final geometry check.
  retargetSettledCallback = null;

  const step = (now: number) => {
    if (token !== generation || activeScrollFrame === null || activeTarget === null) return;

    if (startTime === null) startTime = now;
    const elapsed = now - startTime;
    const t = Math.min(elapsed / duration, 1);
    const eased = easing(t);
    const intendedScrollTop = clampScrollTop(
      activeTarget,
      startScroll + (endScroll - startScroll) * eased,
    );
    const observedBefore = DEBUG_ENABLED ? activeTarget.scrollTop : 0;
    activeTarget.scrollTop = intendedScrollTop;
    const observedAfter = DEBUG_ENABLED ? activeTarget.scrollTop : 0;
    if (DEBUG_ENABLED) {
      const previousObserved = lastObservedScroll ?? startScroll;
      const previousIntended = lastIntendedScroll ?? startScroll;
      emitDebug({
        name: "typewriter-scroll-frame",
        target: activeTarget,
        motionId: activeMotionId,
        generation,
        frameIndex,
        frameTimestamp: now,
        elapsedMs: elapsed,
        t,
        eased,
        startScroll,
        endScroll,
        intendedScrollTop,
        observedBefore,
        observedAfter,
        pluginWriteDelta: observedAfter - observedBefore,
        externalDeltaSincePrevious: observedBefore - previousObserved,
        observedDeltaSincePrevious: observedAfter - previousObserved,
        intendedDeltaSincePrevious: intendedScrollTop - previousIntended,
        resyncPending,
      });
      frameIndex += 1;
      lastObservedScroll = observedAfter;
      lastIntendedScroll = intendedScrollTop;
    }

    if (t < 1) {
      activeScrollFrame = requestAnimationFrame(step);
      return;
    }

    const settledTarget = activeTarget;
    const settledMotionId = activeMotionId;
    const settledGeneration = generation;
    const settledStartScroll = startScroll;
    const settledEndScroll = endScroll;
    const settledDuration = duration;
    const settledElapsedMs = elapsed;
    const settledResyncPending = resyncPending;
    activeScrollFrame = null;
    activeTarget = null;
    activeMotionId = null;
    const callback = resyncPending ? retargetSettledCallback : null;
    resyncPending = false;
    retargetSettledCallback = null;
    if (DEBUG_ENABLED) {
      emitDebug({
        name: "typewriter-scroll-end",
        target: settledTarget,
        motionId: settledMotionId,
        generation: settledGeneration,
        startScroll: settledStartScroll,
        endScroll: settledEndScroll,
        duration: settledDuration,
        elapsedMs: settledElapsedMs,
        finalScrollTop: observedAfter,
        resyncPending: settledResyncPending,
        callbackScheduled: Boolean(callback),
      });
      frameIndex = 0;
      lastObservedScroll = null;
      lastIntendedScroll = null;
    }
    if (callback) callback();
  };

  activeScrollFrame = requestAnimationFrame(step);
  if (DEBUG_ENABLED) {
    emitDebug({
      name: "typewriter-scroll-start",
      target,
      motionId: activeMotionId,
      generation,
      startScroll,
      endScroll,
      deltaY,
      duration,
      easing: easing.name || "anonymous",
      startTime,
      currentScrollTop: target.scrollTop,
    });
  }
}
