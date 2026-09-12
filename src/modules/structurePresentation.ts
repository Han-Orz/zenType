import { MOTION } from "../config";
import { stepCritical, type CriticalState } from "../motion";
import { visualKey } from "../structure";
import type { DebugRecorder } from "../debug/types";

export interface StructuralOffset {
  x: number;
  y: number;
}

interface Armed {
  generation: number;
  element: HTMLElement;
  key: string | undefined;
  at: number;
  host: { x: number; y: number };
}

/**
 * The single presentation owner of one structural displacement.
 *
 * The Host owns layout. Structure owns the generation. This consumer may only
 * attach a capture to structural evidence from that exact generation; semantic
 * continuity still has to pass the visual-key and transform-ownership checks.
 *
 * `capture` runs before the Host mutation, `attach` runs inside the mutation
 * delivery so no frame can paint the new layout before the transform exists, and
 * `step` advances on the shared Session frame. Nothing here schedules a frame,
 * creates a generation or keeps a second business clock.
 */
export function createStructurePresentation(debug?: DebugRecorder) {
  let armed: Armed | null = null;
  let subject: HTMLElement | null = null;
  let ownerGeneration: number | null = null;
  let ownedTransform: string | null = null;
  let host: { x: number; y: number } | null = null;
  let last: number | null = null;
  const offset = { x: { value: 0, velocity: 0 } as CriticalState, y: { value: 0, velocity: 0 } as CriticalState };

  function clearRunning() {
    subject = null;
    ownerGeneration = null;
    ownedTransform = null;
    host = null;
    last = null;
    offset.x.value = offset.x.velocity = offset.y.value = offset.y.velocity = 0;
  }
  function release() {
    // Restore only the exact inline value zenType last wrote. If the Host took
    // transform ownership during the motion, its value wins and is untouched.
    if (subject && ownedTransform !== null && subject.style.transform === ownedTransform) subject.style.transform = "";
    clearRunning();
  }
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
  /** Take ownership of one element's transform; refuse a Host/theme owner. */
  function adopt(element: HTMLElement | null): boolean {
    if (subject === element) {
      if (!element?.isConnected) return false;
      if (ownedTransform !== null && element.style.transform !== ownedTransform) {
        record("host-transform-takeover");
        clearRunning();
        return false;
      }
      return true;
    }
    if (!element?.isConnected || hostOwnsTransform(element)) return false;
    release();
    subject = element;
    ownedTransform = element.style.transform;
    return true;
  }
  function apply(): boolean {
    if (!subject) return false;
    if (ownedTransform !== null && subject.style.transform !== ownedTransform) {
      record("host-transform-takeover");
      clearRunning();
      return false;
    }
    const x = offset.x.value, y = offset.y.value;
    const value = x === 0 && y === 0 ? "" : "translate(" + x + "px, " + y + "px)";
    subject.style.transform = value;
    // CSSOM may canonicalize fractional transform text on assignment. Keep the
    // representation the browser actually owns so a later check distinguishes
    // an external writer from our own normalized value.
    ownedTransform = subject.style.transform;
    return true;
  }
  function refusal(pending: Armed, now: number, reducedMotion: boolean): string | null {
    const target = pending.element;
    if (now - pending.at > MOTION.structureDeadlineMs) return "stale";
    if (reducedMotion) return "reduced-motion";
    if (!target?.isConnected) return "no-subject";
    if (pending.key === undefined || pending.key !== visualKey(target)) return "key-mismatch";
    return adopt(target) ? null : "host-transform";
  }
  return {
    /** Host mutation has not happened yet: bind one list item to one generation. */
    capture(generation: number, element: HTMLElement | null, now: number) {
      if (!element?.isConnected) {
        armed = null;
        refuse("no-capture-subject", generation);
        return;
      }
      // A Host/theme transform fails closed before the current owner is lost.
      if (subject === element && ownedTransform !== null && element.style.transform !== ownedTransform) {
        record("host-transform-takeover");
        clearRunning();
      }
      if (subject !== element && hostOwnsTransform(element)) {
        armed = null;
        refuse("host-transform", generation);
        return;
      }
      if (subject && subject !== element) { record("subject-change"); release(); }
      const carriedX = subject === element ? offset.x.value : 0;
      const carriedY = subject === element ? offset.y.value : 0;
      const rect = element.getBoundingClientRect();
      // Store Host geometry, not transformed visual geometry. A running earlier
      // displacement may keep moving until this generation receives evidence.
      armed = { generation, element, key: visualKey(element), at: now,
        host: { x: rect.left - carriedX, y: rect.top - carriedY } };
    },
    /** Structural evidence may consume only the capture from its generation. */
    attach(generation: number, now: number, reducedMotion: boolean): StructuralOffset | null {
      const pending = armed;
      if (!pending) {
        // Dev-only bounded evidence: at most one rect read per later structural
        // delivery, never a per-frame sampler. This decides whether rebase exists.
        ZENTYPE_DEBUG: if (debug && subject && ownerGeneration === generation && subject.isConnected) {
          const rect = subject.getBoundingClientRect();
          const nextHost = { x: rect.left - offset.x.value, y: rect.top - offset.y.value };
          debug.record("session", "structural-presentation-repeat-evidence", {
            generation, key: visualKey(subject) ?? null,
            hostDx: host ? nextHost.x - host.x : null,
            hostDy: host ? nextHost.y - host.y : null,
            dx: offset.x.value, dy: offset.y.value,
          });
        }
        return null;
      }
      if (pending.generation !== generation) {
        refuse("generation-mismatch", generation);
        return null;
      }
      armed = null;

      const carrying = subject === pending.element;
      const carriedX = carrying ? offset.x.value : 0;
      const carriedY = carrying ? offset.y.value : 0;
      const velocityX = carrying ? offset.x.velocity : 0;
      const velocityY = carrying ? offset.y.velocity : 0;
      const carriedLast = carrying ? last : null;
      const reason = refusal(pending, now, reducedMotion);
      if (reason) {
        refuse(reason, generation);
        return null;
      }

      const rect = subject!.getBoundingClientRect();
      const transformX = carrying && subject === pending.element ? carriedX : 0;
      const transformY = carrying && subject === pending.element ? carriedY : 0;
      const nextHost = { x: rect.left - transformX, y: rect.top - transformY };
      const x = pending.host.x + carriedX - nextHost.x;
      const y = pending.host.y + carriedY - nextHost.y;
      if (Math.abs(x) <= MOTION.cursorSettlePx && Math.abs(y) <= MOTION.cursorSettlePx) {
        refuse("no-displacement", generation);
        release();
        return null;
      }

      ownerGeneration = generation;
      host = nextHost;
      offset.x.value = x;
      offset.y.value = y;
      offset.x.velocity = velocityX;
      offset.y.velocity = velocityY;
      last = carriedLast;
      if (!apply()) return null;
      ZENTYPE_DEBUG: debug?.record("session", "structural-presentation-begin", {
        generation, key: pending.key ?? null, dx: x, dy: y,
      });
      return { x, y };
    },
    /** One Session frame; the returned offset is what this frame presents. */
    step(now: number, reducedMotion: boolean): StructuralOffset | null {
      if (!subject) return null;
      if (!subject.isConnected) { record("detached"); release(); return null; }
      const elapsed = last === null ? 0 : Math.max(0, now - last);
      last = now;
      // Presentation pause/resume policy, not a change to the analytic motion law.
      const response = reducedMotion ? 0 : MOTION.structuralMoveResponseMs;
      const advance = Math.min(elapsed, response / 4);
      const settledX = stepCritical(offset.x, 0, advance, response, MOTION.cursorSettlePx);
      const settledY = stepCritical(offset.y, 0, advance, response, MOTION.cursorSettlePx);
      if (settledX && settledY) { record("settled"); release(); return null; }
      if (!apply()) return null;
      const x = offset.x.value, y = offset.y.value;
      return x === 0 && y === 0 ? null : { x, y };
    },
    /** Drop only the unconsumed capture; a running displacement keeps converging. */
    abandon() {
      if (!armed) return;
      armed = null;
      record("abandoned");
    },
    cancel() {
      if (!armed && !subject) return;
      record("cancelled");
      armed = null;
      release();
    },
  };
}
