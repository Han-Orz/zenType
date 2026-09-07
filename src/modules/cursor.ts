/**
 * 顺滑光标主模块。
 *
 * P0 修复 4 个 BUG：
 *   1. 呼吸感 —— 反向 idle 暂停/恢复（见 ./cursor/breathing.ts）
 *   2. 光标高度 —— lineHeight × CURSOR_CONFIG.HEIGHT_RATIO（见 ../utils/getCursorRect.ts :: getCursorRect）
 *   3. 移动动画 —— no-transition 下一帧恢复；no-animation 在空闲 1.1s 后恢复
 *   4. 边界检测 —— isInAllowElements() 多重检测（见 ../utils/boundary.ts）
 *
 * P2 重构：
 *   - 7 个 EventBus 回调导出（由 index.ts 接入 8 个事件订阅）
 *   - WS 监听从手动 addEventListener 迁移到 ws-main EventBus
 *   - hasScroll/findAllScrollableAncestors 去重到 ../utils/scroll
 *
 * 注意：曾尝试用 activeProtyleIds Set 防止切 Tab 闪现，但发现 .protyle 元素的
 * data-id（Tab.id）与 IProtyle.id（Protyle.id）是不同的 UUID，匹配不上，
 * 导致光标永久隐藏。已删除该 gate——boundary.ts 第一重
 * getActiveEditor().protyle.element.contains() 已天然防止非活跃编辑器内显示。
 *
 * 性能硬指标：每帧 < 1ms。
 *   - rAF 节流（pendingFrame 标志，每帧最多一次 doUpdateCursor）
 *   - passive 事件（scroll/wheel/touchmove 不阻塞滚动）
 *   - keydown/input 事件用 rAF 包裹（替代 P0 时的三阶段 throttle）
 *   - transform 不用 top/left（合成层加速）
 *   - 批量读、批量写（getClientRects → getComputedStyle → style.transform/height）
 */

import type { IProtyle, IWebSocketData } from "siyuan/types";
import { currentInputContextId, recordPerformance } from "../debug/performance";
import { CURSOR_CONFIG, EDGE_FADE, TRANSITION } from "../config";
import { cursorRectPerf, getCursorRect } from "../utils/getCursorRect";
import { isInAllowElements } from "../utils/boundary";
import { isMobile } from "../utils/isMobile";
import { getEffectiveZIndex } from "../utils/getEffectiveZIndex";
import { getEdgeProximity } from "../utils/edgeProximity";
import { prefersReducedMotion } from "../utils/reducedMotion";
import { findClosestScrollableElement } from "../utils/scroll";
import type { CursorRect } from "../types";
import {
  activateNativeCaretOwner,
  restoreNativeCaretOwner,
} from "../utils/caretVisibility";
import {
  initBreathing,
  pauseBreathe,
  scheduleBreathe,
  destroyBreathing,
} from "./cursor/breathing";
import { destroyEdgeArrow, updateEdgeArrow } from "./cursor/edgeArrow";
import {
  bindScrollContainerEvents,
  destroyScrollContainerEvents,
} from "./cursor/scrollBindings";
import {
  bindResizeObservers,
  destroyResizeObservers,
  type ResizeBindingContext,
} from "./cursor/resizeBindings";
import {
  bindPopoverDrag,
  unbindPopoverDrag,
  type PopoverDragContext,
} from "./cursor/popoverDrag";
import {
  bindCursorDocumentEvents,
  destroyCursorDocumentEvents,
  type CursorEventContext,
  type CursorScrollSource,
  shouldUseManualScrollPolicy,
} from "./cursor/events";
import {
  startSwitchSettle,
  stopSwitchSettle,
  isSwitchHiddenActive,
  isSwitchRevealPending,
  type SwitchSettleContext,
} from "./cursor/switchSettle";
import * as inputMode from "./inputMode";
import * as typewriterScroll from "./typewriter/scroll";
import * as structuralFlip from "./typewriter/flip";
import {
  buildCursorPerfSummary,
  cursorPerf,
  CURSOR_PERF_FLUSH_CALLS,
  CURSOR_PERF_FLUSH_MS,
  pushPerfRing,
  resetCursorPerf,
} from "./cursor/perf";

const CURSOR_ID = "zentype-cursor";

export type CursorDebugEventName =
  | "cursor-click"
  | "cursor-update"
  | "cursor-update-skipped"
  | "cursor-frame"
  | "cursor-scroll-policy"
  | "cursor-transition-restored"
  | "cursor-switch-settle"
  | "cursor-reacquire-reveal"
  | "cursor-perf-summary";

export interface CursorDebugEvent {
  name: CursorDebugEventName;
  cursorElement?: HTMLDivElement | null;
  caretElement?: Element | null;
  scrollContainer?: HTMLElement | null;
  caretRect?: CursorRect | null;
  [key: string]: unknown;
}

