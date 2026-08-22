import { getCursorRect } from "../utils/getCursorRect";
import { findClosestScrollableElement } from "../utils/scroll";
import { TYPEWRITER_CONFIG } from "../config";
import { shouldPauseTypewriter } from "../utils/edgeCases";
import * as inputMode from "./inputMode";
import * as inputModeTriggers from "./inputModeTriggers";
import { isInAllowElements } from "../utils/boundary";
import {
  claimInlineStyle,
  restoreOwnedInlineStyle,
  setOwnedInlineStyle,
  type OwnedInlineStyle,
} from "../utils/inlineStyleOwnership";
import {
  isCurrentSelectionEditable,
  isCurrentSelectionInActiveEditor,
  isEditableEvent,
  isReadonlyEditorTarget,
} from "../utils/editorScope";
import { prefersReducedMotion } from "../utils/reducedMotion";

const { COMFORT_ZONE, SCROLL_DURATION_TIERS, SCROLL_CURVE, TYPING_GAP_MS, CLICK_CENTER_LOW, CLICK_CENTER_HIGH } = TYPEWRITER_CONFIG;
const FLIP_BLOCK_RADIUS = 30;

let eventListeners: Array<[string, EventListener, AddEventListenerOptions?]> = [];
let windowEventListeners: Array<[string, EventListener, AddEventListenerOptions?]> = [];
let unsubInputMode: (() => void) | null = null;
let pendingScroll: number | null = null;
let pendingScrollEnd: number = 0;
let scrollResyncPending = false;
let activeFLIPTimer: ReturnType<typeof setTimeout> | null = null;
let lastFLIPElements: HTMLElement[] = []; // P3-7: 上一轮 FLIP 修改的元素，供下一轮入口清理残留 inline transition
const ownedFLIPStyles = new WeakMap<HTMLElement, OwnedInlineStyle>();
let flipGeneration = 0;
let initialized = false;
const deferredFrames = new Set<number>();

// debounce / IME 状态（修复 3a/3b/3c）
let lastInputAt = 0;                                       // 最近一次 input 事件时间戳；0 = 空闲
let composing = false;                                     // IME composition 进行中
let debounceTimer: ReturnType<typeof setTimeout> | null = null;  // 停顿后触发一次舒适区对齐的定时器
let firstCharAfterIdle = false;                            // Option i：空闲后的首个输入立即滚（input 监听器设置，checkAndScroll 消费）
let bypassEmptyBlock = false;                              // Enter 新建空块时设 true，让空块守卫放行一次

/** isScrolling 由 pendingScroll !== null 推断，无需独立状态管理 — 避免动画结束到定时器置 false 间的竞态窗口 */
function isScrolling(): boolean {
  return pendingScroll !== null;
}

export function shouldHandleTypewriterEditKey(
  event: Pick<KeyboardEvent, "key" | "isComposing" | "defaultPrevented">,
): boolean {
  return !event.isComposing && !event.defaultPrevented &&
    (event.key === "Enter" || event.key === "Backspace");
}

export function shouldCancelPendingScrollForReducedMotion(
  reducedMotion: boolean,
  hasPendingScroll: boolean,
): boolean {
  return reducedMotion && hasPendingScroll;
}

let pendingCheck: number | null = null;
let cachedContainer: HTMLElement | null = null;
let cachedCursorElement: Element | null = null;
let lastCheckRect: { x: number; y: number; width: number; height: number } | null = null;

function requestDeferredFrame(callback: FrameRequestCallback): number {
  const frame = requestAnimationFrame((time) => {
    deferredFrames.delete(frame);
    if (!initialized) return;
    callback(time);
  });
  deferredFrames.add(frame);
  return frame;
}

function cancelDeferredFrames(): void {
  for (const frame of deferredFrames) {
    cancelAnimationFrame(frame);
  }
  deferredFrames.clear();
}

