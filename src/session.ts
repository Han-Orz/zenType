import { MOTION } from "./config";
import type { Features, EditorFrame } from "./types";
import { editableAt, readEditorFrame } from "./utils/editorScope";
import { createCursor } from "./modules/cursor";
import { createTypewriter } from "./modules/typewriter";
import { createRipple } from "./modules/ripple";
import type { DebugRecorder } from "./debug/types";
import { classifyMutations, createStructureGate, STRUCTURE_LIMITS } from "./structure";

export interface WritingSession {
  configure(features: Features): void;
  refresh(): void;
  suspend(): void;
  destroy(): void;
}

export function createWritingSession(initial: Features, debug?: DebugRecorder): WritingSession {
  let features = { ...initial };
  const cursor = createCursor(debug);
  const typewriter = createTypewriter();
  const ripple = createRipple(debug);
  const structure = createStructureGate(debug);
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
  let lastInteraction = -Infinity;
  let clickEditor: HTMLElement | null = null;
  let retryUntil = 0;
  const added = new Set<HTMLElement>();

  function queue() {
    if (!disposed && pending === null) pending = requestAnimationFrame(update);
  }
  function refresh() {
    geometryDirty = contentDirty = structureDirty = true;
    retryUntil = performance.now() + MOTION.recoveryMs;
    queue();
  }
  function clearWake() {
    if (wake !== null) clearTimeout(wake);
    wake = null;
  }
  function wakeAfter(delay: number) {
    clearWake();
    debug?.record("session", "wake-scheduled", { delay });
    wake = setTimeout(() => { wake = null; geometryDirty = true; queue(); }, delay);
  }
  function remember(records: MutationRecord[]) {
    if (!records.length) return;
    debug?.recordMutations(records, frame);
    const changes = classifyMutations(records);
    if (changes.kind !== "text") structureDirty = true;
    if (observedEditor && !blocked && !pointerDown) structure.mutation(observedEditor, performance.now(), changes.kind);
    for (const node of changes.added) {
      if (added.size >= STRUCTURE_LIMITS.nodes) break;
      added.add(node);
    }
    if (changes.kind === "overflow") contentDirty = true;
    for (const record of records.slice(0, STRUCTURE_LIMITS.records)) {
      if (!frame?.editable || frame.editable.contains(record.target) ||
          (record.target instanceof Element && record.target.contains(frame.editable))) contentDirty = true;
    }
    if (records.length) geometryDirty = true;
  }
  const mutation = new MutationObserver(records => { remember(records); queue(); });
  const resize = new ResizeObserver(() => { geometryDirty = true; queue(); });
  const theme = new MutationObserver(() => { ripple.invalidateColors(); refresh(); });
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme-mode", "data-light-theme", "data-dark-theme"] });

  function cleanClones(editable = frame?.editable) {
    for (const element of added) {
      if (element !== editable) element.classList.remove("zentype-custom-caret-active");
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
    clickEditor = null;
    typewriter.cancel();
    clearWake();
  }
  function suspend() {
    debug?.record("session", "suspend", { reason: "lifecycle" });
    blocked = true;
    structure.cancel("lifecycle");
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
      debug?.record("session", "frame-start", {
        now,
        blocked,
        hidden: document.hidden,
        geometryDirty,
        contentDirty,
        structureDirty,
      });
      remember(mutation.takeRecords());
      if (blocked || document.hidden) {
        debug?.record("session", "frame-skipped", { reason: blocked ? "blocked" : "hidden" });
        cleanClones();
        return;
      }
      let sampled = false;
      // A typewriter frame only moves the container: the frame already transports
      // the caret and the cursor by that displacement, so re-reading host geometry
      // every frame of a comfort scroll is redundant work.
      if (geometryDirty) {
        sampled = true;
        const next = readEditorFrame(reducedMotion.matches, composingEditor, frame?.editor);
        geometryDirty = false;
        if (next && frame && next.editor !== frame.editor) structure.cancel("editor-switch");
        const decision = structure.sample(next, now);
        if (decision === "wait") {
          // Only rebind old visual owners. No effect may consume a new target or
          // write scrollTop until the shared gate publishes an authoritative frame.
          const carry = ripple.rebind([...added]);
          ripple.freeze();
          carry();
          if (next) cursor.retainOwner(next.editable);
          typewriter.cancel();
          cleanClones(next?.editable ?? frame?.editable);
          if (structure.needsFrameSampling()) { geometryDirty = true; queue(); }
          else wakeAfter(structure.remaining(now));
          return;
        }
        if (decision === "commit" || decision === "timeout" || decision === "overflow") {
          structureDirty = contentDirty = true;
          typewriter.cancel();
          if (decision !== "commit") {
            // A deadline bounds work; it is not proof of stable geometry. Release
            // all presentation and await fresh activity instead of animating a guess.
            cursor.hide(); ripple.clear(); stopWriting(); cleanClones();
            frame = next;
            observe(next);
            debug?.record("session", "structure-release", { now, reason: decision });
            return;
          }
          debug?.record("session", "structure-commit", { now, authority: "quiet-and-stable" });
        }
        if (!next) {
          debug?.record("session", "frame-missing", {
            now,
            withinRecovery: now < retryUntil,
            hadFrame: frame !== null,
          });
          if (now < retryUntil && frame?.editor.isConnected && document.hasFocus() &&
              (document.activeElement === document.body || frame.editor.contains(document.activeElement))) {
            // Copied plugin styling must not survive a replacement just because
            // geometry is temporarily unreadable. No host read follows here, so
            // cleanup cannot invalidate anything.
            cleanClones();
            wakeAfter(Math.max(1, retryUntil - now));
            return;
          }
          cleanClones();
          // No valid frame: fade the overlay out instead of dropping it between
          // two frames (a separator, an image block, a lost selection).
          const fading = cursor.release(now, reducedMotion.matches);
          ripple.clear();
          typewriter.cancel();
          frame = null;
          observe(null);
          if (fading) queue();
          return;
        }
        const editorChanged = frame !== null && frame.editor !== next.editor;
        if (editorChanged) {
          cursor.switched(next.editor, now);
          ripple.clear();
          typewriter.cancel();
          if (writingEditor !== next.editor) writingEditor = null;
          if (composingEditor !== next.editor) composingEditor = null;
        }
        frame = next;
        debug?.recordFrame(next, {
          now,
          sampled,
          editorChanged,
        });
        observe(frame);
      }
      if (!frame) {
        // Keep a release fade running without re-reading host geometry.
        if (cursor.release(now, reducedMotion.matches)) queue();
        return;
      }
      if (frame.selection === "range") {
        stopWriting();
        // Same read-before-write order as the caret path: the selection fade reads
        // the ink opacity before Ripple invalidates the block set, otherwise the
        // first frame of a drag-selection forced the same document-scale recalc.
        const commitRipple = ripple.sample(frame, false, false, false);
        const fading = cursor.yieldSelection(now, reducedMotion.matches, frame.editable);
        commitRipple();
        cleanClones();
        if (ripple.render(now, reducedMotion.matches) || fading) queue();
        debug?.record("session", "frame-commit", {
          now, selection: frame.selection, cursorMoving: fading, rippleMoving: false,
        });
        return;
      }
      const writing = writingEditor === frame.editor;
      const composing = composingEditor === frame.editor;
      const commitRipple = sampled || contentDirty || structureDirty
        ? ripple.sample(frame, contentDirty, structureDirty, features.ripple && writing) : null;
      const locate = clickEditor === frame.editor;
      clickEditor = null;
      const requested = typewriter.next(frame, now, features.typewriter && (writing || locate || typewriter.isLocating()) && !composing && !pointerDown, lastInput, locate);
      let actual = frame.scrollTop;
      if (requested !== frame.scrollTop) {
        frame.scroll.scrollTop = requested;
        actual = frame.scroll.scrollTop;
      }
      typewriter.written(actual);
      const delta = actual - frame.scrollTop;
      if (frame.caret) frame.caret = { ...frame.caret, y: frame.caret.y - delta };
      frame.scrollTop = actual;
      // Read phase before write phase. The cursor samples the ink opacity before
      // Ripple invalidates a large part of the editor, so no frame forces a style
      // recalc of its own invalidation (that recalc measured ~150ms on a long
      // document, once per focus-mode entry and exit).
      const cursorMoving = cursor.render(frame, now, composing || now - lastInput < MOTION.typingPauseMs,
        pointerDown || now - lastInteraction < MOTION.interactionHoldMs);
      const settling = cursor.isSettling();
      if (settling) geometryDirty = true;
      commitRipple?.();
      cleanClones();
      contentDirty = structureDirty = false;
      const rippleMoving = ripple.render(now, reducedMotion.matches);
      debug?.record("typewriter", "frame", {
        now,
        requestedScroll: requested,
        actualScroll: actual,
        moving: typewriter.isMoving(),
        locating: typewriter.isLocating(),
      });
      debug?.record("session", "frame-commit", {
        now,
        selection: frame.selection,
        sampled,
        cursorMoving,
        rippleMoving,
        typewriterMoving: typewriter.isMoving(),
        settling,
      });
      if (cursorMoving || typewriter.isMoving() || rippleMoving || settling) queue();
      else if ((wake === null || !frame.caret) && !composing) {
        // Recovery and typing pauses share the idle wake with CSS breathing.
        const cursorDelay = reducedMotion.matches ? Infinity : cursor.wakeDelay(now) ?? Infinity;
        const pauseDelay = writing && now - lastInput < MOTION.typingPauseMs
          ? MOTION.typingPauseMs + 1 - (now - lastInput) : Infinity;
        const delay = Math.min(cursorDelay, pauseDelay, !frame.caret ? cursor.recoveryDelay(now) ?? Infinity : Infinity);
        if (Number.isFinite(delay)) wakeAfter(delay);
      }
    } catch (error) {
      debug?.record("session", "frame-error", { message: error instanceof Error ? error.message : String(error) });
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
    debug?.recordEvent(event, frame);
    const editable = editableAt(event.target);
    if (["keydown", "pointerdown", "pointerup", "wheel", "touchmove", "scroll"].includes(event.type)) lastInteraction = performance.now();
    switch (event.type) {
      case "click":
        if (editable && !composingEditor && !(event as MouseEvent).shiftKey &&
            (event as MouseEvent).detail <= 1 && window.getSelection()?.isCollapsed &&
            !(event.target as Element).closest('[data-type="a"], a, button')) {
          clickEditor = editable.closest<HTMLElement>(".protyle-wysiwyg");
        }
        break;
      case "focusin":
        if (editable) { blocked = false; retryUntil = performance.now() + MOTION.recoveryMs; }
        break;
      case "focusout":
        if ((event as FocusEvent).relatedTarget && !editableAt((event as FocusEvent).relatedTarget)) { suspend(); return; }
        retryUntil = performance.now() + MOTION.recoveryMs;
        break;
      case "beforeinput":
      case "input":
        if (!editable) return;
        blocked = false;
        activate(editable);
        contentDirty = true;
        if (event.type === "beforeinput" && /^(insertParagraph|insertLineBreak|formatIndent|formatOutdent|historyUndo|historyRedo|deleteByCut|deleteByDrag)$/.test((event as InputEvent).inputType)) {
          structure.intent(editable.closest<HTMLElement>(".protyle-wysiwyg")!, performance.now());
        }
        if (event.type === "input") structure.input();
        structure.activity(performance.now(), event.type);
        if ((event as InputEvent).isComposing) composingEditor = editable.closest<HTMLElement>(".protyle-wysiwyg");
        break;
      case "keydown": {
        const key = event as KeyboardEvent;
        if (!editable || key.defaultPrevented) return;
        blocked = false;
        if (key.isComposing) break;
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", "Escape"].includes(key.key)) {
          structure.cancel("navigation"); stopWriting();
        }
        if (!key.ctrlKey && !key.metaKey && !key.altKey && ["Enter", "Backspace", "Delete", "Tab"].includes(key.key)) {
          activate(editable);
          const now = performance.now();
          retryUntil = now + MOTION.recoveryMs;
          structure.intent(editable.closest<HTMLElement>(".protyle-wysiwyg")!, now);
        }
        break;
      }
      case "compositionstart":
        if (!editable) return;
        blocked = false;
        structure.cancel("composition");
        composingEditor = editable.closest<HTMLElement>(".protyle-wysiwyg");
        activate(editable);
        typewriter.cancel();
        break;
      case "compositionend":
        composingEditor = null;
        if (editable) { blocked = false; activate(editable); }
        contentDirty = true;
        retryUntil = performance.now() + MOTION.recoveryMs;
        break;
      case "pointerdown":
        pointerDown = true;
        structure.cancel("pointer");
        stopWriting();
        break;
      case "pointerup":
      case "pointercancel":
        pointerDown = false;
        if (editable) blocked = false;
        retryUntil = performance.now() + MOTION.recoveryMs;
        break;
      case "wheel":
      case "touchmove":
        structure.cancel(event.type);
        stopWriting();
        break;
      case "scroll": {
        const target = event.target;
        if (!(target instanceof Element) || !observedScroll) break;
        if (target !== observedScroll && !observedScroll.contains(target) && !target.contains(observedScroll)) return;
        // A scrollTop this session just wrote is already carried by the frame.
        // Only host-driven scrolling makes the sampled geometry stale.
        if (target === observedScroll && typewriter.ownsScroll(observedScroll.scrollTop)) return;
        break;
      }
      case "selectionchange":
        structure.activity(performance.now(), "selection");
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
    "pointerdown", "pointerup", "pointercancel", "click", "wheel", "touchmove", "scroll", "focusin", "focusout", "visibilitychange"]) {
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
    refresh() { blocked = false; ripple.invalidateColors(); refresh(); }, suspend,
    configure(next) {
      features = { ...next };
      structure.cancel("configure");
      if (!features.ripple) ripple.clear();
      if (!features.typewriter) typewriter.cancel();
      refresh();
    },
    destroy() {
      disposed = true;
      structure.cancel("destroy");
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
