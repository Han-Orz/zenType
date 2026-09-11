import { MOTION } from "./config";
import type { CursorRect, EditorFrame } from "./types";
import type { DebugRecorder } from "./debug/types";

export type MutationKind = "text" | "representation" | "structural" | "overflow";
export const STRUCTURE_LIMITS = { records: 256, nodes: 2048, depth: 64 } as const;
type IntentKind = "backspace" | "delete" | "other";

interface PendingStructure {
  generation: number;
  editor: HTMLElement;
  start: number;
  activity: number;
  evidence: "structural" | "overflow" | null;
  intent: IntentKind;
  inputObserved: boolean;
  nonStructuralObserved: boolean;
  textObserved: boolean;
  replacementObserved: boolean;
  stable: number;
  geometryPublished: boolean;
  caret: CursorRect | null;
  block: HTMLElement | null;
}

/** Includes marker identity, but markers are not semantic blocks. */
export function visualKey(element: HTMLElement): string | undefined {
  if (!element.classList.contains("protyle-action")) return element.dataset.nodeId;
  const parent = element.parentElement?.dataset.nodeId;
  return parent ? parent + ":action" : undefined;
}

/** Mutation records supply the *old* parent of a moved root; live parentElement cannot. */
export function classifyMutations(records: readonly MutationRecord[]) {
  const added: HTMLElement[] = [];
  const counts = new Map<string, number>();
  const removed = new Set<HTMLElement>();
  const inserted = new Set<HTMLElement>();
  let visited = 0;
  let semantic = false;
  let marker = false;
  let overflow = records.length > STRUCTURE_LIMITS.records;
  function parentId(node: Element | null): string {
    for (let depth = 0; node && depth < STRUCTURE_LIMITS.depth; depth++, node = node.parentElement) {
      if (node instanceof HTMLElement && node.dataset.nodeId) return node.dataset.nodeId;
    }
    if (node) overflow = true;
    return "";
  }
  function visit(node: Node, parent: string, delta: number, depth = 0) {
    if (++visited > STRUCTURE_LIMITS.nodes || depth >= STRUCTURE_LIMITS.depth) { overflow = true; return; }
    if (!(node instanceof HTMLElement)) return;
    if (node.classList.contains("protyle-action")) marker = true;
    if (delta > 0) added.push(node);
    if (node.dataset.nodeId && !node.classList.contains("protyle-action") && !node.classList.contains("protyle-attr")) {
      semantic = true;
      const key = parent + "\u0000" + node.dataset.nodeId;
      counts.set(key, (counts.get(key) ?? 0) + delta);
      (delta > 0 ? inserted : removed).add(node);
      parent = node.dataset.nodeId;
    }
    for (const child of node.children) {
      if (overflow) break;
      visit(child, parent, delta, depth + 1);
    }
  }
  for (const record of records) {
    if (overflow) break;
    if (record.type !== "childList") continue;
    const parent = parentId(record.target instanceof Element ? record.target : record.target.parentElement);
    for (const node of record.removedNodes) { if (overflow) break; visit(node, parent, -1); }
    for (const node of record.addedNodes) { if (overflow) break; visit(node, parent, 1); }
  }
  const moved = [...inserted].some(node => removed.has(node));
  const kind: MutationKind = overflow ? "overflow" : moved || [...counts.values()].some(value => value !== 0)
    ? "structural" : semantic || marker ? "representation" : "text";
  const textOnly = records.length > 0 && records.every(record => record.type === "characterData");
  return { kind, added, textOnly };
}

function hasSafeOrdinaryTextPosition(frame: EditorFrame | null, intent: IntentKind): boolean {
  if (intent !== "backspace" && intent !== "delete") return false;
  if (!frame || frame.selection !== "caret" || frame.caretless || !frame.caret ||
      !frame.editable || !frame.block || !frame.range?.collapsed) return false;
  const node = frame.range.startContainer;
  const value = node.nodeValue;
  if (node.nodeType !== 3 || typeof value !== "string" ||
      frame.range.startOffset <= 0 || frame.range.startOffset >= value.length) return false;
  if (!frame.editable.contains(node) || !frame.block.contains(node)) return false;
  for (let ancestor: HTMLElement | null = frame.block;
       ancestor && ancestor !== frame.editor; ancestor = ancestor.parentElement) {
    if (ancestor.dataset.type === "NodeListItem" || ancestor.dataset.type === "NodeList") return false;
  }
  return true;
}

