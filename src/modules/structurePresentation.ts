import { MOTION } from "../config";
import { stepCritical, type CriticalState } from "../motion";
import { visualKey } from "../structure";
import type { DebugRecorder } from "../debug/types";

export interface StructuralOffset {
  x: number;
  y: number;
}

interface Armed {
  element: HTMLElement;
  key: string | undefined;
  at: number;
  visual: { x: number; y: number };
}

/**
 * The single presentation owner of one structural displacement.
 *
 * The Host owns the layout; this owns only the transform that holds a reparented
 * subject where the user last saw it and then closes the gap to the Host's
 * committed geometry. One physical displacement therefore has exactly one owner,
 * and the Cursor consumes that same offset instead of chasing it a second time.
 *
 * `capture` runs before the Host mutation, `attach` runs inside the mutation
 * delivery so no frame can paint the new layout before the transform exists, and
 * `step` advances on the shared Session frame. Nothing here samples the document,
 * schedules a frame or keeps its own clock.
 */
export function createStructurePresentation(debug?: DebugRecorder) {
  let armed: Armed | null = null;
  let subject: HTMLElement | null = null;
  let origin = "";
  let held = false;
  let last: number | null = null;
  const offset = { x: { value: 0, velocity: 0 } as CriticalState, y: { value: 0, velocity: 0 } as CriticalState };

  function apply() {
    if (!subject) return;
    const x = offset.x.value, y = offset.y.value;
    subject.style.transform = x === 0 && y === 0 ? origin : "translate(" + x + "px, " + y + "px)";
  }
  function release() {
    if (subject && subject.style.transform !== origin) subject.style.transform = origin;
    subject = null;
    origin = "";
    held = false;
    last = null;
    offset.x.value = offset.x.velocity = offset.y.value = offset.y.velocity = 0;
  }
  function record(reason: string) {
    ZENTYPE_DEBUG: debug?.record("session", "structural-presentation-settle", { reason });
  }
  function refuse(reason: string) {
    ZENTYPE_DEBUG: debug?.record("session", "structural-presentation-refused", { reason });
  }
  /** Take ownership of one element's transform; refuse a Host that owns its own. */
  function adopt(element: HTMLElement | null): boolean {
    if (subject === element) return true;
    release();
    // A Host or theme that already sets an inline transform keeps it: this
    // presentation never overwrites a transform it does not own.
    if (!element?.isConnected || element.style.transform) return false;
    subject = element;
    origin = element.style.transform;
    return true;
  }
  function refusal(pending: Armed, fallback: HTMLElement | null, now: number, reducedMotion: boolean): string | null {
    const target = pending.element.isConnected ? pending.element : fallback;
    if (now - pending.at > MOTION.structureDeadlineMs) return "stale";
    if (reducedMotion) return "reduced-motion";
    if (!target?.isConnected) return "no-subject";
    if (pending.key === undefined || pending.key !== visualKey(target)) return "key-mismatch";
    return adopt(target) ? null : "host-transform";
  }
  return {
    /** Host mutation has not happened yet: remember where the subject is drawn. */
    capture(element: HTMLElement | null, now: number) {
      if (!element?.isConnected) {
        if (armed || subject) { record("no-capture-subject"); release(); }
        armed = null;
        return;
      }
      // Only a displacement already running on this subject keeps its ownership.
      // Merely arming must not take the transform, or a Session frame would be
      // queued for an offset that is still exactly zero.
      if (subject && subject !== element) { record("subject-change"); release(); }
      if (subject === element) held = true;
      const rect = element.getBoundingClientRect();
      armed = { element, key: visualKey(element), at: now, visual: { x: rect.left, y: rect.top } };
    },
    /**
     * Mutation delivery. The Host moves the item node itself, so the captured
     * element is normally still the subject; `fallback` only covers a Host that
     * replaced it, and a same-key replacement still has to prove continuity.
     * The live Selection is deliberately not the primary source here: SiYuan
     * restores it through a `<wbr>` that outdent resolves after this delivery.
     */
    attach(fallback: HTMLElement | null, now: number, reducedMotion: boolean): StructuralOffset | null {
      const pending = armed;
      if (!pending) return null;
      armed = null;
      const reason = refusal(pending, fallback, now, reducedMotion);
      if (reason) {
        // A displacement already running keeps running; only this new capture is
        // dropped, so a refused handoff never jumps the subject.
        refuse(reason);
        held = false;
        return null;
      }
      held = false;
      // Separate Host layout from what this presentation is drawing, then hold
      // the visual position the user is looking at across the Host's move.
      const rect = subject!.getBoundingClientRect();
      const x = pending.visual.x - (rect.left - offset.x.value);
      const y = pending.visual.y - (rect.top - offset.y.value);
      // Below the settled-caret threshold there is no displacement to present.
      if (Math.abs(x) <= MOTION.cursorSettlePx && Math.abs(y) <= MOTION.cursorSettlePx) {
        refuse("no-displacement");
        release();
        return null;
      }
      offset.x.value = x;
      offset.y.value = y;
      offset.x.velocity = offset.y.velocity = 0;
      last = null;
      apply();
      ZENTYPE_DEBUG: debug?.record("session", "structural-presentation-begin", { key: pending.key ?? null, dx: x, dy: y });
      return { x, y };
    },
    /** One Session frame; the returned offset is what this frame presents. */
    step(now: number, reducedMotion: boolean): StructuralOffset | null {
      if (!subject) return null;
      if (!subject.isConnected) { record("detached"); release(); return null; }
      const elapsed = last === null ? 0 : Math.max(0, now - last);
      last = now;
      if (!held) {
        // A structural displacement is its own personality dimension: it is not
        // the block alpha timescale, and it settles once the remaining
        // displacement is below the same sub-pixel threshold the cursor uses.
        const response = reducedMotion ? 0 : MOTION.structuralMoveResponseMs;
        // A renderer can stall for far longer than a frame while the window is
        // still visible. Consuming that gap in one step would teleport the
        // subject and leave the caret presentation behind, so one frame may
        // advance at most a quarter of the response.
        const advance = Math.min(elapsed, response / 4);
        const settledX = stepCritical(offset.x, 0, advance, response, MOTION.cursorSettlePx);
        const settledY = stepCritical(offset.y, 0, advance, response, MOTION.cursorSettlePx);
        if (settledX && settledY) { record("settled"); release(); return null; }
      }
      apply();
      const x = offset.x.value, y = offset.y.value;
      return x === 0 && y === 0 ? null : { x, y };
    },
    /**
     * Drop a capture whose own structural generation ended without acting. A
     * displacement already running belongs to an earlier generation and keeps
     * converging, because killing it mid-flight is exactly the jump this exists
     * to avoid.
     */
    abandon() {
      if (!armed) return;
      armed = null;
      held = false;
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
