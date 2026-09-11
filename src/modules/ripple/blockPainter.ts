import { MOTION } from "../../config";
import { visualKey, STRUCTURE_LIMITS } from "../../structure";
import { planHandoff, type BlockStep } from "./blockPlan";
import type { DebugRecord, DebugRecorder } from "../../debug/types";

const OWNERSHIP_TELEMETRY_LIMIT = 16;

interface Paint { value: number; from: number; target: number; base: number; animation: Animation; key: string | undefined }
interface CarrySeed { key: string; value: number }

/**
 * Opacity exists exclusively in owned WAAPI effects, including settled fills.
 * Never commitStyles(), never inline opacity, never a dim class. DOM cloning
 * cannot copy a KeyframeEffect. Cancelling the owner reveals the live host style.
 */
export function createBlockPainter(debug?: DebugRecorder) {
  const paints = new Map<HTMLElement, Paint>();
  let frozen = false;
  let boundEditor: HTMLElement | null = null;
  function sample(paint: Paint) {
    const time = paint.animation.currentTime;
    if (typeof time === "number") {
      const progress = Math.min(1, Math.max(0, time / MOTION.blockFadeMs));
      paint.value = paint.from + (paint.target - paint.from) * (1 - Math.pow(1 - progress, 3));
    }
    return paint.value;
  }
  function release(element: HTMLElement) {
    const paint = paints.get(element);
    if (!paint) return;
    paint.animation.onfinish = null;
    paint.animation.cancel();
    paints.delete(element);
  }
  function write(element: HTMLElement, step: BlockStep, base: number, reducedMotion: boolean) {
    const old = paints.get(element);
    if (old && Math.abs(sample(old) - step.value) < 0.002 && old.target === step.target) {
      if (reducedMotion) old.animation.finish();
      else if (old.animation.playState === "paused") old.animation.play();
      return;
    }
    if (step.value === 1 && step.target === 1) { release(element); return; }
    const animation = element.animate([{ opacity: step.value * base }, { opacity: step.target * base }], {
      duration: MOTION.blockFadeMs, easing: "cubic-bezier(0.333333, 1, 0.666667, 1)", fill: "both",
    });
    animation.id = "zentype-ripple";
    // Install the incoming effect before cancelling the outgoing one. No style
    // flush/transition suppression is needed: the underlying CSS never changed.
    release(element);
    const paint: Paint = { ...step, from: step.value, base, animation, key: visualKey(element) };
    paints.set(element, paint);
    animation.onfinish = () => {
      if (paints.get(element) !== paint) return;
      paint.value = paint.target;
      if (paint.target === 1) release(element);
    };
    if (reducedMotion) animation.finish();
  }
  function snapshot() { return new Map([...paints].map(([element, paint]) => [element, sample(paint)])); }
  function clear() {
    for (const element of paints.keys()) release(element);
    frozen = false;
    boundEditor = null;
  }
  return {
    size: () => paints.size,
    bind(editor: HTMLElement) {
      if (boundEditor === editor) return;
      boundEditor = editor;
      const owned = new Set([...paints.values()].map(paint => paint.animation));
      let released = 0;
      for (const animation of editor.getAnimations({ subtree: true })) {
        if (animation.id !== "zentype-ripple" || owned.has(animation)) continue;
        animation.cancel();
        released++;
      }
      ZENTYPE_DEBUG: if (released) debug?.record("ripple", "stale-recovery", { released });
    },
    resume(reducedMotion: boolean) {
      if (!frozen && !reducedMotion) return;
      frozen = false;
      for (const paint of paints.values()) {
        if (reducedMotion) paint.animation.finish();
        else if (paint.animation.playState === "paused") paint.animation.play();
      }
    },
    freeze() {
      if (frozen) return;
      frozen = true;
      for (const paint of paints.values()) {
        sample(paint);
        if (paint.animation.playState === "running") paint.animation.pause();
      }
      ZENTYPE_DEBUG: debug?.record("ripple", "presentation-hold", { blockCount: paints.size });
    },
    /** Rebind only existing semantic owners; never plan against intermediate DOM. */
    rebind(added: readonly HTMLElement[], seed?: CarrySeed, focusedKey?: string | null) {
      const previous = new Map<string, Pick<Paint, "value" | "target">>();
      for (const paint of paints.values()) if (paint.key) { sample(paint); previous.set(paint.key, paint); }
      if (seed && !previous.has(seed.key)) previous.set(seed.key, { value: seed.value, target: seed.value });
      const replacements = added.flatMap(element => {
        const key = visualKey(element);
        // A same-key replacement that the Host has already made the focused block
        // does not inherit the previous dim role: the key proves semantic object
        // continuity, not presentation-role continuity. The focused block is
        // represented by having no block opacity owner at all.
        if (key && key === focusedKey) return [];
        const old = key && previous.get(key);
        return old && !paints.has(element) && element.isConnected ? [{ element, old, base: Number(getComputedStyle(element).opacity) }] : [];
      });
      ZENTYPE_DEBUG: if (focusedKey && added.some(element => visualKey(element) === focusedKey)) {
        debug?.record("ripple", "replacement-role-invalidated", {
          key: focusedKey, reason: "focused-structural-replacement", carried: false,
        });
      }
      return () => {
        if (paints.size + replacements.length > STRUCTURE_LIMITS.nodes) {
          ZENTYPE_DEBUG: debug?.record("ripple", "ownership-limit", { phase: "replacement" });
          clear();
          return;
        }
        for (const { element, old, base } of replacements) {
          write(element, { value: old.value, target: frozen ? old.value : old.target }, base, false);
          if (frozen) paints.get(element)?.animation.pause();
        }
        ZENTYPE_DEBUG: if (replacements.length) debug?.record("ripple", "replacement-carry", { count: replacements.length, blockCount: paints.size });
      };
    },
    /** Read stage returns a write-only commit, so sentence/color reads can finish first. */
    prepare(targets: ReadonlyMap<HTMLElement, number>, editor: HTMLElement, reducedMotion: boolean) {
      const old = snapshot();
      const byKey = new Map<string, number>();
      // Current semantic projection. A detached owner is no longer presenting
      // anything, so its value must not be folded onto a live replacement.
      for (const [element, paint] of paints) if (paint.key && element.isConnected) byKey.set(paint.key, old.get(element)!);
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
      const bases = new Map([...steps].map(([element]) => [element, paints.get(element)?.base ?? Number(getComputedStyle(element).opacity)]));
      return () => {
        frozen = false;
        let ownershipTelemetry: DebugRecord | null = null;
        ZENTYPE_DEBUG: if (debug) {
          const previousTargets = new Map<string, number>();
          for (const paint of paints.values()) if (paint.key) previousTargets.set(paint.key, paint.target);
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
            const previousTarget = key === null ? paints.get(element)?.target : previousTargets.get(key);
            const hadPreviousKey = key === null ? old.has(element) : previousTargets.has(key);
            if (previousValue === undefined && step.value === 1 && step.target === 1) continue;
            if (previousValue !== undefined && Math.abs(previousValue - step.value) < 0.002 && previousTarget === step.target) continue;
            recordChange(key, previousValue ?? null, step.value, step.target, hadPreviousKey);
          }
          for (const [element, value] of old) {
            if (steps.has(element)) continue;
            const key = visualKey(element) ?? null;
            const previousTarget = key === null ? paints.get(element)?.target : previousTargets.get(key);
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
        for (const [element, step] of steps) write(element, step, bases.get(element)!, reducedMotion);
        for (const element of paints.keys()) if (!steps.has(element)) release(element);
        ZENTYPE_DEBUG: if (ownershipTelemetry) debug?.record("ripple", "ownership-commit", {
          ...ownershipTelemetry, blockCount: paints.size,
        });
      };
    },
    clear,
  };
}
