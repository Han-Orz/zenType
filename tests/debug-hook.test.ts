import assert from "node:assert/strict";
import test from "node:test";
import { setActiveEditor } from "siyuan";
import type { EventBus } from "siyuan";
import {
  initDebugHook,
  redactText,
  summarizeKeyboardKey,
} from "../src/modules/debugHook";

class FakeClassList extends Set<string> {
  contains(value: string): boolean {
    return this.has(value);
  }
}

class FakeText {
  readonly nodeType = 3;
  readonly childNodes: FakeText[] = [];
  parentElement: FakeElement | null = null;
  isConnected = true;
  nodeValue: string;

  constructor(value: string) {
    this.nodeValue = value;
  }

  get textContent(): string {
    return this.nodeValue;
  }
}

class FakeElement {
  readonly nodeType = 1;
  readonly childNodes: Array<FakeElement | FakeText> = [];
  readonly children: FakeElement[] = [];
  readonly classList = new FakeClassList();
  readonly attributes: Array<{ name: string; value: string }> = [];
  parentElement: FakeElement | null = null;
  isConnected = true;
  scrollTop = 0;
  scrollLeft = 0;
  scrollHeight = 100;
  scrollWidth = 100;
  clientHeight = 100;
  clientWidth = 100;
  tagName: string;
  private ownText = "";

  constructor(tagName: string, attrs: Record<string, string> = {}) {
    this.tagName = tagName.toUpperCase();
    for (const [name, value] of Object.entries(attrs)) {
      this.attributes.push({ name, value });
      if (name === "class") {
        for (const className of value.split(/\s+/).filter(Boolean)) this.classList.add(className);
      }
    }
  }

  get textContent(): string {
    return this.ownText + this.childNodes.map((child) => child.textContent ?? "").join("");
  }

  set textContent(value: string) {
    this.ownText = value;
  }

  appendChild(child: FakeElement | FakeText): void {
    child.parentElement = this;
    this.childNodes.push(child);
    if (child instanceof FakeElement) this.children.push(child);
  }

  getAttribute(name: string): string | null {
    return this.attributes.find((attribute) => attribute.name === name)?.value ?? null;
  }

  closest(selector: string): FakeElement | null {
    let current: FakeElement | null = this;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  matches(selector: string): boolean {
    return selector.split(",").some((part) => {
      const normalized = part.trim();
      if (normalized === ".protyle") return this.classList.has("protyle");
      if (normalized === ".protyle-wysiwyg") return this.classList.has("protyle-wysiwyg");
      if (normalized === ".protyle-action") return this.classList.has("protyle-action");
      if (normalized === "[data-node-id]") return this.getAttribute("data-node-id") !== null;
      return false;
    });
  }

  contains(node: object | null): boolean {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node))
      || this.childNodes.some((child) => child === node);
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches: FakeElement[] = [];
    const visit = (element: FakeElement): void => {
      if (element.matches(selector)) matches.push(element);
      for (const child of element.children) visit(child);
    };
    for (const child of this.children) visit(child);
    return matches;
  }

  getBoundingClientRect(): DOMRect {
    return {
      x: 1,
      y: 2,
      width: 100,
      height: 20,
      top: 2,
      right: 101,
      bottom: 22,
      left: 1,
      toJSON: () => ({}),
    } as DOMRect;
  }
}

class FakeSelection {
  rangeCount = 0;
  anchorNode: FakeText | null = null;
  focusNode: FakeText | null = null;
  anchorOffset = 0;
  focusOffset = 0;
  isCollapsed = true;

  getRangeAt(_index: number): never {
    throw new Error("selection has no range");
  }

  toString(): string {
    return "";
  }
}

class FakeDocument {
  readonly body = new FakeElement("BODY");
  readonly documentElement = new FakeElement("HTML");
  readonly selection = new FakeSelection();
  activeElement: FakeElement | null = null;
  root: FakeElement | null = null;
  private readonly listeners = new Map<string, Set<EventListener>>();

  querySelector(selector: string): FakeElement | null {
    return selector === ".protyle" ? this.root : null;
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: Event): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  getSelection(): FakeSelection {
    return this.selection;
  }
}

class FakeMutationObserver {
  target: FakeElement | null = null;
  options: MutationObserverInit | null = null;
  disconnectCount = 0;

  constructor(readonly callback: (records: MutationRecord[]) => void) {}

  observe(target: FakeElement, options?: MutationObserverInit): void {
    this.target = target;
    this.options = options ?? null;
  }

  disconnect(): void {
    this.disconnectCount += 1;
  }
}

