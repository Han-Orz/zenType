import { getActiveEditor } from "siyuan";
import type { EditorFrame } from "../types";
import { getCursorRect, isStructuralBlock } from "./getCursorRect";

const excluded = "[readonly], [aria-readonly='true'], [data-readonly='true'], .av, [data-type='NodeBlockQueryEmbed']";

export function editableAt(target: EventTarget | null): HTMLElement | null {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!(element instanceof HTMLElement)) return null;
  // Cheap containment first: most events (pointer moves in the sidebar or tree)
  // are outside the editor entirely.
  if (!element.closest(".protyle-wysiwyg")) return null;
  if (element.closest(excluded)) return null;
  // The contenteditable attribute is read directly. `isContentEditable` is a
  // computed-style property: reading it on every event forced a style recalc
  // (a measured trace attributed 213ms over 239 events, worst 42ms, to it).
  const host = element.closest("[contenteditable]");
  if (!host || host.getAttribute("contenteditable") === "false") return null;
  return element.closest<HTMLElement>("[contenteditable='true'], [contenteditable='plaintext-only']");
}

export function readEditorFrame(reducedMotion: boolean, composingEditor: HTMLElement | null, previousEditor?: HTMLElement): EditorFrame | null {
  if (!document.hasFocus() || document.hidden) return null;
  const protyle = getActiveEditor()?.protyle;
  const editor = protyle?.wysiwyg?.element;
  const root = protyle?.element;
  const scroll = protyle?.contentElement;
  if (!root?.isConnected || !editor?.isConnected || !scroll?.isConnected ||
      root.closest(".fn__none, [hidden]") || editor.closest(excluded)) return null;
  const selection = window.getSelection();
  const focused = document.activeElement;
  const focusEditable = editableAt(focused);
  if (focused !== document.body && focused !== document.documentElement &&
      (!focusEditable || focusEditable.closest(".protyle-wysiwyg") !== editor)) return null;
  const inside = !!selection?.rangeCount && !!selection.anchorNode?.isConnected &&
    !!selection.focusNode?.isConnected && editor.contains(selection.anchorNode) && editor.contains(selection.focusNode);
  if (!inside && !focusEditable && (previousEditor !== editor || selection?.focusNode &&
      selection.focusNode !== document.body && selection.focusNode !== document.documentElement && selection.focusNode.isConnected)) return null;
  let editable = inside ? editableAt(selection!.focusNode) : focusEditable;
  if (editable?.closest(".protyle-wysiwyg") !== editor) editable = null;
  const state = !inside ? "missing" : selection!.isCollapsed || composingEditor === editor ? "caret" : "range";
  let range: Range | null = null;
  if (state === "caret" && editable) {
    range = document.createRange();
    range.setStart(selection!.focusNode!, selection!.focusOffset);
    range.collapse(true);
  }
  const element = range?.startContainer instanceof Element ? range.startContainer : range?.startContainer.parentElement;
  const block = element?.closest<HTMLElement>("[data-node-id]") ?? null;
  if (inside && !editable) return null;
  const caret = range && editable ? getCursorRect(range, editable) : null;
  const box = scroll.getBoundingClientRect();
  const visual = window.visualViewport;
  const viewport = {
    top: Math.max(box.top + scroll.clientTop, visual?.offsetTop ?? 0),
    bottom: Math.min(box.top + scroll.clientTop + scroll.clientHeight, (visual?.offsetTop ?? 0) + (visual?.height ?? innerHeight)),
    left: Math.max(box.left + scroll.clientLeft, visual?.offsetLeft ?? 0),
    right: Math.min(box.left + scroll.clientLeft + scroll.clientWidth, (visual?.offsetLeft ?? 0) + (visual?.width ?? innerWidth)),
  };
  const scrollViewport = { top: viewport.top, bottom: viewport.bottom, left: viewport.left };
  const nestedScroll: EditorFrame["nestedScroll"] = [];
  let zIndex = 0;
  let aboveScroll = false;
  for (let parent = element ?? editable; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const z = parseInt(style.zIndex, 10);
    if (Number.isFinite(z)) zIndex = Math.max(zIndex, z);
    // The walk always reaches the scroll container (the caret is inside it), so a
    // flag replaces a per-ancestor `contains(scroll)`, which was O(depth) each.
    if (parent === scroll) aboveScroll = true;
    if (aboveScroll) continue;
    if (parent instanceof HTMLElement) nestedScroll.push({ element: parent, left: parent.scrollLeft, top: parent.scrollTop });
    const clipX = /auto|scroll|hidden|clip/.test(style.overflowX);
    const clipY = /auto|scroll|hidden|clip/.test(style.overflowY);
    if (!clipX && !clipY) continue;
    const rect = parent.getBoundingClientRect();
    if (clipX) { viewport.left = Math.max(viewport.left, rect.left); viewport.right = Math.min(viewport.right, rect.right); }
    if (clipY) { viewport.top = Math.max(viewport.top, rect.top); viewport.bottom = Math.min(viewport.bottom, rect.bottom); }
  }
  if (viewport.bottom <= viewport.top || viewport.right <= viewport.left) return null;
  // Inline code has its own smaller line box, so the usual lift reads as a
  // misalignment there; keep the caret centred on its own metrics instead.
  const inlineCode = !!element?.closest('code, kbd, samp, [data-type~="code"], [data-type~="kbd"]');
  return { root, editor, scroll, editable, block, range, caret, caretless: !caret && isStructuralBlock(block),
    caretLift: inlineCode ? 0 : undefined, selection: state, viewport, scrollViewport,
    origin: { x: box.left, y: box.top }, nestedScroll,
    scrollTop: scroll.scrollTop, scrollLeft: scroll.scrollLeft,
    maxScroll: Math.max(0, scroll.scrollHeight - scroll.clientHeight), reducedMotion, zIndex: zIndex + 1 };
}
