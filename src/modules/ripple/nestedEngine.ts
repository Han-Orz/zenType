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
  apply(wysiwyg: HTMLElement, focusElement: HTMLElement): boolean;
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

  function apply(wysiwyg: HTMLElement, focusElement: HTMLElement): boolean {
    const snapshot = getSnapshot(wysiwyg, focusElement);
    if (!snapshot) {
      styleApplier.clear();
      discardSnapshot();
      return false;
    }

    const plan = planSnapshot(snapshot);
    if (!plan) {
      styleApplier.clear();
      discardSnapshot();
      return false;
    }

    styleApplier.apply(plan, snapshot.bindings);
    return true;
  }

  function invalidateStructure(): void {
    structureDirty = true;
  }

  function clear(): void {
    styleApplier.clear();
    discardSnapshot();
  }

  return { apply, invalidateStructure, clear };
}
