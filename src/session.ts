import { MOTION } from "./config";
import type { Features, EditorFrame } from "./types";
import { editableAt, readEditorFrame } from "./utils/editorScope";
import { createCursor } from "./modules/cursor";
import { createTypewriter } from "./modules/typewriter";
import { createRipple } from "./modules/ripple";

export interface WritingSession {
  configure(features: Features): void;
  refresh(): void;
  suspend(): void;
  destroy(): void;
}

export function createWritingSession(initial: Features): WritingSession {
  let features = { ...initial };
  const cursor = createCursor();
  const typewriter = createTypewriter();
  const ripple = createRipple();
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const listeners = new AbortController();
  let pending: number | null = null;
  let wake: ReturnType<typeof setTimeout> | null = null;
  let frame: EditorFrame | null = null;
  let observedEditor: HTMLElement | null = null;
  let observedScroll: HTMLElement | null = null;
  let writingEditor: HTMLElement | null = null;
  let composingEditor: HTMLElement | null = null;
  let pointerDown = false;
  let blocked = false;
  let disposed = false;
  let geometryDirty = true;
  let contentDirty = true;
  let structureDirty = true;
  let lastInput = -Infinity;
  let retryUntil = 0;
  const added = new Set<HTMLElement>();

  function queue() {
    if (!disposed && pending === null) pending = requestAnimationFrame(update);
  }
  function refresh() {
    geometryDirty = contentDirty = structureDirty = true;
    retryUntil = performance.now() + 160;
    queue();
  }
  function clearWake() {
    if (wake !== null) clearTimeout(wake);
    wake = null;
  }
  function wakeAfter(delay: number) {
    clearWake();
    wake = setTimeout(() => { wake = null; geometryDirty = true; queue(); }, delay);
  }
  function remember(records: MutationRecord[]) {
    for (const record of records) {
      if (record.type === "childList") {
        structureDirty = true;
        for (const node of record.addedNodes) if (node instanceof HTMLElement) added.add(node);
      }
      if (!frame?.editable || frame.editable.contains(record.target) ||
          (record.target instanceof Element && record.target.contains(frame.editable))) contentDirty = true;
    }
    if (records.length) geometryDirty = true;
  }
  const mutation = new MutationObserver(records => { remember(records); queue(); });
  const resize = new ResizeObserver(() => { geometryDirty = true; queue(); });
  const theme = new MutationObserver(refresh);
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme-mode", "data-light-theme", "data-dark-theme"] });

  function cleanClones() {
    remember(mutation.takeRecords());
    for (const root of added) {
      if (!root.isConnected) continue;
      for (const element of [root, ...root.querySelectorAll<HTMLElement>(".zentype-ripple-block, .zentype-custom-caret-active")]) {
        if (!ripple.owns(element)) {
          element.classList.remove("zentype-ripple-block");
          element.style.removeProperty("--zentype-dim");
        }
        if (element !== frame?.editable) element.classList.remove("zentype-custom-caret-active");
      }
    }
    added.clear();
  }
  function observe(next: EditorFrame | null) {
    if (observedEditor === next?.editor && observedScroll === next?.scroll) return;
    remember(mutation.takeRecords());
    mutation.disconnect();
    resize.disconnect();
    observedEditor = next?.editor ?? null;
    observedScroll = next?.scroll ?? null;
    if (next) {
      mutation.observe(next.editor, { subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ["contenteditable", "data-readonly"] });
      resize.observe(next.editor);
      resize.observe(next.scroll);
    }
    contentDirty = structureDirty = true;
  }
  function stopWriting() {
    writingEditor = null;
    typewriter.cancel();
    clearWake();
  }
  function suspend() {
    blocked = true;
    composingEditor = null;
    stopWriting();
    cursor.hide();
    ripple.clear();
    frame = null;
    observe(null);
  }

  function update(now: number) {
    pending = null;
    if (disposed) return;
    try {
      cleanClones();
      if (blocked || document.hidden) return;
      let sampled = false;
      if (geometryDirty || typewriter.isMoving() || now < retryUntil) {
        sampled = true;
        const next = readEditorFrame(reducedMotion.matches, composingEditor, frame?.editor);
        geometryDirty = false;
        if (!next) {
          cursor.hide();
          ripple.clear();
          typewriter.cancel();
          frame = null;
          observe(null);
          return;
        }
        if (frame && frame.editor !== next.editor) {
          cursor.hide();
          ripple.clear();
          typewriter.cancel();
          if (writingEditor !== next.editor) writingEditor = null;
          if (composingEditor !== next.editor) composingEditor = null;
        }
        frame = next;
        observe(frame);
      }
      if (!frame) return;
      if (frame.selection === "range") {
        cursor.hide();
        stopWriting();
        ripple.clear();
        return;
      }
      const writing = writingEditor === frame.editor;
      const composing = composingEditor === frame.editor;
      if (features.ripple && (sampled || contentDirty || structureDirty)) ripple.prepare(frame, contentDirty, structureDirty, writing);
      contentDirty = structureDirty = false;
      const requested = typewriter.next(frame, now, features.typewriter && writing && !composing && !pointerDown, lastInput);
      if (requested !== frame.scrollTop) frame.scroll.scrollTop = requested;
      const actual = frame.scroll.scrollTop;
      typewriter.written(actual);
      const delta = actual - frame.scrollTop;
      if (frame.caret) frame.caret = { ...frame.caret, y: frame.caret.y - delta };
      frame.scrollTop = actual;
      const cursorMoving = cursor.render(frame, now, composing || now - lastInput < MOTION.typingPauseMs);
      const rippleMoving = features.ripple && ripple.render(now, reducedMotion.matches);
      if (cursorMoving && !frame.caret) geometryDirty = true;
      if (cursorMoving || typewriter.isMoving() || rippleMoving || now < retryUntil) queue();
      else if (wake === null && !reducedMotion.matches && !composing) {
        // One idle wake starts CSS breathing; no perpetual JavaScript idle loop.
        const delay = cursor.wakeDelay(now);
        if (delay !== null) wakeAfter(delay);
      }
    } catch (error) {
      suspend();
      console.error("[zenType] presentation released after frame failure", error);
    }
  }

  function activate(editable: HTMLElement) {
    writingEditor = editable.closest<HTMLElement>(".protyle-wysiwyg");
    lastInput = performance.now();
    wakeAfter(MOTION.typingPauseMs + 1);
  }
  function handle(event: Event) {
    const editable = editableAt(event.target);
    switch (event.type) {
      case "focusin":
        if (editable) { blocked = false; retryUntil = performance.now() + 160; }
        break;
      case "focusout":
        if ((event as FocusEvent).relatedTarget && !editableAt((event as FocusEvent).relatedTarget)) { suspend(); return; }
        retryUntil = performance.now() + 160;
        break;
      case "beforeinput":
      case "input":
        if (!editable) return;
        blocked = false;
        activate(editable);
        contentDirty = true;
        if ((event as InputEvent).isComposing) composingEditor = editable.closest<HTMLElement>(".protyle-wysiwyg");
        break;
      case "keydown": {
        const key = event as KeyboardEvent;
        if (!editable || key.defaultPrevented) return;
        blocked = false;
        if (key.isComposing) break;
        if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", "Escape"].includes(key.key)) stopWriting();
        if (!key.ctrlKey && !key.metaKey && !key.altKey && ["Enter", "Backspace", "Delete", "Tab"].includes(key.key)) {
          activate(editable);
          retryUntil = performance.now() + 160;
        }
        break;
      }
      case "compositionstart":
        if (!editable) return;
        blocked = false;
        composingEditor = editable.closest<HTMLElement>(".protyle-wysiwyg");
        activate(editable);
        typewriter.cancel();
        break;
      case "compositionend":
        composingEditor = null;
        if (editable) { blocked = false; activate(editable); }
        contentDirty = true;
        retryUntil = performance.now() + 160;
        break;
      case "pointerdown":
        pointerDown = true;
        stopWriting();
        break;
      case "pointerup":
      case "pointercancel":
        pointerDown = false;
        if (editable) blocked = false;
        retryUntil = performance.now() + 160;
        break;
      case "wheel":
      case "touchmove":
        stopWriting();
        break;
      case "scroll":
        if (event.target instanceof Element && observedScroll &&
            event.target !== observedScroll && !observedScroll.contains(event.target) && !event.target.contains(observedScroll)) return;
        break;
      case "blur":
        pointerDown = false;
        suspend();
        return;
      case "visibilitychange":
        if (document.hidden) { pointerDown = false; suspend(); return; }
        blocked = false;
        break;
    }
    geometryDirty = true;
    queue();
  }

  for (const name of ["beforeinput", "input", "keydown", "compositionstart", "compositionend", "selectionchange",
    "pointerdown", "pointerup", "pointercancel", "wheel", "touchmove", "scroll", "focusin", "focusout", "visibilitychange"]) {
    document.addEventListener(name, handle, { capture: true, passive: true, signal: listeners.signal });
  }
  window.addEventListener("blur", handle, { signal: listeners.signal });
  window.addEventListener("focus", () => { blocked = false; refresh(); }, { signal: listeners.signal });
  window.addEventListener("resize", refresh, { passive: true, signal: listeners.signal });
  window.visualViewport?.addEventListener("resize", refresh, { passive: true, signal: listeners.signal });
  window.visualViewport?.addEventListener("scroll", refresh, { passive: true, signal: listeners.signal });
  document.fonts?.addEventListener("loadingdone", refresh, { signal: listeners.signal });
  reducedMotion.addEventListener("change", refresh, { signal: listeners.signal });
  queue();

  return {
    refresh() { blocked = false; refresh(); }, suspend,
    configure(next) {
      features = { ...next };
      if (!features.typewriter) typewriter.cancel();
      if (!features.ripple) ripple.clear();
      refresh();
    },
    destroy() {
      disposed = true;
      listeners.abort();
      cleanClones();
      mutation.disconnect();
      resize.disconnect();
      theme.disconnect();
      clearWake();
      if (pending !== null) cancelAnimationFrame(pending);
      typewriter.cancel();
      ripple.destroy();
      cursor.destroy();
    },
  };
}
