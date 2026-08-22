/**
 * inputMode 触发适配层。
 *
 * 集中表达"什么用户/系统事件开启/退出聚焦+打字机模式"。当前实现直接委托
 * inputMode.setBothOn/Off，不改语义；后续可在这一层加入更精细的触发规则
 * （如区分 focus / typewriter 的开关时机），而无需改动各调用点。
 *
 * 对应 inputMode.ts 触发规则：
 *   ON  ← keyboard input、IME compositionend、Enter/Backspace 编辑
 *   OFF ← wheel、↑/↓、PageUp/Down、click、drag-select、切 tab、blur
 *   Keep ON：←/→、Home、End、Escape
 */

import * as inputMode from "./inputMode";

// ── ON 触发 ───────────────────────────────────────────────────────────

/** 键盘文本输入 → 开启。粘贴/拖放由事件层按 inputType 明确跳过。 */
export function onTextInput(): void {
  inputMode.setBothOn();
}

/** IME compositionend → 开启 */
export function onCompositionEnd(): void {
  inputMode.setBothOn();
}

/** Enter/Backspace 块编辑 → 开启（确保 typewriter 不在 checkAndScroll 早退） */
export function onEnterOrBackspaceEdit(): void {
  inputMode.setBothOn();
}

// ── OFF 触发 ──────────────────────────────────────────────────────────

/** 滚轮 / 触控板 touchmove → 退出 */
export function onWheelOrTouchMove(): void {
  inputMode.setBothOff();
}

/** ↑/↓/PageUp/PageDown 垂直导航键 → 退出（←/→/Home/End/Escape 保持） */
export function onVerticalNavigationKey(): void {
  inputMode.setBothOff();
}

/** 鼠标点击 → 退出 */
export function onMouseClick(): void {
  inputMode.setBothOff();
}

/** 鼠标拖蓝选择 → 退出（mouseup 时 selection 变化检测） */
export function onDragSelection(): void {
  inputMode.setBothOff();
}

/** 切换 protyle（Tab） → 退出 */
export function onSwitchProtyle(): void {
  inputMode.setBothOff();
}

/** 失焦 → 退出 */
export function onBlur(): void {
  inputMode.setBothOff();
}

/** 只读编辑器或只读 UI → 清理聚焦与打字机状态。 */
export function onReadonly(): void {
  inputMode.setBothOff();
}
