import { MOTION } from "../config";
import { approach, clamp } from "../motion";
import type { CursorRect, EditorFrame } from "../types";

export function createCursor() {
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
  let brighten: Animation | null = null;
  let transport = { top: 0, left: 0 };
  let nestedScroll: EditorFrame["nestedScroll"] = [];

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

  function hide() {
    owner?.classList.remove("zentype-custom-caret-active");
    owner = null;
    editor = null;
    current = target = null;
    lastTime = 0;
    alpha = 0;
    selecting = false;
    brighten?.cancel();
    brighten = null;
    ink.style.opacity = "1";
    nestedScroll = [];
    element.hidden = true;
    ink.classList.remove("zentype-breathing");
  }

  function render(frame: EditorFrame, now: number, typing: boolean, interacting = false): boolean {
    if (editor !== frame.editor) { hide(); editor = frame.editor; }
    if (settleUntil !== 0 && now >= settleUntil) settleUntil = 0;
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
    const elapsed = lastTime ? Math.min(MOTION.maxFrameDeltaMs, now - lastTime) : 16;
    if (frame.caret) {
      lastValid = now;
      target = { ...frame.caret, y: frame.caret.y - (frame.caretLift ?? MOTION.caretLiftPx) };
    } else if (frame.caretless) {
      // The caret is on a block with no text position (separator, image). Fade at
      // once rather than freezing the overlay on the previous line for a budget.
      return fadeOut(now, frame.reducedMotion);
    } else if (!current && alpha === 0) {
      hide();
      return false;
    } else if (now - lastValid > MOTION.recoveryMs) {
      // The host cannot measure this caret (a separator, an image block, a
      // boundary with no rectangle). Fading out beats freezing the overlay at a
      // position that is no longer the caret: the user asked for a smooth
      // disappearance rather than a misplaced cursor.
      return fadeOut(now, frame.reducedMotion);
    }
    if (!target) return false;
    lastTime = now;
    if (settleUntil !== 0) {
      // A host switch animation is still moving the layout. Wait out the delay,
      // then reveal once at the settled position instead of chasing it.
      element.hidden = true;
      return true;
    }
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
    const nextOwner = frame.editable ?? owner;
    if (owner !== nextOwner) {
      owner?.classList.remove("zentype-custom-caret-active");
      owner = nextOwner;
    }
    const breathing = !frame.reducedMotion && !typing && !interacting && !moving && now - lastMotion >= MOTION.breatheDelayMs;
    breathe(breathing, frame.reducedMotion);
    alpha = approach(alpha, 1, elapsed, frame.reducedMotion ? 0 : MOTION.caretFadeInMs);
    if (alpha > 0.995) alpha = 1;
    element.style.opacity = String(visible ? alpha * clamp(edge / Math.max(MOTION.edgeFadeMinHeightPx, current.height), 0, 1) : 0);
    element.style.transform = "translate3d(" + current.x + "px," + current.y + "px,0)";
    element.style.height = current.height + "px";
    element.style.clipPath = "inset(" + Math.max(0, view.top - current.y) + "px 0 " + Math.max(0, current.y + current.height - view.bottom) + "px 0)";
    element.style.zIndex = String(frame.zIndex);
    element.hidden = false;
    owner?.classList.add("zentype-custom-caret-active");
    if (!moving && alpha === 1) lastTime = 0;
    return moving || alpha < 1;
  }

  /** Fade the overlay out and release ownership. True while it is still fading. */
  function fadeOut(now: number, reducedMotion: boolean): boolean {
    owner?.classList.remove("zentype-custom-caret-active");
    owner = null;
    const elapsed = lastTime ? Math.min(MOTION.maxFrameDeltaMs, now - lastTime) : 16;
    lastTime = now;
    alpha = approach(alpha, 0, elapsed, reducedMotion ? 0 : MOTION.caretFadeOutMs);
    element.style.opacity = String(alpha);
    current = target = null;
    if (alpha < 0.005) { hide(); return false; }
    return true;
  }

  return { render, hide,
    /**
     * Release presentation without a selection involved (no measurable caret, no
     * valid host frame). Fading keeps the transition smooth instead of the cursor
     * vanishing between two frames.
     */
    release(now: number, reducedMotion: boolean) {
      if (element.hidden) return false;
      // Start the fade from this frame instead of from the last rendered frame,
      // otherwise a long idle gap would drop most of the opacity at once.
      if (current) lastTime = 0;
      brighten?.cancel();
      brighten = null;
      ink.classList.remove("zentype-breathing");
      ink.style.opacity = "1";
      return fadeOut(now, reducedMotion);
    },
    yieldSelection(now: number, reducedMotion: boolean) {
      if (!selecting) {
        // Already released: nothing to fade, and sampling the ink here would
        // force a style read on every frame a selection stays open.
        if (element.hidden) return false;
        const opacity = getComputedStyle(ink).opacity;
        brighten?.cancel();
        brighten = null;
        ink.classList.remove("zentype-breathing");
        ink.style.opacity = opacity;
        // alpha already holds the logical overlay alpha; sampling
        // element.style.opacity here would restart the fade from the clipped
        // edge-fade product instead of from the displayed cursor.
        selecting = true;
        lastTime = 0;
      }
      return fadeOut(now, reducedMotion);
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
    /**
     * The host switched editor (tab, split, popup). Themed switch animations keep
     * moving the caret geometry, so the overlay stays hidden for a fixed delay and
     * then reveals once at the settled position instead of chasing the layout.
     */
    switched() {
      hide();
      settleUntil = performance.now() + MOTION.switchSettleMs;
    },
    destroy() { hide(); element.remove(); } };
}
