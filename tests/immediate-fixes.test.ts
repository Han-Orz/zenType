import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  claimInlineStyle,
  restoreOwnedInlineStyle,
  setOwnedInlineStyle,
} from "../src/utils/inlineStyleOwnership";
import {
  activateNativeCaretOwner,
  CUSTOM_CARET_OWNER_CLASS,
  restoreNativeCaretOwner,
} from "../src/utils/caretVisibility";
import { resolveRangeTextPoint } from "../src/utils/rangeTextPoint";
import { destroyRipple } from "../src/modules/ripple";
import { initRipple } from "../src/modules/ripple";
import * as inputMode from "../src/modules/inputMode";
import { RIPPLE_CONFIG } from "../src/config";
import { bindCursorDocumentEvents, destroyCursorDocumentEvents } from "../src/modules/cursor/events";
import {
  shouldCancelPendingScrollForReducedMotion,
  shouldHandleTypewriterEditKey,
} from "../src/modules/typewriter";
import { prefersReducedMotion } from "../src/utils/reducedMotion";
import { setActiveEditor } from "siyuan";

type FakeNode = {
  nodeType: number;
  childNodes: FakeNode[];
  data?: string;
};

function text(data: string): Text {
  return { nodeType: 3, childNodes: [], data } as unknown as Text;
}

function element(...children: FakeNode[]): Node {
  return { nodeType: 1, childNodes: children } as unknown as Node;
}

test("Range element endpoint at childNodes.length resolves to the final text offset", () => {
  const lastText = text("abc");
  const root = element(lastText);

  const resolved = resolveRangeTextPoint(root, 1);

  assert.equal(resolved?.textNode, lastText);
  assert.equal(resolved?.offset, 3);
});

test("Range element endpoint at offset zero resolves to the first nested text offset", () => {
  const firstText = text("abc");
  const root = element(element(firstText), text("tail"));

  const resolved = resolveRangeTextPoint(root, 0);

  assert.equal(resolved?.textNode, firstText);
  assert.equal(resolved?.offset, 0);
});

test("Range element midpoint and empty text placeholders preserve the nearest boundary", () => {
  const nestedText = text("bc");
  const finalText = text("d");
  const root = element(text("a"), element(nestedText), finalText);

  const midpoint = resolveRangeTextPoint(root, 1);
  assert.equal(midpoint?.textNode, nestedText);
  assert.equal(midpoint?.offset, 0);

  const beforeFinal = resolveRangeTextPoint(root, 2);
  assert.equal(beforeFinal?.textNode, finalText);
  assert.equal(beforeFinal?.offset, 0);

  const withEmpty = element(text(""), element(text("x")), text(""));
  const afterEmpty = resolveRangeTextPoint(withEmpty, 0);
  assert.equal(afterEmpty?.offset, 0);
  assert.equal(afterEmpty?.textNode.data, "x");
});

class FakeStyle {
  private readonly values = new Map<string, { value: string; priority: string }>();

  getPropertyValue(property: string): string {
    return this.values.get(property)?.value ?? "";
  }

  getPropertyPriority(property: string): string {
    return this.values.get(property)?.priority ?? "";
  }

  setProperty(property: string, value: string, priority = ""): void {
    if (value === "") {
      this.values.delete(property);
      return;
    }
    this.values.set(property, { value, priority });
  }
}

function style(): CSSStyleDeclaration {
  return new FakeStyle() as unknown as CSSStyleDeclaration;
}

