import { findAllScrollableAncestors } from "../../utils/scroll";
import {
  shouldUseManualScrollPolicy,
  type CursorScrollSource,
} from "./events";

interface ScrollEventBinding {
  el: HTMLElement;
  handler: EventListener;
}

export interface ScrollBindingContext {
  getCursorElement: () => HTMLElement | null;
  isKeyboardUpdatePending: () => boolean;
  isOwnedScrollTarget: (target: EventTarget | null) => boolean;
  pauseBreathe: () => void;
  queueUpdate: () => void;
}

const scrollEventBindings: ScrollEventBinding[] = [];
let lastScrollBindingCursorElement: Element | null = null;

/** 嵌套滚动容器：给所有可滚动祖先绑 scroll/wheel 监听（passive） */
export function bindScrollContainerEvents(
  cursorElement: Element | null,
  context: ScrollBindingContext,
): void {
  if (!cursorElement) return;
  if (
    cursorElement === lastScrollBindingCursorElement &&
    scrollEventBindings.length > 0 &&
    scrollEventBindings.every(({ el }) => el.isConnected)
  ) {
    return;
  }
  lastScrollBindingCursorElement = cursorElement;

  const scrollEls = findAllScrollableAncestors(cursorElement);
  const currentSet = new Set(scrollEls);

  // 清理已绑定但不再属于当前祖先链的元素（Tab 切换 / DOM 重建后旧容器脱离）
  for (let i = scrollEventBindings.length - 1; i >= 0; i--) {
    const { el } = scrollEventBindings[i];
    if (!currentSet.has(el)) {
      if ((el as any).__zentypeScrollBound) {
        delete (el as any).__zentypeScrollBound;
      }
      const [binding] = scrollEventBindings.splice(i, 1);
      binding.el.removeEventListener("scroll", binding.handler);
      binding.el.removeEventListener("wheel", binding.handler);
    }
  }

  scrollEls.forEach((scrollEl) => {
    if ((scrollEl as any).__zentypeScrollBound) return;
    (scrollEl as any).__zentypeScrollBound = true;

    const handler: EventListener = (event) => {
      const cursorEl = context.getCursorElement();
      if (!cursorEl) return;
      context.pauseBreathe();
      // round 4 fix：键盘触发的嵌套滚动容器滚动（如 Enter 自动滚屏）保留过渡动画
      const source: CursorScrollSource = event.type === "scroll" ? "scroll" : "manual-input";
      const ownedScroll = source === "scroll" && context.isOwnedScrollTarget(event.target);
      if (shouldUseManualScrollPolicy(
        source,
        context.isKeyboardUpdatePending(),
        ownedScroll,
      )) {
        cursorEl.classList.add("no-transition");
        cursorEl.classList.add("no-animation");
      }
      context.queueUpdate();
    };

    scrollEl.addEventListener("scroll", handler, { passive: true });
    scrollEl.addEventListener("wheel", handler, { passive: true });

    scrollEventBindings.push({ el: scrollEl, handler });
  });
}

export function destroyScrollContainerEvents(): void {
  scrollEventBindings.forEach(({ el, handler }) => {
    el.removeEventListener("scroll", handler);
    el.removeEventListener("wheel", handler);
    delete (el as any).__zentypeScrollBound;
  });
  scrollEventBindings.length = 0;
  lastScrollBindingCursorElement = null;
}