function pauseTypewriterMotion(): void {
  flipGeneration += 1;
  cancelDeferredFrames();
  if (pendingScroll !== null) {
    cancelAnimationFrame(pendingScroll);
    pendingScroll = null;
  }
  if (pendingCheck !== null) {
    cancelAnimationFrame(pendingCheck);
    pendingCheck = null;
  }
  if (activeFLIPTimer !== null) {
    clearTimeout(activeFLIPTimer);
    activeFLIPTimer = null;
  }
  clearLastFLIPElements();
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  scrollResyncPending = false;
  composing = false;
  lastInputAt = 0;
  firstCharAfterIdle = false;
  bypassEmptyBlock = false;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** 缓起缓收 —— 点击居中用，比 easeOutCubic 更自然（起步不冲，收尾不突兀） */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * 精简 FLIP 动画：Enter / Backspace 块变更后，下方块平滑过渡回原位。
 *
 * 三阶段批量执行：
 *   Phase 1 (Invert): 采样块一次性写完 transform+transition:none，不读 offsetHeight
 *   Phase 2 (Commit):  读 editor.offsetHeight 一次，唯一 layout — 所有 Invert 一起生效
 *   Phase 3 (Play):    一个 rAF 统一启动所有 transition，一个 setTimeout 集中清理
 *
 * 对比旧版：不逐元素 reflow、不逐元素内层 rAF → 无中间帧残影，定时器从 N×2 降到 2。
 * 防重入：新调用会取消前一轮的 cleanup 定时器，防止覆盖 transform 后又被旧 cleanup 清空。
 */
function clearLastFLIPElements(): void {
  for (const el of lastFLIPElements) {
    const owned = ownedFLIPStyles.get(el);
    if (owned) restoreOwnedInlineStyle(el.style, owned);
    ownedFLIPStyles.delete(el);
  }
  lastFLIPElements = [];
}

function setOwnedFLIPStyle(el: HTMLElement, property: string, value: string): void {
  let owned = ownedFLIPStyles.get(el);
  if (!owned) {
    owned = claimInlineStyle(el.style, ["transform", "transition"]);
    ownedFLIPStyles.set(el, owned);
  }
  setOwnedInlineStyle(el.style, owned, property, value);
}

function isBlockElement(el: Element | null): el is HTMLElement {
  return el instanceof HTMLElement && el.hasAttribute("data-node-id");
}

function addSiblingWindow(block: HTMLElement, blocks: Set<HTMLElement>): void {
  blocks.add(block);

  let prev = block.previousElementSibling;
  let prevCount = 0;
  while (prev && prevCount < FLIP_BLOCK_RADIUS) {
    if (isBlockElement(prev)) {
      blocks.add(prev);
      prevCount++;
    }
    prev = prev.previousElementSibling;
  }

  let next = block.nextElementSibling;
  let nextCount = 0;
  while (next && nextCount < FLIP_BLOCK_RADIUS) {
    if (isBlockElement(next)) {
      blocks.add(next);
      nextCount++;
    }
    next = next.nextElementSibling;
  }
}

function addFlipWindowsFromBlock(block: HTMLElement, editor: HTMLElement, blocks: Set<HTMLElement>): void {
  let current: HTMLElement | null = block;
  while (current && current !== editor && editor.contains(current)) {
    if (isBlockElement(current)) addSiblingWindow(current, blocks);

    const parent: HTMLElement | null = current.parentElement;
    if (!parent || parent === editor) break;

    const ancestor = parent.closest("[data-node-id]") as HTMLElement | null;
    if (!ancestor || ancestor === current || !editor.contains(ancestor)) break;
    current = ancestor;
  }
}

function collectFlipBlocks(editor: HTMLElement, range: Range): HTMLElement[] {
  const blocks = new Set<HTMLElement>();
  const startBlock = elementFromNode(range.startContainer)?.closest("[data-node-id]") as HTMLElement | null;
  if (startBlock && editor.contains(startBlock)) {
    addFlipWindowsFromBlock(startBlock, editor, blocks);
  }

  if (!range.collapsed) {
    const endBlock = elementFromNode(range.endContainer)?.closest("[data-node-id]") as HTMLElement | null;
    if (endBlock && endBlock !== startBlock && editor.contains(endBlock)) {
      addFlipWindowsFromBlock(endBlock, editor, blocks);
    }
  }

  // Rare fallback for unexpected selection containers: keep the old behavior.
  return blocks.size > 0
    ? Array.from(blocks)
    : Array.from(editor.querySelectorAll<HTMLElement>("[data-node-id]"));
}

function animateBlockShift(editor: HTMLElement, range: Range): void {
  if (prefersReducedMotion()) {
    flipGeneration += 1;
    if (activeFLIPTimer !== null) {
      clearTimeout(activeFLIPTimer);
      activeFLIPTimer = null;
    }
    clearLastFLIPElements();
    return;
  }
  const token = ++flipGeneration;

  // 取消前一轮 FLIP cleanup，防止连续 Enter 时前一轮 Phase 3 的 setTimeout 清空当前 transform
  if (activeFLIPTimer !== null) {
    clearTimeout(activeFLIPTimer);
    activeFLIPTimer = null;
  }

  // P3-7: 清理上一轮 FLIP 残留的 inline transition/transform。连续 Enter 时前一轮
  // cleanup setTimeout 已被上方取消，被 |delta|<2 跳过的元素会永久残留 transition。
  clearLastFLIPElements();

  // First: 捕获阶段同步快照当前块附近的旧位置（在 Enter 的 capture handler 中调用，
  // 此时 SiYuan bubble handler 尚未改 DOM）。只采样光标附近 sibling + 祖先层级，
  // 避免长文档里对所有块做 getBoundingClientRect()。
  const first = new Map<HTMLElement, number>();
  collectFlipBlocks(editor, range).forEach(el => {
    first.set(el, el.getBoundingClientRect().top);
  });

  // 等一帧让 SiYuan 完成 DOM 变更
  requestDeferredFrame(() => {
    if (token !== flipGeneration) return;

    const modifiedElements: HTMLElement[] = [];

    // Phase 1 (Invert): 批量写
    for (const [el, y0] of first) {
      if (!el.isConnected) continue;
      const y1 = el.getBoundingClientRect().top;
      const delta = y0 - y1;
      if (Math.abs(delta) < 2) continue;

      setOwnedFLIPStyle(el, "transform", `translateY(${delta}px)`);
      setOwnedFLIPStyle(el, "transition", "none");
      modifiedElements.push(el);
    }

    lastFLIPElements = modifiedElements;

    if (modifiedElements.length === 0) return;

    // Phase 2 (Commit): 唯一一次 layout
    void editor.offsetHeight;

    // Phase 3 (Play): 一个 rAF 统一启动
    requestDeferredFrame(() => {
      if (token !== flipGeneration) return;

      for (const el of modifiedElements) {
        setOwnedFLIPStyle(el, "transition", `transform 250ms ${SCROLL_CURVE}`);
        setOwnedFLIPStyle(el, "transform", "");
      }
      if (activeFLIPTimer !== null) {
        clearTimeout(activeFLIPTimer);
        activeFLIPTimer = null;
      }
      activeFLIPTimer = setTimeout(() => {
        if (token !== flipGeneration || activeFLIPTimer === null) return;  // 被新 FLIP 取消，跳过 cleanup
        activeFLIPTimer = null;
        modifiedElements.forEach(el => {
          const owned = ownedFLIPStyles.get(el);
          if (owned) restoreOwnedInlineStyle(el.style, owned);
          ownedFLIPStyles.delete(el);
        });
      }, 300);
    });
  });
}

function durationForDistance(dist: number): number {
  if (dist < 20) return SCROLL_DURATION_TIERS[0];
  if (dist < 60) return SCROLL_DURATION_TIERS[1];
  if (dist < 150) return SCROLL_DURATION_TIERS[2];
  if (dist < 400) return SCROLL_DURATION_TIERS[3];
  return SCROLL_DURATION_TIERS[4];
}

interface SmoothScrollOptions {
  deltaY: number;
  duration?: number;
  easing?: (t: number) => number;
}

function smoothScroll(target: HTMLElement, options: SmoothScrollOptions): void {
  const { deltaY, duration, easing } = options;
  const easeFn = easing ?? easeOutCubic;

  if (prefersReducedMotion()) {
    if (pendingScroll !== null) cancelAnimationFrame(pendingScroll);
    pendingScroll = null;
    const maxScroll = target.scrollHeight - target.clientHeight;
    target.scrollTop = Math.max(0, Math.min(target.scrollTop + deltaY, maxScroll));
    if (scrollResyncPending) {
      scrollResyncPending = false;
      lastCheckRect = null;
      scheduleCheck();
    }
    return;
  }

  // 设计决策（TODO-5）：checkAndScroll 的 isScrolling() 守卫在动画进行中直接 return，
  // 新滚动请求被丢弃而非合并。下方 cancelAnimationFrame 为防御性保留（未来若有其他
  // 调用方绕过守卫进入此函数时可安全接管）。
  if (pendingScroll !== null) cancelAnimationFrame(pendingScroll);

  pendingScrollEnd = target.scrollTop + deltaY;

  const startScroll = target.scrollTop;
  const startTime = performance.now();
  const dur = duration ?? durationForDistance(Math.abs(deltaY));

  function step() {
    const elapsed = performance.now() - startTime;
    const t = Math.min(elapsed / dur, 1);
    const eased = easeFn(t);
    const maxScroll = target.scrollHeight - target.clientHeight;
    const currentEnd = pendingScrollEnd;
    target.scrollTop = Math.max(0, Math.min(
        startScroll + (currentEnd - startScroll) * eased,
        maxScroll
    ));
    if (t < 1) {
      pendingScroll = requestAnimationFrame(step);
    } else {
      pendingScroll = null;
      if (scrollResyncPending) {
        scrollResyncPending = false;
        lastCheckRect = null;
        scheduleCheck();
      }
    }
  }
  pendingScroll = requestAnimationFrame(step);
}

function cancelPendingScrollForReducedMotion(): void {
  if (!shouldCancelPendingScrollForReducedMotion(prefersReducedMotion(), pendingScroll !== null)) {
    return;
  }
  const frame = pendingScroll;
  if (frame === null) return;
  cancelAnimationFrame(frame);
  pendingScroll = null;
  scrollResyncPending = false;
}

function scheduleCheck(): void {
  if (pendingCheck !== null) return; // already scheduled, merge
  pendingCheck = requestAnimationFrame(() => {
    pendingCheck = null;
    checkAndScroll();
  });
}

function checkAndScroll(): void {
  // 打字机模式关闭时：不自动滚动
  if (!inputMode.isTypewriterActive()) return;

  // Reduced motion may be enabled while an existing smooth scroll is running.
  // Cancel it before any pause or isScrolling guard so this action cannot leave
  // the old animation alive.
  cancelPendingScrollForReducedMotion();

  // 暂停场景（悬浮窗 / 只读 / 嵌入块）：不滚动
  if (shouldPauseTypewriter()) return;

  // 动画进行中：不触发新 scroll，防止连续 keystroke 雪崩到 clamp 边界
  if (isScrolling()) {
    scrollResyncPending = true;
    return;
  }

  // IME composition 进行中：硬暂停，避免 per-frame scrollTop 拖动 IME 候选框（修复 3c）
  if (composing) return;

  const rect = getCursorRect();
  if (!rect) return;

  // 光标未移动则跳过：浏览器可能在 caret blink / IME 更新时反复触发
  // selectionchange，但 getClientRects 返回的 viewport 坐标不变。
  // 避免无意义的 DOM 遍历 + debug 噪声。
  const prevY = lastCheckRect?.y;  // 在更新前捕获，供 vertical-jump defer 使用
  if (
    lastCheckRect &&
    Math.abs(rect.x - lastCheckRect.x) < 1 &&
    Math.abs(rect.y - lastCheckRect.y) < 1 &&
    Math.abs(rect.width - lastCheckRect.width) < 1 &&
    Math.abs(rect.height - lastCheckRect.height) < 1
  ) {
    return;
  }
  lastCheckRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };

  // 垂直跳变 defer：光标 Y 突变 >3px → SiYuan 布局未收敛（块插入/删除后），
  // 推迟一帧等布局稳定再滚。正常打字（同行 x 变 y 不变）不触发。
  // 关键修复（3a）：defer 内清 lastCheckRect=null，让 deferred checkAndScroll 通过
  // equality check（原 bug：deferred check 被 equality check 吞掉 → 首字不滚）。
  if (prevY !== undefined && Math.abs(rect.y - prevY) > 3) {
    lastCheckRect = null;
    scheduleCheck();
    return;
  }

  // 使用 isInAllowElements 复用 cursor 模块验证过的选择器逻辑
  // 内部使用 cursorElement.closest(".protyle:not(.fn__none) .protyle-content")
  // 正确找到当前活跃编辑器的 protyle-content（包括分屏场景）
  const result = isInAllowElements({ x: rect.x, y: rect.y });

  // allowed 为 false 时，如果 editorRect 不可用，说明光标不在有效编辑区域
  // （标题区域由 boundary.ts 提供 editorRect fallback；若仍不可用，此处会被过滤）
  if (!result.editorRect) return;
  if (!result.cursorElement) return;

  // 新增：空块守卫。光标在空块时 typewriter scroll 无意义（块高近 0，cursor
  // 在块顶），且 getCursorRect 已走非突变 fallback 也无 cursorPct 可言。
  // 同时这是防御层：即使未来 fallback 路径再次突变 DOM，空块也直接退出。
  const cursorBlock = result.cursorElement.closest('[data-node-id]');
  if (cursorBlock) {
    // trim() 不移除 ZWSP(\u200B)、BOM(\uFEFF)、NBSP(\u00A0)——SiYuan 可能用这些做占位
    const text = (cursorBlock.textContent?.trim() ?? '')
      .replace(/[\u200B\uFEFF\u00A0]/g, '');
    const isEmptyBlock = text === ''
      && !cursorBlock.querySelector(
        'img, iframe, [data-type^="NodeMathBlock"], [data-type^="NodeCodeBlock"]',
      );
    if (isEmptyBlock) {
      // 空块时清除 lastCheckRect，使下次（首字符）checkAndScroll 的 prevY=undefined
      // 避免 |firstCharY - emptyBlockY| > 3 触发 defer 级联导致滚动丢失（TODO-6）
      lastCheckRect = null;
      // Enter 新建空块时绕过守卫 —— 块虽空但用户需要看到它被带入舒适区
      if (bypassEmptyBlock) {
        bypassEmptyBlock = false;
        // fall through（不 return）
      } else {
        return;
      }
    }
  }

  // debounce：连续键入延后到停顿后再滚一次；空闲态首字立即滚（Option i，修复 3a）
  // 实现"连续键入不滚动，空隙时滚动"的预期行为（3b 作为功能）
  // 放在空块守卫之后 —— 否则 Enter 创建的空块会消费掉 firstCharAfterIdle 标志，
  // 导致用户真正输入首字时标志已丢、走 debounce 延后（Enter/Backspace 行为不一致的根因）
  if (firstCharAfterIdle) {
    // Option i：空闲后的首个输入立即滚（input 监听器检测到 wasIdle 并设置此标志）
    firstCharAfterIdle = false;
  } else {
    const now = Date.now();
    const sinceInput = now - lastInputAt;
    if (sinceInput < TYPING_GAP_MS) {
      // 连续键入中：延后到停顿后再滚一次
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        // 清掉 lastCheckRect 防止 equality check 吞掉这次延后触发的滚动
        lastCheckRect = null;
        checkAndScroll();
      }, TYPING_GAP_MS - sinceInput + 1);
      return;
    }
  }

  // 缓存命中：同一 cursorElement 复用上次的 scroll container，避免每次都 DOM 遍历
  // 同时检查容器是否仍在 DOM 中（主题切换 / 面板 resize / tab 切换可能导致容器被替换）
  let container: HTMLElement | null;
  if (
    result.cursorElement === cachedCursorElement &&
    cachedContainer &&
    cachedContainer.isConnected
  ) {
    container = cachedContainer;
  } else {
    container = findClosestScrollableElement(result.cursorElement);
    cachedContainer = container;
    cachedCursorElement = result.cursorElement;
  }
  if (!container) return;

  // 使用 editorRect（protyle-content 的 bounding rect）作为滚动锚点
  // 而非 container.getBoundingClientRect()（可能是更大的祖先元素）
  // 注：AllowResult.editorRect 只有 top/bottom/left/right，无 height 字段（不像 DOMRect）
  const editorHeight = result.editorRect.bottom - result.editorRect.top;
  const cursorPct = (rect.y - result.editorRect.top) / editorHeight;

  // v2.3.0：舒适区间 [COMFORT_ZONE[0], COMFORT_ZONE[1]]，区间内不滚
  // 符号约定：smoothScroll 中 deltaY > 0 = scrollTop 增加 = 页面/视口向下滚
  // 因此要让 cursor 在视口里"下移"（cursor 在顶部时），需要 deltaY < 0（向上滚）
  let deltaY = 0;
  if (cursorPct < COMFORT_ZONE[0]) {
    // 光标在舒适区上方 → deltaY 负（向上滚）→ cursor 在视口里下移到 COMFORT_ZONE[0]
    deltaY = (cursorPct - COMFORT_ZONE[0]) * editorHeight;
  } else if (cursorPct > COMFORT_ZONE[1]) {
    // 光标在舒适区下方 → deltaY 正（向下滚）→ cursor 在视口里上移到 COMFORT_ZONE[1]
    deltaY = (cursorPct - COMFORT_ZONE[1]) * editorHeight;
  }
  // else: 舒适区内，deltaY = 0，不滚

  if (Math.abs(deltaY) >= 1) {
    smoothScroll(container, { deltaY });
  }
}

