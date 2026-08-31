import { RIPPLE_CONFIG } from "../../config";
import {
  claimInlineStyle,
  restoreOwnedInlineStyle,
  setOwnedInlineStyle,
  type InlineStyleValue,
  type OwnedInlineStyle,
} from "../../utils/inlineStyleOwnership";
import type {
  RippleTargetPlan,
  RippleTargetRole,
} from "./semanticPlanner";

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
  role: RippleTargetRole;
  pendingExit: ReturnType<typeof setTimeout> | null;
}

export interface RippleStyleApplier {
  apply(
    plan: RippleTargetPlan,
    bindings: ReadonlyMap<string, HTMLElement>,
  ): void;
  clear(): void;
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

  function shouldAnimateExit(
    element: HTMLElement,
    target: ActiveTarget,
    nextTargets: Set<HTMLElement>,
  ): boolean {
    if (target.role !== "branch-root") return false;
    for (const nextElement of nextTargets) {
      if (element.contains(nextElement)) return true;
    }
    return false;
  }

  function releaseBranchRootAfterTransition(
    element: HTMLElement,
    target: ActiveTarget,
  ): void {
    const opacityApplied = applyPrivateProperty(
      element,
      target.owned,
      RIPPLE_OPACITY_PROPERTY,
      "1",
    );
    if (!opacityApplied) {
      target.blocked = true;
      releaseTarget(element, target);
      activeTargets.delete(element);
      return;
    }

    if (RIPPLE_CONFIG.TRANSITION_SEC === 0) {
      releaseTarget(element, target);
      activeTargets.delete(element);
      return;
    }

    target.pendingExit = setTimeout(() => {
      target.pendingExit = null;
      if (activeTargets.get(element) !== target) return;
      releaseTarget(element, target);
      activeTargets.delete(element);
    }, RIPPLE_CONFIG.TRANSITION_SEC * 1000);
  }

  function apply(plan: RippleTargetPlan, bindings: ReadonlyMap<string, HTMLElement>): void {
    const nextTargets = new Set<HTMLElement>();

    for (const target of plan.targets) {
      const element = bindings.get(target.semanticId);
      if (!element || nextTargets.has(element)) continue;
      nextTargets.add(element);

      let activeTarget = activeTargets.get(element);
      if (!activeTarget) {
        activeTarget = {
          owned: claimInlineStyle(element.style, RIPPLE_STYLE_PROPERTIES),
          classAdded: false,
          blocked: false,
          role: target.role,
          pendingExit: null,
        };
        activeTargets.set(element, activeTarget);
      } else {
        cancelPendingExit(activeTarget);
        activeTarget.role = target.role;
      }

      if (activeTarget.blocked) continue;

      const opacityApplied = applyPrivateProperty(
        element,
        activeTarget.owned,
        RIPPLE_OPACITY_PROPERTY,
        opacityForDistance(target.distance),
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
      if (shouldAnimateExit(element, activeTarget, nextTargets)) {
        releaseBranchRootAfterTransition(element, activeTarget);
      } else {
        releaseTarget(element, activeTarget);
        activeTargets.delete(element);
      }
    }
  }

  function clear(): void {
    for (const [element, activeTarget] of activeTargets) {
      releaseTarget(element, activeTarget);
    }
    activeTargets.clear();
  }

  return { apply, clear };
}