export type CursorDebugSink = (event: CursorDebugEvent) => void;

const DEBUG_ENABLED = __ZENTYPE_DEV__;
const DEBUG_CURSOR_FRAME_LIMIT = 72;

let cursorEl: HTMLDivElement | null = null;
let pendingFrame: number | null = null;
let queuedInputContextId = 0;
let removeTransitionFrame: number | null = null;
let pendingKeyboardUpdate = false; // round 4 fix：Enter 触发滚动时跳过 .no-transition，保留按距离分档的过渡动画
let keyboardCooldownTimer: ReturnType<typeof setTimeout> | null = null; // round 4 fix（capture + cooldown）：键盘事件后 300ms 内 scroll/ResizeObserver 知道本次更新是键盘驱动
let prevCursorX: number | null = null; // Q7：上一次写入 transform 时的 x，用于计算本帧移动距离 → 时长
let prevCursorY: number | null = null; // Q7：上一次写入 transform 时的 y，同上
let lastCursorDur: number | null = null;
let initialized = false;
let cachedZIndexElement: Element | null = null;
let cachedEffectiveZIndex = 0;
let cachedFullscreenElement: Element | null = null;
let nativeCaretOwner: HTMLElement | null = null;
let debugSink: CursorDebugSink | null = null;
let debugFrameRequest: number | null = null;
let debugFrameToken = 0;
let debugCaretElement: Element | null = null;
let debugCaretRect: CursorRect | null = null;

function emitDebug(event: CursorDebugEvent): void {
  if (!DEBUG_ENABLED) return;
  debugSink?.(event);
}

function debugScrollContainer(): HTMLElement | null {
  if (!DEBUG_ENABLED || !debugCaretElement) return null;
  try {
    return findClosestScrollableElement(debugCaretElement);
  } catch {
    return null;
  }
}

function emitDebugState(
  name: CursorDebugEventName,
  details: Record<string, unknown> = {},
): void {
  if (!DEBUG_ENABLED || !debugSink) return;
  emitDebug({
    name,
    ...details,
    cursorElement: cursorEl,
    caretElement: debugCaretElement,
    scrollContainer: debugScrollContainer(),
    caretRect: debugCaretRect,
    caretViewportY: debugCaretRect?.y ?? null,
  });
}

function stopDebugFrameBurst(): void {
  debugFrameToken += 1;
  if (debugFrameRequest !== null) {
    cancelAnimationFrame(debugFrameRequest);
    debugFrameRequest = null;
  }
}

function startDebugFrameBurst(reason: string): void {
  if (
    !DEBUG_ENABLED
    || !debugSink
    || !cursorEl
    || typeof requestAnimationFrame !== "function"
  ) return;

  stopDebugFrameBurst();
  const token = debugFrameToken;
  let frameIndex = 0;
  const sample = (timestamp: number) => {
    debugFrameRequest = null;
    if (token !== debugFrameToken || !debugSink) return;

    emitDebugState("cursor-frame", {
      reason,
      frameIndex,
      frameTimestamp: timestamp,
    });
    frameIndex += 1;
    if (frameIndex < DEBUG_CURSOR_FRAME_LIMIT && debugSink) {
      debugFrameRequest = requestAnimationFrame(sample);
    }
  };
  debugFrameRequest = requestAnimationFrame(sample);
}

function reportDebugClick(): void {
  if (!DEBUG_ENABLED || !debugSink) return;
  emitDebugState("cursor-click");
  startDebugFrameBurst("click");
}

export function setDebugSink(next: CursorDebugSink | null): void {
  if (!DEBUG_ENABLED) return;
  debugSink = next;
  if (!next) stopDebugFrameBurst();
}

/** Fail open whenever the custom caret cannot be positioned reliably. */
function restoreNativeCaretAndHideCustom(): void {
  nativeCaretOwner = restoreNativeCaretOwner(nativeCaretOwner);
  cursorEl?.classList.add("hidden");
  // 标记"可靠不可见"：下次成功定位时用一次轻量 opacity fade 恢复存在感。
  reacquirePending = true;
}

// Reacquire reveal：custom caret 从可靠不可见（.hidden）恢复到可靠可见时，
// 位置先在 .hidden 的 transition:none 下 snap 提交，存在感用一次 120ms
// opacity fade 恢复。只做一次位置提交 + 一次 rAF handoff，无持续 rAF loop。
const REACQUIRE_REVEAL_MS = 120;
let reacquirePending = false;
let reacquireRevealToken = 0;
let reacquireRevealFrame: number | null = null;

