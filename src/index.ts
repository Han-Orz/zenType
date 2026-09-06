import { Plugin } from "siyuan";
import type { IProtyle, IWebSocketData } from "siyuan/types";
import { addStyle, removeStyle } from "./utils/styleManager";
import {
  initCursor,
  destroyCursor,
  onProtyleLoaded,
  onProtyleSwitched,
  onEditorContentClicked,
  onMenuOpened,
  onWsMain,
  onMobileKeyboardShow,
  onMobileKeyboardHide,
} from "./modules/cursor";
import { initTypewriter, destroyTypewriter } from "./modules/typewriter";
import { initRipple, destroyRipple } from "./modules/ripple";
import {
  initStructuralEditCoordinator,
  destroyStructuralEditCoordinator,
} from "./modules/structuralEdit";
import * as inputMode from "./modules/inputMode";
import * as inputModeTriggers from "./modules/inputModeTriggers";
import type { ModuleEnabled, ModuleName } from "./types";
import { initDebugHook } from "./modules/debugHook";
import type {
  DebugHookController,
  DebugMarkerForensicTarget,
} from "./modules/debugHook";
import { runLifecycleSteps } from "./utils/lifecycle";
import mainCss from "./styles/index.scss";

const STYLE_ID = "main";

const STORAGE_KEY = "zentype-enabled";
// Single static topbar icon — visual state (off/on) is driven by container class
// (.zentype-topbar-icon--on / --off) via SCSS descendant selectors; SVG DOM is
// never replaced post-load so SiYuan's element reference stays stable.
const ICON = `<svg class="zt-galaxy-icon" viewBox="0 0 1024 1024" width="24" height="24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><g class="zt-galaxy-art" transform="translate(0 -128)"><g class="zt-galaxy-planet zt-galaxy-planet--red"><path d="M296 456m-40 0a40 40 0 1 0 80 0 40 40 0 1 0-80 0Z" fill="#FF2E04"/></g><g class="zt-galaxy-planet zt-galaxy-planet--orange"><path d="M504 136m-40 0a40 40 0 1 0 80 0 40 40 0 1 0-80 0Z" fill="#FD7504"/></g><g class="zt-galaxy-planet zt-galaxy-planet--purple"><path d="M816 760a56 56 0 1 1-56-56 56 56 0 0 1 56 56z" fill="#D82FEA"/><path d="M707.84 780.16a56 56 0 0 1 72.32-72.32 56 56 0 0 1-72.32 72.32z" fill="#E667F9"/></g><g class="zt-galaxy-planet zt-galaxy-planet--teal"><path d="M864 408a72 72 0 1 1-72-72 72 72 0 0 1 72 72z" fill="#2DE0C7"/><path d="M727.68 440.32a72 72 0 0 1 96-96 72.16 72.16 0 0 1-96 96z" fill="#93E6D9"/></g><g class="zt-galaxy-planet zt-galaxy-planet--green"><path d="M400 768a48 48 0 1 1-48-48 48 48 0 0 1 48 48z" fill="#84E507"/><path d="M306.08 781.92a48 48 0 0 1 59.84-59.84 48 48 0 0 1-59.84 59.84z" fill="#C5EE09"/></g><path d="M616 587.52a78.88 78.88 0 0 0-64 46.72 80 80 0 0 0-80 0 78.56 78.56 0 0 0-64-46.72A78.24 78.24 0 0 0 384 512a78.24 78.24 0 0 0 24.48-75.52 78.88 78.88 0 0 0 64-46.72 80 80 0 0 0 80 0 78.88 78.88 0 0 0 64 46.72A78.24 78.24 0 0 0 640 512a78.24 78.24 0 0 0-24 75.52z" fill="#FD7504"/><path d="M592 512a80 80 0 1 1-80-80 80 80 0 0 1 80 80z" fill="#FDA736"/><path d="M441.76 550.24a80 80 0 0 1 108.48-108.48 80 80 0 0 1-108.48 108.48z" fill="#FED370"/><path d="M512 608c-24.64 0-67.2-12.32-53.92-34.88a16 16 0 0 1 21.92-5.76 64 64 0 1 0-29.92-40.32 16 16 0 0 1-31.04 8A96 96 0 1 1 512 608zM294.08 411.36A240.96 240.96 0 0 1 512 272a16 16 0 0 1 0 32 208 208 0 0 0-188.8 120.8 16 16 0 0 1-29.12-13.44zM272 512v-18.08a16 16 0 0 1 32 2.88V512a16 16 0 0 1-32 0zM512 752a16 16 0 0 1 0-32 208 208 0 0 0 208-208 16 16 0 0 1 32 0 240 240 0 0 1-240 240zM312.32 756.96c-16 0-90.72-75.36-112.96-176a16 16 0 0 1 32-6.88 288 288 0 0 0 92.16 154.88 16 16 0 0 1-11.2 28zM192 528.8v-16a16 16 0 0 1 32 0v16a16 16 0 0 1-32 0zM512 832a314.4 314.4 0 0 1-124.64-25.28 16 16 0 0 1-8.48-20.96c11.84-28 35.84 14.24 133.12 14.24a16 16 0 0 1 0 32zM800 512a276.8 276.8 0 0 0-1.92-33.44 16 16 0 0 1 32-3.84A305.12 305.12 0 0 1 832 512a16 16 0 0 1-32 0zM750.4 350.72a288 288 0 0 0-132.16-106.4 16 16 0 0 1 11.84-29.76 320 320 0 0 1 146.88 118.24 16 16 0 0 1-26.56 17.92zM577.76 231.2c-4.16 0-4.32-1.12-20.32-3.68a16 16 0 0 1 4.96-32c6.4 0.96 12.64 2.08 18.72 3.52a16 16 0 0 1-3.36 32.16zM209.28 250.56A399.04 399.04 0 0 1 462.4 115.2a16 16 0 0 1 3.84 32A368 368 0 0 0 233.44 272a16 16 0 0 1-24.16-21.44zM117.28 448a394.88 394.88 0 0 1 57.6-150.56 16 16 0 0 1 22.08-4.8c27.04 17.28-28.8 41.44-48 160A16 16 0 0 1 117.28 448zM112 512v-16a16 16 0 0 1 32 1.28v14.4A16 16 0 0 1 112 512z" fill="#35214C"/><path d="M677.12 496.8a45.6 45.6 0 0 1-22.56-69.6 16 16 0 0 0-17.92-24.48 45.92 45.92 0 0 1-59.2-43.2 16 16 0 0 0-28.8-9.28 45.92 45.92 0 0 1-73.28 0 16 16 0 0 0-28.8 9.28 45.76 45.76 0 0 1-59.2 43.2 16 16 0 0 0-17.92 24.48 45.76 45.76 0 0 1-22.56 69.6 16 16 0 0 0 0 30.4 45.6 45.6 0 0 1 22.56 69.6 16 16 0 0 0 17.92 24.48 45.76 45.76 0 0 1 59.2 43.2 16 16 0 0 0 28.8 9.28 45.92 45.92 0 0 1 73.28 0 16 16 0 0 0 17.76 5.6c20-6.4 1.28-30.56 29.92-51.36s45.6 4.48 58.08-12.48-17.12-25.76-5.92-59.2S688 533.6 688 512a16 16 0 0 0-10.88-15.2z m-61.12 90.72a78.88 78.88 0 0 0-64 46.72 80 80 0 0 0-80 0 78.56 78.56 0 0 0-64-46.72A78.24 78.24 0 0 0 384 512a78.24 78.24 0 0 0 24.48-75.52 78.88 78.88 0 0 0 64-46.72 80 80 0 0 0 80 0 78.88 78.88 0 0 0 64 46.72A78.24 78.24 0 0 0 640 512a78.24 78.24 0 0 0-24 75.52zM504 192A56 56 0 1 1 560 136a56 56 0 0 1-56 56z m0-80a24 24 0 0 0 0 48 24 24 0 0 0 0-48zM792 496a88 88 0 1 1 14.24-174.88 16 16 0 0 1-5.12 32 56 56 0 1 0 40.16 28.48 16 16 0 0 1 28.16-15.04A88 88 0 0 1 792 496z" fill="#35214C"/><path d="M296 512a56 56 0 1 1 56-56 56 56 0 0 1-56 56z m0-80a24 24 0 0 0 0 48 24 24 0 0 0 0-48zM512 880a16 16 0 0 1 0-32h14.72a16 16 0 0 1 1.28 32zM574.08 874.56a16 16 0 0 1-2.72-32A334.56 334.56 0 0 0 708.8 784a16 16 0 0 1 18.88 25.92c-57.44 41.76-132 64.64-153.6 64.64zM816 656a326.4 326.4 0 0 0 28.96-96 16 16 0 0 1 32 4.48 361.76 361.76 0 0 1-32 105.28A16 16 0 0 1 816 656z" fill="#35214C"/><path d="M760 832a72 72 0 1 1 72-72 72.16 72.16 0 0 1-72 72z m0-112a40 40 0 1 0 40 40 40 40 0 0 0-40-40zM144 624a48 48 0 1 0 48 48 48 48 0 0 0-48-48z m0 64a16 16 0 0 1 0-32 16 16 0 0 1 0 32z" fill="#35214C"/><path d="M160 672a16 16 0 0 1-32 0 16 16 0 0 1 32 0z" fill="#898EC9"/><path d="M728 128a40 40 0 1 0 40 40A40 40 0 0 0 728 128z m0 48a8 8 0 0 1 0-16 8 8 0 0 1 0 16z" fill="#35214C"/><path d="M736 168a8 8 0 0 1-16 0 8 8 0 0 1 16 0z" fill="#69CC00"/><path d="M352 832a64 64 0 1 1 64-64 64 64 0 0 1-64 64z m0-96a32 32 0 1 0 32 32 32 32 0 0 0-32-32zM416 944a32 32 0 1 1 32-32 32 32 0 0 1-32 32z m0-32z m0 0z m0 0z m0 0z m0 0z m0 0z m0 0z m0 0z" fill="#35214C"/></g></svg>`;

