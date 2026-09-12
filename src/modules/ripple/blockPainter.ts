import { MOTION } from "../../config";
import { clamp, stepCritical, type CriticalState } from "../../motion";
import { visualKey, STRUCTURE_LIMITS } from "../../structure";
import { planHandoff, type BlockStep } from "./blockPlan";
import type { DebugRecord, DebugRecorder } from "../../debug/types";

const OWNERSHIP_TELEMETRY_LIMIT = 16;
const BASELINE_EPSILON = 0.002;
// One paused linear effect per owner is the pixel actuator only:
// alpha = base * (1 - currentTime / BLOCK_ALPHA_CARRIER_MS). It has no easing and
// never advances on its own; the critical law decides the value on the Session frame.
export const BLOCK_ALPHA_CARRIER_MS = 1000;

/** Semantic identity when the Host provides one; element identity otherwise. */
type OwnerId = string | HTMLElement;

/**
 * Semantic presentation identity. The bound element is only the current paint
 * actuator, so a Host replacement or reparent moves this same state to a new
 * element instead of cancelling and rebuilding a motion.
 */
interface Owner extends CriticalState {
  mapKey: OwnerId;
  key: string | undefined;
  element: HTMLElement;
  target: number;
  base: number;
  parents: Owner[];
  carrier: Animation;
}
interface CarrySeed { key: string; value: number }

/**
 * Block alpha is semantic presentation state advanced by the shared Session frame
 * through the critical law. Identity is the visual key, so continuity across a
 * Host replacement is a rebind of one state, not a second animation.
 *
 * The value is delivered by one paused effect per owner, set only from that state.
 * Opacity therefore still never exists as an inline style, a dim class or a custom
 * property: a cloned element cannot serialize a zenType block alpha.
 */