function cancelReacquireReveal(): void {
  reacquireRevealToken += 1;
  if (reacquireRevealFrame !== null) {
    cancelAnimationFrame(reacquireRevealFrame);
    reacquireRevealFrame = null;
  }
}

/**
 * 恢复可见：.hidden 已让新位置在上一段同步代码里提交（transition:none snap）。
 * 先保持不可见并强制布局一次，再交给 opacity-only inline transition 从 0 淡入。
 */
function startReacquireReveal(targetOpacity: string): void {
  const el = cursorEl;
  if (!el) return;
  reacquirePending = false;
  el.classList.remove("hidden");
  // reveal 期间 transition 必须真正生效：清掉可能残留的 no-transition
  // （例如滚动策略在 skip 路径上留下 no-transition 后才转 hidden）。
  el.classList.remove("no-transition");
  el.style.opacity = "0";
  el.style.transition = `opacity ${REACQUIRE_REVEAL_MS}ms ease-out`;
  void el.offsetHeight;
  lastCursorDur = null; // 下一次正常更新按移动距离重写完整 transition
  const token = ++reacquireRevealToken;
  if (DEBUG_ENABLED) emitDebugState("cursor-reacquire-reveal", { phase: "start", targetOpacity });
  reacquireRevealFrame = requestAnimationFrame(() => {
    reacquireRevealFrame = null;
    if (token !== reacquireRevealToken || !cursorEl) return;
    // switch settle 用自己的 inline opacity 生命周期揭示，这里让位避免双重 reveal。
    if (isSwitchHiddenActive() || isSwitchRevealPending()) return;
    cursorEl.style.opacity = targetOpacity;
    if (DEBUG_ENABLED) emitDebugState("cursor-reacquire-reveal", { phase: "revealed", targetOpacity });
  });
}

/** Dev-only: doUpdateCursor gave up before producing visible geometry. */
function emitUpdateSkipped(reason: string): void {
  if (DEBUG_ENABLED) {
    recordCursorUpdateDuration();
    recordPerformance("cursor", "cursor-skipped", { reason, queuedInputContextId });
    emitDebugState("cursor-update-skipped", { reason });
    cursorPerf.skips[reason] = (cursorPerf.skips[reason] ?? 0) + 1;
    maybeFlushCursorPerf();
  }
}

// Dev-only profiling: start timestamp of the doUpdateCursor invocation in
// flight; consumed by recordCursorUpdateDuration at every exit path.
let cursorUpdateStartAt = 0;

function recordCursorUpdateDuration(): void {
  const duration = performance.now() - cursorUpdateStartAt;
  pushPerfRing(cursorPerf.durations, duration);
}

function maybeFlushCursorPerf(): void {
  const now = performance.now();
  if (cursorPerf.windowStartedAt === 0) {
    resetCursorPerf(now);
    return;
  }
  const elapsed = now - cursorPerf.windowStartedAt;
  if (cursorPerf.updates > 0 && (cursorPerf.updates >= CURSOR_PERF_FLUSH_CALLS || elapsed >= CURSOR_PERF_FLUSH_MS)) {
    const summary = buildCursorPerfSummary(now, cursorRectPerf);
    if (summary) emitDebugState("cursor-perf-summary", summary);
    resetCursorPerf(now);
  }
}

/** Hide the native caret only on the editable owner currently being rendered. */
function activateCustomCaret(element: Element): boolean {
  nativeCaretOwner = activateNativeCaretOwner(nativeCaretOwner, element);
  if (!nativeCaretOwner) {
    cursorEl?.classList.add("hidden");
    reacquirePending = true;
    return false;
  }
  return true;
}

function markKeyboardPending(): void {
  pendingKeyboardUpdate = true;
  if (keyboardCooldownTimer !== null) clearTimeout(keyboardCooldownTimer);
  keyboardCooldownTimer = setTimeout(() => {
    pendingKeyboardUpdate = false;
    keyboardCooldownTimer = null;
  }, 300);
}

function clearKeyboardPending(): void {
  pendingKeyboardUpdate = false;
  if (keyboardCooldownTimer !== null) {
    clearTimeout(keyboardCooldownTimer);
    keyboardCooldownTimer = null;
  }
}

/**
 * Q7：根据光标移动距离查表得出过渡时长（秒）。
 * 表在 src/config.ts 的 TRANSITION.TIERS 里，用户可自行调整。
 */
function transitionDurationForDistance(dist: number): number {
  for (const tier of TRANSITION.TIERS) {
    if (dist <= tier.maxDist) return tier.duration;
  }
  return TRANSITION.TIERS[TRANSITION.TIERS.length - 1].duration;
}
// ── 聚焦/打字机模式辅助状态 ──
let unsubInputMode: (() => void) | null = null;