class FakeEventBus {
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  on(name: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(name) ?? new Set<(event: unknown) => void>();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  off(name: string, listener: (event: unknown) => void): void {
    this.listeners.get(name)?.delete(listener);
  }
}

class FakeRuntime {
  readonly document = new FakeDocument();
  readonly window = { getSelection: () => this.document.selection };
  readonly observers: FakeMutationObserver[] = [];
  readonly fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  healthOnline = true;
  private readonly originalGlobals = new Map<string, PropertyDescriptor | undefined>();

  install(): void {
    this.defineGlobal("document", this.document);
    this.defineGlobal("window", this.window);
    this.defineGlobal("Node", { ELEMENT_NODE: 1, TEXT_NODE: 3 });
    this.defineGlobal("Element", FakeElement);
    this.defineGlobal("HTMLElement", FakeElement);
    const runtime = this;
    this.defineGlobal("MutationObserver", class extends FakeMutationObserver {
      constructor(callback: (records: MutationRecord[]) => void) {
        super(callback);
        runtime.observers.push(this);
      }
    });
    this.defineGlobal("getComputedStyle", () => ({
      display: "block",
      position: "relative",
      opacity: "1",
      visibility: "visible",
      color: "rgb(0, 0, 0)",
      backgroundColor: "transparent",
      fill: "none",
      stroke: "none",
      transform: "none",
      filter: "none",
      mixBlendMode: "normal",
      willChange: "auto",
      transition: "opacity 100ms ease",
      transitionProperty: "opacity",
      transitionDuration: "100ms",
      transitionTimingFunction: "ease",
      zIndex: "1",
      contain: "none",
      isolation: "auto",
      pointerEvents: "auto",
      fontSize: "16px",
      lineHeight: "20px",
      overflow: "visible",
      margin: "0px",
      padding: "0px",
      getPropertyValue: (property: string) => property === "--zt-ripple-opacity" ? "0.5" : "",
    }));
    this.defineGlobal("fetch", (url: string, init?: RequestInit) => {
      this.fetchCalls.push({ url, init });
      if (url.endsWith("/health")) {
        return Promise.resolve({ ok: this.healthOnline, status: this.healthOnline ? 200 : 503 });
      }
      return Promise.resolve({ ok: true, status: 202 });
    });
  }

  restore(): void {
    for (const [name, descriptor] of this.originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as unknown as Record<string, unknown>)[name];
    }
  }