function selectionAnchorElement(): Element | null {
  if (typeof window === "undefined" || typeof window.getSelection !== "function") return null;
  const anchor = window.getSelection()?.anchorNode;
  if (!anchor) return null;
  if (anchor.nodeType === 1) return anchor as Element;
  return (anchor as Node & { parentElement?: Element | null }).parentElement ?? null;
}

function resolveMarkerForensicTarget(): DebugMarkerForensicTarget | null {
  try {
    const currentItem = selectionAnchorElement()?.closest('[data-type="NodeListItem"]') ?? null;
    const currentId = currentItem?.getAttribute("data-node-id");
    if (!currentItem || !currentId) return null;

    const previous = currentItem.previousElementSibling;
    const suspectItem = previous?.matches('[data-type="NodeListItem"]')
      ? previous
      : previous
        ? null
        : currentItem.parentElement?.closest('[data-type="NodeListItem"]') ?? null;
    const suspectId = suspectItem?.getAttribute("data-node-id");
    if (!suspectItem || !suspectId) return null;
    return {
      currentElement: currentItem,
      currentNodeId: currentId,
      suspectElement: suspectItem,
      suspectNodeId: suspectId,
    };
  } catch {
    return null;
  }
}

export default class ZenType extends Plugin {
  private enabled: ModuleEnabled = {
    cursor: true,
    typewriter: true,
    ripple: true,
  };