function createCursorElement(): HTMLDivElement {
  let el = document.getElementById(CURSOR_ID) as HTMLDivElement | null;
  if (el) return el;

  el = document.createElement("div");
  el.id = CURSOR_ID;
  // commit D：DOM 刚创建时 transform 还未设置，默认在 (0,0)。
  // 直接把 transform 设到屏幕外，避免 initCursor 末端的 queueUpdate → 首次
  // doUpdateCursor 之间约 16ms 窗口内光标在视口左上角闪现。
  // 从元素进 DOM 那一刻起关闭 transition，防止 SCSS 默认 transition:
  // transform 0.15s 把 (0,0)→(-9999,-9999) 滑出来；首次 doUpdateCursor
  // 写完真实位置后，rAF 会移除这个类。
  el.classList.add("no-transition");
  el.style.transform = "translate3d(-9999px, -9999px, 0)";
  document.body.appendChild(el);
  return el;
}

/**
 * commit 1：写 inline opacity + transform(含 scale) + height 三个属性。
 * 离屏/边缘淡出态专用，正常态继续走原生 transform 写入（不带 scale）。
 * 返回实际写入的 opacity 字符串，供 reacquire reveal 决定淡入目标。
 */
function applyFadeAndScale(
  el: HTMLDivElement,
  opacity: number,
  scale: number,
  pos: { x: number; y: number; height: number },
  yOffset: number = 2,
): string {
  const opacityValue = String(Math.round(opacity * 1000) / 1000);
  el.style.opacity = opacityValue;
  el.style.transform =
    `translate3d(${pos.x}px, ${pos.y - yOffset}px, 0) scale(${scale})`;
  el.style.height = `${pos.height}px`;
  return opacityValue;
}

export function flushCursorTransitionIfNeeded(el: HTMLDivElement): boolean {
  if (!el.classList.contains("no-transition")) return false;
  void el.offsetHeight;
  return true;
}

/**
 * commit 2（已下线）：squish / bounce 触发函数。用户测试后认为缩放弹动画太突兀，
 * 整个边缘缩放动画路线已下线；保留 case B 的平滑 opacity 淡出。
 * 如果以后想重新启用，可以从 git 历史恢复这两个函数 + SCSS keyframes + 这里的触发块。
 */

/** rAF 节流入口：每帧最多执行一次 doUpdateCursor() */
function queueUpdate(): void {
  if (DEBUG_ENABLED) {
    cursorPerf.queueRequests++;
    queuedInputContextId = currentInputContextId();
    if (pendingFrame !== null) cursorPerf.queueDeduped++;
  }
  if (pendingFrame !== null) return;
  pendingFrame = requestAnimationFrame((timestamp) => {
    pendingFrame = null;
    doUpdateCursor(timestamp);
  });
}

const scrollBindingContext = {
  getCursorElement: () => cursorEl,
  isKeyboardUpdatePending: () => pendingKeyboardUpdate,
  isOwnedScrollTarget: (target: EventTarget | null) => typewriterScroll.ownsActiveScroll(target),
  pauseBreathe,
  queueUpdate,
};

function sampleSwitchTarget(): { x: number; y: number; height: number } | null {
  const rect = getCursorRect();
  if (!rect || rect.height === 0) return null;
  return { x: rect.x, y: rect.y, height: rect.height };
}

function cancelRemoveTransitionFrame(): void {
  if (removeTransitionFrame !== null) {
    cancelAnimationFrame(removeTransitionFrame);
    removeTransitionFrame = null;
  }
}

const switchSettleContext: SwitchSettleContext = {
  getCursorElement: () => cursorEl,
  sampleTarget: sampleSwitchTarget,
  cancelRemoveTransitionFrame,
  pauseBreathe,
  queueUpdate,
  scheduleResumeBreathe,
  emitDebug: (details) => {
    if (DEBUG_ENABLED) emitDebugState("cursor-switch-settle", details);
  },
};

const cursorEventContext: CursorEventContext = {
  clearKeyboardPending,
  markKeyboardPending,
  onScrollOrWheel,
  onMouseClick: reportDebugClick,
  queueUpdate,
};

const resizeBindingContext: ResizeBindingContext = {
  getCursorElement: () => cursorEl,
  isKeyboardUpdatePending: () => pendingKeyboardUpdate,
  queueUpdate,
};

const popoverDragContext: PopoverDragContext = {
  getCursorElement: () => cursorEl,
  queueUpdate,
};

