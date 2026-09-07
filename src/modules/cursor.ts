import { MOTION } from "../config";
import type { EditorFrame } from "../types";

export function createCursor() {
  const element = document.createElement("div");
  element.id = "zentype-cursor";
  element.hidden = true;
  element.setAttribute("aria-hidden", "true");
  document.body.appendChild(element);
  let owner: HTMLElement | null = null;
  let previous: { x: number; y: number } | null = null;
  let breatheTimer: ReturnType<typeof setTimeout> | null = null;

  function pause() {
    if (breatheTimer !== null) clearTimeout(breatheTimer);
    breatheTimer = null;
    element.classList.remove("zentype-breathing");
  }

  function hide() {
    pause();
    owner?.classList.remove("zentype-custom-caret-active");
    owner = null;
    previous = null;
    element.hidden = true;
  }

  function render(frame: EditorFrame, scrollDelta: number, snap: boolean, typing: boolean) {
    const { x, height } = frame.caret;
    const y = frame.caret.y - scrollDelta;
    const view = frame.viewport;
    if (x < view.left || x > view.right || y < view.top || y + height > view.bottom) {
      hide();
      return;
    }
    const changedOwner = owner !== frame.editable;
    const moved = !previous || Math.abs(previous.x - x) > 0.1 || Math.abs(previous.y - y) > 0.1;
    if (changedOwner) {
      owner?.classList.remove("zentype-custom-caret-active");
      owner = frame.editable;
    }
    const jump = previous ? Math.hypot(x - previous.x, y - previous.y) : Infinity;
    const animate = !frame.reducedMotion && !changedOwner && !snap && !element.hidden && jump < 200;
    element.style.transition = animate
      ? "transform " + (typing ? MOTION.caretTypingMs : MOTION.caretNavigationMs) + "ms cubic-bezier(0.2, 0, 0, 1)"
      : "none";
    element.style.transform = "translate3d(" + x + "px," + y + "px,0)";
    element.style.height = height + "px";
    element.style.zIndex = String(frame.zIndex);
    element.hidden = false;
    frame.editable.classList.add("zentype-custom-caret-active");
    previous = { x, y };
    if (moved || changedOwner || frame.reducedMotion) pause();
    if (!frame.reducedMotion && !breatheTimer && !element.classList.contains("zentype-breathing")) {
      breatheTimer = setTimeout(() => {
        breatheTimer = null;
        element.classList.add("zentype-breathing");
      }, MOTION.breatheDelayMs);
    }
  }

  return { render, hide, destroy() { hide(); element.remove(); } };
}
