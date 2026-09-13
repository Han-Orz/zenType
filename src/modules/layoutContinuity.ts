import { MOTION } from "../config";
import { stepCritical, type CriticalState } from "../motion";
import { visualKey, STRUCTURE_LIMITS } from "../structure";
import type { DebugRecorder } from "../debug/types";

export type LayoutFlowIntent = "enter" | "backspace" | "delete";

export interface LayoutViewport {
  top: number;
  bottom: number;
}

export interface LayoutPoint {
  x: number;
  y: number;
}

interface CapturedSubject {
  key: string;
  element: HTMLElement;
  host: LayoutPoint;
}

interface ArmedFlow {
  generation: number;
  intent: LayoutFlowIntent;
  at: number;
  editor: HTMLElement;
  subjects: CapturedSubject[];
  continuationOrigin: LayoutPoint | null;
  preEditKeys: Set<string>;
}

interface Runner {
  key: string;
  element: HTMLElement;
  ownedTransform: string | null;
  host: LayoutPoint;
  x: CriticalState;
  y: CriticalState;
}

const FLOW_HARD_LIMIT = 96;
const MIN_OVERSCAN_PX = 160;

/**
 * Local flow continuity for Enter/Delete/Backspace.
 *
 * This module deliberately does not own Tab/Shift+Tab. The validated list-item
 * reparent presentation remains in structurePresentation.ts so adding document
 * flow motion cannot broaden the geometry scope that Ripple/markers already
 * passed on real SiYuan.
 *
 * The Host owns final layout. This engine only keeps surviving visible content at
 * the position the user just saw and lets the shared WritingSession frame converge
 * that displacement to zero through Critical Motion. It owns no scheduler/clock.
 */
