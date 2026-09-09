import { MOTION } from "./config";
import type { CursorRect, EditorFrame } from "./types";
import type { DebugRecorder } from "./debug/types";

export type MutationKind = "text" | "representation" | "structural" | "overflow";
export const STRUCTURE_LIMITS = { records: 256, nodes: 2048, depth: 64 } as const;

interface PendingStructure {
  editor: HTMLElement;
  start: number;
  activity: number;
  evidence: "structural" | "overflow" | null;
  inputObserved: boolean;
  nonStructuralObserved: boolean;
  stable: number;
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
  return { kind, added };
}

/** Clock-free policy: Session owns observation, sampling, rAF and the deadline wake. */
export function createStructureGate(debug?: DebugRecorder) {
  let pending: PendingStructure | null = null;
  function cancel(reason: string) {
    ZENTYPE_DEBUG: if (pending) debug?.record("session", "structure-cancel", { reason });
    pending = null;
  }
  function begin(editor: HTMLElement, now: number, evidence: "structural" | "overflow" | null) {
    if (pending?.editor !== editor) {
      pending = { editor, start: now, activity: now, evidence, inputObserved: false,
        nonStructuralObserved: false, stable: 0, caret: null, block: null };
      ZENTYPE_DEBUG: debug?.record("session", evidence ? "structure-begin" : "structure-intent", { now });
    }
  }
  function activity(now: number, reason: string) {
    if (!pending) return;
    pending.activity = now;
    pending.stable = 0;
    pending.caret = null;
    ZENTYPE_DEBUG: debug?.record("session", "structure-activity", { now, reason });
  }
  return {
    intent(editor: HTMLElement, now: number) { begin(editor, now, null); },
    mutation(editor: HTMLElement, now: number, kind: MutationKind) {
      if (kind === "structural" || kind === "overflow") {
        begin(editor, now, kind);
        pending!.evidence = kind;
        ZENTYPE_DEBUG: debug?.record("session", "structure-evidence", { now, kind });
      } else if (pending) pending.nonStructuralObserved = true;
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
    sample(frame: EditorFrame | null, now: number): "ordinary" | "wait" | "commit" | "timeout" | "overflow" {
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
        // the first sample that happens to precede that task.
        const confirmed = candidate && quiet >= MOTION.structureQuietMs;
        const expired = elapsed >= MOTION.structureDeadlineMs;
        const decision = confirmed ? "ordinary" : expired ? "timeout" : "wait";
        const reason = confirmed ? "non-structural-quiet"
          : expired ? "intent-deadline-expired"
            : candidate ? "awaiting-post-input-quiet" : "awaiting-structural-evidence";
        ZENTYPE_DEBUG: debug?.record("session", "structure-sample", { now, elapsed, quiet, state: "intent",
          inputObserved: pending.inputObserved, nonStructuralObserved: pending.nonStructuralObserved,
          decision, reason });
        if (confirmed) {
          cancel(reason);
          return "ordinary";
        }
        if (expired) {
          ZENTYPE_DEBUG: debug?.record("session", "structure-timeout", { now, elapsed, state: "intent" });
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
      const stable = pending.stable >= 2 && quiet >= MOTION.structureQuietMs;
      ZENTYPE_DEBUG: debug?.record("session", "structure-sample", { now, quiet, stableFrames: pending.stable,
        state: "structural", evidence: pending.evidence, caret: caret ? { ...caret } : null,
        decision: stable ? "commit" : "wait", reason: stable ? "quiet-and-stable" : "awaiting-stable-geometry" });
      if (stable || elapsed >= MOTION.structureDeadlineMs) {
        const result = stable ? "commit" : "timeout";
        ZENTYPE_DEBUG: debug?.record("session", stable ? "structure-stable" : "structure-timeout", { now, elapsed });
        pending = null;
        return result;
      }
      return "wait";
    },
  };
}
