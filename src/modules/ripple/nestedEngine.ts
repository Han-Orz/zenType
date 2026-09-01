import {
  buildRippleDomSnapshot,
  type RippleDomSnapshot,
} from "./domAdapter";
import {
  planRippleTargets,
  type RippleTargetPlan,
} from "./semanticPlanner";
import {
  createRippleStyleApplier,
  type RippleStyleApplier,
} from "./styleApplier";

export interface NestedRippleEngine {
  apply(
    wysiwyg: HTMLElement,
    focusElement: HTMLElement,
    options?: { preserveOnInvalid?: boolean },
  ): boolean;
  hasActiveStyles(): boolean;
  invalidateStructure(): void;
  clear(): void;
}

interface SnapshotCache {
  wysiwyg: HTMLElement;
  focusElement: HTMLElement;
  snapshot: RippleDomSnapshot;
}

function planSnapshot(snapshot: RippleDomSnapshot): RippleTargetPlan | null {
  return planRippleTargets(snapshot.tree, snapshot.focusItemId);
}

export function createNestedRippleEngine(): NestedRippleEngine {
  const styleApplier: RippleStyleApplier = createRippleStyleApplier();
  let cached: SnapshotCache | null = null;
  let structureDirty = true;
  let activeStyles = false;

  function discardSnapshot(): void {
    cached = null;
    structureDirty = true;
  }

  function getSnapshot(
    wysiwyg: HTMLElement,
    focusElement: HTMLElement,
  ): RippleDomSnapshot | null {
    if (
      cached &&
      !structureDirty &&
      cached.wysiwyg === wysiwyg &&
      cached.focusElement === focusElement
    ) {
      return cached.snapshot;
    }

    const snapshot = buildRippleDomSnapshot(wysiwyg, focusElement);
    if (!snapshot) return null;

    cached = { wysiwyg, focusElement, snapshot };
    structureDirty = false;
    return snapshot;
  }

  function apply(
    wysiwyg: HTMLElement,
    focusElement: HTMLElement,
    options: { preserveOnInvalid?: boolean } = {},
  ): boolean {
    const snapshot = getSnapshot(wysiwyg, focusElement);
    if (!snapshot) {
      if (!options.preserveOnInvalid) {
        styleApplier.clear();
        activeStyles = false;
      }
      discardSnapshot();
      return false;
    }

    const plan = planSnapshot(snapshot);
    if (!plan) {
      if (!options.preserveOnInvalid) {
        styleApplier.clear();
        activeStyles = false;
      }
      discardSnapshot();
      return false;
    }

    styleApplier.apply(plan, snapshot.bindings);
    activeStyles = plan.targets.length > 0;
    return true;
  }

  function hasActiveStyles(): boolean {
    return activeStyles;
  }

  function invalidateStructure(): void {
    structureDirty = true;
  }

  function clear(): void {
    styleApplier.clear();
    activeStyles = false;
    discardSnapshot();
  }

  return { apply, hasActiveStyles, invalidateStructure, clear };
}
