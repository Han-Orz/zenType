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
import { CURSOR_CONFIG, EDGE_FADE, TRANSITION } from "../config";
import { getCursorRect } from "../utils/getCursorRect";
import { isInAllowElements } from "../utils/boundary";
import { isMobile } from "../utils/isMobile";
import { getEffectiveZIndex } from "../utils/getEffectiveZIndex";
import { getEdgeProximity } from "../utils/edgeProximity";
import { prefersReducedMotion } from "../utils/reducedMotion";
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
} from "./cursor/events";
import {
  startSwitchSettle,
  stopSwitchSettle,
  isSwitchHiddenActive,
  isSwitchRevealPending,
  type SwitchSettleContext,
} from "./cursor/switchSettle";
import * as inputMode from "./inputMode";

const CURSOR_ID = "zentype-cursor";

let cursorEl: HTMLDivElement | null = null;
let pendingFrame: number | null = null;
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

/** Fail open whenever the custom caret cannot be positioned reliably. */
function restoreNativeCaretAndHideCustom(): void {
  nativeCaretOwner = restoreNativeCaretOwner(nativeCaretOwner);
  cursorEl?.classList.add("hidden");
}

/** Hide the native caret only on the editable owner currently being rendered. */
function activateCustomCaret(element: Element): boolean {
  nativeCaretOwner = activateNativeCaretOwner(nativeCaretOwner, element);
  if (!nativeCaretOwner) {
    cursorEl?.classList.add("hidden");
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
 */
function applyFadeAndScale(
  el: HTMLDivElement,
  opacity: number,
  scale: number,
  pos: { x: number; y: number; height: number },
  yOffset: number = 2,
): void {
  el.style.opacity = String(Math.round(opacity * 1000) / 1000);
  el.style.transform =
    `translate3d(${pos.x}px, ${pos.y - yOffset}px, 0) scale(${scale})`;
  el.style.height = `${pos.height}px`;
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
  if (pendingFrame !== null) return;
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = null;
    doUpdateCursor();
  });
}

const scrollBindingContext = {
  getCursorElement: () => cursorEl,
  isKeyboardUpdatePending: () => pendingKeyboardUpdate,
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
};