  private defineGlobal(name: string, value: unknown): void {
    if (!this.originalGlobals.has(name)) {
      this.originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    }
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
}

test("DebugKit is session-first and stays quiet while the bridge is offline", async () => {
  const runtime = new FakeRuntime();
  runtime.install();
  runtime.healthOnline = false;
  const controller = initDebugHook(new FakeEventBus() as unknown as EventBus);
  try {
    assert.equal(runtime.fetchCalls.length, 0);
    assert.equal(globalThis.__zentypeDebug, globalThis.__zentypeDebugHook);
    const started = await controller.start("offline", { profile: "forensic" });
    assert.equal(started.active, true);
    assert.equal(controller.getState().transportState, "offline");
    assert.equal(runtime.fetchCalls.filter((call) => call.url.endsWith("/health")).length, 1);

    controller.mark("still useful", { source: "caller", detail: "kept in memory" });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(runtime.fetchCalls.some((call) => call.url.endsWith("/events")), false);
    assert.equal(controller.getRecentEvents().some((event) => event.payload.name === "mark"), true);

    await controller.stop();
    assert.equal(controller.getState().active, false);
    assert.equal(runtime.fetchCalls.some((call) => call.url.endsWith("/events")), false);
  } finally {
    controller.destroy();
    runtime.restore();
  }
});

test("forensic sessions capture identity, text, styles, watches, and bounded snapshots", async () => {
  const runtime = new FakeRuntime();
  runtime.install();
  const root = new FakeElement("DIV", { class: "protyle" });
  const editor = new FakeElement("DIV", {
    class: "protyle-wysiwyg",
    "data-type": "protyle-wysiwyg",
    "data-node-id": "block-a",
  });
  const marker = new FakeElement("SPAN", { class: "protyle-action" });
  const initialText = new FakeText("current block text");
  root.appendChild(editor);
  root.appendChild(marker);
  editor.appendChild(initialText);
  runtime.document.root = root;
  runtime.document.activeElement = marker;
  runtime.document.selection.anchorNode = initialText;
  runtime.document.selection.focusNode = initialText;
  setActiveEditor({ protyle: { element: root, id: "protyle-a", block: { id: "block-a" } } });
  const controller = initDebugHook(new FakeEventBus() as unknown as EventBus);
  const watchId = controller.watch(".protyle-action", "marker");
  try {
    assert.equal(runtime.observers.length, 0);
    await controller.start("marker-tab", { profile: "forensic" });
    assert.equal(runtime.observers.length, 1);
    assert.equal(runtime.observers[0].target, root);

    const keyEvent = {
      type: "keydown",
      target: marker,
      key: "a",
      code: "KeyA",
      repeat: false,
      isComposing: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      composedPath: () => [marker, root],
      defaultPrevented: false,
      cancelBubble: false,
      eventPhase: 1,
      timeStamp: 10,
    } as unknown as Event;
    runtime.document.dispatch("keydown", keyEvent);
    const keyCapture = controller.getRecentEvents().find((event) => event.payload.name === "keydown");
    assert.ok(keyCapture);
    assert.equal(keyCapture.payload.key, "a");
    const markerReference = keyCapture.payload.target as { nodeToken: string; isConnected: boolean };
    assert.match(markerReference.nodeToken, /^n\d+$/);
    assert.equal(markerReference.isConnected, true);

    const tabEvent = { ...keyEvent, key: "Tab", code: "Tab" } as unknown as Event;
    runtime.document.dispatch("keydown", tabEvent);
    const tabCapture = controller.getRecentEvents().find(
      (event) => event.payload.name === "keydown" && event.payload.key === "Tab",
    );
    assert.ok(tabCapture);
    const samples = tabCapture.payload.watchSamples as Array<Record<string, unknown>>;
    assert.equal(samples.length, 1);
    assert.equal((samples[0].nodeToken as string), markerReference.nodeToken);
    assert.equal((samples[0].label as string), "marker");
    assert.equal((samples[0].computed as Record<string, string>).transitionDuration, "100ms");

    const textNode = new FakeText("secret text");
    editor.appendChild(textNode);
    runtime.observers[0].callback([{
      type: "childList",
      target: editor,
      attributeName: null,
      oldValue: null,
      addedNodes: [textNode],
      removedNodes: [],
    } as unknown as MutationRecord]);
    const mutation = controller.getRecentEvents().find((event) => event.payload.name === "mutation");
    assert.ok(mutation);
    const records = mutation.payload.records as Array<Record<string, unknown>>;
    const addedText = records[0].addedTextNodes as Array<Record<string, unknown>>;
    assert.equal(addedText[0].text, "secret text");
    assert.equal(controller.getState().mutationBatches, 1);

    controller.mark("flash-seen");
    const mark = controller.getRecentEvents().find((event) => event.payload.name === "mark");
    assert.ok(mark);
    assert.equal(mark.payload.source, "debugkit");
    assert.equal(mark.payload.label, "flash-seen");
    assert.equal((mark.payload.currentBlock as { text: string }).text, "current block textsecret text");

    await controller.stop();
    const snapshots = controller.getRecentEvents().filter((event) => event.kind === "snapshot");
    assert.equal(snapshots.length, 2);
    const snapshot = snapshots[0].payload as { dom: { nodeToken: string; children?: Array<{ nodeToken: string }> } };
    assert.match(snapshot.dom.nodeToken, /^n\d+$/);
    assert.equal(controller.getState().computedStyleReads > 0, true);
    assert.equal(controller.getState().watchSamples >= 3, true);
    controller.unwatch(watchId);
  } finally {
    controller.destroy();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("timing profile masks printable keys and does not serialize a DOM tree", async () => {
  const runtime = new FakeRuntime();
  runtime.install();
  const root = new FakeElement("DIV", { class: "protyle" });
  const editor = new FakeElement("DIV", { class: "protyle-wysiwyg" });
  root.appendChild(editor);
  runtime.document.root = root;
  setActiveEditor({ protyle: { element: root } });
  const controller = initDebugHook(new FakeEventBus() as unknown as EventBus);
  try {
    await controller.start("timing", { profile: "timing" });
    const event = {
      type: "keydown",
      target: editor,
      key: "x",
      code: "KeyX",
      isComposing: false,
      repeat: false,
      composedPath: () => [editor, root],
    } as unknown as Event;
    runtime.document.dispatch("keydown", event);
    const keyCapture = controller.getRecentEvents().find((item) => item.payload.name === "keydown");
    assert.ok(keyCapture);
    assert.equal(keyCapture.payload.key, "<printable>");
    assert.equal(controller.getRecentEvents().some((item) => item.kind === "snapshot"), false);
    assert.equal(controller.getState().computedStyleReads, 0);
  } finally {
    await controller.stop();
    controller.destroy();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("text helpers preserve the timing/forensic boundary", () => {
  assert.deepEqual(redactText("嵌套块", false), { length: 3 });
  assert.deepEqual(redactText("嵌套块", true), { length: 3, text: "嵌套块" });
  assert.equal(summarizeKeyboardKey("Enter"), "Enter");
  assert.equal(summarizeKeyboardKey("a"), "<printable>");
  assert.equal(summarizeKeyboardKey("a", true), "a");
});