/**
 * 核心更新逻辑。
 * 时序：
 *   1. 暂停呼吸（操作中）
 *   2. 读取选区 → getCursorRect（lineHeight × 1.05）
 *   3. 边缘距离计算（commit 1）→ 供边缘淡出与可选箭头复用
 *   4. 边界检测 → 不通过则 pauseBreathe + return（光标保留在最后位置，停在 Phase 1）
 *   5. 计算 zIndex（沿光标元素祖先链查找有效层叠层级 + 1）
 *   6. 写 transform / height / zIndex（commit 1：边缘淡出态走 applyFadeAndScale）
 *   7. no-transition 生效时同步布局 → rAF 移除 no-transition
 *   8. scheduleBreathe() 延迟恢复呼吸（边缘附近不恢复，保持暂停）
 */
function doUpdateCursor(frameTimestamp?: number): void {
  if (!cursorEl) return;

  if (DEBUG_ENABLED) {
    cursorPerf.updates++;
    cursorUpdateStartAt = performance.now();
    // C1 keyboard chain: event → outer rAF → queueUpdate → this run.
    if (pendingKeyboardUpdate && cursorPerf.keyboardEventAt !== null && frameTimestamp !== undefined) {
      pushPerfRing(cursorPerf.keyboardLatencies, frameTimestamp - cursorPerf.keyboardEventAt);
      if (cursorPerf.keyboardOuterRafAt !== null && frameTimestamp > cursorPerf.keyboardOuterRafAt + 0.5) {
        cursorPerf.keyboardTwoFrame++;
      }
      cursorPerf.keyboardEventAt = null;
      cursorPerf.keyboardOuterRafAt = null;
    }
  }

  const reducedMotion = prefersReducedMotion();
  if (reducedMotion) {
    cancelRemoveTransitionFrame();
    cursorEl.classList.add("no-transition", "no-animation");
  }

  // 在途的 reacquire reveal handoff 一律由本次更新接管（任何出口都安全：
  // 成功路径自己决定是否开新 reveal，skip 路径转 hidden，fade 中断即取消）。
  cancelReacquireReveal();

  // 1) 暂停呼吸（操作中不需要呼吸感）
  pauseBreathe();

  // 2) 读取选区 → 显示矩形
  let rect: ReturnType<typeof getCursorRect>;
  const rectStart = DEBUG_ENABLED ? performance.now() : 0;
  try {
    rect = getCursorRect();
  } catch {
    emitUpdateSkipped("selection-read-threw");
    restoreNativeCaretAndHideCustom();
    pauseBreathe();
    return;
  }
  if (DEBUG_ENABLED) cursorPerf.getCursorRectMs += performance.now() - rectStart;
  if (!rect || rect.height === 0) {
    // No reliable geometry means the native caret is the only trustworthy
    // fallback; never leave the previous custom caret parked on old content.
    emitUpdateSkipped("no-caret-rect");
    restoreNativeCaretAndHideCustom();
    pauseBreathe();
    return;
  }

  // 3) 边界检测（3 重，round 3 移除第 3 重弹窗硬性排除）
  // commit 1：边缘距离（供 fade/scale、commit 2/3 复用）
  // 传 editorRect 把淡出边界对齐到"编辑器内容区"而不是"裸视口"，让顶部对称底部。
  // 注意：必须先算 allowed（拿到 editorRect）再调 getEdgeProximity。
  let allowed: ReturnType<typeof isInAllowElements>;
  const boundsStart = DEBUG_ENABLED ? performance.now() : 0;
  try {
    allowed = isInAllowElements({ x: rect.x, y: rect.y });
  } catch {
    emitUpdateSkipped("bounds-check-threw");
    restoreNativeCaretAndHideCustom();
    pauseBreathe();
    return;
  }
  if (DEBUG_ENABLED) {
    cursorPerf.boundsMs += performance.now() - boundsStart;
    cursorPerf.boundsCalls++;
  }
  const edge = getEdgeProximity(rect, allowed.editorRect);

  if (!allowed.allowed) {
    // A rejected boundary is not a reliable custom-caret location. Restore
    // native caret visibility and hide the stale global caret instead of
    // leaving it at the last successful position.
    emitUpdateSkipped("bounds-rejected");
    restoreNativeCaretAndHideCustom();
    pauseBreathe();
    return;
  }

  // 移动端标题：可选跳过光标显示（避免移动端键盘弹出时视觉噪音）
  if (isMobile() && allowed.cursorElement?.closest(".protyle-title__input")) {
    // Mobile title editing keeps the host's native caret. The previous code
    // skipped custom rendering while a global CSS rule still hid this caret.
    emitUpdateSkipped("mobile-title");
    restoreNativeCaretAndHideCustom();
    pauseBreathe();
    return;
  }

  if (!allowed.cursorElement || !activateCustomCaret(allowed.cursorElement)) {
    emitUpdateSkipped("caret-activation-failed");
    pauseBreathe();
    return;
  }

  if (DEBUG_ENABLED) {
    debugCaretElement = allowed.cursorElement;
    debugCaretRect = rect;
  }

  updateEdgeArrow(edge, allowed.isOuterElement, allowed.allowed);

  // 4) zIndex：取编辑器祖先链上最近的层叠上下文 + 1，不强制抬高到 siyuan 全局，
  //    让悬浮窗/弹窗（通常 z-index 更高）能盖在光标上方。
  //    参考实现：顺滑光标.js v0.0.12.4 也只用 effectiveZ + 1。
  let effectiveZ: number;
  const fullscreenElement = allowed.cursorElement!.closest(".fullscreen");
  if (
    allowed.cursorElement === cachedZIndexElement &&
    fullscreenElement === cachedFullscreenElement &&
    cachedZIndexElement !== null &&
    cachedZIndexElement.isConnected
  ) {
    effectiveZ = cachedEffectiveZIndex;
    if (DEBUG_ENABLED) cursorPerf.zIndexHits++;
  } else {
    effectiveZ = getEffectiveZIndex(allowed.cursorElement!);
    cachedZIndexElement = allowed.cursorElement;
    cachedFullscreenElement = fullscreenElement;
    cachedEffectiveZIndex = effectiveZ;
    if (DEBUG_ENABLED) cursorPerf.zIndexMisses++;
  }
  cursorEl.style.zIndex = String(effectiveZ + 1);

  // 5) commit 1：边缘淡出 + 缩放
  //   yOffset：光标上移 N 像素，让光标视觉重心偏到行中线之上（用户偏好）。
  //   HEIGHT_RATIO > 1 时光标下沿超出 lineHeight，光标看起来仍偏下；微调上移抵消。
  const yOffset = 2;
  const dist = prevCursorX !== null && prevCursorY !== null ? Math.hypot(rect.x - prevCursorX, rect.y - prevCursorY) : 0;
  const dur = transitionDurationForDistance(dist);
  if (!reducedMotion && dur !== lastCursorDur) {
    cursorEl.style.transition = `transform ${dur}s cubic-bezier(0.25, 0.1, 0.25, 1), opacity 0.15s ease-out`;
    lastCursorDur = dur;
  }
  // 本帧解析出的可见 opacity（"" = 交回 CSS / 呼吸动画），reacquire reveal 的淡入目标。
  let resolvedOpacity = "";
  if (edge.isOffScreen) {
    // 完全离屏：opacity=0, scale=MIN_SCALE
    resolvedOpacity = applyFadeAndScale(cursorEl, 0, EDGE_FADE.MIN_SCALE, rect, yOffset);
  } else if (edge.distance < EDGE_FADE.ZONE) {
    // FADE_ZONE 内：opacity = factor, scale = lerp(MIN_SCALE, 1, factor)
    const scale =
      EDGE_FADE.MIN_SCALE + (1 - EDGE_FADE.MIN_SCALE) * edge.factor;
    resolvedOpacity = applyFadeAndScale(cursorEl, edge.factor, scale, rect, yOffset);
  } else {
    // 远离边缘：清 inline opacity 让 CSS / 呼吸动画接管；transform 不带 scale
    if (
      !isSwitchHiddenActive() &&
      !isSwitchRevealPending() &&
      cursorEl.style.opacity !== ""
    ) {
      cursorEl.style.opacity = "";
    }
    cursorEl.style.transform = `translate3d(${rect.x}px, ${rect.y - yOffset}px, 0)`;
    cursorEl.style.height = `${rect.height}px`;
  }
  prevCursorX = rect.x;
  prevCursorY = rect.y;

  // 首次移动的 .no-transition 已在 createCursorElement 加上，下一帧的 rAF 会移除。
  // 文本选中时跳过顺滑过渡（光标应瞬间跳到选区末尾）
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && sel.toString()) {
    cursorEl.classList.add("no-transition");
  }

  // 显示光标（commit 1：可能仍带 .hidden 残留，离屏分支不再加 .hidden 但清理一次保险）
  // Reacquire reveal：从可靠 hidden 恢复时，上面的位置写入在 .hidden 的
  // transition:none 下必然 snap（不会从旧位置飞过来），这里只做 opacity 淡入。
  const switchOwnsVisibility = isSwitchHiddenActive() || isSwitchRevealPending();
  if (switchOwnsVisibility) {
    // switch settle 有自己的 inline opacity 生命周期，不叠加 reacquire fade。
    reacquirePending = false;
    cursorEl.classList.remove("hidden");
  } else if (
    reacquirePending &&
    cursorEl.classList.contains("hidden") &&
    !reducedMotion &&
    resolvedOpacity !== "0"
  ) {
    startReacquireReveal(resolvedOpacity);
  } else {
    reacquirePending = false;
    cursorEl.classList.remove("hidden");
  }

  // 7) 仅在 no-transition 生效时同步一次布局，让瞬移位置先提交，再恢复过渡。
  if (!reducedMotion && flushCursorTransitionIfNeeded(cursorEl)) {
    if (DEBUG_ENABLED) cursorPerf.forcedLayouts++;
    // 下一帧恢复 transition（transform / height / opacity 过渡）
    if (removeTransitionFrame !== null) cancelAnimationFrame(removeTransitionFrame);
    removeTransitionFrame = requestAnimationFrame(() => {
      removeTransitionFrame = null;
      cursorEl?.classList.remove("no-transition");
      if (DEBUG_ENABLED) emitDebugState("cursor-transition-restored");
    });
  }

  // 8) commit 1：边缘附近时保持呼吸暂停（避免动画 opacity 与 inline opacity 冲突）
  //    远离边缘（distance >= ZONE）才按 BLINK_DELAY_MS 恢复呼吸
  if (!reducedMotion && edge.distance >= EDGE_FADE.ZONE) {
    scheduleResumeBreathe();
  }

  // 9) round 3 P1：绑定 ResizeObserver / Popover 拖动 / 滚动容器事件
  //    这些 bind 函数内部有"已绑定"去重（lastBound / scrollEventBindings 包含检查 / popoverDragBinding）
  bindResizeObservers(allowed.cursorElement, resizeBindingContext);
  bindPopoverDrag(allowed.cursorElement, popoverDragContext);
  bindScrollContainerEvents(allowed.cursorElement, scrollBindingContext);

  if (DEBUG_ENABLED) {
    const updateMs = performance.now() - cursorUpdateStartAt;
    recordCursorUpdateDuration();
    recordPerformance("cursor", "cursor-commit", {
      queuedInputContextId,
      frameTimestamp: frameTimestamp ?? null,
      x: rect.x,
      y: rect.y,
      transitionSeconds: reducedMotion ? 0 : dur,
      updateMs,
    });
    emitDebugState("cursor-update", {
      frameTimestamp,
    });
    maybeFlushCursorPerf();
  }

  // round 4 fix（capture + cooldown）：键盘标志由 markKeyboardPending 启动的 300ms 倒计时负责清零，
  // 不再在 doUpdateCursor 末尾同步清掉——倒计时窗口内 SiYuan 同步触发的 scroll/ResizeObserver
  // 仍能读到 pendingKeyboardUpdate=true，从而跳过 .no-transition 保留按距离分档的过渡动画
}

