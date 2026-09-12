import { MOTION } from "../config";
import { stepCritical, type CriticalState } from "../motion";
import { visualKey } from "../structure";
import type { DebugRecorder } from "../debug/types";

export interface StructuralOffset {
  x: number;
  y: number;
}

/**
 * The bounded local window of a structural edit: the subject element and its
 * following semantic siblings. Those are the elements whose position the Host is
 * about to change; content above does not move and content far below is offscreen,
 * so neither needs continuity. This keeps the pass local instead of document-scale.
 */
const LAYOUT_SUBJECT_LIMIT = 24;

interface CapturedSubject {
  key: string;
  element: HTMLElement;
  host: { x: number; y: number };
}
interface Armed {
  generation: number;
  at: number;
  parent: HTMLElement | null;
  anchorKey: string | null;
  subjects: CapturedSubject[];
}
/** One surviving element's presentation state, advanced by the shared Session frame. */
interface Runner {
  key: string;
  element: HTMLElement;
  host: { x: number; y: number };
  ownedTransform: string | null;
  x: CriticalState;
  y: CriticalState;
}

/**
 * Bounded local layout continuity for structural edits.
 *
 * The Host owns layout. Before a structural mutation this captures the geometry of
 * a small set of surviving semantic elements; inside the mutation delivery it
 * matches them by identity, attaches the old -> new displacement as a transform,
 * and the shared Session frame drives that displacement back to zero through the
 * critical law. It hides the Host's correct-but-instant discontinuity; it is not a
 * FLIP runtime: no snapshot of the document, no placeholder, no clone, no
 * animation of anything that did not survive.
 *
 * `capture` runs before the Host mutation, `attach` inside the mutation delivery so
 * no frame can paint the new layout before the transform exists, and `step`
 * advances on the Session frame. Nothing here schedules a frame, creates a
 * generation or keeps a second business clock.
 */