test("ripple/typewriter ownership restores original inline values and leaves external changes alone", () => {
  // Ripple owns only its private custom property; typewriter may own the
  // generic transition independently. Clearing ripple must not resurrect a
  // transition value captured by typewriter.
  const sharedStyle = style();
  sharedStyle.setProperty("--zt-ripple-opacity", "host-opacity", "important");
  sharedStyle.setProperty("transition", "color 1s ease");
  const rippleOwned = claimInlineStyle(sharedStyle, ["--zt-ripple-opacity"]);
  assert.equal(
    setOwnedInlineStyle(sharedStyle, rippleOwned, "--zt-ripple-opacity", "0.4"),
    true,
  );
  const flipOwned = claimInlineStyle(sharedStyle, ["transform", "transition"]);
  assert.equal(
    setOwnedInlineStyle(sharedStyle, flipOwned, "transform", "translateY(-12px)"),
    true,
  );
  assert.equal(
    setOwnedInlineStyle(sharedStyle, flipOwned, "transition", "none"),
    true,
  );
  restoreOwnedInlineStyle(sharedStyle, rippleOwned);
  restoreOwnedInlineStyle(sharedStyle, flipOwned);
  assert.equal(sharedStyle.getPropertyValue("--zt-ripple-opacity"), "host-opacity");
  assert.equal(sharedStyle.getPropertyPriority("--zt-ripple-opacity"), "important");
  assert.equal(sharedStyle.getPropertyValue("transition"), "color 1s ease");

  const rippleStyle = style();
  rippleStyle.setProperty("opacity", "0.72", "important");
  rippleStyle.setProperty("transition", "color 1s ease");
  const rippleStyleOwned = claimInlineStyle(rippleStyle, ["opacity", "transition"]);
  setOwnedInlineStyle(rippleStyle, rippleStyleOwned, "opacity", "0.2");
  setOwnedInlineStyle(rippleStyle, rippleStyleOwned, "transition", "opacity 200ms ease");
  restoreOwnedInlineStyle(rippleStyle, rippleStyleOwned);
  assert.equal(rippleStyle.getPropertyValue("opacity"), "0.72");
  assert.equal(rippleStyle.getPropertyPriority("opacity"), "important");
  assert.equal(rippleStyle.getPropertyValue("transition"), "color 1s ease");

  const typewriterStyle = style();
  typewriterStyle.setProperty("transform", "scale(1.1)");
  typewriterStyle.setProperty("transition", "opacity 400ms ease");
  const typewriterOwned = claimInlineStyle(typewriterStyle, ["transform", "transition"]);
  setOwnedInlineStyle(typewriterStyle, typewriterOwned, "transform", "translateY(-12px)");
  setOwnedInlineStyle(typewriterStyle, typewriterOwned, "transition", "none");
  restoreOwnedInlineStyle(typewriterStyle, typewriterOwned);
  assert.equal(typewriterStyle.getPropertyValue("transform"), "scale(1.1)");
  assert.equal(typewriterStyle.getPropertyValue("transition"), "opacity 400ms ease");

  const externalChange = style();
  externalChange.setProperty("opacity", "0.9");
  const externalOwned = claimInlineStyle(externalChange, ["opacity"]);
  assert.equal(setOwnedInlineStyle(externalChange, externalOwned, "opacity", "0.2"), true);
  externalChange.setProperty("opacity", "0.4");
  assert.equal(setOwnedInlineStyle(externalChange, externalOwned, "opacity", "0.3"), false);
  assert.equal(externalChange.getPropertyValue("opacity"), "0.4");
  restoreOwnedInlineStyle(externalChange, externalOwned);
  assert.equal(externalChange.getPropertyValue("opacity"), "0.4");
});

function fakeCaretElement(owner: HTMLElement | null): Element {
  return {
    closest: (selector: string) => selector.includes("contenteditable='false'")
      || selector.includes("[readonly]")
      || selector.includes("[aria-readonly='true']")
      ? null
      : owner,
  } as unknown as Element;
}

interface CaretClassCounts {
  add: number;
  remove: number;
}

function fakeOwner(readOnly = false, counts: CaretClassCounts = { add: 0, remove: 0 }): HTMLElement {
  const classes = new Set<string>();
  return {
    classList: {
      add: (name: string) => { counts.add++; classes.add(name); },
      remove: (name: string) => { counts.remove++; classes.delete(name); },
      contains: (name: string) => classes.has(name),
    },
    getAttribute: (name: string) => name === "contenteditable" && readOnly ? "false" : null,
    hasAttribute: (name: string) => readOnly && name === "readonly",
  } as unknown as HTMLElement;
}

test("caret visibility restores native caret on unsupported owner/fallback", () => {
  const owner = fakeOwner();
  const active = activateNativeCaretOwner(null, fakeCaretElement(owner));
  assert.equal(active, owner);
  assert.equal(owner.classList.contains(CUSTOM_CARET_OWNER_CLASS), true);

  const failed = activateNativeCaretOwner(active, fakeCaretElement(null));
  assert.equal(failed, null);
  assert.equal(owner.classList.contains(CUSTOM_CARET_OWNER_CLASS), false);
  assert.equal(restoreNativeCaretOwner(failed), null);

  const readOnly = fakeOwner(true);
  assert.equal(activateNativeCaretOwner(null, fakeCaretElement(readOnly)), null);
  assert.equal(readOnly.classList.contains(CUSTOM_CARET_OWNER_CLASS), false);
});

