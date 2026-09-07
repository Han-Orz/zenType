import * as inputModeTriggers from "../inputModeTriggers";
import { cursorPerf } from "./perf";
import {
  isCurrentSelectionEditable,
  isCurrentSelectionInActiveEditor,
  isEditableEvent,
  isFocusInsideActiveEditor,
  isInActiveEditor,
  isReadonlyEditorTarget,
} from "../../utils/editorScope";

const DEBUG_ENABLED = __ZENTYPE_DEV__;

export type CursorScrollSource = "scroll" | "manual-input";

/**
 * Manual policy applies to user input or scrolls not owned by Typewriter.
 *
 * Stabilization sweep fix: an engine-owned scroll without an active keyboard
 * cooldown is pure viewport motion (post-typing comfort centering, click
 * centering) — the caret is stationary in content space while the viewport
 * sweeps, so the cursor must track 1:1. Preserving its transition there made
 * it chase the per-frame targets with easing restarts (visible follow lag).
 * Keyboard-pending scrolls (Enter auto-scroll, structural finishes inside the
 * cooldown) keep the transition: the caret itself just moved in content space.
 */
export function shouldUseManualScrollPolicy(
  source: CursorScrollSource,
  pendingKeyboardUpdate: boolean,
  _ownedScroll: boolean,
): boolean {
  if (source === "manual-input") return true;
  return !pendingKeyboardUpdate;
}

export interface CursorEventContext {
  clearKeyboardPending: () => void;
  markKeyboardPending: () => void;
  onMouseClick?: () => void;
  onScrollOrWheel: (source: CursorScrollSource, target: EventTarget | null) => void;
  queueUpdate: () => void;
}

interface MouseDownInfo {
  selectionText: string;
}

let mouseDownInfo: MouseDownInfo | null = null;
let eventListeners: Array<[string, EventListener, AddEventListenerOptions?]> = [];
let windowEventListeners: Array<[string, EventListener, AddEventListenerOptions?]> = [];

function isPasteLikeInput(event: InputEvent): boolean {
  return event.inputType === "insertFromPaste" || event.inputType === "insertFromDrop";
}

function isUsableEditorEvent(event: Event): boolean {
  if (isEditableEvent(event)) return true;
  if (isReadonlyEditorTarget(event.target)) inputModeTriggers.onReadonly();
  return false;
}

