import { cursorPerf } from "./perf";

const DEBUG_ENABLED = __ZENTYPE_DEV__;

let protyleContentObserver: ResizeObserver | null = null;
let protyleWysiwygObserver: ResizeObserver | null = null;
let lastBoundProtyleContent: HTMLElement | null = null;
let lastBoundProtyleWysiwyg: HTMLElement | null = null;

export interface ResizeBindingContext {
  getCursorElement: () => HTMLDivElement | null;
  isKeyboardUpdatePending: () => boolean;
  queueUpdate: () => void;
}

/** 绑定 ResizeObserver 到 protyle-content / protyle-wysiwyg，protyle 切换时自动重绑 */
export function bindResizeObservers(
  cursorElement: Element | null,
  context: ResizeBindingContext,
): void {
  if (!cursorElement) return;
  if (typeof ResizeObserver === "undefined") return;

  const protyleContent = cursorElement.closest(
    ".protyle:not(.fn__none) .protyle-content",
  ) as HTMLElement | null;

  if (protyleContent && protyleContent !== lastBoundProtyleContent) {
    protyleContentObserver?.disconnect();
    protyleContentObserver = new ResizeObserver(() => {
      const el = context.getCursorElement();
      if (!el) return;
      if (DEBUG_ENABLED) cursorPerf.resizeDriven++;
      // round 4 fix：键盘触发的 ResizeObserver（Enter 新建段落等）不强制无过渡
      if (!context.isKeyboardUpdatePending()) el.classList.add("no-transition");
      context.queueUpdate();
    });
    protyleContentObserver.observe(protyleContent);
    lastBoundProtyleContent = protyleContent;
  }

  const protyleWysiwyg = cursorElement.closest(
    ".protyle:not(.fn__none) .protyle-wysiwyg",
  ) as HTMLElement | null;

  if (protyleWysiwyg && protyleWysiwyg !== lastBoundProtyleWysiwyg) {
    protyleWysiwygObserver?.disconnect();
    protyleWysiwygObserver = new ResizeObserver(() => {
      const el = context.getCursorElement();
      if (!el) return;
      if (DEBUG_ENABLED) cursorPerf.resizeDriven++;
      // round 4 fix：键盘触发的 ResizeObserver（Enter 新建段落等）不强制无过渡
      if (!context.isKeyboardUpdatePending()) el.classList.add("no-transition");
      context.queueUpdate();
    });
    protyleWysiwygObserver.observe(protyleWysiwyg);
    lastBoundProtyleWysiwyg = protyleWysiwyg;
  }
}

export function destroyResizeObservers(): void {
  protyleContentObserver?.disconnect();
  protyleContentObserver = null;
  protyleWysiwygObserver?.disconnect();
  protyleWysiwygObserver = null;
  lastBoundProtyleContent = null;
  lastBoundProtyleWysiwyg = null;
}