export function createBlockPainter(debug?: DebugRecorder) {
  const owners = new Map<OwnerId, Owner>();
  let frozen = false;
  let boundEditor: HTMLElement | null = null;
  let last: number | null = null;

  const idOf = (element: HTMLElement): OwnerId => visualKey(element) ?? element;

  function carrierFor(element: HTMLElement, base: number): Animation {
    const carrier = element.animate([{ opacity: base }, { opacity: 0 }],
      { duration: BLOCK_ALPHA_CARRIER_MS, easing: "linear", fill: "both" });
    carrier.id = "zentype-ripple";
    carrier.pause();
    return carrier;
  }
  function writeCarrier(owner: Owner) {
    owner.carrier.currentTime = (1 - clamp(owner.value, 0, 1)) * BLOCK_ALPHA_CARRIER_MS;
  }
  function release(owner: Owner) {
    owner.carrier.cancel();
    owners.delete(owner.mapKey);
  }
  /** Bind one semantic owner to its current actuator element and start it at `step`. */
  function adopt(id: OwnerId, element: HTMLElement, base: number, step: BlockStep, parents: Owner[]): Owner {
    const owner: Owner = { mapKey: id, key: visualKey(element), element, base, parents,
      value: step.value, velocity: 0, target: step.target, carrier: carrierFor(element, base) };
    owners.set(id, owner);
    writeCarrier(owner);
    return owner;
  }
  function rebindElement(owner: Owner, element: HTMLElement, base: number) {
    owner.element = element;
    owner.base = base;
    owner.carrier.cancel();
    owner.carrier = carrierFor(element, base);
    writeCarrier(owner);
  }
  // These are the committed presentation ancestors, not the Host's potentially
  // reparented live ancestors. Composite alpha is the product of their local states.
  function presented(owner: Owner) {
    return owner.parents.reduce((value, parent) => value * parent.value, owner.value);
  }
  function snapshot() { return new Map([...owners.values()].map(owner => [owner.element, presented(owner)] as const)); }
  function baseFor(element: HTMLElement): number {
    const owner = owners.get(idOf(element));
    return owner && owner.element === element ? owner.base : Number(getComputedStyle(element).opacity);
  }
  function clear() {
    for (const owner of [...owners.values()]) release(owner);
    frozen = false;
    boundEditor = null;
    last = null;
  }
  return {
    size: () => owners.size,
    bind(editor: HTMLElement) {
      if (boundEditor === editor) return;
      boundEditor = editor;
      const owned = new Set([...owners.values()].map(owner => owner.carrier));
      let released = 0;
      for (const animation of editor.getAnimations({ subtree: true })) {
        if (animation.id !== "zentype-ripple" || owned.has(animation)) continue;
        animation.cancel();
        released++;
      }
      ZENTYPE_DEBUG: if (released) debug?.record("ripple", "stale-recovery", { released });
    },
    /** Hold block motion for one structural gate. Motion resumes from the held state. */
    freeze() {
      if (frozen) return;
      frozen = true;
      last = null;
      ZENTYPE_DEBUG: debug?.record("ripple", "presentation-hold", { blockCount: owners.size });
    },
    resume(reducedMotion: boolean) {
      if (!frozen && !reducedMotion) return;
      frozen = false;
      if (!reducedMotion) return;
      for (const owner of [...owners.values()]) {
        owner.value = owner.target;
        owner.velocity = 0;
        if (owner.target === 1) { release(owner); continue; }
        writeCarrier(owner);
      }
    },
    /** One Session frame: step the existing states and update their actuators. */
    step(now: number, reducedMotion: boolean): boolean {
      if (frozen) { last = null; return false; }
      const elapsed = last === null ? 0 : Math.max(0, now - last);
      last = now;
      let moving = false;
      const response = reducedMotion ? 0 : MOTION.blockAlphaResponseMs;
      for (const owner of [...owners.values()]) {
        if (owner.value === owner.target && owner.velocity === 0) continue;
        moving = true;
        if (stepCritical(owner, owner.target, elapsed, response, MOTION.alphaSettleEpsilon) && owner.target === 1) {
          release(owner);
          continue;
        }
        writeCarrier(owner);
      }
      // Nothing in flight: restart the clock so a later motion does not inherit
      // the idle interval as one elapsed step.
      if (!moving) last = null;
      return moving;
    },
    /** Rebind existing semantic owners; never plan against intermediate DOM. */
    rebind(added: readonly HTMLElement[], seed?: CarrySeed, focusedKey?: string | null,
      onRoleInvalidated?: (presentation: { key: string; value: number }) => void) {
      const previous = new Map<string, { value: number; target: number; parents: Owner[] }>();
      for (const owner of owners.values()) if (owner.key) previous.set(owner.key, {
        value: owner.value, target: owner.target, parents: owner.parents,
      });
      if (seed && !previous.has(seed.key)) previous.set(seed.key, { value: seed.value, target: seed.value, parents: [] });
      const measured = new Set<OwnerId>();
      const replacements = added.flatMap(element => {
        const key = visualKey(element);
        // A same-key replacement that the Host has already made the focused block
        // does not inherit the previous dim role: the key proves semantic object
        // continuity, not presentation-role continuity. The focused block is
        // represented by having no block opacity owner at all.
        if (key && key === focusedKey) {
          // Only a replacement that previously presented a committed role has a
          // stale role to invalidate. Its last value is the presentation the user
          // was actually looking at, so it travels with the invalidation.
          const carried = previous.get(key);
          if (carried) onRoleInvalidated?.({ key, value: carried.value });
          const owner = owners.get(key);
          if (owner) release(owner);
          return [];
        }
        const carried = key && element.isConnected ? previous.get(key) : undefined;
        return carried ? [{ element, key: key!, carried }] : [];
      });
      ZENTYPE_DEBUG: if (focusedKey && added.some(element => visualKey(element) === focusedKey)) {
        debug?.record("ripple", "replacement-role-invalidated", {
          key: focusedKey, reason: "focused-structural-replacement", carried: false,
        });
      }
      return () => {
        if (owners.size + replacements.length > STRUCTURE_LIMITS.nodes) {
          ZENTYPE_DEBUG: debug?.record("ripple", "ownership-limit", { phase: "replacement" });
          clear();
          return;
        }
        let moved = 0;
        for (const { element, key, carried } of replacements) {
          const owner = owners.get(key);
          if (owner) {
            if (owner.element === element) continue;
            // Same presentation state, new actuator. The host baseline may only be
            // read once per element per commit; afterwards the owner carries it.
            const base = measured.has(key) ? owner.base : (measured.add(key), Number(getComputedStyle(element).opacity));
            rebindElement(owner, element, base);
          } else {
            adopt(key, element, Number(getComputedStyle(element).opacity), { value: carried.value, target: carried.target }, carried.parents);
          }
          moved++;
        }
        ZENTYPE_DEBUG: if (moved) debug?.record("ripple", "replacement-rebind", { count: moved, blockCount: owners.size });
      };
    },
    /**
     * Immediate presentation safety after a structural reparent. A committed owner
     * the Host has moved above the focused block may not keep covering the focused
     * subtree: the focused block is represented by having no block opacity owner.
     *
     * Releasing it would uncover that element's own text at full brightness until
     * the semantic commit re-dims it one level down — the dim -> bright -> dim gap.
     * So the alpha moves with the role: the owner's value and target are re-expressed
     * on its own direct semantic content, everything that is not on the path to the
     * focused block, in this same delivery. The wrapper is then released, and the
     * composite the user sees is continuous. This is a bounded re-expression on one
     * element's children, not a neighborhood plan.
     */
    protectFocus(focused: HTMLElement) {
      let moved = 0;
      let released = 0;
      for (const owner of [...owners.values()]) {
        if (owner.element === focused) continue;
        if (!owner.element.isConnected || !owner.element.contains(focused)) continue;
        if (owner.target !== 1) {
          const children = owner.element.children;
          for (let index = 0; index < children.length; index++) {
            const child = children[index];
            if (child === focused || child.contains(focused)) continue;
            const key = visualKey(child as HTMLElement);
            if (!key || owners.has(key)) continue;
            adopt(key, child as HTMLElement, Number(getComputedStyle(child as HTMLElement).opacity),
              { value: owner.value, target: owner.target }, []);
            moved++;
          }
        }
        release(owner);
        released++;
      }
      ZENTYPE_DEBUG: if (released) debug?.record("ripple", "focus-ancestor-replaced", {
        released, moved, blockCount: owners.size,
      });
    },
    /** Read stage returns a write-only commit, so sentence/color reads can finish first. */
    prepare(targets: ReadonlyMap<HTMLElement, number>, editor: HTMLElement, reducedMotion: boolean) {
      const old = snapshot();
      const byKey = new Map<string, number>();
      // Current semantic projection. A detached owner is no longer presenting
      // anything, so its value must not be folded onto a live replacement.
      for (const owner of owners.values()) if (owner.key && owner.element.isConnected) {
        byKey.set(owner.key, old.get(owner.element)!);
      }
      // Match replacement owners and ancestors against the previous committed
      // bindings, even if SiYuan inserted before removing the old DOM element.
      for (const target of targets.keys()) {
        let element: HTMLElement | null = target;
        for (let depth = 0; element && element !== editor && depth < STRUCTURE_LIMITS.depth; depth++, element = element.parentElement) {
          const key = visualKey(element);
          const value = key && byKey.get(key);
          if (!old.has(element) && typeof value === "number") old.set(element, value);
        }
      }
      const steps = planHandoff(old, targets, editor);
      if (steps.size > STRUCTURE_LIMITS.nodes) return () => {
        ZENTYPE_DEBUG: debug?.record("ripple", "ownership-limit", { phase: "commit" });
        clear();
      };
      const bases = new Map([...steps].map(([element]) => [element, baseFor(element)]));
      return () => {
        frozen = false;
        let ownershipTelemetry: DebugRecord | null = null;
        ZENTYPE_DEBUG: if (debug) {
          const previousTargets = new Map<string, number>();
          for (const owner of owners.values()) if (owner.key) previousTargets.set(owner.key, owner.target);
          const changes: DebugRecord[] = [];
          let changedCount = 0;
          const recordChange = (key: string | null, previousValue: number | null,
            startValue: number, target: number, hadPreviousKey: boolean) => {
            changedCount++;
            if (changes.length >= OWNERSHIP_TELEMETRY_LIMIT) return;
            changes.push({ key, previousValue, startValue, target, hadPreviousKey });
          };
          for (const [element, step] of steps) {
            const key = visualKey(element) ?? null;
            const previousValue = old.get(element) ?? (key === null ? undefined : byKey.get(key));
            const previousTarget = key === null ? undefined : previousTargets.get(key);
            const hadPreviousKey = key === null ? old.has(element) : previousTargets.has(key);
            if (previousValue === undefined && step.value === 1 && step.target === 1) continue;
            if (previousValue !== undefined && Math.abs(previousValue - step.value) < BASELINE_EPSILON && previousTarget === step.target) continue;
            recordChange(key, previousValue ?? null, step.value, step.target, hadPreviousKey);
          }
          for (const [element, value] of old) {
            if (steps.has(element)) continue;
            const key = visualKey(element) ?? null;
            const previousTarget = key === null ? undefined : previousTargets.get(key);
            if (value === 1 && previousTarget === 1) continue;
            recordChange(key, value, value, 1, key === null || previousTargets.has(key));
          }
          ownershipTelemetry = {
            targetCount: targets.size,
            previousCount: old.size,
            stepCount: steps.size,
            changedCount,
            truncated: changedCount > changes.length,
            changes,
          };
        }
        const stepped = new Set<OwnerId>([...steps.keys()].map(idOf));
        const adopted = new Set<OwnerId>();
        for (const [element, step] of steps) {
          const id = idOf(element);
          const existing = owners.get(id);
          if (existing && existing.element !== element) {
            if (existing.element.isConnected) {
              // The same semantic state moves to a live successor; value and
              // velocity continue, so the move is invisible.
              rebindElement(existing, element, bases.get(element)!);
            } else {
              release(existing);
            }
          }
          let owner = owners.get(id);
          if (!owner) {
            if (step.value === 1 && step.target === 1) continue;
            owner = adopt(id, element, bases.get(element)!, step, []);
            adopted.add(id);
          } else if (owner.element === element && !adopted.has(id)) {
            if (Math.abs(owner.value - step.value) < BASELINE_EPSILON) {
              // The planned baseline is where this owner already is: a pure retarget.
              // Critical Motion continues from the current value and velocity.
              owner.target = step.target;
            } else {
              // Ancestry redistribution moved the local baseline; adopt the planned
              // start so the composite alpha stays where the user saw it.
              owner.value = step.value;
              owner.velocity = 0;
              owner.target = step.target;
            }
          }
          if (!owner) continue;
          if (reducedMotion && owner.value !== owner.target) {
            owner.value = owner.target;
            owner.velocity = 0;
          }
          writeCarrier(owner);
          if (owner.target === 1 && owner.value === 1) release(owner);
        }
        for (const owner of [...owners.values()]) if (!stepped.has(owner.mapKey)) release(owner);
        for (const owner of owners.values()) {
          owner.parents = [];
          let parent = owner.element.parentElement;
          for (let depth = 0; parent && parent !== editor && depth < STRUCTURE_LIMITS.depth; depth++, parent = parent.parentElement) {
            const ancestor = owners.get(idOf(parent));
            if (ancestor && ancestor !== owner) owner.parents.push(ancestor);
          }
        }
        ZENTYPE_DEBUG: if (ownershipTelemetry) debug?.record("ripple", "ownership-commit", {
          ...ownershipTelemetry, blockCount: owners.size,
        });
      };
    },
    clear,
  };
}