  // P2: 集中管理 EventBus 退订函数，onunload 时统一释放，避免内存泄漏
  private eventBusOffFns: Array<() => void> = [];

  // 顶栏图标容器引用，供 updateTopBarIcon() 切换 --on / --off class
  private topBarItem: HTMLElement | null = null;
  private saveEnabledPromise: Promise<unknown> = Promise.resolve();
  private debugHook: DebugHookController | null = null;

  async onload(): Promise<void> {
    try {
      await this.loadPlugin();
    } catch (error) {
      this.cleanupResources();
      console.error("[zenType] failed to load:", error);
      throw error;
    }
  }

  private async loadPlugin(): Promise<void> {
    const saved = await this.loadData(STORAGE_KEY);
    if (saved && typeof saved === "object") {
      this.enabled = { ...this.enabled, ...(saved as Partial<ModuleEnabled>) };
    }
    // v2.3.0 起 cursor 常开；旧存储中的 cursor=false 不能阻断光标事件回调。
    this.enabled.cursor = true;

    // 共享样式一次性注入（光标、打字机高亮条都依赖 index.scss，
    // 之前由 cursor.ts / typewriter.ts 各自 import 同一份 SCSS，
    // esbuild 共享字符串常量但 addStyle 仍会创建两个完全相同的 <style> 标签）
    addStyle(STYLE_ID, mainCss);

    this.addCommand({
      langKey: "toggle-typewriter",
      langText: "切换打字机",
      callback: () => this.toggle("typewriter"),
    });
    this.addCommand({
      langKey: "toggle-ripple",
      langText: "切换涟漪",
      callback: () => this.toggle("ripple"),
    });
    this.addCommand({
      langKey: "toggle-type",
      langText: "切换联合（打字机+涟漪）",
      hotkey: "⌃⌥Z",
      callback: () => this.toggleType(),
    });
    if (__ZENTYPE_DEV__) {
      this.addCommand({
        langKey: "start-debug-marker-frame",
        langText: "zenType：开始 Marker 逐帧取证",
        callback: () => { void this.startMarkerFrameCapture(); },
      });
      this.addCommand({
        langKey: "mark-debug-marker-flicker",
        langText: "zenType：标记刚才发生闪烁",
        callback: () => this.markMarkerFlickerObserved(),
      });
      this.addCommand({
        langKey: "toggle-debug-hook",
        langText: "zenType：开始/停止通用 Debug Session",
        callback: () => { void this.debugHook?.toggle(); },
      });
      this.addCommand({
        langKey: "stop-debug-capture",
        langText: "zenType：结束 Debug 取证",
        callback: () => { void this.stopDebugCapture(); },
      });
      this.addCommand({
        langKey: "capture-debug-hook",
        langText: "zenType：捕获 Debug 快照",
        callback: () => this.debugHook?.capture("command"),
      });
    }

    const allOn = this.isAllEnabled();
    this.topBarItem = this.addTopBar({
      icon: ICON,
      title: allOn ? "zenType · 聚焦/打字机：开" : "zenType · 聚焦/打字机：关",
      callback: () => this.toggleType(),
    });
    // 容器 class 互斥初始化：off → --off, on → --on
    if (this.topBarItem) {
      this.topBarItem.classList.add(
        allOn ? "zentype-topbar-icon--on" : "zentype-topbar-icon--off",
      );
    }

    // === EventBus 订阅 ===
    // 所有 8 个事件都按 (on, off) 配对记录到 eventBusOffFns，onunload 时统一释放
    const { eventBus } = this;

    // 1) loaded-protyle-static：新编辑器加载（首次打开文档 / 静态分屏）
    const onLoadedStatic = (e: CustomEvent<{ protyle: IProtyle }>) => {
      if (!this.enabled.cursor) return;
      onProtyleLoaded(e.detail.protyle);
    };
    eventBus.on("loaded-protyle-static", onLoadedStatic);
    this.eventBusOffFns.push(() =>
      eventBus.off("loaded-protyle-static", onLoadedStatic),
    );

    // 2) loaded-protyle-dynamic：动态编辑器（悬浮窗 / 嵌入块 / 链接跳转）
    const onLoadedDynamic = (e: CustomEvent<{ protyle: IProtyle; position: "afterend" | "beforebegin" }>) => {
      if (!this.enabled.cursor) return;
      onProtyleLoaded(e.detail.protyle);
    };
    eventBus.on("loaded-protyle-dynamic", onLoadedDynamic);
    this.eventBusOffFns.push(() =>
      eventBus.off("loaded-protyle-dynamic", onLoadedDynamic),
    );

    // 3) switch-protyle：切 Tab → 光标更新 + 聚焦/打字机模式退出
    const onSwitched = (e: CustomEvent<{ protyle: IProtyle }>) => {
      if (!this.enabled.cursor) return;
      inputModeTriggers.onSwitchProtyle();
      onProtyleSwitched(e.detail.protyle);
    };
    eventBus.on("switch-protyle", onSwitched);
    this.eventBusOffFns.push(() =>
      eventBus.off("switch-protyle", onSwitched),
    );

    // 4) click-editorcontent：用户在编辑器内点击 → 替代 firstProtyleIds 白名单
    const onClickEditorContent = (e: CustomEvent<{ protyle: IProtyle; event: MouseEvent }>) => {
      if (!this.enabled.cursor) return;
      onEditorContentClicked(e.detail.protyle);
    };
    eventBus.on("click-editorcontent", onClickEditorContent);
    this.eventBusOffFns.push(() =>
      eventBus.off("click-editorcontent", onClickEditorContent),
    );

    // 5) open-menu-content：右键菜单弹出 → 立即隐藏光标
    const onMenuOpenedHandler = () => {
      if (!this.enabled.cursor) return;
      onMenuOpened();
    };
    eventBus.on("open-menu-content", onMenuOpenedHandler);
    this.eventBusOffFns.push(() =>
      eventBus.off("open-menu-content", onMenuOpenedHandler),
    );

    // 6) ws-main：替代手动 WS 监听（思源内核已自动 JSON.parse）
    const onWsMainHandler = (e: CustomEvent<IWebSocketData>) => {
      if (!this.enabled.cursor) return;
      onWsMain(e.detail);
    };
    eventBus.on("ws-main", onWsMainHandler);
    this.eventBusOffFns.push(() =>
      eventBus.off("ws-main", onWsMainHandler),
    );

    // 7) mobile-keyboard-show
    const onKeyboardShow = () => {
      if (!this.enabled.cursor) return;
      onMobileKeyboardShow();
    };
    eventBus.on("mobile-keyboard-show", onKeyboardShow);
    this.eventBusOffFns.push(() =>
      eventBus.off("mobile-keyboard-show", onKeyboardShow),
    );

    // 8) mobile-keyboard-hide
    const onKeyboardHide = () => {
      if (!this.enabled.cursor) return;
      onMobileKeyboardHide();
    };
    eventBus.on("mobile-keyboard-hide", onKeyboardHide);
    this.eventBusOffFns.push(() =>
    eventBus.off("mobile-keyboard-hide", onKeyboardHide),
    );

    // 开发版调试钩子：采集器自己管理 DOM/EventBus 监听，统一纳入卸载清理。
    if (__ZENTYPE_DEV__) {
      this.debugHook = initDebugHook(eventBus);
    }

    // === 模块初始化（与 P0 / round-3 相同） ===
    // v2.3.0：cursor 始终初始化（光标常开），不再受 STORAGE_KEY 中 cursor 字段影响
    initStructuralEditCoordinator();
    initCursor();
    if (this.enabled.typewriter) initTypewriter();
    if (this.enabled.ripple) initRipple();

    console.log("zenType loaded");
  }

