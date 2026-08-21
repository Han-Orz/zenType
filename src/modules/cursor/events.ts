export interface CursorEventContext {
  markKeyboardPending: () => void;
  onScrollOrWheel: () => void;
  queueUpdate: () => void;
}

interface MouseDownInfo {
  selectionText: string;
}

let isPasting = false;
let mouseDownInfo: MouseDownInfo | null = null;
let eventListeners: Array<[string, EventListener, AddEventListenerOptions?]> = [];

import * as inputModeTriggers from "../inputModeTriggers";

/** 绑定 document 上的光标相关事件（passive 提升滚动性能） */
export function bindCursorDocumentEvents(context: CursorEventContext): void {
  // 聚焦/打字机模式：wheel/touchmove 退出处理（不涉及 scroll，避免程序滚动误退出）
  const onWheelExit: EventListener = () => {
    inputModeTriggers.onWheelOrTouchMove();
    context.onScrollOrWheel();
  };

  // 聚焦/打字机模式：鼠标拖蓝检测（mouseup 时比对比 selection 变化）
  const onMouseUpWithDragCheck: EventListener = () => {
    if (mouseDownInfo) {
      const currentSel = window.getSelection()?.toString() ?? "";
      if (currentSel !== mouseDownInfo.selectionText && currentSel.length > 0) {
        inputModeTriggers.onDragSelection();
      }
      mouseDownInfo = null;
    }
    context.queueUpdate();
  };

  // DOM 事件绑定（passive 提升滚动性能）
  // round 3：移除三阶段 throttle（200/400/600ms），改用 keydown/input 配 rAF 包裹。
  // compositionend + input 已覆盖 IME / 自动换行延迟场景。
  const handlers: Array<[string, EventListener, AddEventListenerOptions?]> = [
    ["selectionchange", context.queueUpdate],
    // keydown + input 用 rAF 包裹（参考版做法），替代三阶段 throttle
    // round 4 fix：先 set flag，由 300ms 冷却计时器清零；
    // 让 Enter 触发的 scroll/ResizeObserver 知道本次更新是键盘驱动，不加 .no-transition
    // 聚焦/打字机模式：↑↓/PageUp/PageDown 退出；←→/Home/End/Escape 保持
    // round 4 fix（capture + cooldown）：capture 阶段先于 SiYuan handler 跑，
    // markKeyboardPending 启动 300ms 倒计时，期间 scroll/ResizeObserver 不加 .no-transition
    ["keydown", (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === "Enter" || ke.key === "Backspace") {
        inputModeTriggers.onEnterOrBackspaceEdit();
      }
      if (ke.key === "ArrowUp" || ke.key === "ArrowDown" ||
          ke.key === "PageUp" || ke.key === "PageDown") {
        inputModeTriggers.onVerticalNavigationKey();
      }
      context.markKeyboardPending(); requestAnimationFrame(context.queueUpdate);
    }, { capture: true }],
    // 聚焦/打字机模式：输入事件开启（粘贴时跳过）
    ["input", () => {
      if (!isPasting) inputModeTriggers.onTextInput();
      isPasting = false;
      context.markKeyboardPending(); requestAnimationFrame(context.queueUpdate);
    }, { capture: true }],
    // mouseup：已有 cursor 更新 + 拖蓝检测
    ["mouseup", onMouseUpWithDragCheck],
    // 聚焦/打字机模式：鼠标点击退出
    ["click", () => {
      inputModeTriggers.onMouseClick();
      context.queueUpdate();
    }],
    [
      "scroll",
      context.onScrollOrWheel as EventListener,
      { capture: true, passive: true },
    ],
    // 聚焦/打字机模式：wheel/touchmove 退出（capture 阶段，与 scroll/keydown/input 一致；
    //  避免思源 scroll 容器内部 stopPropagation 拦截 bubble 末端 handler）
    ["wheel", onWheelExit, { capture: true, passive: true }],
    ["touchmove", onWheelExit, { capture: true, passive: true }],
    // 聚焦/打字机模式：IME 完成开启
    ["compositionend", () => {
      inputModeTriggers.onCompositionEnd();
      context.queueUpdate();
    }],
    // resize 时刷新（思源侧边栏拖动会触发）
    ["resize", context.queueUpdate, { passive: true }],
    // 聚焦/打字机模式：粘贴标记（跳过 input 开启）
    ["paste", () => { isPasting = true; }],
    // 聚焦/打字机模式：拖蓝起点记录
    ["mousedown", () => {
      mouseDownInfo = { selectionText: window.getSelection()?.toString() ?? "" };
    }],
    // 聚焦/打字机模式：失焦退出
    ["blur", () => { inputModeTriggers.onBlur(); }],
  ];

  handlers.forEach(([event, handler, options]) => {
    document.addEventListener(event, handler, options);
  });
  eventListeners = handlers;
}

export function destroyCursorDocumentEvents(): void {
  eventListeners.forEach(([event, handler, options]) => {
    document.removeEventListener(event, handler, options);
  });
  eventListeners = [];
  isPasting = false;
  mouseDownInfo = null;
}
