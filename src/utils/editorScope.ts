import { getActiveEditor } from "siyuan";
import type { EditorFrame } from "../types";
import { getCursorRect } from "./getCursorRect";

export function editableAt(target: EventTarget | null): HTMLElement | null {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!(element instanceof HTMLElement) || !element.isContentEditable) return null;
  if (element.closest("[readonly], [aria-readonly='true'], [data-readonly='true'], .av, .block__popover, [data-type='NodeBlockQueryEmbed']")) return null;
  const editor = element.closest<HTMLElement>(".protyle-wysiwyg");
  if (!editor || !getActiveEditor()?.protyle.element.contains(editor)) return null;
  return element.closest<HTMLElement>("[contenteditable='true'], [contenteditable='plaintext-only']");
}

export function readEditorFrame(reducedMotion: boolean): EditorFrame | null {
  if (!document.hasFocus()) return null;
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return null;
  const editable = editableAt(selection.focusNode);
  if (!editable) return null;
  const editor = editable.closest<HTMLElement>(".protyle-wysiwyg")!;
  const root = editor.closest<HTMLElement>(".protyle");
  if (!root || root.closest(".fn__none, [hidden]")) return null;
  const focused = document.activeElement;
  if (focused !== document.body && focused !== document.documentElement &&
      (!focused || !root.contains(focused) || !(focused instanceof HTMLElement) || !focused.isContentEditable)) return null;
  const range = selection.getRangeAt(0).cloneRange();
  const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const block = element?.closest<HTMLElement>("[data-node-id]");
  if (!block || !editor.contains(block)) return null;
  const scroll = editor.closest<HTMLElement>(".protyle-content");
  if (!scroll) return null;
  const caret = getCursorRect(range, editable);
  if (!caret) return null;
  const box = scroll.getBoundingClientRect();
  const visual = window.visualViewport;
  const viewport = {
    top: Math.max(box.top, visual?.offsetTop ?? 0),
    bottom: Math.min(box.bottom, (visual?.offsetTop ?? 0) + (visual?.height ?? window.innerHeight)),
    left: Math.max(box.left, visual?.offsetLeft ?? 0),
    right: Math.min(box.right, (visual?.offsetLeft ?? 0) + (visual?.width ?? window.innerWidth)),
  };
  const scrollViewport = { top: viewport.top, bottom: viewport.bottom };
  let zIndex = 0;
  let insideScroll = true;
  // A code block or table may clip the caret inside the editor viewport.
  for (let parent = element; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const z = parseInt(style.zIndex, 10);
    if (Number.isFinite(z)) zIndex = Math.max(zIndex, z);
    if (parent === scroll) insideScroll = false;
    if (!insideScroll) continue;
    const clipX = /auto|scroll|hidden|clip/.test(style.overflowX);
    const clipY = /auto|scroll|hidden|clip/.test(style.overflowY);
    if (!clipX && !clipY) continue;
    const rect = parent.getBoundingClientRect();
    if (clipX) { viewport.left = Math.max(viewport.left, rect.left); viewport.right = Math.min(viewport.right, rect.right); }
    if (clipY) { viewport.top = Math.max(viewport.top, rect.top); viewport.bottom = Math.min(viewport.bottom, rect.bottom); }
  }
  if (viewport.bottom <= viewport.top || viewport.right <= viewport.left) return null;
  return { root, editor, editable, block, scroll, range, caret, viewport, scrollViewport,
    scrollTop: scroll.scrollTop, maxScroll: Math.max(0, scroll.scrollHeight - scroll.clientHeight),
    reducedMotion, zIndex: zIndex + 1 };
}
