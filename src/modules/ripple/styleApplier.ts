import { RIPPLE_CONFIG } from "../../config";
import {
  claimInlineStyle,
  restoreOwnedInlineStyle,
  setOwnedInlineStyle,
  type InlineStyleValue,
  type OwnedInlineStyle,
} from "../../utils/inlineStyleOwnership";
import type { RippleTargetPlan } from "./semanticPlanner";
import { releaseAfterOpacityTransition } from "./transitionRelease";

const RIPPLE_BLOCK_CLASS = "zentype-ripple-block";
const RIPPLE_OPACITY_PROPERTY = "--zt-ripple-opacity";
const RIPPLE_TRANSITION_DURATION_PROPERTY = "--zt-ripple-transition-duration";
const RIPPLE_STYLE_PROPERTIES = [
  RIPPLE_OPACITY_PROPERTY,
  RIPPLE_TRANSITION_DURATION_PROPERTY,
] as const;

interface ActiveTarget {
  owned: OwnedInlineStyle;
  classAdded: boolean;
  blocked: boolean;
  pendingExit: ReturnType<typeof setTimeout> | null;
}

interface OwnershipHandoffSource {
  element: HTMLElement;
  target: ActiveTarget;
}

interface PendingHandoff {
  target: ActiveTarget;
  finalOpacity: string;
}

export interface RippleStyleApplier {
  apply(
    plan: RippleTargetPlan,
    bindings: ReadonlyMap<string, HTMLElement>,
  ): void;
  clear(animate?: boolean): void;
}

function sameStyleValue(a: InlineStyleValue, b: InlineStyleValue): boolean {
  return a.value === b.value && a.priority === b.priority;
}

function currentStyleValue(style: CSSStyleDeclaration, property: string): InlineStyleValue {
  return {
    value: style.getPropertyValue(property),
    priority: style.getPropertyPriority(property),
  };
}

function applyPrivateProperty(
  element: HTMLElement,
  owned: OwnedInlineStyle,
  property: string,
  value: string,
): boolean {
  if (owned.blocked.has(property)) return false;

  const applied = owned.applied[property];
  const expected: InlineStyleValue = { value, priority: "" };
  if (
    applied &&
    sameStyleValue(applied, expected) &&
    sameStyleValue(currentStyleValue(element.style, property), applied)
  ) {
    return true;
  }

  return setOwnedInlineStyle(element.style, owned, property, value);
}

function addRippleClass(element: HTMLElement, target: ActiveTarget): void {
  if (element.classList.contains(RIPPLE_BLOCK_CLASS)) return;
  element.classList.add(RIPPLE_BLOCK_CLASS);
  target.classAdded = true;
}

function removeRippleClass(element: HTMLElement, target: ActiveTarget): void {
  if (!target.classAdded || !element.classList.contains(RIPPLE_BLOCK_CLASS)) return;
  element.classList.remove(RIPPLE_BLOCK_CLASS);
  target.classAdded = false;
}

function opacityForDistance(distance: number): string {
  const levels = RIPPLE_CONFIG.BLOCK_LEVELS;
  return String(levels[Math.min(distance, levels.length - 1)]);
}

