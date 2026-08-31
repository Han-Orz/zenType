import { RIPPLE_CONFIG } from "../../config";
import {
  claimInlineStyle,
  restoreOwnedInlineStyle,
  setOwnedInlineStyle,
  type InlineStyleValue,
  type OwnedInlineStyle,
} from "../../utils/inlineStyleOwnership";
import type { RippleTargetPlan } from "./semanticPlanner";

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

  function releaseTarget(element: HTMLElement, target: ActiveTarget): void {
    restoreOwnedInlineStyle(element.style, target.owned);
    removeRippleClass(element, target);
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
        };
        activeTargets.set(element, activeTarget);
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
      releaseTarget(element, activeTarget);
      activeTargets.delete(element);
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
