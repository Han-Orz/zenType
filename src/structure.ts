import { MOTION } from "./config";
import type { CursorRect, EditorFrame } from "./types";
import type { DebugRecorder } from "./debug/types";

export type MutationKind = "text" | "representation" | "structural" | "overflow";
export const STRUCTURE_LIMITS = { records: 256, nodes: 2048, depth: 64 } as const;

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
  let pending: { editor: HTMLElement; start: number; activity: number; evidence: "structural" | "overflow" | null;
    ordinary: boolean; stable: number; caret: CursorRect | null; block: HTMLElement | null } | null = null;
  function cancel(reason: string) {
    if (pending) debug?.record("session", "structure-cancel", { reason });
    pending = null;
  }
  function begin(editor: HTMLElement, now: number, evidence: "structural" | "overflow" | null) {
    if (pending?.editor !== editor) {
      pending = { editor, start: now, activity: now, evidence, ordinary: false, stable: 0, caret: null, block: null };
      debug?.record("session", evidence ? "structure-begin" : "structure-intent", { now });
    }
  }
  function activity(now: number, reason: string) {
    if (!pending) return;
    pending.activity = now;
    pending.stable = 0;
    pending.caret = null;
    debug?.record("session", "structure-activity", { now, reason });
  }
  return {
    intent(editor: HTMLElement, now: number) { begin(editor, now, null); },
    mutation(editor: HTMLElement, now: number, kind: MutationKind) {
      if (kind === "structural" || kind === "overflow") {
        begin(editor, now, kind);
        pending!.evidence = kind;
        debug?.record("session", "structure-evidence", { now, kind });
      } else if (pending) pending.ordinary = true;
      activity(now, kind);
    },
    activity,
    input() { if (pending) pending.ordinary = true; },
    cancel,
    remaining(now: number) {
      return pending ? Math.max(1, pending.start + (pending.evidence ? MOTION.structureDeadlineMs : MOTION.structureQuietMs) - now) : 0;
    },
    sample(frame: EditorFrame | null, now: number): "ordinary" | "wait" | "commit" | "timeout" | "overflow" {
      if (!pending) return "ordinary";
      if (frame && (frame.editor !== pending.editor || frame.selection === "range")) {
        cancel(frame.selection === "range" ? "selection" : "editor-switch");
        return "ordinary";
      }
      if (pending.evidence === "overflow") { cancel("observation-limit"); return "overflow"; }
      const elapsed = now - pending.start;
      if (!pending.evidence && (pending.ordinary || elapsed >= MOTION.structureQuietMs)) {
        cancel("no-structural-evidence");
        return "ordinary";
      }
      const caret = frame?.caret ?? null;
      const previous = pending.caret;
      const same = caret && previous && frame?.block === pending.block &&
        Math.hypot(caret.x - previous.x, caret.y - previous.y) <= 0.15 && Math.abs(caret.height - previous.height) <= 0.15;
      pending.stable = caret ? same ? pending.stable + 1 : 1 : 0;
      pending.caret = caret && { ...caret };
      pending.block = frame?.block ?? null;
      const quiet = now - pending.activity;
      const stable = pending.evidence === "structural" && pending.stable >= 2 && quiet >= MOTION.structureQuietMs;
      debug?.record("session", "structure-sample", { now, quiet, stableFrames: pending.stable,
        evidence: pending.evidence, caret: caret ? { ...caret } : null, decision: stable ? "commit" : "wait" });
      if (stable || elapsed >= MOTION.structureDeadlineMs) {
        const result = stable ? "commit" : "timeout";
        debug?.record("session", stable ? "structure-stable" : "structure-timeout", { now, elapsed });
        pending = null;
        return result;
      }
      return "wait";
    },
  };
}