export function createRippleStyleApplier(): RippleStyleApplier {
  const activeTargets = new Map<HTMLElement, ActiveTarget>();
  const pendingHandoffs = new Map<HTMLElement, PendingHandoff>();
  let pendingHandoffFrame: number | null = null;

  function cancelPendingExit(target: ActiveTarget): void {
    if (target.pendingExit === null) return;
    clearTimeout(target.pendingExit);
    target.pendingExit = null;
  }

  function releaseTarget(element: HTMLElement, target: ActiveTarget): void {
    cancelPendingExit(target);
    restoreOwnedInlineStyle(element.style, target.owned);
    removeRippleClass(element, target);
  }

  function cancelPendingHandoffFrame(): void {
    if (pendingHandoffFrame === null) return;
    if (typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(pendingHandoffFrame);
    }
    pendingHandoffFrame = null;
  }

  function flushPendingHandoffs(): void {
    const handoffs = [...pendingHandoffs.entries()];
    pendingHandoffs.clear();

    for (const [element, handoff] of handoffs) {
      if (activeTargets.get(element) !== handoff.target || handoff.target.blocked) continue;

      const durationApplied = applyPrivateProperty(
        element,
        handoff.target.owned,
        RIPPLE_TRANSITION_DURATION_PROPERTY,
        `${RIPPLE_CONFIG.TRANSITION_SEC}s`,
      );
      const opacityApplied = durationApplied && applyPrivateProperty(
        element,
        handoff.target.owned,
        RIPPLE_OPACITY_PROPERTY,
        handoff.finalOpacity,
      );
      if (durationApplied && opacityApplied) continue;

      handoff.target.blocked = true;
      releaseTarget(element, handoff.target);
      activeTargets.delete(element);
    }
  }

  function schedulePendingHandoffFlush(): void {
    if (pendingHandoffs.size === 0 || pendingHandoffFrame !== null) return;
    if (typeof requestAnimationFrame !== "function") {
      flushPendingHandoffs();
      return;
    }
    pendingHandoffFrame = requestAnimationFrame(() => {
      pendingHandoffFrame = null;
      flushPendingHandoffs();
    });
  }

  function settlePendingHandoffsBeforeApply(): void {
    cancelPendingHandoffFrame();
    if (pendingHandoffs.size > 0) flushPendingHandoffs();
  }

  function findHandoffSource(
    element: HTMLElement,
    target: ActiveTarget,
    nextTargets: Set<HTMLElement>,
  ): OwnershipHandoffSource | null {
    for (const nextElement of nextTargets) {
      if (element.contains(nextElement) || nextElement.contains(element)) {
        return { element, target };
      }
    }
    return null;
  }

  function releaseTargetAfterTransition(
    element: HTMLElement,
    target: ActiveTarget,
  ): void {
    if (target.pendingExit !== null) return;

    const appliedOpacity = target.owned.applied[RIPPLE_OPACITY_PROPERTY];
    if (
      appliedOpacity?.value === "1" &&
      sameStyleValue(currentStyleValue(element.style, RIPPLE_OPACITY_PROPERTY), appliedOpacity)
    ) {
      releaseTarget(element, target);
      activeTargets.delete(element);
      return;
    }

    target.pendingExit = releaseAfterOpacityTransition(
      RIPPLE_CONFIG.TRANSITION_SEC,
      () => {
        const applied = applyPrivateProperty(
          element,
          target.owned,
          RIPPLE_OPACITY_PROPERTY,
          "1",
        );
        if (!applied) target.blocked = true;
        return applied;
      },
      () => {
        target.pendingExit = null;
        if (activeTargets.get(element) !== target) return;
        releaseTarget(element, target);
        activeTargets.delete(element);
      },
    );
  }

  function apply(plan: RippleTargetPlan, bindings: ReadonlyMap<string, HTMLElement>): void {
    settlePendingHandoffsBeforeApply();
    const nextTargets = new Set<HTMLElement>();

    for (const target of plan.targets) {
      const element = bindings.get(target.semanticId);
      if (!element || nextTargets.has(element)) continue;
      nextTargets.add(element);
    }

    const handoffSources = new Map<HTMLElement, OwnershipHandoffSource>();
    const handoffSourceElements = new Set<HTMLElement>();
    for (const [element, activeTarget] of activeTargets) {
      if (nextTargets.has(element)) continue;
      const source = findHandoffSource(element, activeTarget, nextTargets);
      if (!source) continue;
      handoffSourceElements.add(element);
      for (const nextElement of nextTargets) {
        if (
          (element.contains(nextElement) || nextElement.contains(element)) &&
          !handoffSources.has(nextElement)
        ) {
          handoffSources.set(nextElement, source);
        }
      }
    }

    for (const target of plan.targets) {
      const element = bindings.get(target.semanticId);
      if (!element || !nextTargets.has(element)) continue;

      let activeTarget = activeTargets.get(element);
      const handoffSource = activeTarget ? undefined : handoffSources.get(element);
      if (!activeTarget) {
        activeTarget = {
          owned: claimInlineStyle(element.style, RIPPLE_STYLE_PROPERTIES),
          classAdded: false,
          blocked: false,
          pendingExit: null,
        };
        activeTargets.set(element, activeTarget);
      } else {
        cancelPendingExit(activeTarget);
      }

      if (activeTarget.blocked) continue;

      const finalOpacity = opacityForDistance(target.distance);
      if (handoffSource) {
        // Establish the new layer at the old layer's visual baseline while
        // transitions are suppressed. The old layer is released below in the
        // same task; the next frame restores the transition and retargets.
        const durationApplied = applyPrivateProperty(
          element,
          activeTarget.owned,
          RIPPLE_TRANSITION_DURATION_PROPERTY,
          "0s",
        );
        const baselineOpacity = handoffSource.target.owned.applied[RIPPLE_OPACITY_PROPERTY]?.value ?? "1";
        const baselineApplied = durationApplied && applyPrivateProperty(
          element,
          activeTarget.owned,
          RIPPLE_OPACITY_PROPERTY,
          baselineOpacity,
        );
        if (!durationApplied || !baselineApplied) {
          activeTarget.blocked = true;
          restoreOwnedInlineStyle(element.style, activeTarget.owned);
          removeRippleClass(element, activeTarget);
          continue;
        }

        addRippleClass(element, activeTarget);
        if (baselineOpacity === finalOpacity) {
          const normalDurationApplied = applyPrivateProperty(
            element,
            activeTarget.owned,
            RIPPLE_TRANSITION_DURATION_PROPERTY,
            `${RIPPLE_CONFIG.TRANSITION_SEC}s`,
          );
          if (!normalDurationApplied) {
            activeTarget.blocked = true;
            releaseTarget(element, activeTarget);
            activeTargets.delete(element);
          }
        } else {
          pendingHandoffs.set(element, { target: activeTarget, finalOpacity });
        }
        continue;
      }

      const opacityApplied = applyPrivateProperty(
        element,
        activeTarget.owned,
        RIPPLE_OPACITY_PROPERTY,
        finalOpacity,
      );
      const durationApplied = opacityApplied && applyPrivateProperty(
        element,
        activeTarget.owned,
        RIPPLE_TRANSITION_DURATION_PROPERTY,
        `${RIPPLE_CONFIG.TRANSITION_SEC}s`,
      );

      if (!opacityApplied || !durationApplied) {
        activeTarget.blocked = true;
        restoreOwnedInlineStyle(element.style, activeTarget.owned);
        removeRippleClass(element, activeTarget);
        continue;
      }

      addRippleClass(element, activeTarget);
    }

    for (const [element, activeTarget] of activeTargets) {
      if (nextTargets.has(element)) continue;
      if (handoffSourceElements.has(element)) {
        // An ancestor or descendant target is taking over this element's
        // visual subtree. Do not stage the old layer through natural opacity
        // first: that would create a dim -> full -> dim handoff under CSS
        // opacity multiplication.
        releaseTarget(element, activeTarget);
        activeTargets.delete(element);
      } else {
        releaseTargetAfterTransition(element, activeTarget);
      }
    }

    schedulePendingHandoffFlush();
  }

  function clear(animate = true): void {
    cancelPendingHandoffFrame();
    if (animate) {
      for (const [element, handoff] of pendingHandoffs) {
        if (activeTargets.get(element) !== handoff.target || handoff.target.blocked) continue;
        applyPrivateProperty(
          element,
          handoff.target.owned,
          RIPPLE_TRANSITION_DURATION_PROPERTY,
          `${RIPPLE_CONFIG.TRANSITION_SEC}s`,
        );
      }
    }
    pendingHandoffs.clear();
    for (const [element, activeTarget] of activeTargets) {
      if (animate) releaseTargetAfterTransition(element, activeTarget);
      else releaseTarget(element, activeTarget);
    }
    if (!animate) activeTargets.clear();
  }

  return { apply, clear };
}
