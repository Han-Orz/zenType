import { getCursorRect } from "../utils/getCursorRect";
import { findClosestScrollableElement } from "../utils/scroll";
import { TYPEWRITER_CONFIG } from "../config";
import { shouldPauseTypewriter } from "../utils/edgeCases";
import * as inputMode from "./inputMode";
import * as inputModeTriggers from "./inputModeTriggers";
import * as structuralEdit from "./structuralEdit";
import * as flip from "./typewriter/flip";
import * as scroll from "./typewriter/scroll";
import { resolveScrollTarget } from "./typewriter/targetResolver";
import { isInAllowElements } from "../utils/boundary";
import {
  isCurrentSelectionEditable,
  isCurrentSelectionInActiveEditor,
  isEditableEvent,
  isReadonlyEditorTarget,
} from "../utils/editorScope";

const { TYPING_GAP_MS, CLICK_CENTER_LOW, CLICK_CENTER_HIGH } = TYPEWRITER_CONFIG;

let eventListeners: Array<[string, EventListener, AddEventListenerOptions?]> = [];
let windowEventListeners: Array<[string, EventListener, AddEventListenerOptions?]> = [];
let unsubInputMode: (() => void) | null = null;
let unsubStructuralEditFinish: (() => void) | null = null;
let initialized = false;
const deferredFrames = new Set<number>();

// debounce / IME 状态（修复 3a/3b/3c）
let lastInputAt = 0;                                       // 最近一次 input 事件时间戳；0 = 空闲
let lastInputDebugType = "";                               // dev-only：最近一次 input 的 inputType
let composing = false;                                     // IME composition 进行中
let debounceTimer: ReturnType<typeof setTimeout> | null = null;  // 停顿后触发一次舒适区对齐的定时器
let firstCharAfterIdle = false;                            // Option i：空闲后的首个输入立即滚（input 监听器设置，checkAndScroll 消费）
let bypassEmptyBlock = false;                              // Enter 新建空块时设 true，让空块守卫放行一次

export function shouldHandleTypewriterEditKey(
  event: Pick<KeyboardEvent, "key" | "isComposing" | "defaultPrevented">,
): boolean {
  return !event.isComposing && !event.defaultPrevented &&
    (event.key === "Enter" || event.key === "Backspace");
}

export function shouldHandleListStructuralIntentKey(
  event: Pick<
    KeyboardEvent,
    "key" | "isComposing" | "defaultPrevented" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey"
  >,
): boolean {
  return event.key === "Tab"
    && !event.isComposing
    && !event.defaultPrevented
    && !event.ctrlKey
    && !event.altKey
    && !event.metaKey;
}

export { shouldCancelPendingScrollForReducedMotion } from "./typewriter/scroll";

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
  flip.reset();
  scroll.reset();
  cancelDeferredFrames();
  if (pendingCheck !== null) {
    cancelAnimationFrame(pendingCheck);
    pendingCheck = null;
  }
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  composing = false;
  lastInputAt = 0;
  firstCharAfterIdle = false;
  bypassEmptyBlock = false;
}

/** 缓起缓收 —— 点击居中用，比 easeOutCubic 更自然（起步不冲，收尾不突兀） */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function scheduleCheck(): void {
  if (pendingCheck !== null) return; // already scheduled, merge
  pendingCheck = requestAnimationFrame(() => {
    pendingCheck = null;
    checkAndScroll();
  });
}

function scheduleScrollResync(): void {
  lastCheckRect = null;
  scheduleCheck();
}

type ScrollCheckAuthority = "ordinary" | "structural";

// Dev-only visibility investigation: one event per checkAndScroll gate block,
// recording the caret trajectory and debounce state without any text content.
function reportCheckGate(gate: string, data: Record<string, unknown>): void {
  if (!__ZENTYPE_DEV__) return;
  scroll.reportDebugEvent({ name: "typewriter-check-gate", gate, ...data });
}

// Hard visibility margin: the caret counts as "at risk" once it is within this
// distance of the editor viewport edge. Real-machine gate data showed unsafe
// observations clustered at 0-26px with ~38px lines, so about one line and a
// quarter of margin starts the follow before the caret is visually clipped,
// while mid-editor checks never come close to the boundary.
export const CARET_VISIBILITY_MARGIN_PX = 48;

