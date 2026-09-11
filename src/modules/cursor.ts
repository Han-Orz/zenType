import { MOTION } from "../config";
import { clamp, stepCritical, type CriticalState } from "../motion";
import type { CursorRect, EditorFrame } from "../types";
import type { DebugRecord, DebugRecorder } from "../debug/types";

interface CursorMotion {
  x: CriticalState;
  y: CriticalState;
  height: CriticalState;
}

export type CursorIntent = "typing" | "navigation" | "structural";
type BreathPhase = "normal" | "down" | "hold" | "up";
type SwitchRevealPhase = "none" | "pending" | "active";
interface CursorRenderOptions {
  authoritativeTarget?: boolean;
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
  let lastTime: number | null = null;
  let lastValid = -Infinity;
  let lastMotion = 0;
  // Separate geometry settling from render's broader presentation-work result.
  let targetMoving = false;
  const alpha: CriticalState = { value: 0, velocity: 0 };
  let alphaTarget = 1;
  let selecting = false;
  let settleUntil = 0;
  let stableFrames = 0;
  let switchRevealPhase: SwitchRevealPhase = "none";
  let breathPhase: BreathPhase = "normal";
  // In normal this is the next down deadline after a completed cycle; in hold
  // it is the low-alpha hold deadline. Zero means first idle delay is derived
  // from lastMotion instead of being an active semantic deadline.
  let breathDeadline = 0;
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
      alphaVelocity: alpha.velocity,
      breathing: breathPhase !== "normal",
      breathPhase,
      settling: settleUntil !== 0 || switchRevealPhase !== "none",
      revealPending: switchRevealPhase === "pending",
      revealPhase: switchRevealPhase,
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
    breathPhase = "normal";
    breathDeadline = 0;
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
    switchRevealPhase = "none";
  }

  function hide(preserveOwner = false) {
    if (!preserveOwner) {
      bindOwner(null);
      editor = null;
    }
    motion = target = null;
    targetMoving = false;
    lastTime = null;
    alpha.value = 0;
    alpha.velocity = 0;
    resetBreathing();
    selecting = false;
    clearSettling();
    nestedScroll = [];
    element.hidden = true;
  }

  function render(frame: EditorFrame, now: number, intent: CursorIntent, interacting = false,
    options: CursorRenderOptions = {}): boolean {
    const isTyping = intent === "typing";
    const authoritativeTarget = options.authoritativeTarget === true && frame.caret !== null;
    if (editor !== frame.editor) {
      hide();
      editor = frame.editor;
      ZENTYPE_DEBUG: debugState("editor-change", frame, { now });
    }
    const ownerChanged = bindOwner(frame.editable);
    // Transport the last displayed cursor before approaching the authoritative target.
    const offset = { top: frame.origin.y - frame.scrollTop, left: frame.origin.x - frame.scrollLeft };
    let transportDx = 0;
    let transportDy = 0;
    let transportApplied = false;
    if (motion && target && !authoritativeTarget) {
      let dx = offset.left - transport.left;
      let dy = offset.top - transport.top;
      for (const next of frame.nestedScroll) {
        const previous = nestedScroll.find(item => item.element === next.element);
        if (previous) { dx -= next.left - previous.left; dy -= next.top - previous.top; }
      }
      transportDx = dx;
      transportDy = dy;
      transportApplied = dx !== 0 || dy !== 0;
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
      settleUntil = 0;
      stableFrames = 0;
      // Commit stable geometry in a hidden, fully-rested state. The next
      // Session frame is the first frame allowed to start the reveal clock.
      if (target && !frame.reducedMotion) {
        motion = createMotion(target);
        lastMotion = now;
        lastTime = null;
        alpha.value = 0;
        alpha.velocity = 0;
        resetBreathing();
        switchRevealPhase = "pending";
        const view = frame.viewport;
        element.style.opacity = "0";
        element.style.transform = "translate3d(" + motion.x.value + "px," + motion.y.value + "px,0)";
        element.style.height = motion.height.value + "px";
        element.style.clipPath = "inset(" + Math.max(0, view.top - motion.y.value) + "px 0 " +
          Math.max(0, motion.y.value + motion.height.value - view.bottom) + "px 0)";
        element.style.zIndex = String(frame.zIndex);
        element.hidden = true;
        ZENTYPE_DEBUG: debugState("switch-commit-hidden", frame, { now, revealElapsed: 0 });
        return true;
      }
      switchRevealPhase = "none";
    }
    const startingSwitchReveal = switchRevealPhase === "pending";
    if (startingSwitchReveal) switchRevealPhase = "active";
    const previousMotionTime = lastTime;
    const motionClockInactive = previousMotionTime === null;
    const elapsed = motionClockInactive ? 16 : Math.max(0, now - previousMotionTime);
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
    if (!motion) {
      motion = createMotion(target);
      lastMotion = now;
      selecting = false;
      // A release/selection fade is a presentation transition, not a new
      // visibility owner. A fresh authoritative caret always reveals normally.
      resetBreathing();
    }
    const distance = Math.hypot(motion.x.value - target.x, motion.y.value - target.y);
    const navigationResponse = MOTION.caretNavigationResponseMs + Math.min(120, distance * 0.3);
    let response: number;
    if (frame.reducedMotion) response = 0;
    else if (intent === "typing") response = MOTION.caretTypingResponseMs;
    else if (intent === "structural") response = navigationResponse;
    else response = navigationResponse;
    const xSettled = stepCritical(motion.x, target.x, elapsed, response, MOTION.cursorSettlePx);
    const ySettled = stepCritical(motion.y, target.y, elapsed, response, MOTION.cursorSettlePx);
    const heightSettled = stepCritical(motion.height, target.height, elapsed, response, MOTION.cursorSettlePx);
    const moving = !(xSettled && ySettled && heightSettled);
    targetMoving = moving;
    if (moving || isTyping || interacting) lastMotion = now;
    const view = frame.viewport;
    const edge = Math.min(motion.y.value + motion.height.value - view.top, view.bottom - motion.y.value);
    const visible = motion.x.value >= view.left && motion.x.value <= view.right && edge > 0;
    const idleDeadline = breathDeadline || lastMotion + MOTION.breatheIdleDelayMs;
    const idleReady = breathPhase === "normal" && !frame.reducedMotion && !isTyping && !interacting && !moving &&
      now >= idleDeadline;
    let alphaPhaseChanged = false;
    if (frame.reducedMotion || isTyping || interacting || moving) {
      breathPhase = "normal";
      breathDeadline = 0;
      if (alphaTarget !== 1) {
        alphaTarget = 1;
        alphaPhaseChanged = true;
      }
    } else if (idleReady) {
      breathPhase = "down";
      alphaTarget = MOTION.breatheLowAlpha;
      // The hold starts only after the down motion settles, not at phase entry.
      breathDeadline = 0;
      alphaPhaseChanged = true;
    } else if (breathPhase === "hold" && now >= breathDeadline) {
      breathPhase = "up";
      alphaTarget = 1;
      breathDeadline = 0;
      alphaPhaseChanged = true;
    }
    const alphaResponse = frame.reducedMotion ? 0 : breathPhase === "down"
      ? MOTION.breathDownResponseMs : breathPhase === "up"
        ? MOTION.breathUpResponseMs : alphaTarget < 1
          ? MOTION.cursorDisappearResponseMs : MOTION.cursorAppearResponseMs;
    // A phase entered after an inactive semantic deadline starts at its own
    // baseline; hold/rest time never becomes Critical Motion elapsed.
    const alphaElapsed = startingSwitchReveal ? 0 : alphaPhaseChanged && motionClockInactive ? 0 : elapsed;
    const alphaSettled = breathPhase === "hold" ? true :
      stepCritical(alpha, alphaTarget, alphaElapsed, alphaResponse, MOTION.alphaSettleEpsilon);
    if (breathPhase === "down" && alphaSettled) {
      breathPhase = "hold";
      breathDeadline = now + MOTION.breatheLowHoldMs;
    } else if (breathPhase === "up" && alphaSettled) {
      breathPhase = "normal";
      breathDeadline = now + MOTION.breatheRestMs;
    }
    if (switchRevealPhase === "active" && alphaSettled) switchRevealPhase = "none";
    if (alpha.value < 0 || alpha.value > 1) {
      alpha.value = clamp(alpha.value, 0, 1);
      alpha.velocity = 0;
    }
    element.style.opacity = String(visible ? alpha.value * clamp(edge / Math.max(MOTION.edgeFadeMinHeightPx, motion.height.value), 0, 1) : 0);
    element.style.transform = "translate3d(" + motion.x.value + "px," + motion.y.value + "px,0)";
    element.style.height = motion.height.value + "px";
    element.style.clipPath = "inset(" + Math.max(0, view.top - motion.y.value) + "px 0 " + Math.max(0, motion.y.value + motion.height.value - view.bottom) + "px 0)";
    element.style.zIndex = String(frame.zIndex);
    if (switchRevealPhase !== "pending") element.hidden = false;
    ZENTYPE_DEBUG: debugState("render", frame, {
      now,
      moving,
      intent,
      xVelocity: motion.x.velocity,
      yVelocity: motion.y.velocity,
      heightVelocity: motion.height.velocity,
      interacting,
      breathReady: idleReady,
      revealElapsed: switchRevealPhase === "active" ? alphaElapsed : null,
      visible,
      ownerChanged,
      edge,
      targetAuthority: authoritativeTarget ? "fresh" : "carry",
      transportDx,
      transportDy,
      transportApplied,
    });
    if (!moving && alphaSettled) lastTime = null;
    else lastTime = now;
    // A zero-duration low phase is handed to the next existing Session frame,
    // not to a new wake timer. That frame advances hold -> up immediately.
    const zeroHoldHandoff = breathPhase === "hold" && MOTION.breatheLowHoldMs === 0;
    return moving || !alphaSettled || switchRevealPhase !== "none" || zeroHoldHandoff;
  }

  /** Fade only the overlay; valid editor bindings keep native caret suppressed. */
  function fadeOut(now: number, reducedMotion: boolean, reason = "release"): boolean {
    const fromSemanticHold = breathPhase === "hold" && lastTime === null;
    alphaTarget = 0;
    breathPhase = "normal";
    breathDeadline = 0;
    // An ordinary first fade frame gets the same small initial interval as a
    // fresh render. A settled breath hold, however, must not spend its hold
    // time on the new fade phase.
    const elapsed = lastTime === null ? (fromSemanticHold ? 0 : 16) : Math.max(0, now - lastTime);
    clearSettling();
    const settled = stepCritical(alpha, 0, elapsed, reducedMotion ? 0 : MOTION.cursorDisappearResponseMs,
      MOTION.alphaSettleEpsilon);
    lastTime = settled ? null : now;
    if (alpha.value < 0) { alpha.value = 0; alpha.velocity = 0; }
    element.style.opacity = String(alpha.value);
    motion = target = null;
    targetMoving = false;
    ZENTYPE_DEBUG: debugState("fade-out", null, { now, reason, fading: !settled });
    if (settled) { hide(true); return false; }
    return true;
  }

  return { render, hide,
    /** Binding may change while Session withholds a new visual target. */
    retainOwner(editable: HTMLElement | null) { bindOwner(editable); lastTime = null; },
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
        lastTime = null;
      }
      const fading = fadeOut(now, reducedMotion, "selection");
      bindOwner(editable);
      return fading;
    },
    wakeDelay(now: number) {
      if (!motion) return null;
      if (breathPhase === "down" || breathPhase === "up") return null;
      if (breathPhase === "hold" && MOTION.breatheLowHoldMs === 0) return null;
      const wake = breathDeadline || lastMotion + MOTION.breatheIdleDelayMs;
      return Math.max(1, wake - now);
    },
    recoveryDelay(now: number) {
      return motion ? Math.max(1, lastValid + MOTION.recoveryMs + 1 - now) : null;
    },
    /** True while the overlay waits out a switched editor's animation. */
    isSettling() { return settleUntil !== 0 || switchRevealPhase !== "none"; },
    /** True when the current caret target's x/y/height motion has settled. */
    isTargetSettled() { return !targetMoving; },
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