export function createStructurePresentation(debug?: DebugRecorder) {
  let armed: Armed | null = null;
  let runners: Runner[] = [];
  let last: number | null = null;

  function record(reason: string) {
    ZENTYPE_DEBUG: debug?.record("session", "structural-presentation-settle", { reason });
  }
  function refuse(reason: string, generation?: number) {
    ZENTYPE_DEBUG: debug?.record("session", "structural-presentation-refused", { reason, generation: generation ?? null });
  }
  function hostOwnsTransform(element: HTMLElement): boolean {
    if (element.style.transform) return true;
    const computed = getComputedStyle(element).transform;
    return !!computed && computed !== "none";
  }
  function runnerFor(element: HTMLElement): Runner | undefined {
    return runners.find(runner => runner.element === element);
  }
  /** Restore only the exact inline value zenType last wrote; a Host writer wins. */
  function release(runner: Runner) {
    if (runner.ownedTransform !== null && runner.element.style.transform === runner.ownedTransform) {
      runner.element.style.transform = "";
    }
    const index = runners.indexOf(runner);
    if (index >= 0) runners.splice(index, 1);
  }
  function releaseAll() {
    for (const runner of [...runners]) release(runner);
    runners = [];
    last = null;
  }
  function apply(runner: Runner): boolean {
    // A Host/theme transform that appeared after we wrote is a takeover: drop the
    // runner rather than fight for the property.
    if (runner.ownedTransform !== null && runner.element.style.transform !== runner.ownedTransform) {
      record("host-transform-takeover");
      release(runner);
      return false;
    }
    const x = runner.x.value, y = runner.y.value;
    runner.element.style.transform = x === 0 && y === 0 ? "" : "translate(" + x + "px, " + y + "px)";
    // CSSOM may canonicalize fractional transform text on assignment; keep what the
    // browser actually owns so a later check can tell an external writer apart.
    runner.ownedTransform = runner.element.style.transform;
    return true;
  }
  /** A captured identity that survived: the same element, or a bounded key rematch. */
  function survivor(subject: CapturedSubject, parent: HTMLElement | null, used: Set<HTMLElement>): HTMLElement | null {
    if (subject.element.isConnected && visualKey(subject.element) === subject.key && !used.has(subject.element)) {
      return subject.element;
    }
    if (parent?.isConnected) {
      const children = parent.children;
      for (let index = 0, scanned = 0; index < children.length && scanned < LAYOUT_SUBJECT_LIMIT; index++) {
        if (!(children[index] instanceof HTMLElement)) continue;
        scanned++;
        const candidate = children[index] as HTMLElement;
        if (used.has(candidate)) continue;
        if (visualKey(candidate) === subject.key) return candidate;
      }
    }
    return null;
  }
  function upsert(key: string, element: HTMLElement, host: { x: number; y: number },
    x: CriticalState, y: CriticalState): Runner {
    const existing = runners.find(runner => runner.key === key);
    if (!existing) {
      const runner: Runner = { key, element, host, ownedTransform: null, x, y };
      runners.push(runner);
      return runner;
    }
    if (existing.element !== element) {
      // Same presentation state, new actuator: value and velocity continue, so a
      // same-key replacement is a rebind rather than a new motion.
      if (existing.ownedTransform !== null && existing.element.style.transform === existing.ownedTransform) {
        existing.element.style.transform = "";
      }
      existing.element = element;
      existing.ownedTransform = null;
    }
    existing.host = host;
    existing.x = x;
    existing.y = y;
    return existing;
  }
  return {
    /** Host mutation has not happened yet: bind a bounded local window to one generation. */
    capture(generation: number, anchor: HTMLElement | null, now: number) {
      if (!anchor?.isConnected) {
        armed = null;
        refuse("no-capture-subject", generation);
        return;
      }
      const anchorKey = visualKey(anchor) ?? null;
      const running = runnerFor(anchor);
      if (running && running.ownedTransform !== null && anchor.style.transform !== running.ownedTransform) {
        record("host-transform-takeover");
        release(running);
      } else if (!running && hostOwnsTransform(anchor)) {
        armed = null;
        refuse("host-transform", generation);
        return;
      }
      const subjects: CapturedSubject[] = [];
      const seen = new Set<string>();
      const consider = (element: HTMLElement): boolean => {
        if (subjects.length >= LAYOUT_SUBJECT_LIMIT) return false;
        const key = visualKey(element);
        if (!key || seen.has(key)) return true;
        seen.add(key);
        const rect = element.getBoundingClientRect();
        const owner = runnerFor(element);
        const carriedX = owner ? owner.x.value : 0;
        const carriedY = owner ? owner.y.value : 0;
        subjects.push({ key, element, host: { x: rect.left - carriedX, y: rect.top - carriedY } });
        return true;
      };
      consider(anchor);
      for (let node = anchor.nextElementSibling; node && subjects.length < LAYOUT_SUBJECT_LIMIT;
           node = node.nextElementSibling) {
        if (node instanceof HTMLElement && !consider(node)) break;
      }
      armed = { generation, at: now, parent: anchor.parentElement, anchorKey, subjects };
    },
    /** Structural evidence may consume only the capture from its generation. */
    attach(generation: number, now: number, reducedMotion: boolean): StructuralOffset | null {
      const pending = armed;
      if (!pending) return null;
      if (pending.generation !== generation) {
        refuse("generation-mismatch", generation);
        return null;
      }
      armed = null;
      if (now - pending.at > MOTION.structureDeadlineMs) {
        refuse("stale", generation);
        return null;
      }
      if (reducedMotion) {
        refuse("reduced-motion", generation);
        return null;
      }

      const used = new Set<HTMLElement>();
      let anchor: Runner | null = null;
      let attached = 0;
      for (const subject of pending.subjects) {
        const element = survivor(subject, pending.parent, used);
        if (!element) continue;
        used.add(element);
        const owner = runnerFor(element);
        // A running element keeps the property even if a Host transform appeared
        // meanwhile; a fresh element with a Host transform simply does not join.
        if (!owner && hostOwnsTransform(element)) continue;
        const rect = element.getBoundingClientRect();
        const carriedX = owner ? owner.x.value : 0;
        const carriedY = owner ? owner.y.value : 0;
        const velocityX = owner ? owner.x.velocity : 0;
        const velocityY = owner ? owner.y.velocity : 0;
        const nextHost = { x: rect.left - carriedX, y: rect.top - carriedY };
        const x = subject.host.x + carriedX - nextHost.x;
        const y = subject.host.y + carriedY - nextHost.y;
        if (Math.abs(x) <= MOTION.cursorSettlePx && Math.abs(y) <= MOTION.cursorSettlePx) continue;
        const runner = upsert(subject.key, element, nextHost,
          { value: x, velocity: velocityX }, { value: y, velocity: velocityY });
        if (!apply(runner)) continue;
        attached++;
        if (subject.key === pending.anchorKey) anchor = runner;
      }
      if (!attached) {
        refuse("no-displacement", generation);
        return null;
      }
      ZENTYPE_DEBUG: debug?.record("session", "structural-presentation-begin", {
        generation, subjects: pending.subjects.length, attached,
        x: anchor ? anchor.x.value : null, y: anchor ? anchor.y.value : null,
      });
      return anchor ? { x: anchor.x.value, y: anchor.y.value } : null;
    },
    /** One Session frame: advance every surviving displacement toward zero. */
    step(now: number, reducedMotion: boolean): boolean {
      const elapsed = last === null ? 0 : Math.max(0, now - last);
      last = now;
      if (!runners.length) {
        last = null;
        return false;
      }
      // Presentation pause/resume policy, not a change to the analytic motion law.
      const response = reducedMotion ? 0 : MOTION.structuralMoveResponseMs;
      // One frame may advance at most a quarter of the response so a stalled
      // renderer cannot teleport any subject.
      const advance = Math.min(elapsed, response / 4);
      for (const runner of [...runners]) {
        if (!runner.element.isConnected) {
          release(runner);
          continue;
        }
        const settledX = stepCritical(runner.x, 0, advance, response, MOTION.cursorSettlePx);
        const settledY = stepCritical(runner.y, 0, advance, response, MOTION.cursorSettlePx);
        if (settledX && settledY) {
          release(runner);
          continue;
        }
        apply(runner);
      }
      const moving = runners.length > 0;
      if (!moving) last = null;
      return moving;
    },
    /** The displacement this frame presents at an element, or null when it is not a subject. */
    offsetFor(element: HTMLElement | null): StructuralOffset | null {
      if (!element) return null;
      for (const runner of runners) {
        if (runner.element !== element && !runner.element.contains(element)) continue;
        return runner.x.value === 0 && runner.y.value === 0 ? null : { x: runner.x.value, y: runner.y.value };
      }
      return null;
    },
    /** Drop only the unconsumed capture; running displacements keep converging. */
    abandon() {
      if (!armed) return;
      armed = null;
      record("abandoned");
    },
    cancel() {
      if (!armed && !runners.length) return;
      record("cancelled");
      armed = null;
      releaseAll();
    },
  };
}
