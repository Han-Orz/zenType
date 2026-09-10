import { MOTION } from "../config";
import { clamp, stepCritical, type CriticalState } from "../motion";
import type { CursorRect, EditorFrame } from "../types";
import type { DebugRecord, DebugRecorder } from "../debug/types";

interface CursorMotion {
  x: CriticalState;
  y: CriticalState;
  height: CriticalState;
}

export function createCursor(debug?: DebugRecorder) {
  const element = document.createElement("div");
  element.id = "zentype-cursor";
  element.hidden = true;
  element.setAttribute("aria-hidden", "true");
  const ink = document.createElement("div");
  ink.className = "zentype-cursor-ink";
  element.append(ink);
  document.body.append(element);
  let owner: HTMLElement | null = null;
  let editor: HTMLElement | null = null;
  let motion: CursorMotion | null = null;
  let target: CursorRect | null = null;
  let lastTime = 0;
  let lastValid = -Infinity;
  let lastMotion = 0;
  const alpha: CriticalState = { value: 0, velocity: 0 };
  let alphaTarget = 1;
  let selecting = false;
  let settleUntil = 0;
  let stableFrames = 0;
  let revealPending = false;
  let breathLow = false;
  let breathWake = 0;
  let transport = { top: 0, left: 0 };
  let nestedScroll: EditorFrame["nestedScroll"] = [];

  function debugState(name: string, frame: EditorFrame | null, data: DebugRecord = {}) {
    ZENTYPE_DEBUG: debug?.record("cursor", name, {
      selection: frame?.selection ?? "missing",
      caret: !!frame?.caret,
      caretless: frame?.caretless === true,
      hidden: element.hidden,
      alpha: alpha.value,
      owner: owner !== null,
      breathing: breathLow,
      settling: settleUntil !== 0 || revealPending,
      revealPending,
      stableFrames,
      currentX: motion?.x.value ?? null,
      currentY: motion?.y.value ?? null,
      targetX: target?.x ?? null,
      targetY: target?.y ?? null,
      ...data,
    });
  }

  function createMotion(rect: CursorRect): CursorMotion {
    return {
      x: { value: rect.x, velocity: 0 },
      y: { value: rect.y, velocity: 0 },
      height: { value: rect.height, velocity: 0 },
    };
  }

  function resetBreathing() {
    breathLow = false;
    breathWake = 0;
    alphaTarget = 1;
  }

  function bindOwner(next: HTMLElement | null) {
    if (owner === next) return false;
    owner?.classList.remove("zentype-custom-caret-active");
    owner = next;
    owner?.classList.add("zentype-custom-caret-active");
    return true;
  }

  function clearSettling() {
    settleUntil = 0;
    stableFrames = 0;
    revealPending = false;
  }

  function hide(preserveOwner = false) {
    if (!preserveOwner) {
      bindOwner(null);
      editor = null;
    }
    motion = target = null;
    lastTime = 0;
    alpha.value = 0;
    alpha.velocity = 0;
    resetBreathing();
    selecting = false;
    clearSettling();
    nestedScroll = [];
    element.hidden = true;
  }

  function render(frame: EditorFrame, now: number, typing: boolean, interacting = false): boolean {
    if (editor !== frame.editor) {
      hide();
      editor = frame.editor;
      ZENTYPE_DEBUG: debugState("editor-change", frame, { now });
    }
    const ownerChanged = bindOwner(frame.editable);
    revealPending = false;
    // Transport the last displayed cursor before approaching the authoritative target.
    const offset = { top: frame.origin.y - frame.scrollTop, left: frame.origin.x - frame.scrollLeft };
    if (motion && target) {
      let dx = offset.left - transport.left;
      let dy = offset.top - transport.top;
      for (const next of frame.nestedScroll) {
        const previous = nestedScroll.find(item => item.element === next.element);
        if (previous) { dx -= next.left - previous.left; dy -= next.top - previous.top; }
      }
      motion.x.value += dx; motion.y.value += dy;
      target.x += dx; target.y += dy;
    }
    transport = offset;
    nestedScroll = frame.nestedScroll;
    if (settleUntil !== 0) {
      // A missing sample breaks the stable run; the existing Session frame loop
      // remains bounded by the active settle deadline.
      const next = frame.caret && { ...frame.caret, y: frame.caret.y - (frame.caretLift ?? MOTION.caretLiftPx) };
      if (next) lastValid = now;
      stableFrames = next ? target && Math.hypot(next.x - target.x, next.y - target.y) <= MOTION.cursorSettlePx &&
        Math.abs(next.height - target.height) <= MOTION.cursorSettlePx ? stableFrames + 1 : 1 : 0;
      target = next;
      const settled = frame.reducedMotion || now >= settleUntil ||
        stableFrames >= MOTION.switchStableFrames;
      if (!settled) {
        ZENTYPE_DEBUG: debugState("switch-settling", frame, { now });
        return true;
      }
      ZENTYPE_DEBUG: debugState("switch-settled", frame, { now, deadline: now >= settleUntil });
      clearSettling();
      // Commit the stable geometry while still hidden. The next Session frame
      // reveals it, so themed tab layout cannot paint one frame at an old origin.
      if (target && !frame.reducedMotion) revealPending = true;
    }
    const elapsed = lastTime ? Math.min(MOTION.maxFrameDeltaMs, now - lastTime) : 16;
    if (frame.caret) {
      lastValid = now;
      target = { ...frame.caret, y: frame.caret.y - (frame.caretLift ?? MOTION.caretLiftPx) };
    } else if (frame.caretless) {
      // The caret is on a block with no text position (separator, image). Fade at
      // once rather than freezing the overlay on the previous line for a budget.
      return fadeOut(now, frame.reducedMotion, "caretless");
    } else if (!motion && alpha.value === 0) {
      hide(true);
      return false;
    } else if (now - lastValid > MOTION.recoveryMs) {
      // The host cannot measure this caret (a separator, an image block, a
      // boundary with no rectangle). Fading out beats freezing the overlay at a
      // position that is no longer the caret: the user asked for a smooth
      // disappearance rather than a misplaced cursor.
      return fadeOut(now, frame.reducedMotion, "missing-geometry");
    }
    if (!target) {
      ZENTYPE_DEBUG: debugState("render-without-target", frame, { now });
      return false;
    }
    lastTime = now;
    if (!motion) {
      motion = createMotion(target);
      lastMotion = now;
      selecting = false;
      // A release/selection fade is a presentation transition, not a new
      // visibility owner. A fresh authoritative caret always reveals normally.
      alphaTarget = 1;
      breathLow = false;
      breathWake = 0;
    }
    const distance = Math.hypot(motion.x.value - target.x, motion.y.value - target.y);
    const response = frame.reducedMotion ? 0 : (typing ? MOTION.caretTypingResponse95Ms :
      MOTION.caretNavigationResponse95Ms + Math.min(120, distance * 0.3));
    const moving = !stepCritical(motion.x, target.x, elapsed, response, MOTION.cursorSettlePx) ||
      !stepCritical(motion.y, target.y, elapsed, response, MOTION.cursorSettlePx) ||
      !stepCritical(motion.height, target.height, elapsed, response, MOTION.cursorSettlePx);
    if (moving || typing || interacting) lastMotion = now;
    const view = frame.viewport;
    const edge = Math.min(motion.y.value + motion.height.value - view.top, view.bottom - motion.y.value);
    const visible = motion.x.value >= view.left && motion.x.value <= view.right && edge > 0;
    const breathing = !frame.reducedMotion && !typing && !interacting && !moving && now - lastMotion >= MOTION.breatheDelayMs;
    if (frame.reducedMotion || typing || interacting || moving) {
      breathLow = false;
      breathWake = 0;
      alphaTarget = 1;
    } else if (!breathLow && alphaTarget === 1 && breathing) {
      breathLow = true;
      alphaTarget = MOTION.breatheLowAlpha;
      breathWake = now + MOTION.breatheLowHoldMs;
    } else if (breathLow && now >= breathWake) {
      breathLow = false;
      alphaTarget = 1;
      breathWake = 0;
      lastMotion = now;
    }
    const alphaResponse = frame.reducedMotion ? 0 : alphaTarget < 1
      ? MOTION.cursorDisappearResponse95Ms : MOTION.cursorAppearResponse95Ms;
    const alphaSettled = stepCritical(alpha, alphaTarget, elapsed, alphaResponse, MOTION.alphaSettleEpsilon);
    if (alpha.value < 0 || alpha.value > 1) {
      alpha.value = clamp(alpha.value, 0, 1);
      alpha.velocity = 0;
    }
    element.style.opacity = String(visible ? alpha.value * clamp(edge / Math.max(MOTION.edgeFadeMinHeightPx, motion.height.value), 0, 1) : 0);
    element.style.transform = "translate3d(" + motion.x.value + "px," + motion.y.value + "px,0)";
    element.style.height = motion.height.value + "px";
    element.style.clipPath = "inset(" + Math.max(0, view.top - motion.y.value) + "px 0 " + Math.max(0, motion.y.value + motion.height.value - view.bottom) + "px 0)";
    element.style.zIndex = String(frame.zIndex);
    if (!revealPending) element.hidden = false;
    ZENTYPE_DEBUG: debugState("render", frame, {
      now,
      moving,
      typing,
      interacting,
      breathing,
      visible,
      ownerChanged,
      edge,
    });
    if (!moving && alphaSettled && alphaTarget === 1) lastTime = 0;
    return moving || !alphaSettled || revealPending;
  }

  /** Fade only the overlay; valid editor bindings keep native caret suppressed. */
  function fadeOut(now: number, reducedMotion: boolean, reason = "release"): boolean {
    alphaTarget = 0;
    breathLow = false;
    breathWake = 0;
    const elapsed = lastTime ? Math.min(MOTION.maxFrameDeltaMs, now - lastTime) : 16;
    lastTime = now;
    const settled = stepCritical(alpha, 0, elapsed, reducedMotion ? 0 : MOTION.cursorDisappearResponse95Ms,
      MOTION.alphaSettleEpsilon);
    if (alpha.value < 0) { alpha.value = 0; alpha.velocity = 0; }
    element.style.opacity = String(alpha.value);
    motion = target = null;
    ZENTYPE_DEBUG: debugState("fade-out", null, { now, reason, fading: !settled });
    if (settled) { hide(true); return false; }
    return true;
  }

  return { render, hide,
    /** Binding may change while Session withholds a new visual target. */
    retainOwner(editable: HTMLElement | null) { bindOwner(editable); lastTime = 0; },
    /**
     * Release presentation without a selection involved (no measurable caret, no
     * valid host frame). Fading keeps the transition smooth instead of the cursor
     * vanishing between two frames.
     */
    release(now: number, reducedMotion: boolean) {
      clearSettling();
      if (element.hidden) { hide(); return false; }
      const fading = fadeOut(now, reducedMotion, "release");
      bindOwner(null);
      return fading;
    },
    yieldSelection(now: number, reducedMotion: boolean, editable: HTMLElement | null = owner) {
      clearSettling();
      if (!selecting) {
        // Already released: nothing to fade, and sampling the ink here would
        // force a style read on every frame a selection stays open.
        if (element.hidden) { hide(true); bindOwner(editable); return false; }
        // alpha already holds the logical overlay alpha; sampling the clipped
        // element opacity would restart the fade from an edge product.
        selecting = true;
        lastTime = 0;
      }
      const fading = fadeOut(now, reducedMotion, "selection");
      bindOwner(editable);
      return fading;
    },
    wakeDelay(now: number) {
      if (!motion) return null;
      const wake = breathLow ? breathWake : lastMotion + MOTION.breatheDelayMs;
      return Math.max(1, wake + MOTION.breatheWakeMarginMs - now);
    },
    recoveryDelay(now: number) {
      return motion ? Math.max(1, lastValid + MOTION.recoveryMs + 1 - now) : null;
    },
    /** True while the overlay waits out a switched editor's animation. */
    isSettling() { return settleUntil !== 0 || revealPending; },
    /**
     * The host switched editor (tab, split, popup). Themed switch animations keep
     * moving the caret geometry. Reveal after consecutive stable samples, bounded
     * by a deadline, using the Session's existing frame clock and scheduler.
     */
    switched(nextEditor: HTMLElement, now: number) {
      hide();
      editor = nextEditor;
      settleUntil = now + MOTION.switchSettleMs;
      ZENTYPE_DEBUG: debug?.record("cursor", "switch-start", { settleMs: MOTION.switchSettleMs });
    },
    destroy() { hide(); element.remove(); } };
}
