import { TYPEWRITER_CONFIG } from "../../config";
import { prefersReducedMotion } from "../../utils/reducedMotion";

const { SCROLL_DURATION_TIERS } = TYPEWRITER_CONFIG;

export interface ScrollOptions {
  deltaY: number;
  duration?: number;
  easing?: (t: number) => number;
}

let activeScrollFrame: number | null = null;
let activeTarget: HTMLElement | null = null;
let startScroll = 0;
let endScroll = 0;
let startTime = 0;
let duration = 0;
let easing: (t: number) => number = easeOutCubic;
let generation = 0;
let onSettled: (() => void) | null = null;

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
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
  startTime = 0;
  duration = 0;
  onSettled = null;
}

export function isScrolling(): boolean {
  return activeScrollFrame !== null;
}

export function cancel(): void {
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

function applyImmediately(target: HTMLElement, deltaY: number): void {
  target.scrollTop = clampScrollTop(target, target.scrollTop + deltaY);
}

/**
 * Start or retarget the one active scroll loop. Retargeting samples the
 * current scrollTop so a new caret position never restarts from stale state.
 */
export function scrollTo(
  target: HTMLElement,
  options: ScrollOptions,
  settled?: () => void,
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
    startScroll = target.scrollTop;
    endScroll = target.scrollTop + deltaY;
    startTime = performance.now();
    duration = nextDuration;
    easing = nextEasing;
    onSettled = settled ?? null;
    return;
  }

  if (activeScrollFrame !== null) cancel();

  const token = ++generation;
  activeTarget = target;
  startScroll = target.scrollTop;
  endScroll = target.scrollTop + deltaY;
  startTime = performance.now();
  duration = nextDuration;
  easing = nextEasing;
  onSettled = null;

  const step = (now: number) => {
    if (token !== generation || activeScrollFrame === null || activeTarget === null) return;

    const elapsed = now - startTime;
    const t = Math.min(elapsed / duration, 1);
    const eased = easing(t);
    activeTarget.scrollTop = clampScrollTop(
      activeTarget,
      startScroll + (endScroll - startScroll) * eased,
    );

    if (t < 1) {
      activeScrollFrame = requestAnimationFrame(step);
      return;
    }

    activeScrollFrame = null;
    activeTarget = null;
    const callback = onSettled;
    onSettled = null;
    if (callback) callback();
  };

  activeScrollFrame = requestAnimationFrame(step);
}
