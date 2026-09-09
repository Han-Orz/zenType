import { MOTION } from "../config";
import { approach, clamp } from "../motion";
import type { CursorRect, EditorFrame } from "../types";
import type { DebugRecord, DebugRecorder } from "../debug/types";

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
  let current: CursorRect | null = null;
  let target: CursorRect | null = null;
  let lastTime = 0;
  let lastValid = -Infinity;
  let lastMotion = 0;
  let alpha = 0;
  let selecting = false;
  let settleUntil = 0;
  let stableFrames = 0;
  let settleMode: "switch" | "structure" | null = null;
  let structureReady = true;
  let brighten: Animation | null = null;
  let transport = { top: 0, left: 0 };
  let nestedScroll: EditorFrame["nestedScroll"] = [];

  function debugState(name: string, frame: EditorFrame | null, data: DebugRecord = {}) {
    debug?.record("cursor", name, {
      selection: frame?.selection ?? "missing",
      caret: !!frame?.caret,
      caretless: frame?.caretless === true,
      hidden: element.hidden,
      alpha,
      owner: owner !== null,
      breathing: ink.classList.contains("zentype-breathing"),
      settling: settleUntil !== 0,
      stableFrames,
      currentX: current?.x ?? null,
      currentY: current?.y ?? null,
      targetX: target?.x ?? null,
      targetY: target?.y ?? null,
      ...data,
    });
  }

  function breathe(enabled: boolean, reducedMotion: boolean) {
    const active = ink.classList.contains("zentype-breathing");
    if (enabled === active) return;
    const opacity = active ? getComputedStyle(ink).opacity : "1";
    brighten?.cancel();
    brighten = null;
    ink.classList.toggle("zentype-breathing", enabled);
    ink.style.opacity = "1";
    if (active && !reducedMotion) {
      brighten = ink.animate([{ opacity }, { opacity: 1 }], { duration: MOTION.caretBrightenMs, easing: "ease-out" });
    }
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
    settleMode = null;
    structureReady = true;
  }

  function hide(preserveOwner = false) {
    if (!preserveOwner) {
      bindOwner(null);
      editor = null;
    }
    current = target = null;
    lastTime = 0;
    alpha = 0;
    selecting = false;
    clearSettling();
    brighten?.cancel();
    brighten = null;
    ink.style.opacity = "1";
    nestedScroll = [];
    element.hidden = true;
    ink.classList.remove("zentype-breathing");
  }

  function render(frame: EditorFrame, now: number, typing: boolean, interacting = false): boolean {
    if (editor !== frame.editor) {
      hide();
      editor = frame.editor;
      debugState("editor-change", frame, { now });
    }
    const ownerChanged = bindOwner(frame.editable);
    // Transport the last displayed cursor before checking a new geometry
    // sample. Structural settling keeps the old presentation in place, but a
    // host scroll during that short window must still move it with the page.
    const offset = { top: frame.origin.y - frame.scrollTop, left: frame.origin.x - frame.scrollLeft };
    if (current && target) {
      let dx = offset.left - transport.left;
      let dy = offset.top - transport.top;
      for (const next of frame.nestedScroll) {
        const previous = nestedScroll.find(item => item.element === next.element);
        if (previous) { dx -= next.left - previous.left; dy -= next.top - previous.top; }
      }
      current.x += dx; current.y += dy;
      target.x += dx; target.y += dy;
    }
    transport = offset;
    nestedScroll = frame.nestedScroll;
    if (settleUntil !== 0) {
      // A missing sample breaks the stable run; the existing Session frame loop
      // remains bounded by the active settle deadline.
      const next = frame.caret && { ...frame.caret, y: frame.caret.y - (frame.caretLift ?? MOTION.caretLiftPx) };
      if (next) lastValid = now;
      stableFrames = next ? target && Math.hypot(next.x - target.x, next.y - target.y) <= 0.15 &&
        Math.abs(next.height - target.height) <= 0.15 ? stableFrames + 1 : 1 : 0;
      target = next;
      const threshold = settleMode === "structure" ? MOTION.structuralStableFrames : MOTION.switchStableFrames;
      const settled = frame.reducedMotion || now >= settleUntil ||
        (settleMode !== "structure" || structureReady) && stableFrames >= threshold;
      if (!settled) {
        debugState(settleMode === "structure" ? "structure-settling" : "switch-settling", frame, { now });
        return true;
      }
      const mode = settleMode;
      debugState(mode === "structure" ? "structure-settled" : "switch-settled", frame,
        { now, deadline: now >= settleUntil, structureReady });
      clearSettling();
      if (mode === "switch" && target && !frame.reducedMotion) {
        brighten = ink.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: MOTION.caretBrightenMs, easing: "ease-in-out",
        });
      }
    }
    const elapsed = lastTime ? Math.min(MOTION.maxFrameDeltaMs, now - lastTime) : 16;
    if (frame.caret) {
      lastValid = now;
      target = { ...frame.caret, y: frame.caret.y - (frame.caretLift ?? MOTION.caretLiftPx) };
    } else if (frame.caretless) {
      // The caret is on a block with no text position (separator, image). Fade at
      // once rather than freezing the overlay on the previous line for a budget.
      return fadeOut(now, frame.reducedMotion, "caretless");
    } else if (!current && alpha === 0) {
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
      debugState("render-without-target", frame, { now });
      return false;
    }
    lastTime = now;
    if (!current) {
      current = { ...target }; lastMotion = now;
      if (selecting && !frame.reducedMotion) {
        brighten = ink.animate([{ opacity: ink.style.opacity }, { opacity: 1 }], {
          duration: MOTION.caretBrightenMs, easing: "ease-out",
        });
      }
      selecting = false;
      ink.style.opacity = "1";
    }
    const distance = Math.hypot(current.x - target.x, current.y - target.y);
    const response = frame.reducedMotion ? 0 : (typing ? MOTION.caretTypingMs :
      MOTION.caretNavigationMs + Math.min(120, distance * 0.3)) / 3;
    current.x = approach(current.x, target.x, elapsed, response);
    current.y = approach(current.y, target.y, elapsed, response);
    current.height = approach(current.height, target.height, elapsed, response);
    const moving = Math.hypot(current.x - target.x, current.y - target.y) > 0.15 || Math.abs(current.height - target.height) > 0.15;
    if (moving || typing || interacting) lastMotion = now;
    if (!moving) current = { ...target };
    const view = frame.viewport;
    const edge = Math.min(current.y + current.height - view.top, view.bottom - current.y);
    const visible = current.x >= view.left && current.x <= view.right && edge > 0;
    const breathing = !frame.reducedMotion && !typing && !interacting && !moving && now - lastMotion >= MOTION.breatheDelayMs;
    breathe(breathing, frame.reducedMotion);
    alpha = approach(alpha, 1, elapsed, frame.reducedMotion ? 0 : MOTION.caretFadeInMs / 3);
    if (alpha > 0.995) alpha = 1;
    element.style.opacity = String(visible ? alpha * clamp(edge / Math.max(MOTION.edgeFadeMinHeightPx, current.height), 0, 1) : 0);
    element.style.transform = "translate3d(" + current.x + "px," + current.y + "px,0)";
    element.style.height = current.height + "px";
    element.style.clipPath = "inset(" + Math.max(0, view.top - current.y) + "px 0 " + Math.max(0, current.y + current.height - view.bottom) + "px 0)";
    element.style.zIndex = String(frame.zIndex);
    element.hidden = false;
    debugState("render", frame, {
      now,
      moving,
      typing,
      interacting,
      breathing,
      visible,
      ownerChanged,
      edge,
    });
    if (!moving && alpha === 1) lastTime = 0;
    return moving || alpha < 1;
  }

  /** Fade only the overlay; valid editor bindings keep native caret suppressed. */
  function fadeOut(now: number, reducedMotion: boolean, reason = "release"): boolean {
    if (current) {
      // Freeze displayed ink once so geometry loss cannot brighten a breathing
      // cursor before fading it. Subsequent fade frames do not read styles.
      const opacity = brighten || ink.classList.contains("zentype-breathing")
        ? getComputedStyle(ink).opacity : ink.style.opacity;
      brighten?.cancel();
      brighten = null;
      ink.classList.remove("zentype-breathing");
      ink.style.opacity = opacity;
      lastTime = 0;
    }
    const elapsed = lastTime ? Math.min(MOTION.maxFrameDeltaMs, now - lastTime) : 16;
    lastTime = now;
    alpha = approach(alpha, 0, elapsed, reducedMotion ? 0 : MOTION.caretFadeOutMs / 3);
    element.style.opacity = String(alpha);
    current = target = null;
    debugState("fade-out", null, { now, reason, fading: alpha >= 0.005 });
    if (alpha < 0.005) { hide(true); return false; }
    return true;
  }

  return { render, hide,
    /**
     * Release presentation without a selection involved (no measurable caret, no
     * valid host frame). Fading keeps the transition smooth instead of the cursor
     * vanishing between two frames.
     */
    release(now: number, reducedMotion: boolean) {
      clearSettling();
      bindOwner(null);
      if (element.hidden) { hide(); return false; }
      return fadeOut(now, reducedMotion, "release");
    },
    yieldSelection(now: number, reducedMotion: boolean, editable: HTMLElement | null = owner) {
      clearSettling();
      bindOwner(editable);
      if (!selecting) {
        // Already released: nothing to fade, and sampling the ink here would
        // force a style read on every frame a selection stays open.
        if (element.hidden) { hide(true); return false; }
        // alpha already holds the logical overlay alpha; sampling
        // element.style.opacity here would restart the fade from the clipped
        // edge-fade product instead of from the displayed cursor.
        selecting = true;
        lastTime = 0;
      }
      return fadeOut(now, reducedMotion, "selection");
    },
    wakeDelay(now: number) {
      return current && !ink.classList.contains("zentype-breathing")
        ? Math.max(1, lastMotion + MOTION.breatheDelayMs + MOTION.breatheWakeMarginMs - now) : null;
    },
    recoveryDelay(now: number) {
      return current ? Math.max(1, lastValid + MOTION.recoveryMs + 1 - now) : null;
    },
    /** True while the overlay waits out a switched editor's animation. */
    isSettling() { return settleUntil !== 0; },
    /** Begin a bounded same-editor geometry settle after a structural edit. */
    stabilize(now: number, deadline: number) {
      settleUntil = deadline;
      stableFrames = 0;
      settleMode = "structure";
      structureReady = false;
      debug?.record("cursor", "structure-start", { now, deadline });
    },
    /** The host has delivered a block-level mutation for the pending edit. */
    markStructureReady() {
      structureReady = true;
    },
    /** User navigation takes precedence over a pending structural settle. */
    cancelStructuralSettle() {
      if (settleMode === "structure") clearSettling();
    },
    /**
     * The host switched editor (tab, split, popup). Themed switch animations keep
     * moving the caret geometry. Reveal after consecutive stable samples, bounded
     * by a deadline, using the Session's existing frame clock and scheduler.
     */
    switched(nextEditor: HTMLElement, now: number) {
      hide();
      editor = nextEditor;
      settleUntil = now + MOTION.switchSettleMs;
      settleMode = "switch";
      structureReady = true;
      debug?.record("cursor", "switch-start", { settleMs: MOTION.switchSettleMs });
    },
    destroy() { hide(); element.remove(); } };
}