/**
 * 点击居中（Option B）：仅当 caret 垂直位置超出更宽的 [CLICK_CENTER_LOW, CLICK_CENTER_HIGH]
 * 边界时才主动居中，避免破坏附近点击的滚动定位。绕过 isTypewriterActive / composing / debounce
 * 门禁（click 是显式定位动作，不是连续键入）。跳过链接 / 按钮以不与思源导航冲突。
 */
function centerIfFarOff(target: Element): void {
  // IME composition 进行中不居中 —— 点击同编辑区不一定会结束 composition，避免拖候选框
  if (composing) return;
  if (target.closest('[data-type="a"], button')) return;
  // 点击后等光标定位稳定（思源 selectionchange 在 click 之后异步触发）
  requestDeferredFrame(() => {
    if (composing) return;  // rAF 期间 composition 开始则放弃
    const rect = getCursorRect();
    if (!rect) return;
    const result = isInAllowElements({ x: rect.x, y: rect.y });
    if (!result.editorRect || !result.cursorElement) return;
    const container = findClosestScrollableElement(result.cursorElement);
    if (!container) return;
    const editorHeight = result.editorRect.bottom - result.editorRect.top;
    if (editorHeight <= 0) return;
    const cursorPct = (rect.y - result.editorRect.top) / editorHeight;
    if (cursorPct >= CLICK_CENTER_LOW && cursorPct <= CLICK_CENTER_HIGH) return;
    // 居中到视口 0.5 位置（符号约定与 checkAndScroll 一致：deltaY = (cursorPct - target) * h）
    // 用 easeInOutCubic（缓起缓收）+ 略加时长，比打字滚动的 easeOutCubic 更自然
    const deltaY = (cursorPct - 0.5) * editorHeight;
    if (Math.abs(deltaY) >= 1) {
      const baseDur = durationForDistance(Math.abs(deltaY));
      smoothScroll(container, { deltaY, easing: easeInOutCubic, duration: Math.round(baseDur * 1.4) });
    }
  });
}

