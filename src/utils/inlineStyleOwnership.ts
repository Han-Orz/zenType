/**
 * Track inline style properties written by a visual effect and restore only
 * the values that were present before the effect claimed ownership.
 *
 * The current-value check is intentional: if another plugin changes a
 * property while we own it, releasing the effect must not overwrite that
 * newer value.
 */

export interface InlineStyleValue {
  value: string;
  priority: string;
}

export interface OwnedInlineStyle {
  original: Record<string, InlineStyleValue>;
  applied: Record<string, InlineStyleValue>;
  blocked: Set<string>;
}

function readStyleValue(style: CSSStyleDeclaration, property: string): InlineStyleValue {
  return {
    value: style.getPropertyValue(property),
    priority: style.getPropertyPriority(property),
  };
}

function sameStyleValue(a: InlineStyleValue, b: InlineStyleValue): boolean {
  return a.value === b.value && a.priority === b.priority;
}

export function claimInlineStyle(
  style: CSSStyleDeclaration,
  properties: readonly string[],
): OwnedInlineStyle {
  const original: Record<string, InlineStyleValue> = {};
  for (const property of properties) {
    original[property] = readStyleValue(style, property);
  }
  return { original, applied: {}, blocked: new Set<string>() };
}

export function setOwnedInlineStyle(
  style: CSSStyleDeclaration,
  owned: OwnedInlineStyle,
  property: string,
  value: string,
  priority = "",
): boolean {
  if (owned.blocked.has(property)) return false;

  const applied = owned.applied[property];
  if (applied && !sameStyleValue(readStyleValue(style, property), applied)) {
    // The value changed after our last write. Treat it as a hand-off to the
    // external owner and never overwrite it on a later animation frame.
    owned.blocked.add(property);
    delete owned.applied[property];
    return false;
  }

  style.setProperty(property, value, priority);
  owned.applied[property] = readStyleValue(style, property);
  return true;
}

export function restoreOwnedInlineStyle(
  style: CSSStyleDeclaration,
  owned: OwnedInlineStyle,
): void {
  for (const [property, applied] of Object.entries(owned.applied)) {
    const current = readStyleValue(style, property);
    if (!sameStyleValue(current, applied)) continue;

    const original = owned.original[property] ?? { value: "", priority: "" };
    style.setProperty(property, original.value, original.priority);
  }
}