  onunload(): void {
    this.cleanupResources();
    console.log("zenType unloaded");
  }

  private cleanupResources(): void {
    const eventBusOffFns = this.eventBusOffFns;
    this.eventBusOffFns = [];

    runLifecycleSteps([
      { name: "debugHook.destroy", run: () => {
        this.debugHook?.destroy();
        this.debugHook = null;
      } },
      ...eventBusOffFns.map((off, index) => ({
        name: `eventBus.off#${index + 1}`,
        run: off,
      })),
      { name: "destroyCursor", run: destroyCursor },
      { name: "destroyTypewriter", run: destroyTypewriter },
      { name: "destroyRipple", run: destroyRipple },
      { name: "destroyStructuralEditCoordinator", run: destroyStructuralEditCoordinator },
      { name: "inputMode.reset", run: () => inputMode.reset() },
      { name: "removeStyle", run: () => removeStyle(STYLE_ID) },
    ], (name, error) => {
      console.error(`[zenType] lifecycle cleanup failed in ${name}:`, error);
    });

    this.topBarItem = null;
  }

  // 方案 γ：容器 class 互斥 toggle + aria-label 更新；永不修改 SVG 内部 DOM
  private updateTopBarIcon(): void {
    if (!this.topBarItem) return;
    const allOn = this.isAllEnabled();
    if (allOn) {
      this.topBarItem.classList.add("zentype-topbar-icon--on");
      this.topBarItem.classList.remove("zentype-topbar-icon--off");
    } else {
      this.topBarItem.classList.add("zentype-topbar-icon--off");
      this.topBarItem.classList.remove("zentype-topbar-icon--on");
    }
    this.topBarItem.setAttribute(
      "aria-label",
      allOn ? "zenType · 聚焦/打字机：开" : "zenType · 聚焦/打字机：关",
    );
  }

