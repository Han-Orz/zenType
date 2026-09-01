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
  transactionStartedAt: number | null;
  lastActivityAt: number | null;
  activityVersion: number;
  quietFrames: number;
  settleFrames: number;
}

export interface StructuralEditFinish {
  generation: number;
  kind: StructuralEditKind;
  editor: HTMLElement;
  stable: boolean;
  transactionStartedAt: number;
  lastActivityAt: number;
  finishedAt: number;
  quietFrames: number;
  settleFrames: number;
}

const REQUIRED_QUIET_FRAMES = 2;
// Evidence-backed provisional host threshold. Keep this internal until a new
// clean DebugHook capture confirms the host's trailing-edge quiet period.
const MIN_STABLE_QUIET_MS = 48;
const MAX_SETTLE_MS = 128;

export type SemanticMutationClassification = "structural" | "representation";

type SemanticNodeReference = {
  id: string;
  element: Element;
};

type SemanticMutationGroup = {
  added: SemanticNodeReference[];
  removed: SemanticNodeReference[];
};

function elementFromNode(node: Node | null | undefined): Element | null {
  return node && node.nodeType === 1 ? node as Element : null;
}

function childrenOf(element: Element): Element[] {
  return element.children ? Array.from(element.children) : [];
}

function attributeOf(element: Element, name: string): string | null {
  try {
    return element.getAttribute(name);
  } catch {
    return null;
  }
}

function hasClass(element: Element, name: string): boolean {
  return element.classList?.contains(name) === true;
}

function isSemanticBlock(element: Element): boolean {
  if (!attributeOf(element, "data-node-id")) return false;
  if (hasClass(element, "protyle-action") || hasClass(element, "protyle-attr")) return false;
  const tagName = typeof element.tagName === "string" ? element.tagName.toLowerCase() : "";
  return tagName !== "svg" && tagName !== "use";
}

function semanticRoots(node: Node): SemanticNodeReference[] {
  const element = elementFromNode(node);
  if (!element) return [];

  if (isSemanticBlock(element)) {
    return [{ id: attributeOf(element, "data-node-id") as string, element }];
  }

  const roots: SemanticNodeReference[] = [];
  for (const child of childrenOf(element)) roots.push(...semanticRoots(child));
  return roots;
}

function belongsToEditor(editor: HTMLElement | null, node: Node): boolean {
  if (!editor) return true;
  if (node === editor) return true;
  try {
    return editor.contains(node);
  } catch {
    return false;
  }
}

function parentKey(element: Element): Element | string {
  return attributeOf(element, "data-node-id") ?? element;
}

function countById(references: readonly SemanticNodeReference[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const reference of references) {
    counts.set(reference.id, (counts.get(reference.id) ?? 0) + 1);
  }
  return counts;
}

function hasMovedSemanticNode(
  added: readonly SemanticNodeReference[],
  removed: readonly SemanticNodeReference[],
): boolean {
  return added.some((candidate) => removed.some((previous) => (
    candidate.id === previous.id && candidate.element === previous.element
  )));
}

/**
 * Classify child-list mutations by semantic topology rather than DOM churn.
 * Replacing a block representation with another element carrying the same
 * node id under the same semantic parent is intentionally representation-only.
 */
export function classifySemanticMutations(
  records: readonly MutationRecord[],
  editor: HTMLElement | null = null,
): SemanticMutationClassification {
  const groups = new Map<Element | string, SemanticMutationGroup>();

  for (const record of records) {
    if (record.type !== "childList") continue;
    const target = elementFromNode(record.target);
    if (!target || !belongsToEditor(editor, target)) continue;

    const added = Array.from(record.addedNodes).flatMap((node) => semanticRoots(node));
    const removed = Array.from(record.removedNodes).flatMap((node) => semanticRoots(node));
    if (added.length === 0 && removed.length === 0) continue;

    const key = parentKey(target);
    const group = groups.get(key) ?? { added: [], removed: [] };
    group.added.push(...added);
    group.removed.push(...removed);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    if (hasMovedSemanticNode(group.added, group.removed)) return "structural";

    const addedCounts = countById(group.added);
    const removedCounts = countById(group.removed);
    const ids = new Set([...addedCounts.keys(), ...removedCounts.keys()]);
    for (const id of ids) {
      if ((addedCounts.get(id) ?? 0) !== (removedCounts.get(id) ?? 0)) {
        return "structural";
      }
    }

    // Equal id counts under one semantic parent are representation replacement
    // (remove A + add A). Reordering/reparenting the same DOM node is caught by
    // hasMovedSemanticNode above; a different parent produces an unmatched
    // add/remove count in separate groups.
  }

  return "representation";
}

/** Whether a mutation batch changes semantic block topology. */
export function hasSemanticBlockMutation(
  records: readonly MutationRecord[],
  editor: HTMLElement | null = null,
): boolean {
  return classifySemanticMutations(records, editor) === "structural";
}

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
let transactionStartedAt: number | null = null;
let lastActivityAt: number | null = null;

const finishSubscribers = new Set<(finish: StructuralEditFinish) => void>();

function safeMonotonicNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    try {
      const value = performance.now();
      if (Number.isFinite(value)) return value;
    } catch {
      // Fall through to the safe sentinel below.
    }
  }
  return 0;
}

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
  transactionStartedAt = null;
  lastActivityAt = null;
}

function finish(stable: boolean, token: number): void {
  if (token !== generation || phase === "idle" || !activeKind || !activeEditor) return;

  const finishedAt = safeMonotonicNow();
  const result: StructuralEditFinish = {
    generation: token,
    kind: activeKind,
    editor: activeEditor,
    stable,
    transactionStartedAt: transactionStartedAt ?? finishedAt,
    lastActivityAt: lastActivityAt ?? finishedAt,
    finishedAt,
    quietFrames,
    settleFrames,
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

  const now = safeMonotonicNow();
  settleFrames++;
  if (activityVersion !== observedActivityVersion) {
    observedActivityVersion = activityVersion;
    quietFrames = 0;
    phase = "mutating";
  } else {
    quietFrames++;
    phase = "stabilizing";
  }

  const timeQuiet = lastActivityAt !== null && now - lastActivityAt >= MIN_STABLE_QUIET_MS;
  if (quietFrames >= REQUIRED_QUIET_FRAMES && timeQuiet) {
    finish(true, token);
    return;
  }

  const transactionElapsed = transactionStartedAt !== null ? now - transactionStartedAt : 0;
  if (transactionStartedAt !== null && transactionElapsed >= MAX_SETTLE_MS) {
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
      if (!selection || selection.rangeCount === 0) return;
      const anchorInside = selection.anchorNode ? editor.contains(selection.anchorNode) : false;
      const focusInside = selection.focusNode ? editor.contains(selection.focusNode) : false;
      if (anchorInside || focusInside) noteStructuralActivity(editor);
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
  const now = safeMonotonicNow();
  transactionStartedAt = now;
  lastActivityAt = now;
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
  lastActivityAt = safeMonotonicNow();
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
    transactionStartedAt,
    lastActivityAt,
    activityVersion,
    quietFrames,
    settleFrames,
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
