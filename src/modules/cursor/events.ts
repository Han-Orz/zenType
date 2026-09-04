import * as inputModeTriggers from "../inputModeTriggers";
import {
  isCurrentSelectionEditable,
  isCurrentSelectionInActiveEditor,
  isEditableEvent,
  isFocusInsideActiveEditor,
  isInActiveEditor,
  isReadonlyEditorTarget,
} from "../../utils/editorScope";

export type CursorScrollSource = "scroll" | "manual-input";

/** Manual policy applies to user input or scrolls not owned by Typewriter. */
export function shouldUseManualScrollPolicy(
  source: CursorScrollSource,
  pendingKeyboardUpdate: boolean,
  ownedScroll: boolean,
): boolean {
  if (source === "manual-input") return true;
  return !pendingKeyboardUpdate && !ownedScroll;
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
    context.markKeyboardPending();
    requestAnimationFrame(context.queueUpdate);
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
    }
    requestAnimationFrame(context.queueUpdate);
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
