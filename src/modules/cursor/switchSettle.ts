type SwitchTarget = { x: number; y: number; height: number };

export interface SwitchSettleContext {
  getCursorElement: () => HTMLDivElement | null;
  sampleTarget: () => SwitchTarget | null;
  cancelRemoveTransitionFrame: () => void;
  pauseBreathe: () => void;
  queueUpdate: () => void;
  scheduleResumeBreathe: () => void;
  /** Dev-only DebugKit channel for the settle lifecycle; absent in production. */
  emitDebug?: (details: Record<string, unknown>) => void;
}

let switchSettleFrame: number | null = null;
let switchRevealFrame: number | null = null;
let switchHiddenActive = false;
let switchRevealPending = false;

function hideCursorForSwitch(ctx: SwitchSettleContext): void {
  const el = ctx.getCursorElement();
  if (!el) return;
  ctx.pauseBreathe();
  ctx.cancelRemoveTransitionFrame();
  el.classList.remove("hidden");
  el.classList.remove("no-transition");
  el.classList.add("no-animation");
  switchHiddenActive = true;
  el.style.opacity = "0";
}

export function stopSwitchSettle(): void {
  if (switchSettleFrame !== null) {
    cancelAnimationFrame(switchSettleFrame);
    switchSettleFrame = null;
  }
  if (switchRevealFrame !== null) {
    cancelAnimationFrame(switchRevealFrame);
    switchRevealFrame = null;
  }
  switchRevealPending = false;
  switchHiddenActive = false;
}

function finishAnimatedSwitch(ctx: SwitchSettleContext): void {
  stopSwitchSettle();
  const el = ctx.getCursorElement();
  if (!el) {
    ctx.queueUpdate();
    return;
  }

  el.classList.add("no-transition");
  switchRevealPending = true;
  ctx.queueUpdate();

  switchRevealFrame = requestAnimationFrame(() => {
    switchRevealFrame = null;
    const current = ctx.getCursorElement();
    if (!current) {
      switchRevealPending = false;
      switchHiddenActive = false;
      return;
    }
    void current.offsetHeight;
    switchRevealPending = false;
    switchHiddenActive = false;
    current.classList.remove("no-transition");
    current.classList.remove("no-animation");
    current.style.opacity = "";
    ctx.scheduleResumeBreathe();
    ctx.emitDebug?.({ phase: "revealed" });
  });
}

export function startSwitchSettle(ctx: SwitchSettleContext): void {
  stopSwitchSettle();
  hideCursorForSwitch(ctx);

  let lastTarget = ctx.sampleTarget();
  let stableFrames = 0;
  const startedAt = performance.now();
  const maxDurationMs = 700;
  const stableFrameTarget = 8;
  const epsilonPx = 0.35;
  let firstValidTargetMs: number | null = lastTarget ? 0 : null;
  ctx.emitDebug?.({
    phase: "start",
    maxDurationMs,
    stableFrameTarget,
    epsilonPx,
    hadInitialTarget: lastTarget !== null,
  });

  const finishSettle = (reason: string) => {
    ctx.emitDebug?.({
      phase: "finish",
      reason,
      elapsedMs: Math.round(performance.now() - startedAt),
      stableFrames,
      firstValidTargetMs: firstValidTargetMs === null ? null : Math.round(firstValidTargetMs),
    });
    finishAnimatedSwitch(ctx);
  };

  const tick = () => {
    switchSettleFrame = null;

    const elapsedMs = performance.now() - startedAt;
    const target = ctx.sampleTarget();
    if (!target) {
      if (elapsedMs >= maxDurationMs) {
        finishSettle("max-duration-no-target");
        return;
      }
      switchSettleFrame = requestAnimationFrame(tick);
      return;
    }
    if (firstValidTargetMs === null) firstValidTargetMs = elapsedMs;

    const targetMoved =
      lastTarget === null ||
      Math.abs(target.x - lastTarget.x) > epsilonPx ||
      Math.abs(target.y - lastTarget.y) > epsilonPx ||
      Math.abs(target.height - lastTarget.height) > epsilonPx;

    stableFrames = targetMoved ? 0 : stableFrames + 1;
    lastTarget = target;

    // Readiness = the sampled caret target has held still for a full
    // stability window (any layout or selection shift resets the count);
    // the elapsed cap stays as the fail-open. No fixed delay floor.
    if (
      elapsedMs >= maxDurationMs ||
      stableFrames >= stableFrameTarget
    ) {
      finishSettle(elapsedMs >= maxDurationMs ? "max-duration" : "stable");
      return;
    }

    switchSettleFrame = requestAnimationFrame(tick);
  };

  switchSettleFrame = requestAnimationFrame(tick);
}

export function isSwitchHiddenActive(): boolean {
  return switchHiddenActive;
}

export function isSwitchRevealPending(): boolean {
  return switchRevealPending;
}