export function createLayoutContinuity(debug?: DebugRecorder) {
  let armed: ArmedFlow | null = null;
  const runners = new Map<string, Runner>();
  let last: number | null = null;

  function isSubject(element: Element): element is HTMLElement {
    return element instanceof HTMLElement && !!element.dataset.nodeId &&
      !element.classList.contains("protyle-action") && !element.classList.contains("protyle-attr");
  }

  function runnerForElement(element: HTMLElement): Runner | undefined {
    for (const runner of runners.values()) if (runner.element === element) return runner;
    return undefined;
  }

  function hostOwnsTransform(element: HTMLElement, runner?: Runner): boolean {
    if (runner && runner.element === element && runner.ownedTransform !== null &&
        element.style.transform === runner.ownedTransform) return false;
    if (element.style.transform) return true;
    const computed = getComputedStyle(element).transform;
    return !!computed && computed !== "none";
  }

  function release(runner: Runner) {
    if (runner.ownedTransform !== null && runner.element.style.transform === runner.ownedTransform) {
      runner.element.style.transform = "";
    }
    runners.delete(runner.key);
  }

  function clearRunning() {
    for (const runner of [...runners.values()]) release(runner);
    last = null;
  }

  function apply(runner: Runner): boolean {
    if (!runner.element.isConnected) {
      release(runner);
      return false;
    }
    if (runner.ownedTransform !== null && runner.element.style.transform !== runner.ownedTransform) {
      ZENTYPE_DEBUG: debug?.record("session", "layout-continuity-release", {
        reason: "host-transform-takeover", key: runner.key,
      });
      release(runner);
      return false;
    }
    const x = runner.x.value;
    const y = runner.y.value;
    runner.element.style.transform = x === 0 && y === 0 ? "" : `translate(${x}px, ${y}px)`;
    runner.ownedTransform = runner.element.style.transform;
    return true;
  }

  function hostRect(element: HTMLElement, runner?: Runner): LayoutPoint {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left - (runner?.element === element ? runner.x.value : 0),
      y: rect.top - (runner?.element === element ? runner.y.value : 0),
    };
  }

  function rebindOrCreate(subject: CapturedSubject, element: HTMLElement): Runner | null {
    const existing = runners.get(subject.key);
    if (hostOwnsTransform(element, existing)) return null;

    const carriedX = existing?.x.value ?? 0;
    const carriedY = existing?.y.value ?? 0;
    const velocityX = existing?.x.velocity ?? 0;
    const velocityY = existing?.y.velocity ?? 0;
    const nextHost = hostRect(element, existing);
    const x = subject.host.x + carriedX - nextHost.x;
    const y = subject.host.y + carriedY - nextHost.y;

    if (Math.abs(x) <= MOTION.cursorSettlePx && Math.abs(y) <= MOTION.cursorSettlePx) {
      if (existing && existing.element !== element) release(existing);
      return null;
    }

    if (existing && existing.element !== element) {
      if (existing.ownedTransform !== null && existing.element.style.transform === existing.ownedTransform) {
        existing.element.style.transform = "";
      }
      existing.element = element;
      existing.ownedTransform = null;
    }

    const runner = existing ?? {
      key: subject.key,
      element,
      ownedTransform: null,
      host: nextHost,
      x: { value: x, velocity: velocityX },
      y: { value: y, velocity: velocityY },
    };
    runner.host = nextHost;
    runner.x.value = x;
    runner.x.velocity = velocityX;
    runner.y.value = y;
    runner.y.velocity = velocityY;
    if (!existing) runners.set(subject.key, runner);
    return apply(runner) ? runner : null;
  }

  function semanticAncestor(element: HTMLElement | null, editor: HTMLElement): HTMLElement | null {
    for (let node = element?.parentElement ?? null, depth = 0;
         node && node !== editor && depth < STRUCTURE_LIMITS.depth;
         node = node.parentElement, depth++) {
      if (isSubject(node)) return node;
    }
    return null;
  }

  function findAddedByKey(added: readonly HTMLElement[], key: string): HTMLElement | null {
    let visited = 0;
    const stack = [...added];
    while (stack.length && visited++ < STRUCTURE_LIMITS.nodes) {
      const element = stack.pop()!;
      if (visualKey(element) === key) return element;
      for (const child of element.children) if (child instanceof HTMLElement) stack.push(child);
    }
    return null;
  }

  function collectImpactPath(anchor: HTMLElement, editor: HTMLElement, viewport: LayoutViewport) {
    const subjects: CapturedSubject[] = [];
    const preEditKeys = new Set<string>();
    const seen = new Set<string>();
    const viewportHeight = Math.max(1, viewport.bottom - viewport.top);
    const overscan = Math.max(MIN_OVERSCAN_PX, viewportHeight * 0.5);
    const minY = viewport.top - overscan;
    const maxY = viewport.bottom + overscan;

    let path: HTMLElement | null = anchor;
    for (let depth = 0; path && path !== editor && depth < STRUCTURE_LIMITS.depth; depth++) {
      const pathKey = visualKey(path);
      if (pathKey) preEditKeys.add(pathKey);
      const parent = path.parentElement;
      if (!parent) break;

      let sibling = path.nextElementSibling;
      while (sibling && subjects.length < FLOW_HARD_LIMIT) {
        const next = sibling.nextElementSibling;
        if (isSubject(sibling)) {
          const key = visualKey(sibling);
          if (key) preEditKeys.add(key);
          if (key && !seen.has(key)) {
            const runner = runnerForElement(sibling);
            const rect = sibling.getBoundingClientRect();
            const top = rect.top - (runner?.y.value ?? 0);
            const bottom = rect.bottom - (runner?.y.value ?? 0);
            if (bottom >= minY && top <= maxY) {
              seen.add(key);
              subjects.push({
                key,
                element: sibling,
                host: {
                  x: rect.left - (runner?.x.value ?? 0),
                  y: top,
                },
              });
            } else if (top > maxY) {
              break;
            }
          }
        }
        sibling = next;
      }
      if (subjects.length >= FLOW_HARD_LIMIT || parent === editor) break;
      path = isSubject(parent) ? parent : semanticAncestor(path, editor);
    }
    return { subjects, preEditKeys };
  }

  function continuationRoot(block: HTMLElement | null): HTMLElement | null {
    return block?.closest<HTMLElement>('[data-type="NodeListItem"]') ?? block;
  }

  return {
    /**
     * Capture the visible layout-impact path before Enter/Delete/Backspace mutates
     * Host DOM. Callers must skip this entirely for proven ordinary text deletes.
     */
    capture(generation: number, intent: LayoutFlowIntent, block: HTMLElement | null,
      editor: HTMLElement | null, viewport: LayoutViewport | null, now: number,
      continuationOrigin: LayoutPoint | null = null) {
      if (!block?.isConnected || !editor?.isConnected || !viewport) {
        armed = null;
        return;
      }
      const { subjects, preEditKeys } = collectImpactPath(block, editor, viewport);
      const key = visualKey(block);
      if (key) preEditKeys.add(key);
      armed = { generation, intent, at: now, editor, subjects, continuationOrigin, preEditKeys };
      ZENTYPE_DEBUG: debug?.record("session", "layout-continuity-capture", {
        generation, intent, subjects: subjects.length,
      });
    },

    /**
     * Attach only after Structural Contract evidence from the same generation.
     * Same-key replacements keep value/velocity; deleted subjects simply vanish.
     * Enter may additionally bind the newly focused root as a split continuation.
     */
    attach(generation: number, now: number, reducedMotion: boolean,
      added: readonly HTMLElement[], focusedBlock: HTMLElement | null): boolean {
      const pending = armed;
      if (!pending || pending.generation !== generation) return false;
      armed = null;
      if (reducedMotion || now - pending.at > MOTION.structureDeadlineMs) return false;

      let attached = 0;
      const retained = new Set<string>();
      for (const subject of pending.subjects) {
        const element = subject.element.isConnected && visualKey(subject.element) === subject.key
          ? subject.element : findAddedByKey(added, subject.key);
        if (!element) continue;
        const runner = rebindOrCreate(subject, element);
        if (!runner) continue;
        retained.add(subject.key);
        attached++;
      }

      // Enter split continuation: a new Host node can still be the visual
      // continuation of the text after the old caret. This is presentation
      // continuity only; no semantic identity is invented or persisted.
      if (pending.intent === "enter" && pending.continuationOrigin) {
        const root = continuationRoot(focusedBlock);
        const key = root && visualKey(root);
        if (root?.isConnected && key && !pending.preEditKeys.has(key) && !runners.has(key) &&
            !hostOwnsTransform(root)) {
          const rect = root.getBoundingClientRect();
          const x = pending.continuationOrigin.x - rect.left;
          const y = pending.continuationOrigin.y - rect.top;
          if (Math.abs(x) > MOTION.cursorSettlePx || Math.abs(y) > MOTION.cursorSettlePx) {
            const runner: Runner = {
              key,
              element: root,
              ownedTransform: null,
              host: { x: rect.left, y: rect.top },
              x: { value: x, velocity: 0 },
              y: { value: y, velocity: 0 },
            };
            runners.set(key, runner);
            if (apply(runner)) {
              retained.add(key);
              attached++;
            }
          }
        }
      }

      // Only states touched by this structural generation may continue. This keeps
      // one geometry authority and prevents stale transforms surviving topology.
      for (const runner of [...runners.values()]) if (!retained.has(runner.key)) release(runner);
      if (attached && last === null) last = now;
      ZENTYPE_DEBUG: debug?.record("session", "layout-continuity-begin", {
        generation, intent: pending.intent, attached,
      });
      return attached > 0;
    },

    /** Advance every attached subject on the shared Session frame. */
    step(now: number, reducedMotion: boolean): boolean {
      if (!runners.size) { last = null; return false; }
      const elapsed = last === null ? 0 : Math.max(0, now - last);
      last = now;
      const response = reducedMotion ? 0 : MOTION.structuralMoveResponseMs;
      const advance = Math.min(elapsed, response / 4);
      for (const runner of [...runners.values()]) {
        if (!runner.element.isConnected) { release(runner); continue; }
        const settledX = stepCritical(runner.x, 0, advance, response, MOTION.cursorSettlePx);
        const settledY = stepCritical(runner.y, 0, advance, response, MOTION.cursorSettlePx);
        if (settledX && settledY) { release(runner); continue; }
        apply(runner);
      }
      if (!runners.size) last = null;
      return runners.size > 0;
    },

    /** Offset drawn at an element (or an ancestor geometry subject containing it). */
    offsetFor(element: HTMLElement | null): LayoutPoint | null {
      if (!element) return null;
      for (const runner of runners.values()) {
        if (runner.element !== element && !runner.element.contains(element)) continue;
        return runner.x.value === 0 && runner.y.value === 0
          ? null : { x: runner.x.value, y: runner.y.value };
      }
      return null;
    },

    abandon() { armed = null; },
    cancel() { armed = null; clearRunning(); },
  };
}
