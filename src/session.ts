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
  let pendingFrame: number | null = null;
  let pauseTimer: ReturnType<typeof setTimeout> | null = null;
  let inputEditor: HTMLElement | null = null;
  let observedEditor: HTMLElement | null = null;
  let observedScroll: HTMLElement | null = null;
  let composing = false;
  let pointerDown = false;
  let disposed = false;
  let geometryDirty = true;
  let contentDirty = true;
  let structureDirty = true;
  let viewportMoved = true;
  let lastInput = -Infinity;
  let caretSuspended = false;
  const addedRoots = new Set<HTMLElement>();

  function queue() {
    if (!disposed && pendingFrame === null) pendingFrame = requestAnimationFrame(update);
  }

  function refresh() {
    geometryDirty = true;
    contentDirty = true;
    structureDirty = true;
    queue();
  }

  function cancelPause() {
    if (pauseTimer !== null) clearTimeout(pauseTimer);
    pauseTimer = null;
  }

  function suspend() {
    caretSuspended = true;
    inputEditor = null;
    cancelPause();
    typewriter.cancel();
    ripple.clear();
    cursor.hide();
    viewportMoved = true;
    geometryDirty = true;
    queue();
  }

  function rememberAddedNodes(records: MutationRecord[]) {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLElement) addedRoots.add(node);
      }
    }
  }

  const mutation = new MutationObserver(records => {
    structureDirty = structureDirty || records.some(record => record.type === "childList");
    rememberAddedNodes(records);
    contentDirty = records.some(record => record.type === "childList" || record.type === "characterData") || contentDirty;
    geometryDirty = true;
    queue();
  });
  const resize = new ResizeObserver(() => {
    geometryDirty = true;
    viewportMoved = true;
    queue();
  });
  const theme = new MutationObserver(refresh);
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme-mode", "data-light-theme", "data-dark-theme"] });

  function cleanAddedNodes() {
    rememberAddedNodes(mutation.takeRecords());
    // Host replacements can clone our presentation attributes. Discard them;
    // the new DOM receives the current state, never an old animation identity.
    const selector = ".zentype-ripple-block, .zentype-custom-caret-active";
    for (const root of addedRoots) {
      const elements = [root, ...root.querySelectorAll<HTMLElement>(selector)];
      for (const element of elements) {
        element.classList.remove("zentype-ripple-block", "zentype-custom-caret-active");
        element.style.removeProperty("--zentype-dim");
      }
    }
    addedRoots.clear();
  }

  function observe(frame: EditorFrame | null) {
    if (observedEditor === frame?.editor && observedScroll === frame?.scroll) return;
    rememberAddedNodes(mutation.takeRecords());
    mutation.disconnect();
    resize.disconnect();
    observedEditor = frame?.editor ?? null;
    observedScroll = frame?.scroll ?? null;
    if (frame) {
      mutation.observe(frame.editor, { subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ["contenteditable"] });
      resize.observe(frame.editor);
      resize.observe(frame.scroll);
    }
    contentDirty = true;
    structureDirty = true;
    viewportMoved = true;
  }

  function update(now: number) {
    pendingFrame = null;
    if (disposed) return;
    if (composing || pointerDown || document.hidden || caretSuspended) {
      cleanAddedNodes();
      cursor.hide();
      typewriter.cancel();
      ripple.clear();
      return;
    }
    try {
      if (!geometryDirty && !typewriter.isMoving()) {
        if (ripple.render({ targets: null, sentences: null }, now, reducedMotion.matches)) queue();
        return;
      }
      const frame = readEditorFrame(reducedMotion.matches);
      geometryDirty = false;
      if (!frame) {
        cleanAddedNodes();
        cursor.hide();
        typewriter.cancel();
        ripple.clear();
        return;
      }
      observe(frame);
      const active = inputEditor === frame.editor;
      const plan = active && features.ripple ? ripple.prepare(frame, contentDirty, structureDirty) : null;
      const nextScroll = typewriter.next(frame, now, active && features.typewriter, lastInput, !viewportMoved);
      contentDirty = false;
      structureDirty = false;
      // All geometry and sentence color reads precede these visual writes.
      cleanAddedNodes();
      if (nextScroll !== frame.scrollTop) frame.scroll.scrollTop = nextScroll;
      cursor.render(frame, nextScroll - frame.scrollTop, viewportMoved || nextScroll !== frame.scrollTop, now - lastInput < MOTION.typingPauseMs);
      let animating = false;
      if (plan) animating = ripple.render(plan, now, frame.reducedMotion);
      else ripple.clear();
      viewportMoved = false;
      if (typewriter.isMoving() || animating) queue();
    } catch (error) {
      cursor.hide();
      typewriter.cancel();
      ripple.clear();
      console.error("[zenType] frame failed; native caret restored", error);
    }
  }

  function activate(editable: HTMLElement | null) {
    if (!editable) return;
    caretSuspended = false;
    inputEditor = editable.closest<HTMLElement>(".protyle-wysiwyg");
    lastInput = performance.now();
    cancelPause();
    pauseTimer = setTimeout(() => {
      pauseTimer = null;
      geometryDirty = true;
      queue();
    }, MOTION.typingPauseMs + 1);
  }

  function handle(event: Event) {
    const editable = ["input", "keydown", "focusin", "pointerup", "compositionstart", "compositionend"].includes(event.type)
      ? editableAt(event.target) : null;
    if (editable) {
      caretSuspended = false;
    }
    switch (event.type) {
      case "input": {
        const input = event as InputEvent;
        if (!editable) return;
        if (!input.isComposing && !composing && input.inputType !== "insertFromPaste" && input.inputType !== "insertFromDrop") activate(editable);
        contentDirty = true;
        break;
      }
      case "keydown": {
        const key = event as KeyboardEvent;
        if (!editable || key.isComposing || key.defaultPrevented) return;
        if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Escape"].includes(key.key)) suspend();
        if (key.key !== "Escape") caretSuspended = false;
        if (!key.ctrlKey && !key.metaKey && !key.altKey && ["Enter", "Backspace", "Delete"].includes(key.key)) activate(editable);
        break;
      }
      case "compositionstart":
        if (!editable) return;
        composing = true;
        cancelPause();
        typewriter.cancel();
        cursor.hide();
        ripple.clear();
        return;
      case "compositionend":
        composing = false;
        activate(editable);
        contentDirty = true;
        break;
      case "pointerdown":
        pointerDown = true;
        suspend();
        return;
      case "pointerup":
      case "pointercancel":
        pointerDown = false;
        break;
      case "wheel":
      case "touchmove":
        suspend();
        return;
      case "scroll":
        if (event.target instanceof Element && observedScroll &&
            event.target !== observedScroll && !observedScroll.contains(event.target) && !event.target.contains(observedScroll)) return;
        viewportMoved = true;
        if (document.hasFocus() && !pointerDown) caretSuspended = false;
        break;
      case "blur":
      case "visibilitychange":
        composing = false;
        pointerDown = false;
        suspend();
        return;
      case "focusout":
        if (!editableAt((event as FocusEvent).relatedTarget)) {
          composing = false;
          suspend();
          return;
        }
        break;
      case "resize":
        viewportMoved = true;
        break;
    }
    geometryDirty = true;
    queue();
  }

  for (const name of ["input", "keydown", "compositionstart", "compositionend", "selectionchange", "pointerdown", "pointerup", "pointercancel", "wheel", "touchmove", "scroll", "focusin", "focusout", "visibilitychange"]) {
    document.addEventListener(name, handle, { capture: true, passive: true, signal: listeners.signal });
  }
  window.addEventListener("blur", handle, { signal: listeners.signal });
  window.addEventListener("resize", handle, { passive: true, signal: listeners.signal });
  window.visualViewport?.addEventListener("resize", handle, { passive: true, signal: listeners.signal });
  window.visualViewport?.addEventListener("scroll", handle, { passive: true, signal: listeners.signal });
  reducedMotion.addEventListener("change", refresh, { signal: listeners.signal });
  queue();

  return {
    refresh, suspend,
    configure(next) {
      features = { ...next };
      if (!features.typewriter) typewriter.cancel();
      if (!features.ripple) ripple.clear();
      refresh();
    },
    destroy() {
      disposed = true;
      listeners.abort();
      cleanAddedNodes();
      mutation.disconnect();
      resize.disconnect();
      theme.disconnect();
      cancelPause();
      if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
      pendingFrame = null;
      typewriter.cancel();
      ripple.destroy();
      cursor.destroy();
    },
  };
}