const cursorEventContext: CursorEventContext = {
  clearKeyboardPending,
  markKeyboardPending,
  onScrollOrWheel,
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
function doUpdateCursor(): void {
  if (!cursorEl) return;

  const reducedMotion = prefersReducedMotion();
  if (reducedMotion) {
    cancelRemoveTransitionFrame();
    cursorEl.classList.add("no-transition", "no-animation");
  }

  // 1) 暂停呼吸（操作中不需要呼吸感）
  pauseBreathe();

  // 2) 读取选区 → 显示矩形
  let rect: ReturnType<typeof getCursorRect>;
  try {
    rect = getCursorRect();
  } catch {
    restoreNativeCaretAndHideCustom();
    pauseBreathe();
    return;
  }
  if (!rect || rect.height === 0) {
    // No reliable geometry means the native caret is the only trustworthy
    // fallback; never leave the previous custom caret parked on old content.
    restoreNativeCaretAndHideCustom();
    pauseBreathe();
    return;
  }

  // 3) 边界检测（3 重，round 3 移除第 3 重弹窗硬性排除）
  // commit 1：边缘距离（供 fade/scale、commit 2/3 复用）
  // 传 editorRect 把淡出边界对齐到"编辑器内容区"而不是"裸视口"，让顶部对称底部。
  // 注意：必须先算 allowed（拿到 editorRect）再调 getEdgeProximity。
  let allowed: ReturnType<typeof isInAllowElements>;
  try {
    allowed = isInAllowElements({ x: rect.x, y: rect.y });
  } catch {
    restoreNativeCaretAndHideCustom();
    pauseBreathe();
    return;
  }
  const edge = getEdgeProximity(rect, allowed.editorRect);

  if (!allowed.allowed) {
    // A rejected boundary is not a reliable custom-caret location. Restore
    // native caret visibility and hide the stale global caret instead of
    // leaving it at the last successful position.
    restoreNativeCaretAndHideCustom();
    pauseBreathe();
    return;
  }

  // 移动端标题：可选跳过光标显示（避免移动端键盘弹出时视觉噪音）
  if (isMobile() && allowed.cursorElement?.closest(".protyle-title__input")) {
    // Mobile title editing keeps the host's native caret. The previous code
    // skipped custom rendering while a global CSS rule still hid this caret.
    restoreNativeCaretAndHideCustom();
    pauseBreathe();
    return;
  }

  if (!allowed.cursorElement || !activateCustomCaret(allowed.cursorElement)) {
    pauseBreathe();
    return;
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
  } else {
    effectiveZ = getEffectiveZIndex(allowed.cursorElement!);
    cachedZIndexElement = allowed.cursorElement;
    cachedFullscreenElement = fullscreenElement;
    cachedEffectiveZIndex = effectiveZ;
  }
  cursorEl.style.zIndex = String(effectiveZ + 1);

  // 5) commit 1：边缘淡出 + 缩放
  //   yOffset：光标上移 N 像素，让光标视觉重心偏到行中线之上（用户偏好）。
  //   HEIGHT_RATIO > 1 时光标下沿超出 lineHeight，光标看起来仍偏下；微调上移抵消。
  const yOffset = 2;
  if (edge.isOffScreen) {
    // 完全离屏：opacity=0, scale=MIN_SCALE
    applyFadeAndScale(cursorEl, 0, EDGE_FADE.MIN_SCALE, rect, yOffset);
  } else if (edge.distance < EDGE_FADE.ZONE) {
    // FADE_ZONE 内：opacity = factor, scale = lerp(MIN_SCALE, 1, factor)
    const scale =
      EDGE_FADE.MIN_SCALE + (1 - EDGE_FADE.MIN_SCALE) * edge.factor;
    applyFadeAndScale(cursorEl, edge.factor, scale, rect, yOffset);
  } else {
    // 远离边缘：清 inline opacity 让 CSS / 呼吸动画接管；transform 不带 scale
    // Q7：长距离 = 长时长。查表 TRANSITION.TIERS（config.ts），用户可自行调整。
    const dist = prevCursorX !== null && prevCursorY !== null ? Math.hypot(rect.x - prevCursorX, rect.y - prevCursorY) : 0;
    const dur = transitionDurationForDistance(dist);
    if (!reducedMotion && dur !== lastCursorDur) {
      cursorEl.style.transition = `transform ${dur}s cubic-bezier(0.25, 0.1, 0.25, 1), opacity 0.15s ease-out`;
      lastCursorDur = dur;
    }
    if (
      !isSwitchHiddenActive() &&
      !isSwitchRevealPending() &&
      cursorEl.style.opacity !== ""
    ) {
      cursorEl.style.opacity = "";
    }
    cursorEl.style.transform = `translate3d(${rect.x}px, ${rect.y - yOffset}px, 0)`;
    cursorEl.style.height = `${rect.height}px`;
    prevCursorX = rect.x;
    prevCursorY = rect.y;
  }

  // 首次移动的 .no-transition 已在 createCursorElement 加上，下一帧的 rAF 会移除。
  // 文本选中时跳过顺滑过渡（光标应瞬间跳到选区末尾）
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && sel.toString()) {
    cursorEl.classList.add("no-transition");
  }

  // 显示光标（commit 1：可能仍带 .hidden 残留，离屏分支不再加 .hidden 但清理一次保险）
  cursorEl.classList.remove("hidden");

  // 7) 仅在 no-transition 生效时同步一次布局，让瞬移位置先提交，再恢复过渡。
  if (!reducedMotion && flushCursorTransitionIfNeeded(cursorEl)) {
    // 下一帧恢复 transition（transform / height / opacity 过渡）
    if (removeTransitionFrame !== null) cancelAnimationFrame(removeTransitionFrame);
    removeTransitionFrame = requestAnimationFrame(() => {
      removeTransitionFrame = null;
      cursorEl?.classList.remove("no-transition");
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

  // round 4 fix（capture + cooldown）：键盘标志由 markKeyboardPending 启动的 300ms 倒计时负责清零，
  // 不再在 doUpdateCursor 末尾同步清掉——倒计时窗口内 SiYuan 同步触发的 scroll/ResizeObserver
  // 仍能读到 pendingKeyboardUpdate=true，从而跳过 .no-transition 保留按距离分档的过渡动画
}

function scheduleResumeBreathe(): void {
  scheduleBreathe(CURSOR_CONFIG.BLINK_DELAY_MS);
}

/** 滚动 / 滚轮处理：暂停呼吸 + 停止过渡 + 立即更新 */
function onScrollOrWheel(): void {
  if (!cursorEl) return;
  pauseBreathe();
  // round 4 fix：Enter 触发的 SiYuan 自动滚动会同步到这里；
  // 此时 pendingKeyboardUpdate=true，跳过加 .no-transition 保留按距离分档的过渡动画
  if (!pendingKeyboardUpdate) {
    cursorEl.classList.add("no-transition");
    cursorEl.classList.add("no-animation");
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

  // 首次定位
  queueUpdate();
}

export function destroyCursor(): void {
  initialized = false;

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