// 舒适区修正可以 debounce；caret 可见性不能 debounce。该判定只用于让
// empty-block 守卫和打字 debounce 为视口安全让位，不影响 structural
// pending / 暂停 / scroll ownership 等更早的 gate。
export function isCaretNearVisibilityBoundary(
  caretRect: { y: number; height: number },
  editorRect: { top: number; bottom: number },
): boolean {
  return (
    caretRect.y - CARET_VISIBILITY_MARGIN_PX <= editorRect.top
    || caretRect.y + caretRect.height + CARET_VISIBILITY_MARGIN_PX >= editorRect.bottom
  );
}

function checkAndScroll(authority: ScrollCheckAuthority = "ordinary"): void {
  // 打字机模式关闭时：不自动滚动
  if (!inputMode.isTypewriterActive()) return;

  // Reduced motion may be enabled while an existing smooth scroll is running.
  // Cancel it before reading the new target so this action cannot leave the old
  // animation alive.
  scroll.cancelForReducedMotion();

  // SiYuan may emit selectionchange while Enter/Backspace is still settling.
  // The coordinator's stable finish is the authoritative geometry sample; do
  // not let a transient range start, restart, or cancel that motion.
  if (structuralEdit.isStructuralEditPending()) {
    reportCheckGate("structural-pending", {
      authority,
      scrolling: scroll.isScrolling(),
      structural: structuralEdit.getStructuralEditSnapshot(),
    });
    if (scroll.isScrolling()) scroll.requestResync(scheduleScrollResync);
    return;
  }

  // Once a smooth motion has started, ordinary selectionchange events are not
  // authoritative enough to retarget it. Let the current loop finish and do a
  // single resync; only a coordinator stable finish may explicitly opt into a
  // structural target at its safe point.
  if (scroll.isScrolling() && authority !== "structural") {
    reportCheckGate("scroll-active", { authority });
    scroll.requestResync(scheduleScrollResync);
    return;
  }

  // 暂停场景（悬浮窗 / 只读 / 嵌入块）：不滚动
  if (shouldPauseTypewriter()) return;

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
    reportCheckGate("unchanged-caret", { authority });
    return;
  }
  lastCheckRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };

  // 垂直跳变 defer：光标 Y 突变 >3px → SiYuan 布局未收敛（块插入/删除后），
  // 推迟一帧等布局稳定再滚。正常打字（同行 x 变 y 不变）不触发。
  // 关键修复（3a）：defer 内清 lastCheckRect=null，让 deferred checkAndScroll 通过
  // equality check（原 bug：deferred check 被 equality check 吞掉 → 首字不滚）。
  if (prevY !== undefined && Math.abs(rect.y - prevY) > 3) {
    lastCheckRect = null;
    reportCheckGate("vertical-jump-defer", { authority, prevY, caretY: rect.y });
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

  const visibilityBypass = isCaretNearVisibilityBoundary(rect, result.editorRect);

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
      // Enter 新建空块时绕过守卫 —— 块虽空但用户需要看到它被带入舒适区；
      // caret 已处于视口边缘时同样必须放行（可见性不能被守卫吞掉）
      if (bypassEmptyBlock || visibilityBypass) {
        bypassEmptyBlock = false;
        // fall through（不 return）
      } else {
        reportCheckGate("empty-block", {
          authority,
          caret: { y: Math.round(rect.y), height: Math.round(rect.height) },
          editorTop: Math.round(result.editorRect.top),
          editorBottom: Math.round(result.editorRect.bottom),
          scrollTop: cachedContainer && cachedContainer.isConnected ? Math.round(cachedContainer.scrollTop) : null,
        });
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
  } else if (!visibilityBypass) {
    const now = Date.now();
    const sinceInput = now - lastInputAt;
    if (sinceInput < TYPING_GAP_MS) {
      const debugContainer = cachedContainer && cachedContainer.isConnected ? cachedContainer : null;
      reportCheckGate("typing-debounce", {
        authority,
        caret: { y: Math.round(rect.y), height: Math.round(rect.height) },
        editorTop: Math.round(result.editorRect.top),
        editorBottom: Math.round(result.editorRect.bottom),
        caretTopGapPx: Math.round(rect.y - result.editorRect.top),
        caretBottomGapPx: Math.round(result.editorRect.bottom - (rect.y + rect.height)),
        cursorPct: result.editorRect.bottom > result.editorRect.top
          ? Math.round(((rect.y - result.editorRect.top) / (result.editorRect.bottom - result.editorRect.top)) * 1000) / 1000
          : null,
        sinceInputMs: sinceInput,
        debounceRemainingMs: TYPING_GAP_MS - sinceInput,
        lastInputType: lastInputDebugType,
        firstCharAfterIdle,
        scrolling: scroll.isScrolling(),
        scrollTop: debugContainer ? Math.round(debugContainer.scrollTop) : null,
        maxScrollTop: debugContainer ? debugContainer.scrollHeight - debugContainer.clientHeight : null,
      });
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

  // The resolver receives the already-trusted caret/editor geometry and
  // returns an absolute endpoint. The existing scroll controller still
  // consumes a delta adapter so its motion timeline remains unchanged.
  const resolution = resolveScrollTarget({
    cursorY: rect.y,
    editorTop: result.editorRect.top,
    editorBottom: result.editorRect.bottom,
    currentScrollTop: container.scrollTop,
    maxScrollTop: container.scrollHeight - container.clientHeight,
  });

  if (__ZENTYPE_DEV__) {
    scroll.reportDebugEvent({
      name: "typewriter-scroll-resolve",
      target: container,
      caretY: rect.y,
      editorTop: result.editorRect.top,
      editorBottom: result.editorRect.bottom,
      currentScrollTop: container.scrollTop,
      maxScrollTop: container.scrollHeight - container.clientHeight,
      ...resolution,
    });
  }

  if (resolution.action === "move") {
    scroll.scrollTo(container, { deltaY: resolution.deltaY }, scheduleScrollResync);
  } else if (scroll.isScrolling()) {
    // Keep the active motion alive through a temporary hold result. Its
    // completion will schedule one fresh geometry check when requested.
    scroll.requestResync(scheduleScrollResync);
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
      const baseDur = scroll.durationForDistance(Math.abs(deltaY));
      scroll.scrollTo(container, {
        deltaY,
        easing: easeInOutCubic,
        duration: Math.round(baseDur * 1.4),
      });
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

function listStructuralIntentEditorForKey(event: KeyboardEvent): HTMLElement | null {
  if (!shouldHandleListStructuralIntentKey(event) || composing) return null;

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const anchorNode = selection.anchorNode;
  if (!anchorNode) return null;
  const selectionElement = elementFromNode(anchorNode);
  const listItem = selectionElement?.closest('[data-type="NodeListItem"]');
  return listItem?.closest(".protyle-wysiwyg") as HTMLElement | null;
}

function onStructuralEditFinish(finish: structuralEdit.StructuralEditFinish): void {
  if (!initialized) return;

  if (pendingCheck !== null) {
    cancelAnimationFrame(pendingCheck);
    pendingCheck = null;
  }
  lastCheckRect = null;
  if (!finish.stable) {
    // The coordinator could not establish an authoritative quiet window.
    // Allow the ordinary guards to decide conservatively on the next frame.
    scheduleCheck();
    return;
  }

  if (finish.kind === "enter") {
    bypassEmptyBlock = true;
    lastInputAt = 0;
  } else if (finish.kind === "backspace" && flip.hasShiftedBlocks()) {
    lastInputAt = 0;
  }

  checkAndScroll("structural");
  bypassEmptyBlock = false;
}

export function initTypewriter(): void {
  if (initialized) return;
  initialized = true;

  unsubStructuralEditFinish = structuralEdit.subscribeStructuralEditFinish(onStructuralEditFinish);

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
        if (__ZENTYPE_DEV__) lastInputDebugType = ie.inputType ?? "";
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
        if (scroll.isScrolling()) scroll.cancel();
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
        const listEditor = listStructuralIntentEditorForKey(ke);
        if (listEditor) {
          structuralEdit.beginStructuralEdit("list-change", listEditor);
          return;
        }
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
        if (editor && (ke.key === "Enter" || shouldAnimateBlockShift)) {
          structuralEdit.beginStructuralEdit(
            ke.key === "Enter" ? "enter" : "backspace",
            editor,
          );
        }
        if (editor && shouldAnimateBlockShift) {
          flip.start(editor, sel.getRangeAt(0), requestDeferredFrame);
        }
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
  if (unsubStructuralEditFinish) {
    unsubStructuralEditFinish();
    unsubStructuralEditFinish = null;
  }
  initialized = false;
  flip.reset();
  scroll.reset();
  cancelDeferredFrames();

  if (pendingCheck !== null) {
    cancelAnimationFrame(pendingCheck);
    pendingCheck = null;
  }

  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  cachedContainer = null;
  cachedCursorElement = null;
  lastCheckRect = null;
  composing = false;
  lastInputAt = 0;
  firstCharAfterIdle = false;
  bypassEmptyBlock = false;
}