test("caret owner activation is idempotent for the same owner", () => {
  const firstCounts = { add: 0, remove: 0 };
  const secondCounts = { add: 0, remove: 0 };
  const first = fakeOwner(false, firstCounts);
  const second = fakeOwner(false, secondCounts);

  let active = activateNativeCaretOwner(null, fakeCaretElement(first));
  assert.equal(active, first);
  assert.deepEqual(firstCounts, { add: 1, remove: 0 });

  active = activateNativeCaretOwner(active, fakeCaretElement(first));
  assert.equal(active, first);
  assert.deepEqual(firstCounts, { add: 1, remove: 0 });

  first.classList.remove(CUSTOM_CARET_OWNER_CLASS);
  firstCounts.remove = 0;
  active = activateNativeCaretOwner(active, fakeCaretElement(first));
  assert.equal(active, first);
  assert.deepEqual(firstCounts, { add: 2, remove: 0 });

  active = activateNativeCaretOwner(active, fakeCaretElement(second));
  assert.equal(active, second);
  assert.deepEqual(firstCounts, { add: 2, remove: 1 });
  assert.deepEqual(secondCounts, { add: 1, remove: 0 });

  active = activateNativeCaretOwner(active, fakeCaretElement(null));
  assert.equal(active, null);
  assert.deepEqual(secondCounts, { add: 1, remove: 1 });
});

class FakeEventTarget {
  private readonly listeners = new Map<string, EventListener[]>();

  addEventListener(event: string, listener: EventListener): void {
    const current = this.listeners.get(event) ?? [];
    current.push(listener);
    this.listeners.set(event, current);
  }

  removeEventListener(event: string, listener: EventListener): void {
    const current = this.listeners.get(event) ?? [];
    this.listeners.set(event, current.filter((candidate) => candidate !== listener));
  }

  dispatch(event: string, init: Record<string, unknown> = {}): void {
    const eventObject = {
      target: this,
      composedPath: () => [this],
      ...init,
    } as unknown as Event;
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(eventObject);
  }
}

function scopedEventNode(
  parent: any,
  kind: "editable" | "readonly" | "external",
): any {
  const classNames = new Set(kind === "editable" ? ["protyle-title__input"] : []);
  const node = {
    nodeType: 1,
    parentElement: parent,
    isContentEditable: kind === "editable",
    classList: { contains: (name: string) => classNames.has(name) },
    closest: (selector: string) => {
      if (kind === "editable" && (
        selector.includes("contenteditable='true'") ||
        selector.includes(".protyle-title__input")
      )) return node;
      return null;
    },
  };
  return node;
}

function editorRootWithContains(): any {
  const root: any = {
    nodeType: 1,
    contains: (candidate: any) => {
      let current = candidate;
      while (current) {
        if (current === root) return true;
        current = current.parentElement;
      }
      return false;
    },
  };
  return root;
}

