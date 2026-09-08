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
  let transport = { top: 0, left: 0 };
  let nestedScroll: EditorFrame["nestedScroll"] = [];

  function hide() {
    owner?.classList.remove("zentype-custom-caret-active");
    owner = null;
    editor = null;
    current = target = null;
    nestedScroll = [];
    element.hidden = true;
    ink.classList.remove("zentype-breathing");
  }

  function render(frame: EditorFrame, now: number, typing: boolean): boolean {
    if (editor !== frame.editor) { hide(); editor = frame.editor; }
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
    const elapsed = lastTime ? Math.min(64, now - lastTime) : 16;
    lastTime = now;
    if (frame.caret) {
      lastValid = now;
      target = { ...frame.caret };
    } else if (!current || now - lastValid > 160) {
      hide();
      return false;
    }
    if (!target) return false;
    if (!current) { current = { ...target }; lastMotion = now; }
    const response = frame.reducedMotion ? 0 : (typing ? MOTION.caretTypingMs : MOTION.caretNavigationMs) / 3;
    current.x = approach(current.x, target.x, elapsed, response);
    current.y = approach(current.y, target.y, elapsed, response);
    current.height = approach(current.height, target.height, elapsed, response);
    const moving = Math.hypot(current.x - target.x, current.y - target.y) > 0.15 || Math.abs(current.height - target.height) > 0.15;
    if (moving) lastMotion = now;
    else current = { ...target };
    const view = frame.viewport;
    const edge = Math.min(current.y + current.height - view.top, view.bottom - current.y);
    const visible = current.x >= view.left && current.x <= view.right && edge > 0;
    const nextOwner = frame.editable ?? owner;
    if (owner !== nextOwner) {
      owner?.classList.remove("zentype-custom-caret-active");
      owner = nextOwner;
    }
    element.style.opacity = String(visible ? clamp(edge / Math.max(12, current.height), 0, 1) : 0);
    element.style.transform = "translate3d(" + current.x + "px," + current.y + "px,0)";
    element.style.height = current.height + "px";
    element.style.clipPath = "inset(" + Math.max(0, view.top - current.y) + "px 0 " + Math.max(0, current.y + current.height - view.bottom) + "px 0)";
    element.style.zIndex = String(frame.zIndex);
    element.hidden = false;
    owner?.classList.add("zentype-custom-caret-active");
    const breathing = !frame.reducedMotion && !typing && !moving && now - lastMotion >= MOTION.breatheDelayMs;
    ink.classList.toggle("zentype-breathing", breathing);
    return moving || !frame.caret;
  }

  return { render, hide,
    wakeDelay(now: number) {
      return current && !ink.classList.contains("zentype-breathing")
        ? Math.max(1, lastMotion + MOTION.breatheDelayMs + 20 - now) : null;
    },
    destroy() { hide(); element.remove(); } };
}