/** 绑定 document 上的光标相关事件（passive 提升滚动性能） */
export function bindCursorDocumentEvents(context: CursorEventContext): void {
  // 聚焦/打字机模式：wheel/touchmove 退出处理（不涉及 scroll，避免程序滚动误退出）
  const onWheelExit: EventListener = (event) => {
    if (DEBUG_ENABLED) cursorPerf.docCaptureWheel++;
    inputModeTriggers.onWheelOrTouchMove();
    context.clearKeyboardPending();
    if (isInActiveEditor(event.target)) context.onScrollOrWheel("manual-input", event.target);
  };

  // 聚焦/打字机模式：鼠标拖蓝检测（mouseup 时比对 selection 变化）
  const onMouseUpWithDragCheck: EventListener = (event) => {
    if (mouseDownInfo) {
      const currentSel = window.getSelection()?.toString() ?? "";
      if (currentSel !== mouseDownInfo.selectionText && currentSel.length > 0) {
        inputModeTriggers.onDragSelection();
      }
      mouseDownInfo = null;
    }
    if (isEditableEvent(event)) context.queueUpdate();
  };

  const onSelectionChange: EventListener = () => {
    if (isCurrentSelectionEditable()) {
      context.queueUpdate();
    } else if (isCurrentSelectionInActiveEditor()) {
      inputModeTriggers.onReadonly();
      context.clearKeyboardPending();
      context.queueUpdate();
    }
  };

  const onKeyDown: EventListener = (event) => {
    const ke = event as KeyboardEvent;
    if (ke.isComposing || ke.defaultPrevented || !isUsableEditorEvent(event)) {
      if (isReadonlyEditorTarget(event.target)) {
        context.clearKeyboardPending();
        context.queueUpdate();
      }
      return;
    }
    if (ke.key === "Enter" || ke.key === "Backspace") {
      inputModeTriggers.onEnterOrBackspaceEdit();
    }
    if (ke.key === "ArrowUp" || ke.key === "ArrowDown" ||
        ke.key === "PageUp" || ke.key === "PageDown") {
      inputModeTriggers.onVerticalNavigationKey();
    }
    const navigation = ke.key === "ArrowLeft" || ke.key === "ArrowRight" ||
      ke.key === "ArrowUp" || ke.key === "ArrowDown" ||
      ke.key === "Home" || ke.key === "End" ||
      ke.key === "PageUp" || ke.key === "PageDown";
    context.markKeyboardPending();
    // C1 keyboard chain: stamp the event time, then the outer rAF's frame time.
    // doUpdateCursor compares its own rAF timestamp against outerRafAt — a later
    // timestamp proves the update ran one frame after the outer hop.
    if (DEBUG_ENABLED) {
      cursorPerf.keyboardEvents++;
      cursorPerf.keyboardEventAt = performance.now();
      cursorPerf.keyboardOuterRafAt = null;
    }
    // queueUpdate already waits for a frame, after the host's default action.
    if (navigation) {
      context.queueUpdate();
      return;
    }
    requestAnimationFrame((outerFrameTs) => {
      if (DEBUG_ENABLED) cursorPerf.keyboardOuterRafAt = outerFrameTs;
      context.queueUpdate();
    });
  };

  const onInput: EventListener = (event) => {
    if (!isUsableEditorEvent(event)) {
      if (isReadonlyEditorTarget(event.target)) {
        context.clearKeyboardPending();
        context.queueUpdate();
      }
      return;
    }
    const inputEvent = event as InputEvent;
    const pasteLike = isPasteLikeInput(inputEvent);
    // Paste/drop is already a committed edit. It must not turn on inputMode or
    // extend the keyboard cooldown; its explicit inputType replaces the old
    // document-global paste flag.
    if (!pasteLike && !inputEvent.isComposing) {
      inputModeTriggers.onTextInput();
      context.markKeyboardPending();
      // Stamp only when the keyboard cooldown actually arms, so IME composing
      // inputs cannot leave a stale slot for a later unrelated update to consume.
      if (DEBUG_ENABLED) {
        cursorPerf.keyboardEvents++;
        cursorPerf.keyboardEventAt = performance.now();
      }
    }
    requestAnimationFrame((outerFrameTs) => {
      if (DEBUG_ENABLED) cursorPerf.keyboardOuterRafAt = outerFrameTs;
      context.queueUpdate();
    });
  };

  const onClick: EventListener = (event) => {
    // Clicking anywhere still exits the current product mode. Only an editor
    // click queues a caret refresh; external inputs never activate work.
    inputModeTriggers.onMouseClick();
    context.clearKeyboardPending();
    if (isInActiveEditor(event.target)) {
      context.queueUpdate();
      context.onMouseClick?.();
    }
  };

  const onScroll: EventListener = (event) => {
    if (DEBUG_ENABLED) cursorPerf.docCaptureScroll++;
    if (isInActiveEditor(event.target)) context.onScrollOrWheel("scroll", event.target);
  };

  const onCompositionEnd: EventListener = (event) => {
    if (!isUsableEditorEvent(event)) {
      if (isReadonlyEditorTarget(event.target)) {
        context.clearKeyboardPending();
        context.queueUpdate();
      }
      return;
    }
    inputModeTriggers.onCompositionEnd();
    context.queueUpdate();
  };

  const onMouseDown: EventListener = (event) => {
    if (!isEditableEvent(event)) {
      mouseDownInfo = null;
      return;
    }
    mouseDownInfo = { selectionText: window.getSelection()?.toString() ?? "" };
  };

  const onFocusOut: EventListener = (event) => {
    const focusEvent = event as FocusEvent;
    if (focusEvent.relatedTarget && isFocusInsideActiveEditor(focusEvent.relatedTarget)) {
      return;
    }
    inputModeTriggers.onBlur();
    context.clearKeyboardPending();
    context.queueUpdate();
  };

  const handlers: Array<[string, EventListener, AddEventListenerOptions?]> = [
    ["selectionchange", onSelectionChange],
    ["keydown", onKeyDown, { capture: true }],
    ["input", onInput, { capture: true }],
    ["mouseup", onMouseUpWithDragCheck],
    ["click", onClick],
    ["scroll", onScroll, { capture: true, passive: true }],
    ["wheel", onWheelExit, { capture: true, passive: true }],
    ["touchmove", onWheelExit, { capture: true, passive: true }],
    ["compositionend", onCompositionEnd, { capture: true }],
    ["mousedown", onMouseDown],
    ["focusout", onFocusOut, { capture: true }],
  ];

  handlers.forEach(([event, handler, options]) => {
    document.addEventListener(event, handler, options);
  });
  eventListeners = handlers;

  const windowHandlers: Array<[string, EventListener, AddEventListenerOptions?]> = [
    ["blur", () => {
      inputModeTriggers.onBlur();
      context.clearKeyboardPending();
      context.queueUpdate();
    }],
    ["resize", () => {
      if (isCurrentSelectionEditable()) {
        context.queueUpdate();
      } else if (isCurrentSelectionInActiveEditor()) {
        inputModeTriggers.onReadonly();
        context.queueUpdate();
      }
    }, { passive: true }],
  ];
  windowHandlers.forEach(([event, handler, options]) => {
    window.addEventListener(event, handler, options);
  });
  windowEventListeners = windowHandlers;
}

export function destroyCursorDocumentEvents(): void {
  eventListeners.forEach(([event, handler, options]) => {
    document.removeEventListener(event, handler, options);
  });
  eventListeners = [];
  windowEventListeners.forEach(([event, handler, options]) => {
    window.removeEventListener(event, handler, options);
  });
  windowEventListeners = [];
  mouseDownInfo = null;
}
