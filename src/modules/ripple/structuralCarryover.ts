import {
  claimInlineStyle,
  restoreOwnedInlineStyle,
  setOwnedInlineStyle,
  type OwnedInlineStyle,
} from "../../utils/inlineStyleOwnership";

export const RIPPLE_BLOCK_CLASS = "zentype-ripple-block";
export const RIPPLE_OPACITY_PROPERTY = "--zt-ripple-opacity";
export const RIPPLE_TRANSITION_DURATION_PROPERTY = "--zt-ripple-transition-duration";
export const RIPPLE_STYLE_PROPERTIES = [
  RIPPLE_OPACITY_PROPERTY,
  RIPPLE_TRANSITION_DURATION_PROPERTY,
] as const;

interface StructuralCarryover {
  owned: OwnedInlineStyle;
  classAdded: boolean;
}

export interface RippleOwnershipClaim {
  owned: OwnedInlineStyle;
  adoptedStructuralCarryover: boolean;
  classAdded: boolean;
}

const structuralCarryovers = new Map<HTMLElement, StructuralCarryover>();

export function hasStructuralCarryovers(): boolean {
  return structuralCarryovers.size > 0;
}

/**
 * Install the last valid block opacity on a host-created replacement until the
 * normal Ripple owner can rebuild against the stable DOM. Only clean
 * replacement elements are eligible; existing Ripple state belongs to another
 * owner and must not be overwritten here.
 */
export function installStructuralCarryover(
  element: HTMLElement,
  opacity: string,
): boolean {
  if (!element.isConnected || structuralCarryovers.has(element)) return false;
  if (element.classList.contains(RIPPLE_BLOCK_CLASS)) return false;
  if (
    element.style.getPropertyValue(RIPPLE_OPACITY_PROPERTY) !== "" ||
    element.style.getPropertyValue(RIPPLE_TRANSITION_DURATION_PROPERTY) !== ""
  ) return false;

  const owned = claimInlineStyle(element.style, RIPPLE_STYLE_PROPERTIES);
  const durationApplied = setOwnedInlineStyle(
    element.style,
    owned,
    RIPPLE_TRANSITION_DURATION_PROPERTY,
    "0s",
  );
  const opacityApplied = durationApplied && setOwnedInlineStyle(
    element.style,
    owned,
    RIPPLE_OPACITY_PROPERTY,
    opacity,
  );
  if (!durationApplied || !opacityApplied) {
    restoreOwnedInlineStyle(element.style, owned);
    return false;
  }

  element.classList.add(RIPPLE_BLOCK_CLASS);
  structuralCarryovers.set(element, { owned, classAdded: true });
  return true;
}

/**
 * Claim normal Ripple ownership. If the element is carrying a structural
 * baseline, transfer that exact ownership record instead of clearing it first;
 * this preserves both the rendered baseline and the true pre-Ripple original.
 */
export function claimRippleOwnership(element: HTMLElement): RippleOwnershipClaim {
  const carryover = structuralCarryovers.get(element);
  if (carryover) {
    structuralCarryovers.delete(element);
    return {
      owned: carryover.owned,
      adoptedStructuralCarryover: true,
      classAdded: carryover.classAdded,
    };
  }

  return {
    owned: claimInlineStyle(element.style, RIPPLE_STYLE_PROPERTIES),
    adoptedStructuralCarryover: false,
    classAdded: false,
  };
}

/** Release only carryovers that no permanent Ripple owner consumed. */
export function clearStructuralCarryovers(): void {
  for (const [element, carryover] of structuralCarryovers) {
    restoreOwnedInlineStyle(element.style, carryover.owned);
    if (carryover.classAdded && element.classList.contains(RIPPLE_BLOCK_CLASS)) {
      element.classList.remove(RIPPLE_BLOCK_CLASS);
    }
  }
  structuralCarryovers.clear();
}