function elementFromNode(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement;
}

function shouldAnimateBlockShiftForKey(key: string): boolean {
  if (key === "Enter") return true;
  if (key !== "Backspace") return false;

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;

  const range = sel.getRangeAt(0);
  const startEl = elementFromNode(range.startContainer);
  if (!startEl) return false;

  const startBlock = startEl.closest('[data-node-id]');
  if (!startBlock) return false;

  if (!range.collapsed) {
    const endEl = elementFromNode(range.endContainer);
    const endBlock = endEl?.closest('[data-node-id]') ?? null;
    return endBlock !== null && endBlock !== startBlock;
  }

  const beforeCaret = range.cloneRange();
  try {
    beforeCaret.selectNodeContents(startBlock);
    beforeCaret.setEnd(range.startContainer, range.startOffset);
  } catch {
    return true;
  }

  return beforeCaret.toString().replace(/[\u200B\uFEFF\u00A0]/g, '') === '';
}

export function initTypewriter(): void {
  if (initialized) return;
  initialized = true;

  // 事件数组使用三元组以便保留 options
  const handlers: Array<[string, EventListener, AddEventListenerOptions?]> = [
    ["selectionchange", () => {
      if (isCurrentSelectionEditable()) scheduleCheck();
      else if (isCurrentSelectionInActiveEditor()) {
        inputModeTriggers.onReadonly();
        pauseTypewriterMotion();
      }
    }],
    // input 事件维护 debounce 心跳（lastInputAt），区分"连续键入"与"停顿"
    // Option i：若此次 input 前已空闲（>2×gap），设置标志让 checkAndScroll 立即滚而不延后
    [
      "input",
      (e: Event) => {
        if (!isEditableEvent(e)) {
          if (isReadonlyEditorTarget(e.target)) {
            inputModeTriggers.onReadonly();
            pauseTypewriterMotion();
          }
          return;
        }
        const ie = e as InputEvent;
        const wasIdle = lastInputAt === 0 || (Date.now() - lastInputAt) > 2 * TYPING_GAP_MS;
        // 仅 insert 类输入设置 firstCharAfterIdle（Backspace delete 不应绕过 debounce）
        if (wasIdle && ie.inputType?.startsWith("insert")) firstCharAfterIdle = true;
        lastInputAt = Date.now();
      },
      { capture: true },
    ],
    // IME composition 开始：硬暂停 + 取消进行中的 smoothScroll，否则 per-frame scrollTop 会拖候选框（修复 3c）
    [
      "compositionstart",
      (e) => {
        if (!isEditableEvent(e)) {
          if (isReadonlyEditorTarget(e.target)) {
            inputModeTriggers.onReadonly();
            pauseTypewriterMotion();
          }
          return;
        }
        composing = true;
        firstCharAfterIdle = false;  // composition 走自己的路径，不消费 firstChar 标志
        if (pendingScroll !== null) {
          cancelAnimationFrame(pendingScroll);
          pendingScroll = null;
        }
        scrollResyncPending = false;
        if (debounceTimer !== null) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
      },
      { capture: true },
    ],
    // IME composition 结束：解除暂停，重置 debounce 心跳，调度一次舒适区检查（走 debounce 路径）
    [
      "compositionend",
      (e) => {
        if (!isEditableEvent(e)) {
          if (isReadonlyEditorTarget(e.target)) {
            inputModeTriggers.onReadonly();
            pauseTypewriterMotion();
          }
          return;
        }
        composing = false;
        firstCharAfterIdle = false;  // post-composition 走 debounce，不立即滚
        lastInputAt = Date.now();
        scheduleCheck();
      },
      { capture: true },
    ],
    // 点击居中（Option B）：仅在 caret 超出 [CLICK_CENTER_LOW, CLICK_CENTER_HIGH] 时居中
    [
      "click",
      (e) => {
        if (!isEditableEvent(e)) return;
        const target = e.target;
        if (target instanceof Element) centerIfFarOff(target);
      },
    ],
    // Enter / Backspace 块变更 → 块级 FLIP 过渡动画 + 重新对齐舒适区
    // capture 阶段：先于 SiYuan bubble handler，在 DOM 变更前快照块位置
    [
      "keydown",
      (e) => {
        if (!isEditableEvent(e)) {
          if (isReadonlyEditorTarget(e.target)) {
            inputModeTriggers.onReadonly();
            pauseTypewriterMotion();
          }
          return;
        }
        const ke = e as KeyboardEvent;
        if (!shouldHandleTypewriterEditKey(ke)) return;
        const shouldAnimateBlockShift = shouldAnimateBlockShiftForKey(ke.key);
        // Enter/Backspace 后 SiYuan 可能 preventDefault → 不触发 input 事件 → typewriterActive 不被重置
        // 主动激活，确保 checkAndScroll 不因 typewriter 状态关闭而早退（修 Enter 不滚的根因）
        inputModeTriggers.onEnterOrBackspaceEdit();
        // 先触发 FLIP 快照
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return;
        const editor = sel.anchorNode?.parentElement?.closest(
          ".protyle-wysiwyg",
        ) as HTMLElement | null;
        if (editor && shouldAnimateBlockShift) animateBlockShift(editor, sel.getRangeAt(0));
        // 延迟两帧等 SiYuan 布局收敛后再触发滚动对齐
        // 不能用 scheduleCheck() 唯一一帧，因为思源在 Enter/Backspace 的 bubble
        // handler 中还要修改 DOM，一帧不够——两帧后布局稳定
        requestDeferredFrame(() => {
          requestDeferredFrame(() => {
            // 同时清掉 lastCheckRect 让 checkAndScroll 不因坐标未变而跳过
            lastCheckRect = null;
            // Enter vs Backspace 区别处理：
            //  - Enter 新建块（常为空）→ 绕过空块守卫 + 立即滚（不等首字输入）
            //  - Backspace 块级合并（FLIP 检测到块位移 lastFLIPElements.length>0）→ 立即滚
            //  - Backspace 字符删除（无块位移）→ 不设 lastInputAt=0，走 debounce
            if (ke.key === "Enter") {
              bypassEmptyBlock = true;
              lastInputAt = 0;
            } else if (shouldAnimateBlockShift && lastFLIPElements.length > 0) {
              lastInputAt = 0;
            }
            checkAndScroll();
            bypassEmptyBlock = false;  // 清理（防止泄漏到后续 checkAndScroll）
          });
        });
      },
      { capture: true },
    ],
  ];

  const windowHandlers: Array<[string, EventListener, AddEventListenerOptions?]> = [
    ["resize", () => {
      if (isCurrentSelectionEditable()) scheduleCheck();
      else if (isCurrentSelectionInActiveEditor()) {
        inputModeTriggers.onReadonly();
        pauseTypewriterMotion();
      }
    }, { passive: true }],
  ];

  // 解构必须包含第三个元素，否则 passive 等选项会被丢弃
  handlers.forEach(([event, handler, options]) => {
    document.addEventListener(event, handler as EventListener, options);
  });
  eventListeners = handlers;
  windowHandlers.forEach(([event, handler, options]) => {
    window.addEventListener(event, handler, options);
  });
  windowEventListeners = windowHandlers;

  unsubInputMode = inputMode.subscribe((state) => {
    if (!state.typewriterActive) pauseTypewriterMotion();
  });

  // 只有当前活跃可编辑 Protyle 才允许初始化时进入模式；只读/外部焦点
  // 保持关闭，避免模块启动把全局 UI 输入误判为编辑活动。
  if (isCurrentSelectionEditable() && !shouldPauseTypewriter()) {
    inputModeTriggers.onTextInput();
  } else {
    inputModeTriggers.onReadonly();
  }
}

export function destroyTypewriter(): void {
  eventListeners.forEach(([event, handler, options]) => {
    document.removeEventListener(event, handler, options);
  });
  eventListeners = [];
  windowEventListeners.forEach(([event, handler, options]) => {
    window.removeEventListener(event, handler, options);
  });
  windowEventListeners = [];
  if (unsubInputMode) {
    unsubInputMode();
    unsubInputMode = null;
  }
  initialized = false;
  flipGeneration += 1;
  cancelDeferredFrames();

  if (pendingScroll !== null) {
    cancelAnimationFrame(pendingScroll);
    pendingScroll = null;
  }

  if (pendingCheck !== null) {
    cancelAnimationFrame(pendingCheck);
    pendingCheck = null;
  }

  if (activeFLIPTimer !== null) {
    clearTimeout(activeFLIPTimer);
    activeFLIPTimer = null;
  }
  clearLastFLIPElements();

  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  cachedContainer = null;
  cachedCursorElement = null;
  lastCheckRect = null;
  pendingScrollEnd = 0;
  scrollResyncPending = false;
  composing = false;
  lastInputAt = 0;
  firstCharAfterIdle = false;
  bypassEmptyBlock = false;
}
