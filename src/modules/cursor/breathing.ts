/**
 * 顺滑光标呼吸动画状态机。
 *
 * 修复 P0 BUG 1：原实现仅 initCursor() 末尾调用一次 startBlink()，
 * 每次 selectionchange/keydown/mousedown 都 stopBlink()，
 * 导致 .breathing 加上后永远不会再被加上 → 呼吸感丢失。
 *
 * 新设计（参考 legacy 顺滑光标.js）：
 *   - CSS 默认带 animation: zentype-breathe infinite
 *   - initBreathing() 时给 cursorEl 加 .no-animation（暂停）
 *   - scheduleBreathe() 设 idle 定时器，到期移除 .no-animation（恢复呼吸）
 *   - pauseBreathe() 立即加 .no-animation（停止呼吸）
 *   - updateCursor() 每次操作时 pauseBreathe()，然后 scheduleBreathe()
 *   - destroyBreathing() 清理 timer + 移除 class
 */

import { CURSOR_CONFIG } from "../../config";
import { prefersReducedMotion } from "../../utils/reducedMotion";

let cursorEl: HTMLElement | null = null;
let breatheTimer: number | null = null;
type BreatheState = "paused" | "pending" | "breathing";
let breatheState: BreatheState = "paused";

export function initBreathing(cursor: HTMLElement): void {
  clearBreatheTimer();
  cursorEl = cursor;
  breatheState = "paused";
  // 默认 pause，等首次 updateCursor 后再 resume（避免 init 时一闪而过）
  cursorEl.classList.add("no-animation");
  // 不主动启动 breathing，由 caller 在第一次 updateCursor 后调度
}

export function pauseBreathe(): void {
  clearBreatheTimer();
  if (!cursorEl) {
    breatheState = "paused";
    return;
  }
  if (breatheState !== "paused" || !cursorEl.classList.contains("no-animation")) {
    cursorEl.classList.add("no-animation");
  }
  breatheState = "paused";
}

export function scheduleBreathe(delayMs: number = CURSOR_CONFIG.BLINK_DELAY_MS): void {
  if (!cursorEl) return;
  clearBreatheTimer();
  if (breatheState !== "paused" || !cursorEl.classList.contains("no-animation")) {
    cursorEl.classList.add("no-animation");
  }
  if (prefersReducedMotion()) {
    cursorEl.classList.add("no-animation");
    breatheState = "paused";
    return;
  }
  breatheState = "pending";
  breatheTimer = window.setTimeout(() => {
    if (!cursorEl) return;
    breatheTimer = null;
    cursorEl.classList.remove("no-animation");
    breatheState = "breathing";
  }, delayMs);
}

export function destroyBreathing(): void {
  clearBreatheTimer();
  cursorEl?.classList.remove("no-animation");
  cursorEl = null;
  breatheState = "paused";
}

function clearBreatheTimer(): void {
  if (breatheTimer !== null) {
    clearTimeout(breatheTimer);
    breatheTimer = null;
  }
}