test("document events stay scoped, paste does not activate, and focusout/blur/readonly clear", () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalRequest = globalThis.requestAnimationFrame;
  const fakeDocument = new FakeEventTarget();
  const fakeWindow = new FakeEventTarget() as FakeEventTarget & { getSelection: () => Selection };
  const root = editorRootWithContains();
  const editable = scopedEventNode(root, "editable");
  const editableSibling = scopedEventNode(root, "editable");
  const toolbar = scopedEventNode(root, "external");
  const readonly = scopedEventNode(root, "readonly");
  const outside = scopedEventNode(null, "external");
  const selection = {
    rangeCount: 1,
    anchorNode: editable,
    focusNode: editable,
    toString: () => "",
  } as unknown as Selection;
  fakeWindow.getSelection = () => selection;
  Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => { callback(0); return 1; },
  });
  setActiveEditor({ protyle: { element: root } });
  inputMode.setBothOff();

  let marked = 0;
  let cleared = 0;
  let queued = 0;
  const context = {
    clearKeyboardPending: () => { cleared++; },
    markKeyboardPending: () => { marked++; },
    onScrollOrWheel: () => undefined,
    queueUpdate: () => { queued++; },
  };

  try {
    bindCursorDocumentEvents(context);

    inputMode.setBothOn();
    fakeDocument.dispatch("keydown", {
      target: outside,
      composedPath: () => [outside],
      key: "a",
    });
    fakeDocument.dispatch("input", {
      target: outside,
      composedPath: () => [outside],
      inputType: "insertText",
    });
    assert.equal(marked, 0);
    assert.equal(inputMode.isFocusActive(), true);
    inputMode.setBothOff();

    fakeDocument.dispatch("input", {
      target: editable,
      composedPath: () => [editable, root],
      inputType: "insertText",
    });
    assert.equal(marked, 1);
    assert.equal(inputMode.isFocusActive(), true);

    inputMode.setBothOff();
    fakeDocument.dispatch("input", {
      target: editable,
      composedPath: () => [editable, root],
      inputType: "insertFromPaste",
    });
    assert.equal(marked, 1);
    assert.equal(inputMode.isFocusActive(), false);

    inputMode.setBothOn();
    fakeDocument.dispatch("focusout", {
      target: editable,
      relatedTarget: editableSibling,
      composedPath: () => [editable, root],
    });
    assert.equal(inputMode.isFocusActive(), true);
    fakeDocument.dispatch("focusout", {
      target: editable,
      relatedTarget: toolbar,
      composedPath: () => [editable, root],
    });
    assert.equal(inputMode.isFocusActive(), true);
    fakeDocument.dispatch("focusout", {
      target: editable,
      relatedTarget: outside,
      composedPath: () => [editable, root],
    });
    assert.equal(inputMode.isFocusActive(), false);

    const queuedBeforeDocumentResize = queued;
    fakeDocument.dispatch("resize");
    assert.equal(queued, queuedBeforeDocumentResize);
    fakeWindow.dispatch("resize");
    assert.equal(queued > queuedBeforeDocumentResize, true);

    inputMode.setBothOff();
    fakeDocument.dispatch("keydown", {
      target: editable,
      composedPath: () => [editable, root],
      key: "Enter",
      isComposing: true,
      defaultPrevented: false,
    });
    fakeDocument.dispatch("keydown", {
      target: editable,
      composedPath: () => [editable, root],
      key: "Enter",
      isComposing: false,
      defaultPrevented: true,
    });
    assert.equal(inputMode.isFocusActive(), false);

    inputMode.setBothOn();
    fakeWindow.dispatch("blur");
    assert.equal(inputMode.isFocusActive(), false);
    assert.equal(cleared > 0, true);

    inputMode.setBothOn();
    fakeDocument.dispatch("keydown", {
      target: readonly,
      composedPath: () => [readonly, root],
      key: "a",
    });
    assert.equal(inputMode.isFocusActive(), false);

    inputMode.setBothOn();
    fakeDocument.dispatch("click", { target: outside, composedPath: () => [outside] });
    assert.equal(inputMode.isFocusActive(), false);
    assert.equal(queued > 0, true);
  } finally {
    destroyCursorDocumentEvents();
    inputMode.setBothOff();
    setActiveEditor(null);
    Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    if (originalRequest === undefined) {
      delete (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame }).requestAnimationFrame;
    } else {
      Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: originalRequest });
    }
  }
});

test("reduced-motion helper reads preference changes on the next action", () => {
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { matchMedia: () => ({ matches: true }) },
  });
  try {
    assert.equal(prefersReducedMotion(), true);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { matchMedia: () => ({ matches: false }) },
    });
    assert.equal(prefersReducedMotion(), false);
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("typewriter edit guard rejects IME and already-prevented Enter/Backspace", () => {
  assert.equal(shouldHandleTypewriterEditKey({
    key: "Enter",
    isComposing: true,
    defaultPrevented: false,
  }), false);
  assert.equal(shouldHandleTypewriterEditKey({
    key: "Backspace",
    isComposing: false,
    defaultPrevented: true,
  }), false);
  assert.equal(shouldHandleTypewriterEditKey({
    key: "Enter",
    isComposing: false,
    defaultPrevented: false,
  }), true);
});

test("reduced-motion scroll guard identifies an in-flight animation to cancel", () => {
  assert.equal(shouldCancelPendingScrollForReducedMotion(true, true), true);
  assert.equal(shouldCancelPendingScrollForReducedMotion(true, false), false);
  assert.equal(shouldCancelPendingScrollForReducedMotion(false, true), false);
});

