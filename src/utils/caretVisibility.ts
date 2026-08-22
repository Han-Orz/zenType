/**
 * Ownership of the native caret while the global custom caret is renderable.
 * The owner is the nearest editable host, so switching editors removes the
 * marker from the previous host before hiding the new host's native caret.
 */

export const CUSTOM_CARET_OWNER_CLASS = "zentype-custom-caret-active";

export function findNativeCaretOwner(element: Element): HTMLElement | null {
  const readOnlyAncestor = element.closest<HTMLElement>(
    "[contenteditable='false'], [readonly], [aria-readonly='true']",
  );
  if (readOnlyAncestor) return null;

  const owner = element.closest<HTMLElement>(
    "[contenteditable='true'], [contenteditable='plaintext-only'], .protyle-title__input",
  );
  if (!owner) return null;
  if (
    owner.getAttribute("contenteditable") === "false" ||
    owner.hasAttribute("readonly") ||
    owner.getAttribute("aria-readonly") === "true"
  ) {
    return null;
  }
  return owner;
}

export function activateNativeCaretOwner(
  previous: HTMLElement | null,
  element: Element | null,
): HTMLElement | null {
  const owner = element ? findNativeCaretOwner(element) : null;

  // Cursor updates commonly resolve to the same editable owner. Avoid a
  // remove/add cycle unless the marker was externally removed.
  if (owner === previous && owner?.classList.contains(CUSTOM_CARET_OWNER_CLASS)) {
    return owner;
  }

  if (previous && previous !== owner && previous.classList.contains(CUSTOM_CARET_OWNER_CLASS)) {
    previous.classList.remove(CUSTOM_CARET_OWNER_CLASS);
  }
  if (!owner) return null;
  if (!owner.classList.contains(CUSTOM_CARET_OWNER_CLASS)) {
    owner.classList.add(CUSTOM_CARET_OWNER_CLASS);
  }
  return owner;
}

export function restoreNativeCaretOwner(previous: HTMLElement | null): null {
  previous?.classList.remove(CUSTOM_CARET_OWNER_CLASS);
  return null;
}