/** Clock-free policy: Session owns observation, sampling, rAF and the deadline wake. */
export function createStructureGate(debug?: DebugRecorder) {
  let pending: PendingStructure | null = null;
  let nextGeneration = 0;
  function cancel(reason: string) {
    ZENTYPE_DEBUG: if (pending) debug?.record("session", "structure-cancel", { reason });
    pending = null;
  }
  function createPending(editor: HTMLElement, now: number, evidence: "structural" | "overflow" | null,
    intent: IntentKind): PendingStructure {
    return { generation: ++nextGeneration, editor, start: now, activity: now, evidence, intent,
      inputObserved: false, nonStructuralObserved: false, textObserved: false, replacementObserved: false,
      stable: 0, geometryPublished: false, caret: null, block: null };
  }
  function begin(editor: HTMLElement, now: number, evidence: "structural" | "overflow" | null) {
    if (pending?.editor !== editor) {
      pending = createPending(editor, now, evidence, "other");
      ZENTYPE_DEBUG: debug?.record("session", evidence ? "structure-begin" : "structure-intent",
        { now, generation: pending.generation, intent: pending.intent });
    }
  }
  function intent(editor: HTMLElement, now: number, kind: IntentKind = "other") {
    const previous = pending?.editor === editor ? pending : null;
    pending = createPending(editor, now, null, kind);
    ZENTYPE_DEBUG: if (previous) {
      debug?.record("session", "structure-generation-superseded", {
        now, from: previous.generation, to: pending.generation, intent: kind,
      });
    } else {
      debug?.record("session", "structure-intent", {
        now, generation: pending.generation, intent: kind,
      });
    }
  }
  function activity(now: number, reason: string) {
    if (!pending) return;
    pending.activity = now;
    pending.stable = 0;
    pending.geometryPublished = false;
    pending.caret = null;
    ZENTYPE_DEBUG: debug?.record("session", "structure-activity", { now, reason });
  }
  return {
    intent,
    mutation(editor: HTMLElement, now: number, kind: MutationKind, textOnly = false) {
      if (kind === "structural" || kind === "overflow") {
        begin(editor, now, kind);
        pending!.evidence = kind;
        ZENTYPE_DEBUG: debug?.record("session", "structure-evidence", { now, kind });
      } else if (pending) {
        pending.nonStructuralObserved = true;
        if (kind === "text" && textOnly) pending.textObserved = true;
        else pending.replacementObserved = true;
      }
      activity(now, kind);
    },
    activity,
    input() { if (pending) pending.inputObserved = true; },
    cancel,
    needsFrameSampling() { return pending?.evidence === "structural"; },
    remaining(now: number) {
      if (!pending) return 0;
      const ordinaryCandidate = pending.inputObserved && pending.nonStructuralObserved;
      const wakeAt = !pending.evidence && ordinaryCandidate
        ? pending.activity + MOTION.structureQuietMs
        : pending.start + MOTION.structureDeadlineMs;
      return Math.max(1, wakeAt - now);
    },
    sample(frame: EditorFrame | null, now: number): "ordinary" | "wait" | "geometry" | "commit" | "timeout" | "overflow" {
      if (!pending) return "ordinary";
      if (frame && (frame.editor !== pending.editor || frame.selection === "range")) {
        cancel(frame.selection === "range" ? "selection" : "editor-switch");
        return "ordinary";
      }
      if (pending.evidence === "overflow") { cancel("observation-limit"); return "overflow"; }
      const elapsed = now - pending.start;
      if (!pending.evidence) {
        const quiet = now - pending.activity;
        const candidate = pending.inputObserved && pending.nonStructuralObserved;
        // SiYuan schedules post-input normalization in a later task. Text evidence
        // therefore becomes ordinary only after a bounded quiet interval, not at
        // the first sample that happens to precede that task, unless a strict
        // characterData-only interior text position has already ruled out a
        // structural boundary for this Backspace/Delete intent.
        const fastPath = candidate && pending.textObserved && !pending.replacementObserved &&
          hasSafeOrdinaryTextPosition(frame, pending.intent);
        const confirmed = fastPath || candidate && quiet >= MOTION.structureQuietMs;
        const expired = elapsed >= MOTION.structureDeadlineMs;
        const decision = confirmed ? "ordinary" : expired ? "timeout" : "wait";
        const reason = fastPath ? "ordinary-delete-admitted" : confirmed ? "non-structural-quiet"
          : expired ? "intent-deadline-expired"
            : candidate ? "awaiting-post-input-quiet" : "awaiting-structural-evidence";
        ZENTYPE_DEBUG: debug?.record("session", "structure-sample", { now, elapsed, quiet, state: "intent",
          inputObserved: pending.inputObserved, nonStructuralObserved: pending.nonStructuralObserved,
          generation: pending.generation, intent: pending.intent, textObserved: pending.textObserved,
          replacementObserved: pending.replacementObserved, decision, reason });
        if (confirmed) {
          ZENTYPE_DEBUG: if (fastPath) debug?.record("session", "ordinary-delete-admitted", {
            now, generation: pending.generation, intent: pending.intent,
          });
          cancel(reason);
          return "ordinary";
        }
        if (expired) {
          ZENTYPE_DEBUG: debug?.record("session", "structure-timeout", {
            now, elapsed, state: "intent", generation: pending.generation,
          });
          pending = null;
          return "timeout";
        }
        return "wait";
      }
      const caret = frame?.caret ?? null;
      const previous = pending.caret;
      const same = caret && previous && frame?.block === pending.block &&
        Math.hypot(caret.x - previous.x, caret.y - previous.y) <= 0.15 && Math.abs(caret.height - previous.height) <= 0.15;
      pending.stable = caret ? same ? pending.stable + 1 : 1 : 0;
      pending.caret = caret && { ...caret };
      pending.block = frame?.block ?? null;
      const quiet = now - pending.activity;
      const geometryReady = !!frame && frame.selection === "caret" && frame.caretless !== true && pending.stable >= 2;
      const semanticReady = geometryReady && quiet >= MOTION.structureQuietMs;
      if (!geometryReady) pending.geometryPublished = false;
      if (geometryReady && !pending.geometryPublished) {
        pending.geometryPublished = true;
        ZENTYPE_DEBUG: debug?.record("session", "structure-geometry-ready", {
          now, quiet, stableFrames: pending.stable, generation: pending.generation,
          caret: caret ? { ...caret } : null, block: frame?.block?.dataset.nodeId ?? null,
        });
      }
      const expired = elapsed >= MOTION.structureDeadlineMs;
      const decision = semanticReady ? "commit" : expired ? "timeout" : geometryReady ? "geometry" : "wait";
      const reason = semanticReady ? "quiet-and-stable" : geometryReady ? "awaiting-semantic-quiet"
        : "awaiting-stable-geometry";
      ZENTYPE_DEBUG: debug?.record("session", "structure-sample", { now, quiet, stableFrames: pending.stable,
        state: "structural", evidence: pending.evidence, generation: pending.generation,
        caret: caret ? { ...caret } : null, geometryReady, semanticReady, decision, reason });
      if (semanticReady || expired) {
        const result = semanticReady ? "commit" : "timeout";
        ZENTYPE_DEBUG: debug?.record("session", semanticReady ? "structure-stable" : "structure-timeout", {
          now, elapsed, generation: pending.generation,
        });
        pending = null;
        return result;
      }
      return geometryReady ? "geometry" : "wait";
    },
  };
}