test("ripple destroy does not run a global block scan when no owned state exists", () => {
  const originalDocument = globalThis.document;
  const fakeDocument = {
    querySelectorAll: () => {
      throw new Error("destroy must not scan unowned document blocks");
    },
  } as unknown as Document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: fakeDocument,
  });

  try {
    destroyRipple();
  } finally {
    if (originalDocument === undefined) {
      delete (globalThis as { document?: Document }).document;
    } else {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: originalDocument,
      });
    }
  }
});

function classList(): DOMTokenList {
  const names = new Set<string>();
  return {
    add: (...tokens: string[]) => tokens.forEach((token) => names.add(token)),
    remove: (...tokens: string[]) => tokens.forEach((token) => names.delete(token)),
    contains: (token: string) => names.has(token),
  } as unknown as DOMTokenList;
}

test("ripple destroy restores an applied block and leaves a target's generic inline styles untouched", () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  const originalMutationObserver = globalThis.MutationObserver;
  const originalNode = globalThis.Node;
  const originalNodeFilter = globalThis.NodeFilter;
  const originalCSS = globalThis.CSS;
  const originalHighlight = globalThis.Highlight;

  const callbacks: FrameRequestCallback[] = [];
  let themeMode: string | null = null;
  const rootStyle = style();
  const root = {
    style: rootStyle,
    getAttribute: () => themeMode,
  } as unknown as HTMLElement;
  const container = {
    children: [] as HTMLElement[],
    childElementCount: 0,
    scrollTop: 0,
    parentElement: null,
    getBoundingClientRect: () => ({ top: 0, bottom: 800, left: 0, right: 1000, height: 800 }),
  } as unknown as HTMLElement;
  const targetWithHostStyles = {
    style: style(),
    classList: classList(),
    hasAttribute: (name: string) => name === "data-node-id",
    dataset: { nodeId: "target-with-host-styles" },
    parentElement: container,
    getBoundingClientRect: () => ({ top: 100, bottom: 140, left: 0, right: 1000, height: 40 }),
  } as unknown as HTMLElement;
  const blockClassList = classList();
  const block = {
    style: style(),
    classList: blockClassList,
    isContentEditable: true,
    hasAttribute: (name: string) => name === "data-node-id",
    dataset: { nodeId: "owned" },
    parentElement: container,
    childNodes: [] as Node[],
    closest: (selector: string) => selector === "[data-node-id]"
      ? block
      : selector === ".protyle-wysiwyg"
      ? container
      : null,
    contains: (node: Node) => node === block || node === emptyText,
  } as unknown as HTMLElement;
  const emptyText = {
    nodeType: 3,
    data: "",
    childNodes: [],
    parentElement: block,
  } as unknown as Text;
  block.childNodes = [emptyText];
  container.children = [block, targetWithHostStyles];
  container.childElementCount = 2;
  block.style.setProperty("--zt-ripple-opacity", "host-opacity", "important");
  block.style.setProperty("--zt-ripple-transition-duration", "1.25s", "important");
  targetWithHostStyles.style.setProperty("opacity", "0.8", "important");
  targetWithHostStyles.style.setProperty("transition", "host-transition");

  const selection = {
    rangeCount: 1,
    getRangeAt: () => ({ startContainer: emptyText, startOffset: 0 }),
    toString: () => "",
  } as unknown as Selection;
  const fakeDocument = {
    documentElement: root,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelector: () => null,
    querySelectorAll: () => {
      throw new Error("destroy must not scan unowned document blocks");
    },
    createTreeWalker: () => ({ nextNode: () => null }),
  } as unknown as Document;
  const observerInstances: FakeMutationObserver[] = [];
  class FakeMutationObserver {
    readonly callback: () => void;
    disconnected = false;

    constructor(callback: () => void) {
      this.callback = callback;
      observerInstances.push(this);
    }

    observe(): void {}
    disconnect(): void { this.disconnected = true; }
  }

  Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { getSelection: () => selection },
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    },
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => undefined });
  Object.defineProperty(globalThis, "MutationObserver", { configurable: true, value: FakeMutationObserver });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: { TEXT_NODE: 3 } });
  Object.defineProperty(globalThis, "NodeFilter", { configurable: true, value: { SHOW_TEXT: 4 } });
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { highlights: { delete: () => undefined, has: () => false, set: () => undefined } },
  });
  Object.defineProperty(globalThis, "Highlight", { configurable: true, value: class {} });

  try {
    inputMode.setBothOn();
    initRipple();
    while (callbacks.length > 0) callbacks.shift()?.(0);

    assert.equal(blockClassList.contains("zentype-ripple-block"), true);
    assert.equal(block.style.getPropertyValue("--zt-ripple-opacity"), "1");
    assert.equal(
      block.style.getPropertyValue("--zt-ripple-transition-duration"),
      `${RIPPLE_CONFIG.TRANSITION_SEC}s`,
    );
    assert.equal(observerInstances.length, 2);
    themeMode = "dark";
    observerInstances[0].callback();
    while (callbacks.length > 0) callbacks.shift()?.(0);
    assert.match(rootStyle.getPropertyValue("--zt-sentence-dim-color"), /255,255,255/);
    assert.equal(targetWithHostStyles.style.getPropertyValue("opacity"), "0.8");
    assert.equal(targetWithHostStyles.style.getPropertyPriority("opacity"), "important");

    destroyRipple();
    assert.equal(blockClassList.contains("zentype-ripple-block"), false);
    assert.equal(block.style.getPropertyValue("--zt-ripple-opacity"), "host-opacity");
    assert.equal(block.style.getPropertyPriority("--zt-ripple-opacity"), "important");
    assert.equal(block.style.getPropertyValue("--zt-ripple-transition-duration"), "1.25s");
    assert.equal(
      block.style.getPropertyPriority("--zt-ripple-transition-duration"),
      "important",
    );
    assert.equal(targetWithHostStyles.style.getPropertyValue("opacity"), "0.8");
    assert.equal(targetWithHostStyles.style.getPropertyValue("transition"), "host-transition");
    assert.equal(observerInstances.every((observer) => observer.disconnected), true);
  } finally {
    inputMode.setBothOff();
    Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: originalRequest });
    Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: originalCancel });
    Object.defineProperty(globalThis, "MutationObserver", { configurable: true, value: originalMutationObserver });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: originalNode });
    Object.defineProperty(globalThis, "NodeFilter", { configurable: true, value: originalNodeFilter });
    Object.defineProperty(globalThis, "CSS", { configurable: true, value: originalCSS });
    Object.defineProperty(globalThis, "Highlight", { configurable: true, value: originalHighlight });
  }
});