  private async startMarkerFrameCapture(): Promise<void> {
    const debug = this.debugHook;
    if (!debug) return;
    if (debug.getState().active) await debug.stop();
    debug.clearWatches();

    await debug.start("marker-frame", {
      profile: "forensic",
      frameBurst: {
        enabled: true,
        frames: 18,
      },
      markerForensic: {
        enabled: true,
        resolveTarget: () => resolveMarkerForensicTarget(),
      },
    });
    console.info(`[zenType DebugKit] marker frame capture started · build ${debug.getState().buildSha ?? "unknown"}`);
  }

  private markMarkerFlickerObserved(): void {
    const debug = this.debugHook;
    const state = debug?.getState();
    if (!debug || !state?.active || state.label !== "marker-frame" || !state.latestBurstId) {
      console.warn("[zenType DebugKit] no marker burst is available to mark");
      return;
    }
    debug.mark("marker-flicker-observed", {
      latestBurstId: state.latestBurstId,
    });
  }

  private async stopDebugCapture(): Promise<void> {
    const debug = this.debugHook;
    if (!debug) return;
    await debug.stop();
    debug.clearWatches();
    console.info("[zenType DebugKit] capture stopped");
  }

  private toggle(name: ModuleName): void {
    this.enabled[name] = !this.enabled[name];

    if (name === "typewriter") {
      if (this.enabled.typewriter) initTypewriter();
      else destroyTypewriter();
    } else if (name === "ripple") {
      if (this.enabled.ripple) initRipple();
      else destroyRipple();
    }

    this.saveEnabledState();
    this.updateTopBarIcon();
  }

  private toggleType(): void {
    const allOn = this.isAllEnabled();
    const newState = !allOn;

    // v2.3.0：toggleType 不再 touch cursor（光标常开 spec）

    if (newState && !this.enabled.typewriter) {
      this.enabled.typewriter = true;
      initTypewriter();
    } else if (!newState && this.enabled.typewriter) {
      this.enabled.typewriter = false;
      destroyTypewriter();
    }

    if (newState && !this.enabled.ripple) {
      this.enabled.ripple = true;
      initRipple();
    } else if (!newState && this.enabled.ripple) {
      this.enabled.ripple = false;
      destroyRipple();
    }

    this.saveEnabledState();
    this.updateTopBarIcon();
  }

  private isAllEnabled(): boolean {
    // v2.3.0：语义改为"typewriter + ripple 两者都开"，不再 include cursor
    return this.enabled.typewriter && this.enabled.ripple;
  }

  private saveEnabledState(): void {
    const snapshot = { ...this.enabled };
    this.saveEnabledPromise = this.saveEnabledPromise
      .catch(() => undefined)
      .then(() => this.saveData(STORAGE_KEY, snapshot))
      .catch((err) => {
        console.error("[zenType] failed to save enabled state:", err);
      });
  }
}
