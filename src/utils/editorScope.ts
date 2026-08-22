import { getActiveEditor } from "siyuan";

const ELEMENT_NODE = 1;

function activeEditorElement(): HTMLElement | null {
  try {
    const editor = getActiveEditor();
    return (editor?.protyle?.element as HTMLElement | undefined) ?? null;
  } catch {
    return null;
  }
}

function asNode(target: EventTarget | Node | null | undefined): Node | null {
  if (!target || typeof target !== "object") return null;
  if ("nodeType" in target) return target as Node;
  return null;
}

function parentElementOf(node: Node): Element | null {
  if (node.nodeType === ELEMENT_NODE) return node as Element;
  return node.parentElement;
}

function contains(root: Element, node: Node): boolean {
  return root === node || root.contains(node);
}

function isEditableNode(target: EventTarget | Node | null | undefined, root: HTMLElement): boolean {
  const node = asNode(target);
  if (!node || !contains(root, node)) return false;
  return isEditableElement(parentElementOf(node));
}

function isEditableElement(element: Element | null): boolean {
  if (!element || typeof element.closest !== "function") return false;
  const editable = element.closest(
    "[contenteditable='true'], [contenteditable='plaintext-only'], .protyle-title__input",
  ) as HTMLElement | null;
  if (!editable) return false;
  if (editable.closest("[contenteditable='false'], [readonly], [aria-readonly='true']")) {
    return false;
  }
  // isContentEditable is available on real HTMLElement instances. Keep title
  // inputs valid on hosts that do not expose it consistently.
  return editable.classList?.contains("protyle-title__input")
    || editable.isContentEditable !== false;
}

/** Whether a node belongs to the currently active SiYuan Protyle. */
export function isInActiveEditor(target: EventTarget | Node | null | undefined): boolean {
  const node = asNode(target);
  const root = activeEditorElement();
  return !!node && !!root && contains(root, node);
}

/** Whether a node belongs to an editable region of the active Protyle. */
export function isEditableTarget(target: EventTarget | Node | null | undefined): boolean {
  const root = activeEditorElement();
  return !!root && isEditableNode(target, root);
}

/** Scope a target-bearing event to the active editable Protyle. */
export function isEditableEvent(event: Event): boolean {
  const root = activeEditorElement();
  if (!root) return false;
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  if (path.some((target) => isEditableNode(target as EventTarget, root))) return true;
  return isEditableNode(event.target, root);
}

/** Selectionchange/resize have no useful target; validate current selection. */
export function isCurrentSelectionEditable(): boolean {
  const selection = typeof window !== "undefined" ? window.getSelection() : null;
  const root = activeEditorElement();
  if (!selection || selection.rangeCount === 0 || !root) return false;
  return isEditableNode(selection.anchorNode, root) || isEditableNode(selection.focusNode, root);
}

/** Whether the current targetless Selection still belongs to the active Protyle. */
export function isCurrentSelectionInActiveEditor(): boolean {
  const selection = typeof window !== "undefined" ? window.getSelection() : null;
  const root = activeEditorElement();
  if (!selection || selection.rangeCount === 0 || !root) return false;
  const anchor = asNode(selection.anchorNode);
  const focus = asNode(selection.focusNode);
  return (!!anchor && contains(root, anchor)) || (!!focus && contains(root, focus));
}

/** Focusout uses relatedTarget to distinguish an internal focus move. */
export function isFocusInsideActiveEditor(target: EventTarget | Node | null | undefined): boolean {
  const node = asNode(target);
  const root = activeEditorElement();
  return !!node && !!root && contains(root, node);
}

/** An event in the active Protyle but outside an editable region is readonly UI. */
export function isReadonlyEditorTarget(target: EventTarget | Node | null | undefined): boolean {
  const node = asNode(target);
  const root = activeEditorElement();
  return !!node && !!root && contains(root, node) && !isEditableNode(node, root);
}
