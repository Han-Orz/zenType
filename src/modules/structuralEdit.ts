import * as inputMode from "./inputMode";

export type StructuralEditKind =
  | "enter"
  | "backspace"
  | "delete-forward"
  | "list-change"
  | "history"
  | "cut-drag"
  | "unknown";

export type StructuralEditPhase = "idle" | "mutating" | "stabilizing";

export interface StructuralEditSnapshot {
  generation: number;
  phase: StructuralEditPhase;
  kind: StructuralEditKind | null;
  editor: HTMLElement | null;
}

export interface StructuralEditFinish {
  generation: number;
  kind: StructuralEditKind;
  editor: HTMLElement;
  stable: boolean;
}

const REQUIRED_QUIET_FRAMES = 2;
const MAX_SETTLE_FRAMES = 8;

let initialized = false;
let generation = 0;
let phase: StructuralEditPhase = "idle";
let activeKind: StructuralEditKind | null = null;
let activeEditor: HTMLElement | null = null;
let activityVersion = 0;
let observedActivityVersion = 0;
let quietFrames = 0;
let settleFrames = 0;
let settleFrame: number | null = null;
let mutationObserver: MutationObserver | null = null;
let selectionChangeListener: (() => void) | null = null;
let inputModeUnsubscribe: (() => void) | null = null;

const finishSubscribers = new Set<(finish: StructuralEditFinish) => void>();

function onInputModeChange(state: { focusActive: boolean; typewriterActive: boolean }): void {
  if (!state.focusActive && !state.typewriterActive) resetStructuralEdit();
}

function bindInputModeSubscription(): void {
  // inputMode.reset() clears its subscriber set during test/plugin teardown.
  // Rebinding at the next transaction keeps the coordinator safe for a later
  // init without making feature modules own the shared transaction reset.
  inputModeUnsubscribe?.();
  inputModeUnsubscribe = inputMode.subscribe(onInputModeChange);
}

function detachTransactionResources(): void {
  if (settleFrame !== null) {
    cancelAnimationFrame(settleFrame);
    settleFrame = null;
  }
  mutationObserver?.disconnect();
  mutationObserver = null;
  if (selectionChangeListener !== null && typeof document !== "undefined") {
    document.removeEventListener("selectionchange", selectionChangeListener);
    selectionChangeListener = null;
  }
}

function resetState(): void {
  phase = "idle";
  activeKind = null;
  activeEditor = null;
  activityVersion = 0;
  observedActivityVersion = 0;
  quietFrames = 0;
  settleFrames = 0;
}

function finish(stable: boolean, token: number): void {
  if (token !== generation || phase === "idle" || !activeKind || !activeEditor) return;

  const result: StructuralEditFinish = {
    generation: token,
    kind: activeKind,
    editor: activeEditor,
    stable,
  };
  detachTransactionResources();
  resetState();

  finishSubscribers.forEach((listener) => {
    try {
      listener(result);
    } catch (error) {
      console.error("[zenType] structural edit subscriber threw:", error);
    }
  });
}

function checkStable(token: number): void {
  if (token !== generation || phase === "idle") return;

  settleFrames++;
  if (activityVersion !== observedActivityVersion) {
    observedActivityVersion = activityVersion;
    quietFrames = 0;
    phase = "mutating";
  } else {
    quietFrames++;
    phase = "stabilizing";
  }

  if (quietFrames >= REQUIRED_QUIET_FRAMES) {
    finish(true, token);
    return;
  }
  if (settleFrames >= MAX_SETTLE_FRAMES) {
    finish(false, token);
    return;
  }

  if (typeof requestAnimationFrame !== "function") {
    finish(false, token);
    return;
  }
  settleFrame = requestAnimationFrame(() => checkStable(token));
}

function attachTransactionResources(token: number): void {
  const editor = activeEditor;
  if (!editor) return;

  if (typeof MutationObserver !== "undefined") {
    mutationObserver = new MutationObserver(() => {
      if (token === generation) noteStructuralActivity(editor);
    });
    mutationObserver.observe(editor, { childList: true, subtree: true });
  }

  if (typeof document !== "undefined") {
    selectionChangeListener = () => {
      if (token !== generation || phase === "idle") return;
      const selection = typeof window !== "undefined" ? window.getSelection() : null;
      if (!selection || selection.rangeCount === 0 || !selection.anchorNode) return;
      if (editor.contains(selection.anchorNode)) noteStructuralActivity(editor);
    };
    document.addEventListener("selectionchange", selectionChangeListener);
  }

  if (typeof requestAnimationFrame === "function") {
    settleFrame = requestAnimationFrame(() => checkStable(token));
  } else {
    finish(false, token);
  }
}

export function initStructuralEditCoordinator(): void {
  if (initialized) return;
  initialized = true;
  bindInputModeSubscription();
}

export function destroyStructuralEditCoordinator(): void {
  resetStructuralEdit();
  initialized = false;
  inputModeUnsubscribe?.();
  inputModeUnsubscribe = null;
  finishSubscribers.clear();
}

export function beginStructuralEdit(
  kind: StructuralEditKind,
  editor: HTMLElement,
): number {
  if (!initialized) initStructuralEditCoordinator();
  bindInputModeSubscription();
  detachTransactionResources();

  generation++;
  phase = "mutating";
  activeKind = kind;
  activeEditor = editor;
  activityVersion++;
  observedActivityVersion = activityVersion;
  quietFrames = 0;
  settleFrames = 0;
  attachTransactionResources(generation);
  return generation;
}

export function noteStructuralActivity(editor?: HTMLElement | null): void {
  if (phase === "idle") return;
  if (editor && editor !== activeEditor) return;
  activityVersion++;
  quietFrames = 0;
  phase = "mutating";
}

export function isStructuralEditPending(): boolean {
  return phase !== "idle";
}

export function getStructuralEditSnapshot(): StructuralEditSnapshot {
  return {
    generation,
    phase,
    kind: activeKind,
    editor: activeEditor,
  };
}

export function subscribeStructuralEditFinish(
  listener: (finish: StructuralEditFinish) => void,
): () => void {
  finishSubscribers.add(listener);
  return () => finishSubscribers.delete(listener);
}

export function resetStructuralEdit(): void {
  generation++;
  detachTransactionResources();
  resetState();
}

export function structuralKindFromInputType(inputType: string): StructuralEditKind | null {
  switch (inputType) {
    case "insertParagraph":
    case "insertLineBreak":
      return "enter";
    case "insertOrderedList":
    case "insertUnorderedList":
    case "formatBlock":
    case "formatIndent":
    case "formatOutdent":
      return "list-change";
    case "historyUndo":
    case "historyRedo":
      return "history";
    case "deleteByCut":
    case "deleteByDrag":
      return "cut-drag";
    default:
      return null;
  }
}