function scheduleResumeBreathe(): void {
  scheduleBreathe(CURSOR_CONFIG.BLINK_DELAY_MS);
}

/** 滚动 / 滚轮处理：暂停呼吸 + 停止过渡 + 立即更新 */
function onScrollOrWheel(source: CursorScrollSource, target: EventTarget | null): void {
  if (!cursorEl) return;
  pauseBreathe();
  const noTransitionBefore = DEBUG_ENABLED && cursorEl.classList.contains("no-transition");
  const noAnimationBefore = DEBUG_ENABLED && cursorEl.classList.contains("no-animation");
  const ownedScroll = source === "scroll" && typewriterScroll.ownsActiveScroll(target);
  const useManualScrollPolicy = shouldUseManualScrollPolicy(
    source,
    pendingKeyboardUpdate,
    ownedScroll,
  );
  // round 4 fix：Enter 触发的 SiYuan 自动滚动会同步到这里；
  // 此时 pendingKeyboardUpdate=true，跳过加 .no-transition 保留按距离分档的过渡动画
  if (useManualScrollPolicy) {
    cursorEl.classList.add("no-transition");
    cursorEl.classList.add("no-animation");
  }
  if (DEBUG_ENABLED) {
    emitDebugState("cursor-scroll-policy", {
      policy: pendingKeyboardUpdate
        ? "keyboard-preserve-transition"
        : "manual-scroll-no-transition",
      source,
      ownedScroll,
      manualPolicy: useManualScrollPolicy,
      pendingKeyboardUpdate,
      noTransitionBefore,
      noTransitionAfter: cursorEl.classList.contains("no-transition"),
      noAnimationBefore,
      noAnimationAfter: cursorEl.classList.contains("no-animation"),
    });
  }
  queueUpdate();
}

