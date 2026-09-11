import { MOTION } from "../../config";
import { stepCritical, type CriticalState } from "../../motion";
import { visualKey } from "../../structure";

export interface StructuralOffset {
  x: number;
  y: number;
}

interface Armed {
  key: string | undefined;
  left: number;
  top: number;
}

interface Active {
  element: HTMLElement;
  origin: string;
  dx: number;
  dy: number;
  length: number;
  state: CriticalState;
  last: number | null;
}

/**
 * Bounded structural geometry handoff for one Host element. The Host owns the
 * final layout; this owns only the transform that closes the visual gap between
 * where the user last saw the block and where the Host has already put it.
 *
 * `capture` runs before the Host mutation (one bounded rect read), `begin` runs
 * once geometry is authoritative, and `step` advances on the shared Session
 * frame. Nothing here samples the document, schedules a frame or keeps time.
 */
export function createStructuralMove() {
  let armed: Armed | null = null;
  let active: Active | null = null;

  function restore() {
    if (active) active.element.style.transform = active.origin;
    active = null;
  }
  function drop() {
    restore();
    armed = null;
  }
  return {
    capture(element: HTMLElement | null) {
      restore();
      armed = null;
      if (!element?.isConnected) return;
      const rect = element.getBoundingClientRect();
      armed = { key: visualKey(element), left: rect.left, top: rect.top };
    },
    /**
     * DOM identity is not continuity: the moved Host node may be a same-key
     * replacement, so the semantic key has to agree before anything animates.
     */
    begin(element: HTMLElement | null, reducedMotion: boolean): StructuralOffset | null {
      const pending = armed;
      armed = null;
      if (!pending || !element?.isConnected || pending.key !== visualKey(element)) return null;
      const rect = element.getBoundingClientRect();
      const dx = pending.left - rect.left;
      const dy = pending.top - rect.top;
      const length = Math.hypot(dx, dy);
      // Reduced motion snaps to the Host's committed geometry, and a displacement
      // below the settled-caret threshold is not motion the eye can resolve.
      if (reducedMotion || length <= MOTION.cursorSettlePx) return null;
      active = { element, origin: element.style.transform, dx, dy, length, last: null,
        state: { value: 0, velocity: 0 } };
      element.style.transform = "translate(" + dx + "px, " + dy + "px)";
      return { x: dx, y: dy };
    },
    /** One Session frame; the returned offset is what this frame presents. */
    step(now: number, reducedMotion: boolean): StructuralOffset | null {
      const move = active;
      if (!move) return null;
      if (!move.element.isConnected) { restore(); return null; }
      const elapsed = move.last === null ? 0 : Math.max(0, now - move.last);
      move.last = now;
      // The block layer keeps one timescale: a structural slide settles on the
      // same response as the block alpha it accompanies, and stops once the
      // remaining displacement is below the settled-caret threshold.
      const settled = stepCritical(move.state, 1, elapsed, reducedMotion ? 0 : MOTION.blockFadeMs,
        MOTION.cursorSettlePx / move.length);
      if (settled) { restore(); return null; }
      const remaining = 1 - move.state.value;
      const offset = { x: move.dx * remaining, y: move.dy * remaining };
      move.element.style.transform = "translate(" + offset.x + "px, " + offset.y + "px)";
      return offset;
    },
    cancel: drop,
  };
}
