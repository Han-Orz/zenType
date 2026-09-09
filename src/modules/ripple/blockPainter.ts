import { MOTION } from "../../config";
import { visualKey, STRUCTURE_LIMITS } from "../../structure";
import { planHandoff, type BlockStep } from "./blockPlan";
import type { DebugRecorder } from "../../debug/types";

interface Paint { value: number; from: number; target: number; base: number; animation: Animation; key: string | undefined }

/**
 * Opacity exists exclusively in owned WAAPI effects, including settled fills.
 * Never commitStyles(), never inline opacity, never a dim class. DOM cloning
 * cannot copy a KeyframeEffect. Cancelling the owner reveals the live host style.
 */
export function createBlockPainter(debug?: DebugRecorder) {
  const paints = new Map<HTMLElement, Paint>();
  let frozen = false;
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
  function clear() { for (const element of paints.keys()) release(element); frozen = false; }
  return {
    size: () => paints.size,
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
      debug?.record("ripple", "presentation-hold", { blockCount: paints.size });
    },
    /** Rebind only existing semantic owners; never plan against intermediate DOM. */
    rebind(added: readonly HTMLElement[]) {
      const previous = new Map<string, Paint>();
      for (const paint of paints.values()) if (paint.key) { sample(paint); previous.set(paint.key, paint); }
      const replacements = added.flatMap(element => {
        const key = visualKey(element);
        const old = key && previous.get(key);
        return old && !paints.has(element) && element.isConnected ? [{ element, old, base: Number(getComputedStyle(element).opacity) }] : [];
      });
      return () => {
        if (paints.size + replacements.length > STRUCTURE_LIMITS.nodes) {
          debug?.record("ripple", "ownership-limit", { phase: "replacement" });
          clear();
          return;
        }
        for (const { element, old, base } of replacements) {
          write(element, { value: old.value, target: frozen ? old.value : old.target }, base, false);
          if (frozen) paints.get(element)?.animation.pause();
        }
        if (replacements.length) debug?.record("ripple", "replacement-carry", { count: replacements.length, blockCount: paints.size });
      };
    },
    /** Read stage returns a write-only commit, so sentence/color reads can finish first. */
    prepare(targets: ReadonlyMap<HTMLElement, number>, editor: HTMLElement, reducedMotion: boolean) {
      const old = snapshot();
      const byKey = new Map<string, number>();
      for (const [element, paint] of paints) if (paint.key) byKey.set(paint.key, old.get(element)!);
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
        debug?.record("ripple", "ownership-limit", { phase: "commit" });
        clear();
      };
      const bases = new Map([...steps].map(([element]) => [element, paints.get(element)?.base ?? Number(getComputedStyle(element).opacity)]));
      return () => {
        frozen = false;
        for (const [element, step] of steps) write(element, step, bases.get(element)!, reducedMotion);
        for (const element of paints.keys()) if (!steps.has(element)) release(element);
        debug?.record("ripple", "ownership-commit", { targetCount: targets.size, previousCount: old.size,
          stepCount: steps.size, blockCount: paints.size });
      };
    },
    clear,
  };
}