// ============== round 3 P1：ResizeObserver / Popover 拖动 / 滚动容器 ==============
// P2: hasScroll / findAllScrollableAncestors 已迁移到 ../utils/scroll（统一去重）
// bindResizeObservers / bindPopoverDrag / unbindPopoverDrag 已迁移到 ./cursor/resizeBindings 和 ./cursor/popoverDrag

export function initCursor(): void {
  if (initialized) return;
  initialized = true;

  // 创建 DOM
  cursorEl = createCursorElement();
  initBreathing(cursorEl);

  // commit C fix：呼吸与聚焦模式解耦，光标始终呼吸；聚焦模式开启时
  // 重新调度一次 idle 呼吸恢复。
  unsubInputMode = inputMode.subscribe((state) => {
    if (!cursorEl) return;
    if (state.focusActive) scheduleResumeBreathe();
  });

  bindCursorDocumentEvents(cursorEventContext);

  // P2: WS 监听已迁移到 ws-main EventBus（由 index.ts 订阅，destroy 时由 eventBusOffFns 清理）
  // 不再手动 addEventListener("message", ...) + JSON.parse。

  // structural FLIP 动画期间（Play→Cleanup）逐帧跟随 caret 的 visual geometry：
  // cursor 是事件驱动的，动画期间没有事件触发更新，会在中间帧位置停格，
  // 直到下一次输入/点击（Tab/Shift+Tab 实测停格偏差 ~36-45px）。
  structuralFlip.setMotionFrameSink(() => queueUpdate());

  // 首次定位
  queueUpdate();
}

