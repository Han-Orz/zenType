import { getActiveEditor } from "siyuan";
import { getCursorElement } from "./getCursorElement";

/**
 * 边界场景判定工具集。
 * 每个函数独立无副作用，便于在模块中按需调用。
 */

/** 选中了任意文本（拖蓝） */
export function hasSelection(): boolean {
  const sel = window.getSelection();
  return (sel?.toString().length ?? 0) > 0;
}

/** 思源编辑器处于只读状态（修复：检查光标所在元素的 isContentEditable） */
export function isReadMode(): boolean {
  const cursor = getCursorElement();
  if (cursor) {
    const titleInput = cursor.closest(".protyle-title__input") as HTMLInputElement | null;
    if (titleInput) {
      return titleInput.hasAttribute("readonly")
        || titleInput.getAttribute("aria-readonly") === "true"
        || titleInput.getAttribute("contenteditable") === "false"
        || titleInput.readOnly === true;
    }
    // 思源 .protyle-content 容器本身没有 contenteditable 属性，
    // contenteditable=true 写在内部 block（paragraph/heading/list）上。
    // 所以检查光标实际所在的元素，不是外层容器。
    return (cursor as HTMLElement).isContentEditable !== true;
  }
  // fallback：无光标时检查活跃编辑器内是否有 contenteditable 元素
  const activeEditor = getActiveEditor();
  if (!activeEditor) return true;
  const editable = activeEditor.protyle.element.querySelector(
    '[contenteditable="true"]',
  );
  return !editable;
}

/** 悬浮窗（block__popover）处于打开状态 */
export function isInPopup(): boolean {
  return !!document.querySelector(".block__popover--open");
}

/** 文本光标在嵌入块里（iframe / video / PDF） */
export function isInEmbedBlock(): boolean {
  const cursor = getCursorElement();
  if (!cursor) return false;
  return !!cursor.closest(
    "iframe, video, [data-type='NodeIFrame'], [data-type='NodeVideo'], [data-type='NodePDF']"
  );
}

/** 两个暂停函数共用的基础条件。 */
function shouldPauseCommon(): boolean {
  return isInPopup();
}

/**
 * 聚焦 + 打字机需要暂停的场景。
 * 包含：选中多行、悬浮窗编辑。
 */
export function shouldPauseFocusAndTypewriter(): boolean {
  if (hasSelection()) return true;
  if (shouldPauseCommon()) return true;
  if (isReadMode()) return true;
  return false;
}

/**
 * 打字机模式额外需要暂停的场景。
 * 包含：悬浮窗、只读、嵌入块。
 */
export function shouldPauseTypewriter(): boolean {
  if (shouldPauseCommon()) return true;
  if (isReadMode()) return true;
  if (isInEmbedBlock()) return true;
  return false;
}
