import { MOTION } from "./config";
import type { Features, EditorFrame } from "./types";
import { editableAt, readEditorFrame } from "./utils/editorScope";
import { createCursor, type CursorIntent } from "./modules/cursor";
import { createTypewriter } from "./modules/typewriter";
import { createRipple } from "./modules/ripple";
import type { DebugRecorder } from "./debug/types";
import { classifyMutations, createStructureGate, semanticBlockKey, STRUCTURE_LIMITS } from "./structure";

type SelectionMode = "unknown" | "caret" | "range";
interface SelectionHandoff {
  editable: HTMLElement;
  editor: HTMLElement;
  blockKey: string | null;
  block: HTMLElement | null;
}

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
  let cursorTargetIntent: CursorIntent = "navigation";
  let selectionMode: SelectionMode = "unknown";
  let selectionHandoff: SelectionHandoff | null = null;
  // Events that change the logical caret leave one pending authority bit until
  // Session admits a frame. Viewport-only invalidations deliberately do not set it.
  let targetAuthorityPending = false;
  let structuralGeometryGeneration: number | null = null;

  function cursorTargetIntentFor(now: number, structural = false): CursorIntent {
    if (structural) {
      cursorTargetIntent = "structural";
      return cursorTargetIntent;
    }
    if (cursorTargetIntent === "typing" && now - lastInput >= MOTION.typingPauseMs) cursorTargetIntent = "navigation";
    return cursorTargetIntent;
  }

  function readSelectionMode(): "caret" | "range" | null {
    const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
    if (selection) return selection.isCollapsed ? "caret" : "range";
    if (frame?.selection === "caret" || frame?.selection === "range") return frame.selection;
    return null;
  }

  function captureCollapsedSelection(): SelectionHandoff | null {
    const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
    const node = selection?.isCollapsed ? selection.focusNode : null;
    if (!node || !node.isConnected) return null;
    const element = node instanceof Element ? node : node.parentElement;
    const editable = editableAt(node);
    const editor = editable?.closest<HTMLElement>(".protyle-wysiwyg") ?? null;
    if (!editable || !editor) return null;
    const block = element?.closest<HTMLElement>("[data-node-id]") ?? null;
    return { editable, editor, blockKey: semanticBlockKey(block), block };
  }

  /**
   * The Host root a list indent actually moves. A list item is reparented as a
   * whole, so its marker and any nested list have to travel with the text.
   */
  function structuralMoveRoot(block: HTMLElement | null): HTMLElement | null {
    return block ? block.closest<HTMLElement>('[data-type="NodeListItem"]') ?? block : null;
  }

  /**
   * The caret is attached to the glyphs, so a structural slide is presented on
   * the caret too. `frame.caret` stays the Host's untransformed truth; this adds
   * back only the transform the presentation is currently showing.
   */
  function presentedFrame(source: EditorFrame, offset: { x: number; y: number } | null): EditorFrame {
    if (!offset || !source.caret) return source;
    return { ...source, caret: { ...source.caret, x: source.caret.x + offset.x, y: source.caret.y + offset.y } };
  }

  function blockKeyForStructuralIntent(editable: HTMLElement, editor: HTMLElement): string | null | undefined {
    if (selectionMode === "range") {
      return selectionHandoff?.editable === editable && selectionHandoff.editor === editor
        ? selectionHandoff.blockKey : null;
    }
    return undefined;
  }

  /**
   * The live collapsed Selection's semantic block when it belongs to the observed
   * editor. `null` means "unknown", never "no focus".
   */
  function focusedSelectionKey(): string | null {
    const handoff = captureCollapsedSelection();
    return handoff && handoff.editor === observedEditor ? handoff.blockKey : null;
  }

  function noteSampledSelection(next: EditorFrame | null) {
    if (next?.selection === "range") {
      selectionMode = "range";
      selectionHandoff = null;
    } else if (next?.selection === "caret" && selectionMode !== "range") {
      selectionMode = "caret";
    }
  }

  function acceptSelectionAuthority(next: EditorFrame | null) {
    if (next?.selection !== "caret") return;
    selectionMode = "caret";
    selectionHandoff = null;
  }

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
    ZENTYPE_DEBUG: debug?.record("session", "wake-scheduled", { delay });
    wake = setTimeout(() => { wake = null; geometryDirty = true; queue(); }, delay);
  }
  function remember(records: MutationRecord[]) {
    if (!records.length) return;
    ZENTYPE_DEBUG: debug?.recordMutations(records, frame);
    const changes = classifyMutations(records);
    if (changes.kind !== "text") structureDirty = true;
    if (changes.kind === "text" || changes.kind === "representation") targetAuthorityPending = true;
    if (observedEditor && !blocked && !pointerDown) {
      structure.mutation(observedEditor, performance.now(), changes.kind, changes.textOnly);
      if (changes.kind === "representation" || changes.kind === "structural") {
        // A structural topology change can replace the destination element under
        // the same semantic key while its Ripple role changes from dim neighbour
        // to focused. The Host has already restored the collapsed Selection into
        // the final block by the time this microtask runs, so its semantic key is
        // the evidence for that role change. Only the key crosses the boundary;
        // Ripple decides that the old non-focused presentation role is stale.
        const focusedKey = changes.kind === "structural" ? focusedSelectionKey() : null;
        const carry = ripple.rebind(changes.added, focusedKey);
        ripple.freeze();
        carry();
      }
    }
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
  // A suspension that leaves the renderer visible retargets Ripple from its
  // current presentation to neutral and lets the existing motion finish. Only a
  // hidden document, which cannot show the release, tears the owners down.
  function releaseRipple() {
    if (!frame) return;
    const release = ripple.sample(frame, false, false, false);
    release();
    if (ripple.render(performance.now(), reducedMotion.matches) && !document.hidden) queue();
  }

  function suspend(immediate = false) {
    ZENTYPE_DEBUG: debug?.record("session", "suspend", { reason: "lifecycle" });
    const wasBlocked = blocked;
    blocked = true;
    structure.cancel("lifecycle");
    composingEditor = null;
    cursorTargetIntent = "navigation";
    selectionMode = "unknown";
    selectionHandoff = null;
    targetAuthorityPending = false;
    structuralGeometryGeneration = null;
    stopWriting();
    cursor.hide();
    if (immediate || document.hidden) ripple.clear();
    else if (frame) releaseRipple();
    else if (!wasBlocked) ripple.clear();
    // A blocked Session stops advancing the slide, so it must not leave the Host
    // element translated by a presentation offset nobody will finish.
    ripple.cancelStructuralMove();
    frame = null;
    observe(null);
  }

  function suspendForWindowBlur() {
    ZENTYPE_DEBUG: debug?.record("session", "suspend", { reason: "window-blur", preserveCursor: true });
    blocked = true;
    structure.cancel("lifecycle");
    composingEditor = null;
    cursorTargetIntent = "navigation";
    selectionMode = "unknown";
    selectionHandoff = null;
    targetAuthorityPending = false;
    structuralGeometryGeneration = null;
    stopWriting();
    if (pending !== null) cancelAnimationFrame(pending);
    pending = null;
    // Losing OS focus does not make the renderer invisible: the dim Ripple keeps
    // its Cursor presentation and releases from its current value instead of
    // snapping every owner to neutral in one frame.
    if (document.hidden) ripple.clear();
    else releaseRipple();
    ripple.cancelStructuralMove();
    cleanClones();
    frame = null;
    observe(null);
  }

  function update(rafTimestamp: number) {
    pending = null;
    if (disposed) return;
    // Event, observer and frame decisions share one monotonic clock. A host may
    // expose an rAF timestamp with a stable offset from performance.now().
    const now = performance.now();
    try {
      ZENTYPE_DEBUG: debug?.record("session", "frame-start", {
        now,
        clockNow: now,
        rafTimestamp,
        rafSkewMs: rafTimestamp - now,
        blocked,
        hidden: document.hidden,
        geometryDirty,
        contentDirty,
        structureDirty,
      });
      remember(mutation.takeRecords());
      if (blocked || document.hidden) {
        ZENTYPE_DEBUG: debug?.record("session", "frame-skipped", { reason: blocked ? "blocked" : "hidden" });
        cleanClones();
        if (blocked && ripple.render(now, reducedMotion.matches) && !document.hidden) queue();
        return;
      }
      let sampled = false;
      let authoritativeTarget = false;
      // One bounded structural slide is advanced once per Session frame, before
      // any path below consumes the caret it carries. The returned offset is
      // exactly what the Host element is presenting this frame.
      const structuralOffset = ripple.stepStructuralMove(now, reducedMotion.matches);
      // A typewriter frame only moves the container: the frame already transports
      // the caret and the cursor by that displacement, so re-reading host geometry
      // every frame of a comfort scroll is redundant work.
      if (geometryDirty) {
        sampled = true;
        const next = readEditorFrame(reducedMotion.matches, composingEditor, frame?.editor);
        geometryDirty = false;
        // The Host element is currently presenting the structural transform, and
        // the caret rect includes it. Remove it here so the Structural Contract
        // and every stored frame keep consuming untransformed Host truth.
        if (structuralOffset && next?.caret) {
          next.caret = { ...next.caret,
            x: next.caret.x - structuralOffset.x, y: next.caret.y - structuralOffset.y };
        }
        noteSampledSelection(next);
        if (next && frame && next.editor !== frame.editor) structure.cancel("editor-switch");
        const decision = structure.sample(next, now);
        const handoff = structure.handoff();
        // Sentence presentation only needs the current focused block, editable
        // text and collapsed Range, so it can commit on the first authoritative
        // structural frame instead of waiting for topology quiet. The block
        // neighborhood still waits for the semantic commit. The frame's content
        // evidence travels with it: a host that rewrites the block's text nodes
        // leaves the registered Highlight ranges collapsed at an element boundary,
        // where they paint nothing until the next projection.
        if (next && (decision === "wait" || decision === "geometry")) {
          if (ripple.presentSentences(next, now, reducedMotion.matches, contentDirty)) queue();
        }
        if (decision === "geometry") {
          // Geometry-ready gives Cursor its caret. Ripple stays held until the
          // semantic commit; the Structural Contract's identity readiness is
          // evidence, not a destination opacity command.
          ripple.freeze();
          typewriter.cancel();
          if (!next) {
            geometryDirty = true;
            queue();
            return;
          }
          acceptSelectionAuthority(next);
          frame = next;
          observe(frame);
          const writing = writingEditor === frame.editor;
          const composing = composingEditor === frame.editor;
          const intent = cursorTargetIntentFor(now, handoff?.topologyChanged === true);
          structuralGeometryGeneration = handoff?.generation ?? structuralGeometryGeneration;
          targetAuthorityPending = false;
          // The Host layout is committed, so this is the one moment that may read
          // the new position and start the slide. Cursor and text share the
          // resulting offset, so the caret never separates from its glyphs.
          const started = ripple.beginStructuralMove(structuralMoveRoot(frame.block), reducedMotion.matches);
          const cursorMoving = cursor.render(presentedFrame(frame, started ?? structuralOffset), now, intent,
            pointerDown || now - lastInteraction < MOTION.interactionHoldMs,
            { authoritativeTarget: true });
          const settling = cursor.isSettling();
          if (intent === "structural" && cursor.isTargetSettled() && !settling) cursorTargetIntent = "navigation";
          geometryDirty = true;
          cleanClones();
          if (cursorMoving || settling || structure.needsFrameSampling() || started) queue();
          return;
        }
        if (decision === "wait") {
          // Existing visual owners were rebound in the mutation microtask. No
          // effect may consume a new target or write scrollTop until the shared
          // gate publishes an authoritative frame.
          ripple.freeze();
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
            targetAuthorityPending = false;
            cursor.hide(); cursorTargetIntent = "navigation";
            ripple.clear(); stopWriting(); cleanClones();
            frame = next;
            observe(next);
            ZENTYPE_DEBUG: debug?.record("session", "structure-release", { now, reason: decision });
            return;
          }
          // A generation that already published geometry keeps that target's
          // provenance through semantic commit. A direct geometry+semantic sample
          // is the only commit that still admits a fresh target here.
          authoritativeTarget = !!next?.caret && handoff?.generation !== structuralGeometryGeneration;
          structuralGeometryGeneration = handoff?.generation ?? structuralGeometryGeneration;
          targetAuthorityPending = false;
          if (handoff?.topologyChanged === true) cursorTargetIntent = "structural";
          ZENTYPE_DEBUG: debug?.record("session", "structure-commit", {
            now, authority: "quiet-and-stable", generation: handoff?.generation ?? null,
            topologyChanged: handoff?.topologyChanged ?? false,
            fromBlockKey: handoff?.fromBlockKey ?? null, toBlockKey: handoff?.toBlockKey ?? null,
          });
        }
        if (decision === "ordinary" && next?.caret && (targetAuthorityPending || frame === null)) {
          authoritativeTarget = true;
          targetAuthorityPending = false;
        }
        if (!next) {
          ZENTYPE_DEBUG: debug?.record("session", "frame-missing", {
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
          cursorTargetIntent = "navigation";
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
          cursorTargetIntent = "navigation";
          targetAuthorityPending = true;
          ripple.clear();
          typewriter.cancel();
          if (writingEditor !== next.editor) writingEditor = null;
          if (composingEditor !== next.editor) composingEditor = null;
        }
        frame = next;
        acceptSelectionAuthority(next);
        ZENTYPE_DEBUG: debug?.recordFrame(next, {
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
        ZENTYPE_DEBUG: debug?.record("session", "frame-commit", {
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
      const intent = cursorTargetIntentFor(now);
      const cursorMoving = cursor.render(presentedFrame(frame, structuralOffset), now, intent,
        pointerDown || now - lastInteraction < MOTION.interactionHoldMs,
        { authoritativeTarget });
      const settling = cursor.isSettling();
      if (intent === "structural" && cursor.isTargetSettled() && !settling) cursorTargetIntent = "navigation";
      if (settling) geometryDirty = true;
      commitRipple?.();
      cleanClones();
      contentDirty = structureDirty = false;
      const rippleMoving = ripple.render(now, reducedMotion.matches);
      ZENTYPE_DEBUG: debug?.record("typewriter", "frame", {
        now,
        requestedScroll: requested,
        actualScroll: actual,
        moving: typewriter.isMoving(),
        locating: typewriter.isLocating(),
        ...typewriter.motionTelemetry(),
      });
      ZENTYPE_DEBUG: debug?.record("session", "frame-commit", {
        now,
        selection: frame.selection,
        sampled,
        cursorMoving,
        rippleMoving,
        typewriterMoving: typewriter.isMoving(),
        settling,
      });
      if (cursorMoving || typewriter.isMoving() || rippleMoving || settling || structuralOffset) queue();
      else if ((wake === null || !frame.caret) && !composing) {
        // Recovery, typing pauses and cursor breathing share the idle wake.
        const cursorDelay = reducedMotion.matches ? Infinity : cursor.wakeDelay(now) ?? Infinity;
        const pauseDelay = writing && now - lastInput < MOTION.typingPauseMs
          ? MOTION.typingPauseMs + 1 - (now - lastInput) : Infinity;
        const delay = Math.min(cursorDelay, pauseDelay, !frame.caret ? cursor.recoveryDelay(now) ?? Infinity : Infinity);
        if (Number.isFinite(delay)) wakeAfter(delay);
      }
    } catch (error) {
      ZENTYPE_DEBUG: debug?.record("session", "frame-error", { message: error instanceof Error ? error.message : String(error) });
      suspend(true);
      console.error("[zenType] presentation released after frame failure", error);
    }
  }

  function activate(editable: HTMLElement) {
    writingEditor = editable.closest<HTMLElement>(".protyle-wysiwyg");
    lastInput = performance.now();
    wakeAfter(MOTION.typingPauseMs + 1);
  }
  function handle(event: Event) {
    ZENTYPE_DEBUG: debug?.recordEvent(event, frame);
    const editable = editableAt(event.target);
    if (["keydown", "pointerdown", "pointerup", "wheel", "touchmove", "scroll"].includes(event.type)) lastInteraction = performance.now();
    switch (event.type) {
      case "click":
        if (editable && !composingEditor && !(event as MouseEvent).shiftKey &&
            (event as MouseEvent).detail <= 1 && window.getSelection()?.isCollapsed &&
            !(event.target as Element).closest('[data-type="a"], a, button')) {
          clickEditor = editable.closest<HTMLElement>(".protyle-wysiwyg");
          cursorTargetIntent = "navigation";
          targetAuthorityPending = true;
        }
        break;
      case "focusin":
        if (editable) {
          blocked = false;
          targetAuthorityPending = true;
          retryUntil = performance.now() + MOTION.recoveryMs;
        }
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
          const editor = editable.closest<HTMLElement>(".protyle-wysiwyg")!;
          structure.intent(editor, performance.now(), "other", blockKeyForStructuralIntent(editable, editor));
        }
        if (event.type === "input") {
          cursorTargetIntent = "typing";
          targetAuthorityPending = true;
          structure.input();
        }
        structure.activity(performance.now(), event.type);
        if ((event as InputEvent).isComposing) composingEditor = editable.closest<HTMLElement>(".protyle-wysiwyg");
        break;
      case "keydown": {
        const key = event as KeyboardEvent;
        if (!editable || key.defaultPrevented) return;
        blocked = false;
        if (key.isComposing) break;
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", "Escape"].includes(key.key)) {
          cursorTargetIntent = "navigation";
          targetAuthorityPending = true;
          structure.cancel("navigation");
        }
        if (["ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(key.key)) {
          stopWriting();
        }
        if (!key.ctrlKey && !key.metaKey && !key.altKey && ["Enter", "Backspace", "Delete", "Tab"].includes(key.key)) {
          activate(editable);
          targetAuthorityPending = false;
          const now = performance.now();
          retryUntil = now + MOTION.recoveryMs;
          const intent = key.key === "Backspace" ? "backspace" : key.key === "Delete" ? "delete"
            : key.key === "Tab" ? key.shiftKey ? "outdent" : "indent" : "other";
          const editor = editable.closest<HTMLElement>(".protyle-wysiwyg")!;
          structure.intent(editor, now, intent, blockKeyForStructuralIntent(editable, editor));
          // A list indent reparents Host DOM, so the position the user is looking
          // at has to be read before the mutation. This is the only geometry read
          // the structural slide adds, and it is bounded to the focused item.
          if (intent === "indent" || intent === "outdent") {
            ripple.captureStructuralMove(structuralMoveRoot(captureCollapsedSelection()?.block ?? null));
          }
        }
        break;
      }
      case "compositionstart":
        if (!editable) return;
        blocked = false;
        structure.cancel("composition");
        composingEditor = editable.closest<HTMLElement>(".protyle-wysiwyg");
        cursorTargetIntent = "typing";
        activate(editable);
        typewriter.cancel();
        break;
      case "compositionend":
        composingEditor = null;
        if (editable) {
          blocked = false;
          cursorTargetIntent = "typing";
          targetAuthorityPending = true;
          activate(editable);
        }
        contentDirty = true;
        retryUntil = performance.now() + MOTION.recoveryMs;
        break;
      case "pointerdown":
        pointerDown = true;
        cursorTargetIntent = "navigation";
        targetAuthorityPending = false;
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
        cursorTargetIntent = "navigation";
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
      case "selectionchange": {
        const now = performance.now();
        const previous = selectionMode;
        const next = readSelectionMode();
        if (next === "range") {
          selectionMode = "range";
          selectionHandoff = null;
          targetAuthorityPending = false;
          cursorTargetIntent = "navigation";
          structure.cancel("selection");
        } else if (next === "caret") {
          const collapsedAfterRange = previous === "range" || previous === "unknown" && frame?.selection === "range";
          if (collapsedAfterRange) {
            selectionMode = "range";
            selectionHandoff = captureCollapsedSelection();
            targetAuthorityPending = true;
            structure.cancel("selection-collapse");
          } else {
            selectionMode = "caret";
            selectionHandoff = null;
            targetAuthorityPending = true;
          }
        }
        structure.activity(now, "selection");
        break;
      }
      case "blur":
        pointerDown = false;
        suspendForWindowBlur();
        return;
      case "visibilitychange":
        if (document.hidden) { pointerDown = false; suspend(); return; }
        blocked = false;
        targetAuthorityPending = true;
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
  window.addEventListener("focus", () => { blocked = false; targetAuthorityPending = true; refresh(); }, { signal: listeners.signal });
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