test("build copies watched static assets and zips only the allowlist", async () => {
  const root = process.cwd();
  const requireFromTest = createRequire(import.meta.url);
  const buildApi = requireFromTest(path.join(root, "build.js")) as {
    STATIC_ASSETS: string[];
    PACKAGE_FILES: string[];
    copyAssets: (outDir: string, sourceDir: string) => void;
    watchStaticAssets: (outDir: string, sourceDir: string) => () => void;
  };
  const tempRoot = mkdtempSync(path.join(root, ".tmp-build-test-"));
  const sourceDir = path.join(tempRoot, "source");
  const outputDir = path.join(tempRoot, "output");
  mkdirSync(sourceDir);
  mkdirSync(outputDir);
  writeFileSync(path.join(outputDir, "index.js"), "#zentype-cursor");
  for (const asset of buildApi.STATIC_ASSETS) {
    writeFileSync(path.join(sourceDir, asset), `initial-${asset}`);
  }

  let closeWatcher: (() => void) | null = null;
  try {
    buildApi.copyAssets(outputDir, sourceDir);
    assert.equal(readFileSync(path.join(outputDir, "plugin.json"), "utf8"), "initial-plugin.json");
    closeWatcher = buildApi.watchStaticAssets(outputDir, sourceDir);
    writeFileSync(path.join(sourceDir, "plugin.json"), "changed-plugin");
    for (let attempt = 0; attempt < 20; attempt++) {
      if (readFileSync(path.join(outputDir, "plugin.json"), "utf8") === "changed-plugin") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(readFileSync(path.join(outputDir, "plugin.json"), "utf8"), "changed-plugin");
  } finally {
    closeWatcher?.();
    rmSync(tempRoot, { recursive: true, force: true });
  }

  const buildResult = spawnSync(process.execPath, ["build.js", "--zip"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(buildResult.status, 0, buildResult.stderr || buildResult.stdout);
  assert.equal(existsSync(path.join(root, "package.zip")), true);
  const archiveResult = spawnSync("tar", ["-tf", "package.zip"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(archiveResult.status, 0, archiveResult.stderr);
  const entries = archiveResult.stdout.trim().split(/\r?\n/).filter(Boolean).sort();
  assert.deepEqual(entries, [...buildApi.PACKAGE_FILES].sort());
});