export function destroyCursor(): void {
  initialized = false;

  // structural FLIP 的逐帧跟随回调随 cursor 生命周期注销
  structuralFlip.setMotionFrameSink(null);

  // round 4 fix（capture + cooldown）：清理键盘冷却定时器
  if (keyboardCooldownTimer !== null) {
    clearTimeout(keyboardCooldownTimer);
    keyboardCooldownTimer = null;
  }
  pendingKeyboardUpdate = false;

  // 清理 DOM 事件
  destroyCursorDocumentEvents();

  // P2: 退订聚焦模式变化
  if (unsubInputMode) {
    unsubInputMode();
    unsubInputMode = null;
  }

  // P2: WS 监听已迁移到 EventBus（由 index.ts 的 eventBusOffFns 在 onunload 时清理）

  // 清理呼吸状态机
  destroyBreathing();

  // 清理 rAF
  if (pendingFrame !== null) {
    cancelAnimationFrame(pendingFrame);
    pendingFrame = null;
  }
  if (removeTransitionFrame !== null) {
    cancelAnimationFrame(removeTransitionFrame);
    removeTransitionFrame = null;
  }
  cancelReacquireReveal();
  reacquirePending = false;
  stopSwitchSettle();

  // 移除 DOM 元素
  if (cursorEl) {
    cursorEl.remove();
    cursorEl = null;
  }

  // round 3 P1 清理：ResizeObserver / Popover 拖动 / 滚动容器事件
  destroyResizeObservers();

  unbindPopoverDrag();

  destroyScrollContainerEvents();

  // commit 1：重置边缘交互状态
  cachedZIndexElement = null;
  cachedFullscreenElement = null;
  cachedEffectiveZIndex = 0;
  prevCursorX = null; // Q7：重置距离记录，下次启动从头计算
  prevCursorY = null;
  lastCursorDur = null;
  nativeCaretOwner = restoreNativeCaretOwner(nativeCaretOwner);
  if (DEBUG_ENABLED) stopDebugFrameBurst();
  debugCaretElement = null;
  debugCaretRect = null;

  destroyEdgeArrow();
}

// ============== P2: EventBus 回调（由 index.ts 订阅并调用） ==============

/** loaded-protyle-static / loaded-protyle-dynamic 回调：新编辑器加载完成时触发更新 */
export function onProtyleLoaded(_protyle: IProtyle): void {
  queueUpdate();
}

/** switch-protyle 回调：切换 tab 时隐藏旧位置，稳定后在新位置淡入 */
export function onProtyleSwitched(_protyle: IProtyle): void {
  if (prefersReducedMotion()) {
    stopSwitchSettle();
    queueUpdate();
    return;
  }
  startSwitchSettle(switchSettleContext);
}

/** click-editorcontent 回调：用户点击了编辑器内容 */
export function onEditorContentClicked(_protyle: IProtyle): void {
  // 点击后可能触发 selectionchange，队列更新
  queueUpdate();
}

/** open-menu-content 回调：右键菜单弹出时光标停在 Phase 1（静态），保留在最后位置 */
export function onMenuOpened(): void {
  if (!cursorEl) return;
  pauseBreathe();
}

/** ws-main 回调：替代手动 WS 监听 + JSON.parse（EventBus 已自动解析） */
export function onWsMain(data: IWebSocketData): void {
  if (data.cmd === "transactions") {
    queueUpdate();
  }
}

/** mobile-keyboard-show 回调：移动端键盘弹出，重定位光标 */
export function onMobileKeyboardShow(): void {
  queueUpdate();
}

/** mobile-keyboard-hide 回调：移动端键盘收起，重定位光标 */
export function onMobileKeyboardHide(): void {
  queueUpdate();
}
