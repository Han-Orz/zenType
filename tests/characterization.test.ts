import assert from "node:assert/strict";
import test from "node:test";
import { setActiveEditor } from "siyuan";
import { RIPPLE_CONFIG } from "../src/config";
import * as inputMode from "../src/modules/inputMode";
import * as inputModeTriggers from "../src/modules/inputModeTriggers";
import {
  bindCursorDocumentEvents,
  destroyCursorDocumentEvents,
  shouldUseManualScrollPolicy,
  type CursorScrollSource,
} from "../src/modules/cursor/events";
import {
  destroyTypewriter,
  initTypewriter,
} from "../src/modules/typewriter";
import * as flip from "../src/modules/typewriter/flip";
import * as scroll from "../src/modules/typewriter/scroll";
import {
  destroyCursor,
  initCursor,
  onProtyleLoaded,
  onProtyleSwitched,
} from "../src/modules/cursor";
import {
  destroyRipple,
  initRipple,
} from "../src/modules/ripple";
import {
  destroyStructuralEditCoordinator,
  getStructuralEditSnapshot,
  isStructuralEditPending,
  subscribeStructuralEditFinish,
} from "../src/modules/structuralEdit";
import {
  isSwitchHiddenActive,
  isSwitchRevealPending,
  startSwitchSettle,
  stopSwitchSettle,
} from "../src/modules/cursor/switchSettle";

type Rect = {
  x: number;
  y: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
};

function rect(x: number, y: number, width = 1, height = 20): Rect {
  return {
    x,
    y,
    top: y,
    bottom: y + height,
    left: x,
    right: x + width,
    width,
    height,
  };
}

class FakeStyle {
  private readonly values = new Map<string, { value: string; priority: string }>();

  cssText = "";
  transform = "";
  transition = "";
  opacity = "";
  height = "";
  zIndex = "";

  getPropertyValue(property: string): string {
    return this.values.get(property)?.value ?? "";
  }

  getPropertyPriority(property: string): string {
    return this.values.get(property)?.priority ?? "";
  }

  setProperty(property: string, value: string, priority = ""): void {
    if (value === "") this.values.delete(property);
    else this.values.set(property, { value, priority });

    if (property === "transform" || property === "transition" ||
        property === "opacity" || property === "height" || property === "z-index") {
      const field = property === "z-index" ? "zIndex" : property;
      (this as unknown as Record<string, string>)[field] = value;
    }
  }
}

class FakeClassList {
  private readonly names: Set<string>;

  constructor(names: readonly string[] = []) {
    this.names = new Set(names);
  }

  add(...names: string[]): void {
    names.forEach((name) => this.names.add(name));
  }

  remove(...names: string[]): void {
    names.forEach((name) => this.names.delete(name));
  }

  contains(name: string): boolean {
    return this.names.has(name);
  }
}

type ListenerRecord = {
  listener: EventListener;
  options?: AddEventListenerOptions | boolean;
};

class FakeEventTarget {
  private readonly listeners = new Map<string, ListenerRecord[]>();

  addEventListener(
    event: string,
    listener: EventListener,
    options?: AddEventListenerOptions | boolean,
  ): void {
    const records = this.listeners.get(event) ?? [];
    records.push({ listener, options });
    this.listeners.set(event, records);
  }

  removeEventListener(
    event: string,
    listener: EventListener,
  ): void {
    const records = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      records.filter((record) => record.listener !== listener),
    );
  }

  dispatch(event: string, init: Record<string, unknown> = {}): void {
    const target = init.target ?? this;
    const eventObject = {
      type: event,
      target,
      composedPath: () => [target],
      ...init,
    } as unknown as Event;
    for (const record of [...(this.listeners.get(event) ?? [])]) {
      record.listener(eventObject);
    }
  }

  listenerCount(event: string): number {
    return (this.listeners.get(event) ?? []).length;
  }
}

class FakeText extends FakeEventTarget {
  readonly nodeType = 3;
  readonly childNodes: FakeText[] = [];
  parentElement: FakeElement | null = null;
  parentNode: FakeElement | null = null;

  constructor(public data: string) {
    super();
  }

  get nodeValue(): string {
    return this.data;
  }
}

function readAttributeSelector(
  element: FakeElement,
  selector: string,
): boolean | null {
  const match = selector.match(/^\[([^\]=]+)(?:([\^]?=)['"]?([^\]'"]*)['"]?)?\]$/);
  if (!match) return null;
  const [, name, operator, expected] = match;
  const value = element.getAttribute(name);
  if (!operator) return value !== null;
  if (value === null) return false;
  return operator === "^=" ? value.startsWith(expected) : value === expected;
}

class FakeElement extends FakeEventTarget {
  readonly nodeType = 1;
  readonly childNodes: Array<FakeElement | FakeText> = [];
  readonly classList: FakeClassList;
  readonly style = new FakeStyle();
  readonly tagName: string;
  id = "";
  readonly dataset: Record<string, string> = {};
  readonly computed: Record<string, string> = {};
  parentElement: FakeElement | null = null;
  parentNode: FakeElement | null = null;
  isContentEditable = false;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  scrollWidth = 0;
  clientWidth = 0;
  rect = rect(0, 0, 100, 100);
  connectedRoot = false;
  private readonly attributes = new Map<string, string>();

  constructor(options: {
    classes?: readonly string[];
    tagName?: string;
    dataNodeId?: string;
    dataType?: string;
    contentEditable?: boolean;
  } = {}) {
    super();
    this.classList = new FakeClassList(options.classes);
    this.tagName = options.tagName ?? "DIV";
    if (options.dataNodeId !== undefined) this.setAttribute("data-node-id", options.dataNodeId);
    if (options.dataType !== undefined) this.setAttribute("data-type", options.dataType);
    if (options.contentEditable) {
      this.setAttribute("contenteditable", "true");
      this.isContentEditable = true;
    }
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((child): child is FakeElement => child.nodeType === 1);
  }

  get childElementCount(): number {
    return this.children.length;
  }

  get firstChild(): FakeElement | FakeText | null {
    return this.childNodes[0] ?? null;
  }

  get previousElementSibling(): FakeElement | null {
    const siblings = this.parentElement?.children ?? [];
    const index = siblings.indexOf(this);
    return index > 0 ? siblings[index - 1] : null;
  }

  get nextElementSibling(): FakeElement | null {
    const siblings = this.parentElement?.children ?? [];
    const index = siblings.indexOf(this);
    return index >= 0 ? siblings[index + 1] ?? null : null;
  }

  get isConnected(): boolean {
    let current: FakeElement | null = this;
    while (current?.parentElement) current = current.parentElement;
    return current?.connectedRoot === true;
  }

  get offsetHeight(): number {
    return this.rect.height;
  }

  get textContent(): string {
    return this.childNodes.map((child) => child instanceof FakeText
      ? child.data
      : child.textContent).join("");
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "data-node-id") this.dataset.nodeId = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  appendChild(child: FakeElement | FakeText): void {
    child.parentElement?.removeChild(child);
    child.parentElement = this;
    child.parentNode = this;
    this.childNodes.push(child);
  }

  removeChild(child: FakeElement | FakeText): void {
    const index = this.childNodes.indexOf(child);
    if (index === -1) return;
    this.childNodes.splice(index, 1);
    child.parentElement = null;
    child.parentNode = null;
  }

  replaceChild(newChild: FakeElement | FakeText, oldChild: FakeElement | FakeText): void {
    const index = this.childNodes.indexOf(oldChild);
    if (index === -1) return;
    oldChild.parentElement = null;
    oldChild.parentNode = null;
    newChild.parentElement?.removeChild(newChild);
    newChild.parentElement = this;
    newChild.parentNode = this;
    this.childNodes[index] = newChild;
  }

  remove(): void {
    this.parentElement?.removeChild(this);
  }

  contains(candidate: FakeElement | FakeText | null): boolean {
    if (!candidate) return false;
    if (candidate === this) return true;
    return this.childNodes.some((child) => child === candidate ||
      (child instanceof FakeElement && child.contains(candidate)));
  }

  closest(selector: string): FakeElement | null {
    let current: FakeElement | null = this;
    while (current) {
      if (selector.split(",").some((part) => current?.matchesSelector(part.trim()))) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const result: FakeElement[] = [];
    const visit = (element: FakeElement) => {
      for (const child of element.children) {
        if (selector.split(",").some((part) => child.matchesSelector(part.trim()))) {
          result.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return result;
  }

  getBoundingClientRect(): Rect {
    return this.rect;
  }

  private matchesSelector(selector: string): boolean {
    if (selector === ".protyle:not(.fn__none) .protyle-content" ||
        selector === ".protyle:not(.fn__none) .protyle-wysiwyg") {
      const childSelector = selector.endsWith(".protyle-content")
        ? ".protyle-content"
        : ".protyle-wysiwyg";
      if (!this.matchesSelector(childSelector)) return false;
      return this.parentElement?.closest(".protyle:not(.fn__none)") !== null;
    }
    if (selector === ".protyle:not(.fn__none)") {
      return this.classList.contains("protyle") && !this.classList.contains("fn__none");
    }
    if (selector.includes(":not(")) {
      const [base, excluded] = selector.split(":not(");
      return this.matchesSelector(base) && !this.matchesSelector(excluded.replace(/\)$/, ""));
    }
    const attributeResult = readAttributeSelector(this, selector);
    if (attributeResult !== null) return attributeResult;
    if (selector.startsWith(".")) {
      return selector.split(".").filter(Boolean).every((name) => this.classList.contains(name));
    }
    if (selector === "button" || selector === "iframe" || selector === "video" ||
        selector === "img" || selector === "svg" || selector === "use") {
      return this.tagName.toLowerCase() === selector;
    }
    if (selector === "*") return true;
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
}

class FakeRange {
  startContainer: FakeElement | FakeText;
  endContainer: FakeElement | FakeText;
  startOffset: number;
  endOffset: number;
  private readonly getRect: () => Rect | null;

  constructor(
    startContainer: FakeElement | FakeText = new FakeElement(),
    startOffset = 0,
    getRect: () => Rect | null = () => null,
  ) {
    this.startContainer = startContainer;
    this.endContainer = startContainer;
    this.startOffset = startOffset;
    this.endOffset = startOffset;
    this.getRect = getRect;
  }

  cloneRange(): FakeRange {
    const clone = new FakeRange(this.startContainer, this.startOffset, this.getRect);
    clone.endContainer = this.endContainer;
    clone.endOffset = this.endOffset;
    return clone;
  }

  collapse(toStart: boolean): void {
    if (toStart) {
      this.endContainer = this.startContainer;
      this.endOffset = this.startOffset;
    } else {
      this.startContainer = this.endContainer;
      this.startOffset = this.endOffset;
    }
  }

  getClientRects(): Rect[] {
    const current = this.getRect();
    return current ? [current] : [];
  }

  get collapsed(): boolean {
    return this.startContainer === this.endContainer && this.startOffset === this.endOffset;
  }

  setStart(node: FakeElement | FakeText, offset: number): void {
    this.startContainer = node;
    this.startOffset = offset;
  }

  setEnd(node: FakeElement | FakeText, offset: number): void {
    this.endContainer = node;
    this.endOffset = offset;
  }

  selectNodeContents(node: FakeElement): void {
    const text = node.querySelectorAll("*")
      .flatMap((element) => element.childNodes.filter((child): child is FakeText => child instanceof FakeText))[0]
      ?? node.childNodes.find((child): child is FakeText => child instanceof FakeText);
    this.startContainer = node;
    this.startOffset = 0;
    this.endContainer = text ?? node;
    this.endOffset = text?.data.length ?? 0;
  }

  toString(): string {
    return this.endOffset > 0 ? "content before caret" : "";
  }
}

class FakeSelection {
  range: FakeRange | null = null;
  selectionText = "";

  get rangeCount(): number {
    return this.range ? 1 : 0;
  }

  get anchorNode(): FakeElement | FakeText | null {
    return this.range?.startContainer ?? null;
  }

  get focusNode(): FakeElement | FakeText | null {
    return this.range?.endContainer ?? null;
  }

  getRangeAt(index: number): FakeRange {
    if (index !== 0 || !this.range) throw new Error("selection has no range");
    return this.range;
  }

  toString(): string {
    return this.selectionText;
  }
}

class FakeDocument extends FakeEventTarget {
  readonly documentElement: FakeElement;
  readonly body: FakeElement;

  constructor() {
    super();
    this.documentElement = new FakeElement({ tagName: "HTML" });
    this.documentElement.connectedRoot = true;
    this.body = new FakeElement({ tagName: "BODY" });
    this.documentElement.appendChild(this.body);
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement({ tagName: tagName.toUpperCase() });
  }

  createTreeWalker(root: FakeElement): { nextNode: () => FakeText | null } {
    const nodes: FakeText[] = [];
    const visit = (element: FakeElement) => {
      for (const child of element.childNodes) {
        if (child instanceof FakeText) nodes.push(child);
        else visit(child);
      }
    };
    visit(root);
    let index = 0;
    return { nextNode: () => nodes[index++] ?? null };
  }

  createRange(): FakeRange {
    return new FakeRange();
  }

  getElementById(id: string): FakeElement | null {
    return this.querySelectorAll("*").find((element) =>
      element.getAttribute("id") === id || element.id === id) ?? null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.documentElement.querySelectorAll(selector);
  }
}

class FakeWindow extends FakeEventTarget {
  innerWidth = 1200;
  innerHeight = 1000;
  reducedMotion = false;
  private selection: FakeSelection | null = null;

  setSelection(selection: FakeSelection): void {
    this.selection = selection;
  }

  getSelection(): FakeSelection | null {
    return this.selection;
  }

  matchMedia(): { matches: boolean } {
    return { matches: this.reducedMotion };
  }
}

class FakeClock {
  now = 0;
  private nextId = 1;
  readonly pending = new Map<number, { callback: () => void; due: number; delay: number }>();

  setTimeout = (callback: () => void, delay = 0): number => {
    const id = this.nextId++;
    this.pending.set(id, { callback, due: this.now + delay, delay });
    return id;
  };

  clearTimeout = (id: number): void => {
    this.pending.delete(id);
  };

  advance(milliseconds: number): void {
    this.now += milliseconds;
    let next: [number, { callback: () => void; due: number; delay: number }] | undefined;
    while (true) {
      next = [...this.pending.entries()]
        .filter(([, timer]) => timer.due <= this.now)
        .sort(([, a], [, b]) => a.due - b.due)[0];
      if (!next) return;
      this.pending.delete(next[0]);
      next[1].callback();
    }
  }

  delays(): number[] {
    return [...this.pending.values()].map((timer) => timer.delay);
  }
}

class FakeRafQueue {
  private nextId = 1;
  readonly pending = new Map<number, FrameRequestCallback>();

  request = (callback: FrameRequestCallback): number => {
    const id = this.nextId++;
    this.pending.set(id, callback);
    return id;
  };

  cancel = (id: number): void => {
    this.pending.delete(id);
  };

  flush(id: number, time: number): void {
    const callback = this.pending.get(id);
    assert.ok(callback, "expected the requested animation frame");
    this.pending.delete(id);
    callback(time);
  }

  flushNext(time: number): void {
    const entry = this.pending.entries().next().value as [number, FrameRequestCallback] | undefined;
    assert.ok(entry, "expected a pending animation frame");
    this.flush(entry[0], time);
  }
}

class FakeMutationObserver {
  disconnected = false;
  readonly observed: unknown[] = [];
  constructor(public readonly callback: (records: MutationRecord[]) => void) {}
  observe(target: unknown): void {
    this.disconnected = false;
    this.observed.push(target);
  }
  disconnect(): void { this.disconnected = true; }
}

class FakeResizeObserver {
  disconnected = false;
  readonly observed: unknown[] = [];
  constructor(public readonly callback: ResizeObserverCallback) {}
  observe(target: unknown): void { this.observed.push(target); }
  disconnect(): void { this.disconnected = true; }
}

class FakeHighlight {
  readonly ranges: FakeRange[];

  constructor(...ranges: FakeRange[]) {
    this.ranges = ranges;
  }
}

class FakeDOMRect {
  readonly x: number;
  readonly y: number;
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly width: number;
  readonly height: number;

  constructor(x: number, y: number, width: number, height: number) {
    Object.assign(this, {
      x,
      y,
      top: y,
      bottom: y + height,
      left: x,
      right: x + width,
      width,
      height,
    });
    this.x = x;
    this.y = y;
    this.top = y;
    this.bottom = y + height;
    this.left = x;
    this.right = x + width;
    this.width = width;
    this.height = height;
  }
}

type RuntimeFixture = {
  editor: FakeElement;
  content: FakeElement;
  wysiwyg: FakeElement;
  block: FakeElement;
  text: FakeText;
};

class FakeRuntime {
  readonly document = new FakeDocument();
  readonly window = new FakeWindow();
  readonly selection = new FakeSelection();
  readonly clock = new FakeClock();
  readonly raf = new FakeRafQueue();
  readonly highlights = new Map<string, FakeHighlight>();
  readonly mutationObservers: FakeMutationObserver[] = [];
  readonly resizeObservers: FakeResizeObserver[] = [];
  private readonly originalGlobals = new Map<string, PropertyDescriptor | undefined>();
  private readonly originalDateNow = Date.now;

  install(): void {
    const runtime = this;
    this.defineGlobal("document", this.document);
    this.defineGlobal("window", this.window);
    this.defineGlobal("requestAnimationFrame", this.raf.request);
    this.defineGlobal("cancelAnimationFrame", this.raf.cancel);
    this.defineGlobal("setTimeout", this.clock.setTimeout);
    this.defineGlobal("clearTimeout", this.clock.clearTimeout);
    this.defineGlobal("Node", { ELEMENT_NODE: 1, TEXT_NODE: 3 });
    this.defineGlobal("NodeFilter", { SHOW_TEXT: 4 });
    this.defineGlobal("Element", FakeElement);
    this.defineGlobal("HTMLElement", FakeElement);
    this.defineGlobal("Text", FakeText);
    this.defineGlobal("Range", FakeRange);
    this.defineGlobal("DOMRect", FakeDOMRect);
    this.defineGlobal("MutationObserver", class extends FakeMutationObserver {
      constructor(callback: (records: MutationRecord[]) => void) {
        super(callback);
        runtime.mutationObservers.push(this);
      }
    });
    this.defineGlobal("ResizeObserver", class extends FakeResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        super(callback);
        runtime.resizeObservers.push(this);
      }
    });
    this.defineGlobal("CSS", {
      highlights: {
        set: (name: string, highlight: FakeHighlight) => this.highlights.set(name, highlight),
        delete: (name: string) => this.highlights.delete(name),
        has: (name: string) => this.highlights.has(name),
      },
    });
    this.defineGlobal("Highlight", FakeHighlight);
    this.defineGlobal("getComputedStyle", (element: FakeElement) => ({
      overflowY: element.computed.overflowY ?? "visible",
      overflowX: element.computed.overflowX ?? "visible",
      lineHeight: element.computed.lineHeight ?? "20px",
      fontSize: element.computed.fontSize ?? "16px",
      color: element.computed.color ?? "rgb(0, 0, 0)",
      zIndex: element.computed.zIndex ?? "auto",
    }));
    Object.defineProperty(this.window, "getComputedStyle", {
      configurable: true,
      value: globalThis.getComputedStyle,
    });
    Object.defineProperty(this.window, "setTimeout", {
      configurable: true,
      value: this.clock.setTimeout,
    });
    Object.defineProperty(this.window, "clearTimeout", {
      configurable: true,
      value: this.clock.clearTimeout,
    });
    this.window.setSelection(this.selection);
    Object.defineProperty(Date, "now", {
      configurable: true,
      value: () => this.clock.now,
    });
    this.defineGlobal("performance", { now: () => this.clock.now });
  }

  restore(): void {
    for (const [name, descriptor] of this.originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as unknown as Record<string, unknown>)[name];
    }
    Object.defineProperty(Date, "now", {
      configurable: true,
      value: this.originalDateNow,
    });
  }

  setCaret(node: FakeElement | FakeText, offset: number, currentRect: Rect): void {
    this.selection.range = new FakeRange(node, offset, () => currentRect);
    this.selection.range.setEnd(node, offset);
  }

  clearCaret(): void {
    this.selection.range = null;
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

function installRuntime(runtime: FakeRuntime): void {
  runtime.install();
  // Each test owns a fresh DOM/runtime. Dispose any transaction that a prior
  // module-only test may have left pending before installing the next one.
  destroyStructuralEditCoordinator();
}

function flushAllFrames(runtime: FakeRuntime): void {
  let remaining = 100;
  while (runtime.raf.pending.size > 0) {
    assert.ok(remaining-- > 0, "animation work must settle in a bounded number of frames");
    runtime.raf.flushNext(runtime.clock.now);
  }
}

function append(parent: FakeElement, ...children: Array<FakeElement | FakeText>): void {
  children.forEach((child) => parent.appendChild(child));
}

function eventPath(target: FakeElement | FakeText): FakeElement[] {
  const path: FakeElement[] = [];
  let current: FakeElement | null = target instanceof FakeText ? target.parentElement : target;
  while (current) {
    path.push(current);
    current = current.parentElement;
  }
  return path;
}

function eventFor(
  target: FakeElement | FakeText,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    target,
    composedPath: () => [target, ...eventPath(target)],
    ...extra,
  };
}

function createEditorFixture(
  runtime: FakeRuntime,
  textValue = "hello",
): RuntimeFixture {
  const editor = new FakeElement({ classes: ["protyle"] });
  const content = new FakeElement({ classes: ["protyle-content"] });
  content.rect = rect(0, 0, 1000, 1000);
  content.scrollHeight = 2000;
  content.clientHeight = 1000;
  content.clientWidth = 1000;
  content.computed.overflowY = "auto";
  const wysiwyg = new FakeElement({ classes: ["protyle-wysiwyg"] });
  const block = new FakeElement({
    dataNodeId: "block-current",
    contentEditable: true,
  });
  const text = new FakeText(textValue);
  block.rect = rect(0, 500, 1000, 20);
  append(block, text);
  append(wysiwyg, block);
  append(content, wysiwyg);
  append(editor, content);
  append(runtime.document.body, editor);
  setActiveEditor({ protyle: { element: editor } });
  runtime.setCaret(text, Math.min(textValue.length, 1), rect(20, 500, 1, 20));
  return { editor, content, wysiwyg, block, text };
}

type RippleFixture = {
  editor: FakeElement;
  content: FakeElement;
  wysiwyg: FakeElement;
  rootList: FakeElement;
  focusItem: FakeElement;
  focusContent: FakeElement;
  focusText: FakeText;
  alternateItem: FakeElement;
  alternateContent: FakeElement;
  alternateText: FakeText;
  siblingItem: FakeElement;
  topSibling: FakeElement;
  secondTopSibling: FakeElement;
};

function createRippleFixture(runtime: FakeRuntime): RippleFixture {
  const editor = new FakeElement({ classes: ["protyle"] });
  const content = new FakeElement({ classes: ["protyle-content"] });
  content.rect = rect(0, 0, 1000, 1000);
  content.scrollHeight = 2000;
  content.clientHeight = 1000;
  content.clientWidth = 1000;
  content.computed.overflowY = "auto";
  const wysiwyg = new FakeElement({ classes: ["protyle-wysiwyg"] });
  const rootList = new FakeElement({ dataType: "NodeList" });

  const makeItem = (id: string, textValue: string) => {
    const item = new FakeElement({
      dataType: "NodeListItem",
      dataNodeId: `item:${id}`,
    });
    const marker = new FakeElement({ classes: ["protyle-action"] });
    const block = new FakeElement({
      dataType: "NodeParagraph",
      dataNodeId: `block:${id}`,
      contentEditable: true,
    });
    const text = new FakeText(textValue);
    const attr = new FakeElement({ classes: ["protyle-attr"] });
    append(block, text);
    append(item, marker, block, attr);
    return { item, block, text };
  };

  const focus = makeItem("focus", "one. two!");
  const alternate = makeItem("alternate", "alternate. branch!");
  const sibling = makeItem("sibling", "sibling");
  const childList = new FakeElement({ dataType: "NodeList" });
  append(childList, alternate.item, sibling.item);
  append(focus.item, childList);
  append(rootList, focus.item);

  const topSibling = new FakeElement({
    dataType: "NodeParagraph",
    dataNodeId: "top-sibling",
    contentEditable: true,
  });
  const topSiblingText = new FakeText("top sibling");
  append(topSibling, topSiblingText);
  const secondTopSibling = new FakeElement({
    dataType: "NodeParagraph",
    dataNodeId: "top-sibling-2",
    contentEditable: true,
  });
  append(secondTopSibling, new FakeText("second top sibling"));

  append(wysiwyg, rootList, topSibling, secondTopSibling);
  append(content, wysiwyg);
  append(editor, content);
  append(runtime.document.body, editor);
  setActiveEditor({ protyle: { element: editor } });
  runtime.setCaret(alternate.text, 1, rect(20, 400));

  return {
    editor,
    content,
    wysiwyg,
    rootList,
    focusItem: focus.item,
    focusContent: focus.block,
    focusText: focus.text,
    alternateItem: alternate.item,
    alternateContent: alternate.block,
    alternateText: alternate.text,
    siblingItem: sibling.item,
    topSibling,
    secondTopSibling,
  };
}

function assertInputMode(active: boolean): void {
  assert.equal(inputMode.isFocusActive(), active);
  assert.equal(inputMode.isTypewriterActive(), active);
}

test("input session preserves activation, exit, and scroll distinctions", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime);
  const sibling = new FakeElement({ contentEditable: true });
  const readonly = new FakeElement();
  readonly.setAttribute("contenteditable", "false");
  const toolbar = new FakeElement();
  append(fixture.editor, sibling, readonly, toolbar);
  const outside = new FakeElement();

  let markCount = 0;
  let clearCount = 0;
  let scrollOrWheelCount = 0;
  let queueCount = 0;

  try {
    inputMode.reset();
    bindCursorDocumentEvents({
      clearKeyboardPending: () => { clearCount++; },
      markKeyboardPending: () => { markCount++; },
      onScrollOrWheel: () => { scrollOrWheelCount++; },
      queueUpdate: () => { queueCount++; },
    });

    runtime.document.dispatch("input", eventFor(fixture.block, {
      inputType: "insertText",
      isComposing: false,
    }));
    assertInputMode(true);
    assert.equal(markCount, 1);

    inputMode.setBothOff();
    const composingMarksBefore = markCount;
    runtime.document.dispatch("input", eventFor(fixture.block, {
      inputType: "insertText",
      isComposing: true,
    }));
    assertInputMode(false);
    assert.equal(markCount, composingMarksBefore);

    inputMode.setBothOff();
    runtime.document.dispatch("compositionend", eventFor(fixture.block));
    assertInputMode(true);

    for (const key of ["Enter", "Backspace"]) {
      inputMode.setBothOff();
      runtime.document.dispatch("keydown", eventFor(fixture.block, {
        key,
        isComposing: false,
        defaultPrevented: false,
      }));
      assertInputMode(true);
    }

    for (const inputType of ["insertFromPaste", "insertFromDrop"]) {
      inputMode.setBothOff();
      const marksBefore = markCount;
      runtime.document.dispatch("input", eventFor(fixture.block, {
        inputType,
        isComposing: false,
      }));
      assertInputMode(false);
      assert.equal(markCount, marksBefore);
    }

    for (const key of ["ArrowUp", "ArrowDown", "PageUp", "PageDown"]) {
      inputMode.setBothOn();
      runtime.document.dispatch("keydown", eventFor(fixture.block, {
        key,
        isComposing: false,
        defaultPrevented: false,
      }));
      assertInputMode(false);
    }

    inputMode.setBothOn();
    runtime.document.dispatch("click", eventFor(outside));
    assertInputMode(false);

    inputMode.setBothOn();
    runtime.document.dispatch("click", eventFor(fixture.block));
    assertInputMode(false);

    inputMode.setBothOn();
    runtime.document.dispatch("wheel", eventFor(outside));
    assertInputMode(false);
    assert.equal(scrollOrWheelCount, 0);

    inputMode.setBothOn();
    runtime.document.dispatch("wheel", eventFor(fixture.block));
    assertInputMode(false);
    assert.equal(scrollOrWheelCount, 1);

    inputMode.setBothOn();
    runtime.document.dispatch("touchmove", eventFor(outside));
    assertInputMode(false);

    inputMode.setBothOn();
    runtime.document.dispatch("scroll", eventFor(fixture.block));
    assertInputMode(true);
    assert.equal(scrollOrWheelCount, 2);

    inputMode.setBothOn();
    inputModeTriggers.onSwitchProtyle();
    assertInputMode(false);

    inputMode.setBothOn();
    runtime.document.dispatch("focusout", eventFor(fixture.block, {
      relatedTarget: sibling,
    }));
    assertInputMode(true);
    runtime.document.dispatch("focusout", eventFor(fixture.block, {
      relatedTarget: outside,
    }));
    assertInputMode(false);

    inputMode.setBothOn();
    runtime.window.dispatch("blur");
    assertInputMode(false);

    inputMode.setBothOn();
    runtime.document.dispatch("keydown", eventFor(readonly, {
      key: "a",
      isComposing: false,
      defaultPrevented: false,
    }));
    assertInputMode(false);

    inputMode.setBothOn();
    runtime.document.dispatch("selectionchange");
    assertInputMode(true);
    runtime.setCaret(readonly, 0, rect(20, 500));
    runtime.document.dispatch("selectionchange");
    assertInputMode(false);

    assert.equal(clearCount > 0, true);
    assert.equal(queueCount > 0, true);
  } finally {
    destroyCursorDocumentEvents();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("typewriter gives an idle first character an immediate scroll opportunity", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime);
  runtime.clock.now = 10_000;

  try {
    inputMode.reset();
    initTypewriter();
    const caret = rect(20, 800);
    runtime.setCaret(fixture.text, 1, caret);
    runtime.document.dispatch("input", eventFor(fixture.block, {
      inputType: "insertText",
      isComposing: false,
    }));
    runtime.document.dispatch("selectionchange");
    assert.equal(runtime.raf.pending.size, 1);
    runtime.raf.flushNext(runtime.clock.now);

    assert.deepEqual(runtime.clock.delays(), []);
    assert.equal(runtime.raf.pending.size, 1, "check must start scroll without waiting for debounce");
    assert.equal(fixture.content.scrollTop, 0);

    const firstScrollFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(firstScrollFrame);
    runtime.raf.flush(firstScrollFrame, runtime.clock.now);
    runtime.clock.advance(600);
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(fixture.content.scrollTop > 0, true);
  } finally {
    destroyTypewriter();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("typewriter coalesces continuous typing and scrolls when its debounce expires", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime);
  runtime.clock.now = 20_000;

  try {
    inputMode.reset();
    initTypewriter();

    runtime.setCaret(fixture.text, 1, rect(20, 400));
    runtime.document.dispatch("input", eventFor(fixture.block, {
      inputType: "insertText",
      isComposing: false,
    }));
    runtime.document.dispatch("selectionchange");
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(runtime.raf.pending.size, 0);

    runtime.clock.advance(100);
    runtime.setCaret(fixture.text, 1, rect(20, 402));
    runtime.document.dispatch("input", eventFor(fixture.block, {
      inputType: "insertText",
      isComposing: false,
    }));
    runtime.document.dispatch("selectionchange");
    runtime.raf.flushNext(runtime.clock.now);

    assert.equal(runtime.raf.pending.size, 0);
    assert.deepEqual(runtime.clock.delays(), [401]);

    runtime.setCaret(fixture.text, 1, rect(20, 800));
    runtime.clock.advance(401);
    assert.equal(runtime.raf.pending.size, 1, "debounce expiry must schedule the current scroll");
    assert.equal(fixture.content.scrollTop, 0);
  } finally {
    destroyTypewriter();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("typewriter uses the outer trigger band and inner settle target", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime);
  runtime.clock.now = 25_000;

  try {
    inputMode.reset();
    initTypewriter();

    runtime.setCaret(fixture.text, 1, rect(20, 520));
    runtime.document.dispatch("input", eventFor(fixture.block, {
      inputType: "insertText",
      isComposing: false,
    }));
    runtime.document.dispatch("selectionchange");
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(runtime.raf.pending.size, 0, "caret inside the trigger band must hold");
    assert.equal(fixture.content.scrollTop, 0);

    runtime.clock.advance(401);
    runtime.setCaret(fixture.text, 1, rect(20, 550));
    runtime.document.dispatch("selectionchange");
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(runtime.raf.pending.size, 1, "caret below the trigger band must start one scroll");
    runtime.raf.flushNext(runtime.clock.now);
    const firstScrollFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(firstScrollFrame);
    runtime.raf.flush(firstScrollFrame, runtime.clock.now);
    assert.equal(runtime.raf.pending.size, 1);

    const scrollFrame = [...runtime.raf.pending.keys()][0];
    runtime.clock.advance(1000);
    runtime.raf.flush(scrollFrame, runtime.clock.now);
    assert.equal(
      Math.round(fixture.content.scrollTop),
      70,
      "ordinary following settles at 48% instead of the old 50% boundary",
    );
  } finally {
    destroyTypewriter();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("typewriter click relocation keeps its existing 50% center target", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime);
  runtime.clock.now = 26_000;

  try {
    inputMode.reset();
    initTypewriter();
    runtime.setCaret(fixture.text, 1, rect(20, 800));
    runtime.document.dispatch("click", eventFor(fixture.block));
    runtime.raf.flushNext(runtime.clock.now);

    assert.equal(runtime.raf.pending.size, 1, "an explicit far click starts its own motion");
    const firstScrollFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(firstScrollFrame);
    runtime.raf.flush(firstScrollFrame, runtime.clock.now);
    const scrollFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(scrollFrame);
    runtime.clock.advance(1000);
    runtime.raf.flush(scrollFrame, runtime.clock.now);
    assert.equal(Math.round(fixture.content.scrollTop), 300);
  } finally {
    destroyTypewriter();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("typewriter hard-pauses during IME composition and debounces compositionend", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime);
  runtime.clock.now = 30_000;

  try {
    inputMode.reset();
    initTypewriter();
    runtime.setCaret(fixture.text, 1, rect(20, 800));
    runtime.document.dispatch("input", eventFor(fixture.block, {
      inputType: "insertText",
      isComposing: false,
    }));
    runtime.document.dispatch("selectionchange");
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(runtime.raf.pending.size, 1, "composition starts with one in-flight smooth scroll");

    runtime.document.dispatch("compositionstart", eventFor(fixture.block));
    assert.equal(runtime.raf.pending.size, 0, "composition cancels the in-flight scroll");
    assert.deepEqual(runtime.clock.delays(), []);
    runtime.document.dispatch("selectionchange");
    assert.equal(runtime.raf.pending.size, 1, "selectionchange still queues a guarded check while composing");
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(runtime.raf.pending.size, 0);
    assert.equal(fixture.content.scrollTop, 0);

    runtime.setCaret(fixture.text, 1, rect(20, 850));
    runtime.document.dispatch("compositionend", eventFor(fixture.block));
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(runtime.raf.pending.size, 1, "compositionend first waits through the vertical layout defer");
    assert.deepEqual(runtime.clock.delays(), []);
    runtime.raf.flushNext(runtime.clock.now);
    assert.deepEqual(runtime.clock.delays(), [401]);
    assert.equal(fixture.content.scrollTop, 0);

    runtime.clock.advance(401);
    assert.equal(runtime.raf.pending.size, 1);
  } finally {
    destroyTypewriter();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("typewriter defers transient caret changes until active scroll settles", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime);
  runtime.clock.now = 60_000;

  try {
    inputMode.reset();
    initTypewriter();
    runtime.setCaret(fixture.text, 1, rect(20, 800));
    runtime.document.dispatch("input", eventFor(fixture.block, {
      inputType: "insertText",
      isComposing: false,
    }));
    runtime.document.dispatch("selectionchange");
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(runtime.raf.pending.size, 1);

    const initialScrollFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(initialScrollFrame);
    runtime.raf.flush(initialScrollFrame, runtime.clock.now);
    const firstScrollFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(firstScrollFrame);
    runtime.clock.advance(401);
    runtime.setCaret(fixture.text, 1, rect(20, 850));
    runtime.document.dispatch("selectionchange");
    const resyncCheckFrame = [...runtime.raf.pending.keys()][1];
    assert.ok(resyncCheckFrame);
    runtime.raf.flush(resyncCheckFrame, runtime.clock.now);
    assert.equal(runtime.raf.pending.size, 1, "transient geometry does not restart or add a loop");
    assert.equal(runtime.raf.pending.has(firstScrollFrame), true);

    runtime.clock.advance(600);
    runtime.raf.flush(firstScrollFrame, runtime.clock.now);
    assert.equal(Math.round(fixture.content.scrollTop), 320, "the current motion finishes naturally");
    assert.equal(runtime.raf.pending.size, 1, "completion schedules one final geometry resync");
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(runtime.raf.pending.size, 1, "the resync starts one follow-up loop at the safe point");
    const resyncScrollFrame = [...runtime.raf.pending.keys()][0];
    runtime.raf.flush(resyncScrollFrame, runtime.clock.now);
    const resyncProgressFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(resyncProgressFrame);
    runtime.clock.advance(600);
    runtime.raf.flush(resyncProgressFrame, runtime.clock.now);
    assert.equal(fixture.content.scrollTop > 300, true, "the latest caret target is eventually adopted");
    assert.equal(runtime.raf.pending.size, 0);
  } finally {
    destroyTypewriter();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("scroll starts its timeline from the first rAF timestamp", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime);
  runtime.clock.now = 1_000;
  fixture.content.scrollTop = 100;

  try {
    scroll.reset();
    scroll.scrollTo(fixture.content, { deltaY: 400, duration: 400 });
    const firstFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(firstFrame);

    // Model the SiYuan runtime's distinct performance/rAF clock origins:
    // performance.now() at request time is 1000, while the first rAF callback
    // receives 1100. The first renderable frame must still be the baseline.
    runtime.raf.flush(firstFrame, 1_100);
    assert.equal(fixture.content.scrollTop, 100);

    const secondFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(secondFrame);
    runtime.raf.flush(secondFrame, 1_200);
    assert.equal(
      fixture.content.scrollTop,
      331.25,
      "progress is based on the difference between rAF timestamps",
    );

    const finalFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(finalFrame);
    runtime.raf.flush(finalFrame, 1_500);
    assert.equal(fixture.content.scrollTop, 500);
    assert.equal(runtime.raf.pending.size, 0);
  } finally {
    scroll.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("cursor routes Typewriter-owned scrolls separately from manual input", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime);
  const routed: Array<{ source: CursorScrollSource; target: EventTarget | null }> = [];

  try {
    inputMode.reset();
    scroll.reset();
    bindCursorDocumentEvents({
      clearKeyboardPending: () => undefined,
      markKeyboardPending: () => undefined,
      onScrollOrWheel: (source, target) => routed.push({ source, target }),
      queueUpdate: () => undefined,
    });

    scroll.scrollTo(fixture.content, { deltaY: 100, duration: 100 });
    assert.equal(scroll.ownsActiveScroll(fixture.content), true);
    assert.equal(scroll.ownsActiveScroll(fixture.wysiwyg), false);

    runtime.document.dispatch("scroll", eventFor(fixture.content));
    runtime.document.dispatch("scroll", eventFor(fixture.wysiwyg));
    runtime.document.dispatch("wheel", eventFor(fixture.content));
    runtime.document.dispatch("touchmove", eventFor(fixture.content));

    assert.deepEqual(
      routed.map(({ source, target }) => ({
        source,
        manual: shouldUseManualScrollPolicy(
          source,
          false,
          source === "scroll" && scroll.ownsActiveScroll(target),
        ),
      })),
      [
        { source: "scroll", manual: false },
        { source: "scroll", manual: true },
        { source: "manual-input", manual: true },
        { source: "manual-input", manual: true },
      ],
    );
    assert.equal(shouldUseManualScrollPolicy("manual-input", true, true), true);

    const firstFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(firstFrame);
    runtime.raf.flush(firstFrame, 0);
    const finalFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(finalFrame);
    runtime.raf.flush(finalFrame, 100);
    assert.equal(scroll.ownsActiveScroll(fixture.content), false);

    runtime.document.dispatch("scroll", eventFor(fixture.content));
    const finalRoute = routed.at(-1);
    assert.ok(finalRoute);
    assert.equal(finalRoute.source, "scroll");
    assert.equal(
      shouldUseManualScrollPolicy(
        finalRoute.source,
        false,
        scroll.ownsActiveScroll(finalRoute.target),
      ),
      true,
    );
  } finally {
    destroyCursorDocumentEvents();
    scroll.reset();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("scroll keeps its active timeline while adopting a structural resync target", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime);
  let settledCount = 0;

  try {
    scroll.reset();
    scroll.scrollTo(fixture.content, { deltaY: 400, duration: 600 });
    const firstFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(firstFrame);

    runtime.raf.flush(firstFrame, runtime.clock.now);
    const firstProgressFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(firstProgressFrame);
    runtime.clock.advance(200);
    runtime.raf.flush(firstProgressFrame, runtime.clock.now);
    const activeFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(activeFrame);

    scroll.scrollTo(
      fixture.content,
      { deltaY: 100, duration: 600 },
      () => { settledCount++; },
    );
    assert.equal(runtime.raf.pending.size, 1, "retargeting reuses the active loop");
    assert.equal(runtime.raf.pending.has(activeFrame), true);

    runtime.clock.advance(100);
    runtime.raf.flush(activeFrame, runtime.clock.now);
    assert.equal(
      Math.round(fixture.content.scrollTop),
      334,
      "the retarget keeps the original easing timeline instead of restarting at t=0",
    );
    assert.equal(runtime.raf.pending.size, 1);

    const completionFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(completionFrame);
    runtime.clock.advance(300);
    runtime.raf.flush(completionFrame, runtime.clock.now);
    assert.equal(settledCount, 1, "an active retarget settles exactly once");
    assert.equal(runtime.raf.pending.size, 0);

    scroll.scrollTo(fixture.content, { deltaY: 50 });
    const cancellableFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(cancellableFrame);
    scroll.requestResync(() => { settledCount++; });
    scroll.cancel();
    assert.equal(runtime.raf.pending.size, 0, "cancel stops the one active loop");
    runtime.clock.advance(1000);
    assert.equal(settledCount, 1, "cancel does not invoke a stale resync callback");
  } finally {
    scroll.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("typewriter waits for stable structural geometry before changing active scroll", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime);
  runtime.clock.now = 80_000;

  try {
    inputMode.reset();
    initTypewriter();
    runtime.setCaret(fixture.text, 1, rect(20, 800));
    runtime.document.dispatch("input", eventFor(fixture.block, {
      inputType: "insertText",
      isComposing: false,
    }));
    runtime.document.dispatch("selectionchange");
    runtime.raf.flushNext(runtime.clock.now);

    let activeScrollFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(activeScrollFrame);
    runtime.raf.flush(activeScrollFrame, runtime.clock.now);
    activeScrollFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(activeScrollFrame);

    // Start a structural edit while a scroll is in flight. The first
    // selectionchange reports a transient comfort-zone position.
    runtime.setCaret(fixture.text, 0, rect(20, 400));
    runtime.document.dispatch("keydown", eventFor(fixture.block, {
      key: "Backspace",
      isComposing: false,
      defaultPrevented: false,
    }));
    runtime.document.dispatch("selectionchange");
    const pendingFrames = [...runtime.raf.pending.keys()];
    const transientCheck = pendingFrames[pendingFrames.length - 1];
    assert.ok(transientCheck);
    runtime.raf.flush(transientCheck, runtime.clock.now);
    assert.equal(
      runtime.raf.pending.has(activeScrollFrame),
      true,
      "transient geometry does not cancel the active structural motion",
    );

    // Publish the stable caret before draining the FLIP and coordinator settle
    // work; only the structural settle callback may consume this target.
    runtime.setCaret(fixture.text, 1, rect(20, 900));
    let settleFrameCount = 0;
    while (true) {
      const nonScrollFrame = [...runtime.raf.pending.keys()].find((id) => id !== activeScrollFrame);
      if (nonScrollFrame === undefined) break;
      assert.ok(settleFrameCount++ < 16, "settle and readiness frames must remain bounded");
      runtime.clock.advance(16);
      runtime.raf.flush(nonScrollFrame, runtime.clock.now);
    }
    assert.equal(settleFrameCount >= 2, true, "structural scrolling waits through two settle frames");
    assert.equal(runtime.raf.pending.has(activeScrollFrame), true);
    assert.equal(runtime.raf.pending.size, 1, "the structural check reuses one active loop");

    // A later transient comfort-zone check still leaves the authoritative
    // motion alive; it only requests a post-settle geometry resync.
    runtime.setCaret(fixture.text, 1, rect(20, 400));
    runtime.document.dispatch("selectionchange");
    let nonScrollFrame = [...runtime.raf.pending.keys()].find((id) => id !== activeScrollFrame);
    assert.ok(nonScrollFrame);
    runtime.raf.flush(nonScrollFrame, runtime.clock.now);
    assert.equal(runtime.raf.pending.has(activeScrollFrame), true);

    runtime.clock.advance(600);
    runtime.raf.flush(activeScrollFrame, runtime.clock.now);
    assert.equal(fixture.content.scrollTop > 0, true, "the stable structural target eventually scrolls");
  } finally {
    destroyTypewriter();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("reduced motion uses immediate scroll and cancels an in-flight smooth scroll", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime);
  runtime.clock.now = 70_000;

  try {
    inputMode.reset();
    runtime.window.reducedMotion = true;
    initTypewriter();
    runtime.setCaret(fixture.text, 1, rect(20, 800));
    runtime.document.dispatch("input", eventFor(fixture.block, {
      inputType: "insertText",
      isComposing: false,
    }));
    runtime.document.dispatch("selectionchange");
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(fixture.content.scrollTop > 0, true);
    assert.equal(runtime.raf.pending.size, 0);

    destroyTypewriter();
    inputMode.reset();
    runtime.raf.pending.clear();
    runtime.clock.pending.clear();
    runtime.window.reducedMotion = false;
    initTypewriter();
    runtime.setCaret(fixture.text, 1, rect(20, 800));
    runtime.document.dispatch("input", eventFor(fixture.block, {
      inputType: "insertText",
      isComposing: false,
    }));
    runtime.document.dispatch("selectionchange");
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(runtime.raf.pending.size, 1);

    runtime.window.reducedMotion = true;
    runtime.setCaret(fixture.text, 1, rect(20, 850));
    runtime.document.dispatch("selectionchange");
    const checkFrame = [...runtime.raf.pending.keys()][1];
    assert.ok(checkFrame);
    runtime.raf.flush(checkFrame, runtime.clock.now);
    assert.equal(runtime.raf.pending.size, 1, "a large layout jump gets one deferred recheck after cancellation");
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(runtime.raf.pending.size, 0);
    assert.equal(fixture.content.scrollTop > 0, true);
  } finally {
    destroyTypewriter();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("Cursor, Typewriter, and Ripple keep one input session across shared events", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime, "current sentence");
  const readonly = new FakeElement();
  readonly.setAttribute("contenteditable", "false");
  append(fixture.editor, readonly);
  runtime.clock.now = 80_000;

  try {
    inputMode.reset();
    initCursor();
    initTypewriter();
    initRipple();
    assert.equal(runtime.document.listenerCount("input"), 3);
    assert.equal(runtime.document.listenerCount("selectionchange"), 3);
    assert.equal(runtime.document.listenerCount("keydown"), 2);

    inputMode.setBothOff();
    runtime.setCaret(fixture.text, 1, rect(20, 500));
    runtime.document.dispatch("input", eventFor(fixture.block, {
      inputType: "insertText",
      isComposing: false,
    }));
    assertInputMode(true);
    assert.equal(
      fixture.block.style.getPropertyValue("--zt-ripple-opacity"),
      "1",
      "Ripple observes the same activation synchronously",
    );

    while (runtime.raf.pending.size > 0) runtime.raf.flushNext(runtime.clock.now);
    assert.equal(runtime.document.getElementById("zentype-cursor") !== null, true);

    runtime.document.dispatch("click", eventFor(new FakeElement()));
    assertInputMode(false);
    assert.equal(fixture.block.style.getPropertyValue("--zt-ripple-opacity"), "");

    inputMode.setBothOn();
    runtime.document.dispatch("wheel", eventFor(new FakeElement()));
    assertInputMode(false);

    inputMode.setBothOn();
    runtime.setCaret(readonly, 0, rect(20, 500));
    runtime.document.dispatch("selectionchange");
    assertInputMode(false);

    destroyCursor();
    destroyTypewriter();
    destroyRipple();
    assert.equal(runtime.document.listenerCount("input"), 0);
    assert.equal(runtime.document.listenerCount("selectionchange"), 0);
    assert.equal(runtime.document.listenerCount("keydown"), 0);
    assert.equal(runtime.window.listenerCount("resize"), 0);
    assert.equal(runtime.document.getElementById("zentype-cursor"), null);
    assert.equal(runtime.raf.pending.size, 0);
    runtime.clock.advance(1000);
    assert.equal(runtime.clock.pending.size, 0);
    assert.equal(fixture.block.style.getPropertyValue("--zt-ripple-opacity"), "");

    const queueBeforeDeadEvent = runtime.raf.pending.size;
    inputMode.setBothOn();
    runtime.document.dispatch("input", eventFor(fixture.block, {
      inputType: "insertText",
      isComposing: false,
    }));
    assert.equal(runtime.raf.pending.size, queueBeforeDeadEvent);

    inputMode.reset();
    runtime.setCaret(fixture.text, 1, rect(20, 500));
    initCursor();
    initTypewriter();
    initRipple();
    assert.equal(runtime.document.listenerCount("input"), 3);
    assert.equal(runtime.document.listenerCount("selectionchange"), 3);
    assertInputMode(true);
  } finally {
    destroyCursor();
    destroyTypewriter();
    destroyRipple();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("cursor fails open on invalid geometry, active-editor mismatch, and rejected boundary", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime, "cursor");
  runtime.clock.now = 90_000;

  try {
    inputMode.reset();
    initCursor();
    runtime.raf.flushNext(runtime.clock.now);
    runtime.raf.flushNext(runtime.clock.now);

    const cursor = runtime.document.getElementById("zentype-cursor");
    assert.ok(cursor);
    assert.equal(cursor.classList.contains("hidden"), false);
    assert.equal(fixture.block.classList.contains("zentype-custom-caret-active"), true);

    runtime.clearCaret();
    onProtyleLoaded({} as never);
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(cursor.classList.contains("hidden"), true);
    assert.equal(fixture.block.classList.contains("zentype-custom-caret-active"), false);

    const otherEditor = new FakeElement({ classes: ["protyle"] });
    setActiveEditor({ protyle: { element: otherEditor } });
    runtime.setCaret(fixture.text, 1, rect(20, 500));
    onProtyleLoaded({} as never);
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(cursor.classList.contains("hidden"), true);
    assert.equal(fixture.block.classList.contains("zentype-custom-caret-active"), false);

    setActiveEditor({ protyle: { element: fixture.editor } });
    fixture.content.rect = rect(0, 100, 1000, 100);
    runtime.setCaret(fixture.text, 1, rect(20, 500));
    onProtyleLoaded({} as never);
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(cursor.classList.contains("hidden"), true);
    assert.equal(fixture.block.classList.contains("zentype-custom-caret-active"), false);

    fixture.content.rect = rect(0, 0, 1000, 1000);
    runtime.setCaret(fixture.text, 1, rect(20, 500));
    onProtyleLoaded({} as never);
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(cursor.classList.contains("hidden"), false);
    assert.equal(fixture.block.classList.contains("zentype-custom-caret-active"), true);
  } finally {
    destroyCursor();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("cursor switch settle hides until stable, cancels stale settle, and reveals once", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const cursor = new FakeElement();
  cursor.classList.add("hidden", "no-transition");
  const target = { x: 10, y: 20, height: 20 };
  let queueUpdates = 0;
  let resumeBreathing = 0;
  let cancelTransition = 0;

  try {
    stopSwitchSettle();
    runtime.clock.now = 0;
    startSwitchSettle({
      getCursorElement: () => cursor as unknown as HTMLDivElement,
      sampleTarget: () => target,
      cancelRemoveTransitionFrame: () => { cancelTransition++; },
      pauseBreathe: () => undefined,
      queueUpdate: () => { queueUpdates++; },
      scheduleResumeBreathe: () => { resumeBreathing++; },
    });
    assert.equal(isSwitchHiddenActive(), true);
    assert.equal(isSwitchRevealPending(), false);
    assert.equal(cursor.style.opacity, "0");
    assert.equal(cursor.classList.contains("no-animation"), true);
    assert.equal(cursor.classList.contains("no-transition"), false);

    for (let index = 0; index < 8; index++) {
      runtime.clock.now = (index + 1) * 30;
      runtime.raf.flushNext(runtime.clock.now);
    }
    assert.equal(isSwitchHiddenActive(), false);
    assert.equal(isSwitchRevealPending(), true);
    assert.equal(queueUpdates, 1);
    assert.equal(cursor.classList.contains("no-transition"), true);

    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(isSwitchRevealPending(), false);
    assert.equal(cursor.style.opacity, "");
    assert.equal(cursor.classList.contains("no-transition"), false);
    assert.equal(cursor.classList.contains("no-animation"), false);
    assert.equal(resumeBreathing, 1);

    startSwitchSettle({
      getCursorElement: () => cursor as unknown as HTMLDivElement,
      sampleTarget: () => target,
      cancelRemoveTransitionFrame: () => { cancelTransition++; },
      pauseBreathe: () => undefined,
      queueUpdate: () => { queueUpdates++; },
      scheduleResumeBreathe: () => { resumeBreathing++; },
    });
    const pendingBeforeRestart = runtime.raf.pending.size;
    startSwitchSettle({
      getCursorElement: () => cursor as unknown as HTMLDivElement,
      sampleTarget: () => target,
      cancelRemoveTransitionFrame: () => { cancelTransition++; },
      pauseBreathe: () => undefined,
      queueUpdate: () => { queueUpdates++; },
      scheduleResumeBreathe: () => { resumeBreathing++; },
    });
    assert.equal(pendingBeforeRestart, 1);
    assert.equal(runtime.raf.pending.size, 1);
    assert.equal(cancelTransition, 3);
    stopSwitchSettle();
    assert.equal(runtime.raf.pending.size, 0);
    assert.equal(isSwitchHiddenActive(), false);
    assert.equal(isSwitchRevealPending(), false);
  } finally {
    stopSwitchSettle();
    runtime.restore();
  }
});

test("module lifecycle releases owned resources and reinitializes cleanly", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime, "lifecycle sentence.");

  const initAll = () => {
    initCursor();
    initTypewriter();
    initRipple();
    flushAllFrames(runtime);
  };

  try {
    inputMode.reset();
    initAll();

    assert.equal(runtime.document.listenerCount("input"), 3);
    assert.equal(runtime.document.listenerCount("selectionchange"), 3);
    assert.equal(runtime.document.listenerCount("keydown"), 2);
    assert.equal(runtime.window.listenerCount("resize"), 2);
    assert.equal(fixture.content.listenerCount("scroll"), 1);
    assert.equal(fixture.content.listenerCount("wheel"), 1);
    assert.equal(runtime.resizeObservers.filter((observer) => !observer.disconnected).length, 2);
    assert.equal(runtime.mutationObservers.filter((observer) => !observer.disconnected).length, 2);

    const firstCursor = runtime.document.getElementById("zentype-cursor");
    assert.ok(firstCursor);
    assert.equal(fixture.block.classList.contains("zentype-custom-caret-active"), true);
    assert.equal(fixture.block.classList.contains("zentype-ripple-block"), true);
    assert.equal(runtime.document.documentElement.style.getPropertyValue("--zt-sentence-dim-color") !== "", true);
    assert.equal(runtime.clock.pending.size > 0, true, "cursor breathing remains timer-owned until destroy");

    onProtyleSwitched({} as never);
    assert.equal(isSwitchHiddenActive(), true);
    assert.equal(runtime.raf.pending.size > 0, true);

    const firstResizeObservers = [...runtime.resizeObservers];
    const firstMutationObservers = [...runtime.mutationObservers];
    destroyCursor();
    assert.equal(isSwitchHiddenActive(), false);
    assert.equal(runtime.document.getElementById("zentype-cursor"), null);
    assert.equal(fixture.block.classList.contains("zentype-custom-caret-active"), false);
    assert.equal(runtime.raf.pending.size, 0, "destroy cancels the pending switch reveal");

    destroyTypewriter();
    destroyRipple();
    assert.equal(runtime.document.listenerCount("input"), 0);
    assert.equal(runtime.document.listenerCount("selectionchange"), 0);
    assert.equal(runtime.document.listenerCount("keydown"), 0);
    assert.equal(runtime.window.listenerCount("resize"), 0);
    assert.equal(fixture.content.listenerCount("scroll"), 0);
    assert.equal(fixture.content.listenerCount("wheel"), 0);
    assert.equal(runtime.resizeObservers.every((observer) => observer.disconnected), true);
    assert.equal(runtime.mutationObservers.every((observer) => observer.disconnected), true);
    runtime.clock.advance(1000);
    assert.equal(runtime.clock.pending.size, 0);
    assert.equal(runtime.highlights.size, 0);
    assert.equal(fixture.block.classList.contains("zentype-ripple-block"), false);
    assert.equal(runtime.document.documentElement.style.getPropertyValue("--zt-sentence-dim-color"), "");

    // A callback retained by an old observer must be harmless after teardown.
    for (const observer of firstResizeObservers) {
      observer.callback([], observer as unknown as ResizeObserver);
    }
    for (const observer of firstMutationObservers) observer.callback([]);
    assert.equal(runtime.raf.pending.size, 0);
    assert.equal(runtime.clock.pending.size, 0);

    inputMode.reset();
    runtime.setCaret(fixture.text, 1, rect(20, 500));
    initAll();
    const secondCursor = runtime.document.getElementById("zentype-cursor");
    assert.ok(secondCursor);
    assert.notEqual(secondCursor, firstCursor);
    assert.equal(runtime.document.listenerCount("input"), 3);
    assert.equal(runtime.document.listenerCount("selectionchange"), 3);
    assert.equal(runtime.resizeObservers.filter((observer) => !observer.disconnected).length, 2);
    assert.equal(runtime.mutationObservers.filter((observer) => !observer.disconnected).length, 2);
    assert.equal(fixture.block.classList.contains("zentype-custom-caret-active"), true);
    assert.equal(fixture.block.classList.contains("zentype-ripple-block"), true);
  } finally {
    destroyCursor();
    destroyTypewriter();
    destroyRipple();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("cursor rebinds resize and scroll resources after an editor container replacement", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const first = createEditorFixture(runtime, "first");

  try {
    inputMode.reset();
    initCursor();
    flushAllFrames(runtime);
    const firstResizeObservers = [...runtime.resizeObservers];
    assert.equal(firstResizeObservers.filter((observer) => !observer.disconnected).length, 2);
    assert.equal(first.content.listenerCount("scroll"), 1);
    assert.equal(first.content.listenerCount("wheel"), 1);

    first.editor.remove();
    const second = createEditorFixture(runtime, "second");
    runtime.setCaret(second.text, 1, rect(20, 500));
    onProtyleLoaded({} as never);
    flushAllFrames(runtime);

    assert.equal(firstResizeObservers.every((observer) => observer.disconnected), true);
    assert.equal(runtime.resizeObservers.filter((observer) => !observer.disconnected).length, 2);
    assert.equal(first.content.listenerCount("scroll"), 0);
    assert.equal(first.content.listenerCount("wheel"), 0);
    assert.equal(second.content.listenerCount("scroll"), 1);
    assert.equal(second.content.listenerCount("wheel"), 1);
    assert.equal(first.block.classList.contains("zentype-custom-caret-active"), false);
    assert.equal(second.block.classList.contains("zentype-custom-caret-active"), true);
  } finally {
    destroyCursor();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("cursor keyboard cooldown keeps scroll and resize refreshes transition-safe", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime, "cooldown");

  try {
    inputMode.reset();
    initCursor();
    flushAllFrames(runtime);
    const cursor = runtime.document.getElementById("zentype-cursor");
    assert.ok(cursor);
    assert.equal(cursor.classList.contains("no-transition"), false);

    runtime.document.dispatch("keydown", eventFor(fixture.block, {
      key: "a",
      isComposing: false,
      defaultPrevented: false,
    }));
    const resizeObserver = runtime.resizeObservers.find((observer) => !observer.disconnected);
    assert.ok(resizeObserver);
    resizeObserver.callback([], resizeObserver as unknown as ResizeObserver);
    runtime.document.dispatch("scroll", eventFor(fixture.block));
    assert.equal(cursor.classList.contains("no-transition"), false);
    assert.equal(cursor.classList.contains("no-animation"), true);
    flushAllFrames(runtime);

    runtime.clock.advance(300);
    resizeObserver.callback([], resizeObserver as unknown as ResizeObserver);
    assert.equal(cursor.classList.contains("no-transition"), true);
    assert.equal(runtime.raf.pending.size > 0, true);
  } finally {
    destroyCursor();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("cursor popover drag binding is released when the popover is removed", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime, "popover");
  const popover = new FakeElement({ classes: ["block__popover"] });
  const dragHandle = new FakeElement({ classes: ["resize__move"] });
  fixture.wysiwyg.removeChild(fixture.block);
  append(popover, dragHandle, fixture.block);
  append(fixture.wysiwyg, popover);

  try {
    inputMode.reset();
    initCursor();
    flushAllFrames(runtime);
    assert.equal(dragHandle.listenerCount("mousedown"), 1);
    assert.equal(runtime.document.listenerCount("mousemove"), 1);
    assert.equal(runtime.document.listenerCount("mouseup"), 2);

    dragHandle.dispatch("mousedown");
    runtime.document.dispatch("mousemove");
    assert.equal(runtime.document.getElementById("zentype-cursor")?.classList.contains("no-transition"), true);
    assert.equal(runtime.raf.pending.size > 0, true);
    runtime.document.dispatch("mouseup");

    const removalObserver = runtime.mutationObservers.find((observer) =>
      observer.observed.includes(fixture.wysiwyg));
    assert.ok(removalObserver);
    popover.remove();
    removalObserver.callback([]);
    assert.equal(removalObserver.disconnected, true);
    assert.equal(dragHandle.listenerCount("mousedown"), 0);
    assert.equal(runtime.document.listenerCount("mousemove"), 0);
    assert.equal(runtime.document.listenerCount("mouseup"), 1);
  } finally {
    destroyCursor();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("ripple seam keeps nested focus and top-level opacity as separate layers", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createRippleFixture(runtime);
  fixture.topSibling.style.setProperty("--zt-ripple-opacity", "host-opacity", "important");
  fixture.topSibling.style.setProperty("color", "host-color");

  try {
    inputMode.reset();
    inputMode.setBothOn();
    initRipple();
    runtime.raf.flushNext(runtime.clock.now);

    assert.equal(fixture.focusContent.style.getPropertyValue("--zt-ripple-opacity"), "0.4");
    assert.equal(fixture.focusContent.classList.contains("zentype-ripple-block"), true);
    assert.equal(
      fixture.focusItem.style.getPropertyValue("--zt-ripple-opacity"),
      "",
      "the nested wrapper must not add a second opacity layer",
    );
    assert.equal(fixture.siblingItem.style.getPropertyValue("--zt-ripple-opacity"), "0.4");
    assert.equal(fixture.topSibling.style.getPropertyValue("--zt-ripple-opacity"), "0.4");
    assert.equal(fixture.secondTopSibling.style.getPropertyValue("--zt-ripple-opacity"), "0.2");
    assert.equal(runtime.highlights.has("zt-sentence-dim"), true);

    runtime.setCaret(fixture.focusText, 1, rect(20, 400));
    runtime.document.dispatch("selectionchange");
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(fixture.focusContent.style.getPropertyValue("--zt-ripple-opacity"), "1");
    assert.equal(fixture.alternateContent.style.getPropertyValue("--zt-ripple-opacity"), "");
    assert.equal(fixture.topSibling.style.getPropertyValue("--zt-ripple-opacity"), "0.4");

    runtime.setCaret(fixture.alternateText, 1, rect(20, 400));
    runtime.document.dispatch("selectionchange");
    runtime.raf.flushNext(runtime.clock.now);

    const replacement = new FakeElement({
      dataType: "NodeParagraph",
      dataNodeId: "block:replacement",
      contentEditable: true,
    });
    const replacementText = new FakeText("replacement");
    append(replacement, replacementText);
    fixture.alternateItem.replaceChild(replacement, fixture.alternateContent);
    runtime.setCaret(replacementText, 1, rect(20, 400));
    const mutationObserver = runtime.mutationObservers.find((observer) =>
      observer.observed.includes(fixture.rootList));
    assert.ok(mutationObserver);
    mutationObserver.callback([{
      type: "childList",
      target: fixture.alternateItem,
      addedNodes: [replacement],
      removedNodes: [fixture.alternateContent],
    } as unknown as MutationRecord]);
    let structuralFrames = 0;
    while (isStructuralEditPending()) {
      assert.ok(structuralFrames++ < 4, "mutation fallback must settle in a bounded number of frames");
      runtime.clock.advance(16);
      runtime.raf.flushNext(runtime.clock.now);
    }
    assert.equal(replacement.style.getPropertyValue("--zt-ripple-opacity"), "1");
    assert.equal(fixture.alternateContent.style.getPropertyValue("--zt-ripple-opacity"), "");
    assert.equal(fixture.topSibling.style.getPropertyValue("--zt-ripple-opacity"), "0.4");

    const topSiblingText = fixture.topSibling.childNodes[0];
    assert.ok(topSiblingText instanceof FakeText);
    runtime.setCaret(topSiblingText, 1, rect(20, 400));
    runtime.document.dispatch("selectionchange");
    runtime.clock.advance(16);
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(fixture.topSibling.style.getPropertyValue("--zt-ripple-opacity"), "1");
    assert.equal(replacement.style.getPropertyValue("--zt-ripple-opacity"), "");
    inputMode.setBothOff();
    assert.equal(runtime.highlights.size, 0);
    assert.equal(fixture.topSibling.style.getPropertyValue("--zt-ripple-opacity"), "host-opacity");
    assert.equal(fixture.topSibling.style.getPropertyPriority("--zt-ripple-opacity"), "important");
    assert.equal(fixture.topSibling.style.getPropertyValue("color"), "host-color");
  } finally {
    destroyRipple();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("ripple preserves valid nested opacity until the coordinator commits a structural edit", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createRippleFixture(runtime);
  runtime.document.querySelector = () => null;

  try {
    inputMode.reset();
    inputMode.setBothOn();
    initRipple();
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(fixture.focusContent.style.getPropertyValue("--zt-ripple-opacity"), "0.4");

    const transientList = new FakeElement({ dataType: "NodeList" });
    Object.defineProperty(transientList, "children", {
      configurable: true,
      value: undefined,
    });
    append(fixture.alternateItem, transientList);
    runtime.document.dispatch("input", eventFor(fixture.alternateContent, {
      inputType: "insertParagraph",
      isComposing: false,
    }));
    assert.equal(isStructuralEditPending(), true);
    assert.equal(runtime.raf.pending.size, 1, "structural input starts one coordinator stability chain");

    runtime.clock.advance(16);
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(
      fixture.focusContent.style.getPropertyValue("--zt-ripple-opacity"),
      "0.4",
      "the transient malformed structure keeps the last valid opacity",
    );
    assert.equal(isStructuralEditPending(), true);
    fixture.alternateItem.removeChild(transientList);

    const newItem = new FakeElement({
      dataType: "NodeListItem",
      dataNodeId: "item:parent-level",
    });
    const newMarker = new FakeElement({ classes: ["protyle-action"] });
    const newContent = new FakeElement({
      dataType: "NodeParagraph",
      dataNodeId: "block:parent-level",
      contentEditable: true,
    });
    const newText = new FakeText("parent level");
    const newAttr = new FakeElement({ classes: ["protyle-attr"] });
    append(newContent, newText);
    append(newItem, newMarker, newContent, newAttr);
    append(fixture.rootList, newItem);
    runtime.setCaret(newText, 1, rect(20, 400));

    runtime.clock.advance(16);
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(isStructuralEditPending(), true);
    runtime.clock.advance(16);
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(newContent.style.getPropertyValue("--zt-ripple-opacity"), "1");
    assert.equal(fixture.focusContent.style.getPropertyValue("--zt-ripple-opacity"), "");
    assert.equal(runtime.raf.pending.size, 1, "a changed nested handoff retargets on the next frame");
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(runtime.raf.pending.size, 0);

    inputMode.setBothOff();
    assert.equal(newContent.style.getPropertyValue("--zt-ripple-opacity"), "");
    runtime.document.dispatch("input", eventFor(newContent, {
      inputType: "insertParagraph",
      isComposing: false,
    }));
    assert.equal(runtime.raf.pending.size, 0, "OFF clears structural input immediately");
  } finally {
    destroyRipple();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("ordinary Backspace and IME same-block rerenders do not start transactions", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createRippleFixture(runtime);

  try {
    inputMode.reset();
    initTypewriter();
    initRipple();
    runtime.raf.flushNext(runtime.clock.now);

    runtime.setCaret(fixture.alternateText, 1, rect(20, 400));
    runtime.document.dispatch("keydown", eventFor(fixture.alternateContent, {
      key: "Backspace",
      isComposing: false,
      defaultPrevented: false,
    }));
    assert.equal(isStructuralEditPending(), false, "mid-block Backspace is not pre-classified as structural");
    runtime.document.dispatch("input", eventFor(fixture.alternateContent, {
      inputType: "deleteContentBackward",
      isComposing: false,
    }));

    const replacement = new FakeElement({
      dataType: "NodeParagraph",
      dataNodeId: "block:alternate",
      contentEditable: true,
    });
    const replacementText = new FakeText("ime replacement");
    append(replacement, replacementText);
    fixture.alternateItem.replaceChild(replacement, fixture.alternateContent);
    runtime.setCaret(replacementText, 1, rect(20, 400));
    const mutationObserver = runtime.mutationObservers.find((observer) =>
      observer.observed.includes(fixture.rootList));
    assert.ok(mutationObserver);
    mutationObserver.callback([{
      type: "childList",
      target: fixture.alternateItem,
      addedNodes: [replacement],
      removedNodes: [fixture.alternateContent],
    } as unknown as MutationRecord]);
    assert.equal(isStructuralEditPending(), false);

    runtime.document.dispatch("compositionstart", eventFor(replacement));
    const imeReplacement = new FakeElement({
      dataType: "NodeParagraph",
      dataNodeId: "block:alternate",
      contentEditable: true,
    });
    const imeText = new FakeText("ime composition");
    append(imeReplacement, imeText);
    fixture.alternateItem.replaceChild(imeReplacement, replacement);
    runtime.setCaret(imeText, 1, rect(20, 400));
    mutationObserver.callback([{
      type: "childList",
      target: fixture.alternateItem,
      addedNodes: [imeReplacement],
      removedNodes: [replacement],
    } as unknown as MutationRecord]);
    assert.equal(isStructuralEditPending(), false, "IME tokenization replacement is representation-only");
  } finally {
    destroyTypewriter();
    destroyRipple();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("typewriter captures plain and Shift+Tab only inside a semantic list item", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createRippleFixture(runtime);
  const topSiblingText = fixture.topSibling.childNodes[0];
  assert.ok(topSiblingText instanceof FakeText);

  try {
    inputMode.reset();
    inputMode.setBothOn();
    initTypewriter();

    const dispatchTab = (target: FakeElement, extra: Record<string, unknown> = {}) => {
      runtime.document.dispatch("keydown", eventFor(target, {
        key: "Tab",
        isComposing: false,
        defaultPrevented: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        metaKey: false,
        ...extra,
      }));
    };

    runtime.setCaret(topSiblingText, 1, rect(20, 400));
    dispatchTab(fixture.topSibling);
    assert.equal(isStructuralEditPending(), false, "Tab outside a list item is not structural");

    runtime.setCaret(fixture.alternateText, 1, rect(20, 400));
    for (const extra of [
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
      { isComposing: true },
      { defaultPrevented: true },
    ]) {
      dispatchTab(fixture.alternateContent, extra);
      assert.equal(isStructuralEditPending(), false, "modified or composing Tab is ignored");
    }

    dispatchTab(fixture.alternateContent);
    const plainTab = getStructuralEditSnapshot();
    assert.equal(plainTab.phase, "mutating");
    assert.equal(plainTab.kind, "list-change");

    dispatchTab(fixture.alternateContent, { shiftKey: true });
    const shiftTab = getStructuralEditSnapshot();
    assert.equal(shiftTab.phase, "mutating");
    assert.equal(shiftTab.kind, "list-change");
    assert.equal(shiftTab.generation > plainTab.generation, true, "a new list action supersedes the old generation");
  } finally {
    destroyTypewriter();
    destroyStructuralEditCoordinator();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("Tab list intent stays authoritative through nested-list reparent and stable finish", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createRippleFixture(runtime);
  const finishes: Array<{ generation: number; kind: string; stable: boolean }> = [];
  const unsubscribe = subscribeStructuralEditFinish((finish) => finishes.push(finish));

  try {
    inputMode.reset();
    inputMode.setBothOn();
    initTypewriter();
    runtime.setCaret(fixture.alternateText, 1, rect(20, 550));
    runtime.document.dispatch("keydown", eventFor(fixture.alternateContent, {
      key: "Tab",
      isComposing: false,
      defaultPrevented: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    }));

    const started = getStructuralEditSnapshot();
    assert.equal(started.phase, "mutating");
    assert.equal(started.kind, "list-change");
    const generation = started.generation;

    const oldList = fixture.alternateItem.parentElement;
    assert.ok(oldList);
    const newList = new FakeElement({ dataType: "NodeList" });
    append(fixture.focusItem, newList);
    oldList.removeChild(fixture.alternateItem);
    append(newList, fixture.alternateItem);

    const observer = runtime.mutationObservers.find((candidate) =>
      candidate.observed.includes(fixture.wysiwyg));
    assert.ok(observer);
    observer.callback([
      {
        type: "childList",
        target: oldList,
        addedNodes: [],
        removedNodes: [fixture.alternateItem],
      },
      {
        type: "childList",
        target: newList,
        addedNodes: [fixture.alternateItem],
        removedNodes: [],
      },
    ] as unknown as MutationRecord[]);
    runtime.document.dispatch("selectionchange");

    const afterReparent = getStructuralEditSnapshot();
    assert.equal(afterReparent.generation, generation);
    assert.equal(afterReparent.phase, "mutating", "the semantic mutation has no idle gap");
    assert.equal(afterReparent.activityVersion > started.activityVersion, true);

    runtime.clock.now = 16;
    runtime.raf.flushNext(runtime.clock.now);
    runtime.clock.now = 32;
    runtime.raf.flushNext(runtime.clock.now);
    runtime.raf.flushNext(runtime.clock.now);
    runtime.clock.now = 48;
    runtime.raf.flushNext(runtime.clock.now);

    assert.deepEqual(
      finishes.map(({ generation: finishedGeneration, kind, stable }) => ({
        generation: finishedGeneration,
        kind,
        stable,
      })),
      [{ generation, kind: "list-change", stable: true }],
    );
    assert.equal(isStructuralEditPending(), false);
    assert.equal(runtime.raf.pending.size, 0, "list-change keeps the existing typing debounce");
    runtime.clock.advance(401);
    assert.equal(runtime.raf.pending.size, 1, "debounced list-change starts one scroll");
    const firstScrollFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(firstScrollFrame);
    runtime.raf.flush(firstScrollFrame, runtime.clock.now);
    const scrollFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(scrollFrame);
    runtime.clock.advance(1000);
    runtime.raf.flush(scrollFrame, runtime.clock.now);
    assert.equal(Math.round(fixture.content.scrollTop), 70);
  } finally {
    unsubscribe();
    destroyTypewriter();
    destroyStructuralEditCoordinator();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("pending structural transactions extend their quiet window for same-block rerenders", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createRippleFixture(runtime);

  try {
    inputMode.reset();
    inputMode.setBothOn();
    initRipple();
    runtime.raf.flushNext(runtime.clock.now);
    runtime.document.dispatch("input", eventFor(fixture.alternateContent, {
      inputType: "insertParagraph",
      isComposing: false,
    }));
    assert.equal(isStructuralEditPending(), true);
    const beforeRerender = getStructuralEditSnapshot();

    const replacement = new FakeElement({
      dataType: "NodeParagraph",
      dataNodeId: "block:alternate",
      contentEditable: true,
    });
    const replacementText = new FakeText("same block");
    append(replacement, replacementText);
    fixture.alternateItem.replaceChild(replacement, fixture.alternateContent);
    runtime.setCaret(replacementText, 1, rect(20, 400));
    runtime.clock.now = 20;
    const mutationObserver = runtime.mutationObservers.find((observer) =>
      observer.observed.includes(fixture.rootList));
    assert.ok(mutationObserver);
    mutationObserver.callback([{
      type: "childList",
      target: fixture.alternateItem,
      addedNodes: [replacement],
      removedNodes: [fixture.alternateContent],
    } as unknown as MutationRecord]);

    const afterRerender = getStructuralEditSnapshot();
    assert.equal(isStructuralEditPending(), true);
    assert.equal(afterRerender.activityVersion > beforeRerender.activityVersion, true);
    assert.equal(afterRerender.lastActivityAt, 20);

    runtime.clock.now = 36;
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(isStructuralEditPending(), true);
    runtime.clock.now = 52;
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(isStructuralEditPending(), true, "two quiet frames before 48ms must remain pending");
    runtime.clock.now = 68;
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(isStructuralEditPending(), false);
    assert.equal(replacement.style.getPropertyValue("--zt-ripple-opacity"), "1");
  } finally {
    destroyRipple();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("structural replacement carries dim visual state until normal Ripple ownership resumes", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createRippleFixture(runtime);

  try {
    inputMode.reset();
    inputMode.setBothOn();
    initRipple();
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(fixture.alternateContent.style.getPropertyValue("--zt-ripple-opacity"), "1");
    assert.equal(runtime.highlights.has("zt-sentence-dim"), true);

    runtime.document.dispatch("input", eventFor(fixture.alternateContent, {
      inputType: "insertParagraph",
      isComposing: false,
    }));
    assert.equal(isStructuralEditPending(), true);

    const replacement = new FakeElement({
      dataType: "NodeParagraph",
      dataNodeId: "block:alternate",
      contentEditable: true,
    });
    const replacementText = new FakeText("alternate. branch!");
    append(replacement, replacementText);

    const newItem = new FakeElement({
      dataType: "NodeListItem",
      dataNodeId: "item:after-enter",
    });
    const newMarker = new FakeElement({ classes: ["protyle-action"] });
    const newContent = new FakeElement({
      dataType: "NodeParagraph",
      dataNodeId: "block:after-enter",
      contentEditable: true,
    });
    const newText = new FakeText("new block");
    const newAttr = new FakeElement({ classes: ["protyle-attr"] });
    append(newContent, newText);
    append(newItem, newMarker, newContent, newAttr);

    const parentList = fixture.alternateItem.parentElement;
    assert.ok(parentList);
    fixture.alternateItem.replaceChild(replacement, fixture.alternateContent);
    append(parentList, newItem);
    runtime.setCaret(newText, 1, rect(20, 400));

    const mutationObserver = runtime.mutationObservers.find((observer) =>
      observer.observed.includes(fixture.rootList));
    assert.ok(mutationObserver);
    mutationObserver.callback([
      {
        type: "childList",
        target: fixture.alternateItem,
        addedNodes: [replacement],
        removedNodes: [fixture.alternateContent],
      },
      {
        type: "childList",
        target: parentList,
        addedNodes: [newItem],
        removedNodes: [],
      },
    ] as unknown as MutationRecord[]);

    assert.equal(
      replacement.style.getPropertyValue("--zt-ripple-opacity"),
      String(RIPPLE_CONFIG.BLOCK_LEVELS[1]),
      "the replacement avoids the natural full-brightness window",
    );
    assert.equal(
      replacement.style.getPropertyValue("--zt-ripple-transition-duration"),
      "0s",
    );
    assert.equal(replacement.classList.contains("zentype-ripple-block"), true);
    assert.equal(newContent.style.getPropertyValue("--zt-ripple-opacity"), "");

    let settleFrames = 0;
    while (isStructuralEditPending()) {
      assert.ok(settleFrames++ < 8, "structural replacement settles in a bounded window");
      runtime.clock.advance(16);
      runtime.raf.flushNext(runtime.clock.now);
    }
    while (runtime.raf.pending.size > 0) runtime.raf.flushNext(runtime.clock.now);

    assert.equal(newContent.style.getPropertyValue("--zt-ripple-opacity"), "1");
    assert.equal(replacement.style.getPropertyValue("--zt-ripple-opacity"), "");
    assert.equal(replacement.classList.contains("zentype-ripple-block"), false);
  } finally {
    destroyRipple();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("a semantic top-level block addition starts the idle fallback transaction", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createRippleFixture(runtime);

  try {
    inputMode.reset();
    inputMode.setBothOn();
    initRipple();
    runtime.raf.flushNext(runtime.clock.now);

    const addedItem = new FakeElement({
      dataType: "NodeListItem",
      dataNodeId: "item:added",
    });
    append(fixture.rootList, addedItem);
    const mutationObserver = runtime.mutationObservers.find((observer) =>
      observer.observed.includes(fixture.rootList));
    assert.ok(mutationObserver);
    mutationObserver.callback([{
      type: "childList",
      target: fixture.rootList,
      addedNodes: [addedItem],
      removedNodes: [],
    } as unknown as MutationRecord]);
    assert.equal(isStructuralEditPending(), true);

    runtime.clock.now = 16;
    runtime.raf.flushNext(runtime.clock.now);
    runtime.clock.now = 32;
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(isStructuralEditPending(), true);
    runtime.clock.now = 48;
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(isStructuralEditPending(), false);
  } finally {
    destroyRipple();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("ripple transitions a legacy block handoff before releasing ownership", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createRippleFixture(runtime);
  fixture.rootList.setAttribute("data-node-id", "root-list");
  const topSiblingText = fixture.topSibling.childNodes[0];
  assert.ok(topSiblingText instanceof FakeText);

  try {
    inputMode.reset();
    inputMode.setBothOn();
    runtime.setCaret(topSiblingText, 1, rect(20, 400));
    initRipple();
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(fixture.rootList.style.getPropertyValue("--zt-ripple-opacity"), "0.4");
    assert.equal(fixture.rootList.classList.contains("zentype-ripple-block"), true);

    runtime.setCaret(fixture.alternateText, 1, rect(20, 400));
    runtime.document.dispatch("selectionchange");
    runtime.raf.flushNext(runtime.clock.now);

    assert.equal(
      fixture.rootList.style.getPropertyValue("--zt-ripple-opacity"),
      "",
      "nested takeover releases the legacy parent without a natural-opacity stage",
    );
    assert.equal(
      fixture.rootList.classList.contains("zentype-ripple-block"),
      false,
      "the legacy class is removed when nested ownership takes over",
    );
    assert.equal(runtime.clock.delays().length, 0);

    // A nested-to-legacy handoff is immediate because the nested layer is
    // being replaced by the legacy parent layer.
    runtime.setCaret(topSiblingText, 1, rect(20, 400));
    runtime.document.dispatch("selectionchange");
    runtime.raf.flushNext(runtime.clock.now);
    runtime.setCaret(fixture.alternateText, 1, rect(20, 400));
    runtime.document.dispatch("selectionchange");
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(fixture.rootList.style.getPropertyValue("--zt-ripple-opacity"), "");
    assert.equal(fixture.rootList.classList.contains("zentype-ripple-block"), false);

    // Focus exit keeps a dim legacy target alive at natural opacity until the
    // configured transition has completed.
    runtime.setCaret(topSiblingText, 1, rect(20, 400));
    runtime.document.dispatch("selectionchange");
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(fixture.rootList.style.getPropertyValue("--zt-ripple-opacity"), "0.4");
    inputMode.setBothOff();
    assert.equal(fixture.rootList.style.getPropertyValue("--zt-ripple-opacity"), "1");
    assert.equal(fixture.rootList.classList.contains("zentype-ripple-block"), true);
    assert.equal(runtime.clock.delays().includes(400), true);
    runtime.clock.advance(400);
    inputMode.setBothOff();
    assert.equal(fixture.rootList.style.getPropertyValue("--zt-ripple-opacity"), "");
    assert.equal(fixture.rootList.classList.contains("zentype-ripple-block"), false);
    runtime.clock.advance(1000);
  } finally {
    destroyRipple();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("ripple retains outgoing sentence dim through a block handoff", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createRippleFixture(runtime);

  try {
    inputMode.reset();
    inputMode.setBothOn();
    initRipple();
    runtime.raf.flushNext(runtime.clock.now);

    const oldDim = runtime.highlights.get("zt-sentence-dim");
    assert.ok(oldDim);
    assert.equal(oldDim.ranges.some((range) => range.startContainer === fixture.alternateText), true);

    runtime.setCaret(fixture.focusText, 1, rect(20, 400));
    runtime.document.dispatch("selectionchange");
    runtime.raf.flushNext(runtime.clock.now);

    const outgoing = runtime.highlights.get("zt-sentence-outgoing-dim");
    assert.ok(outgoing, "the previous block keeps its dimmed sentence range");
    assert.equal(
      outgoing.ranges.some((range) => range.startContainer === fixture.alternateText),
      true,
    );
    const current = runtime.highlights.get("zt-sentence-dim");
    assert.ok(current);
    assert.equal(current.ranges.some((range) => range.startContainer === fixture.focusText), true);

    runtime.clock.advance(399);
    assert.equal(runtime.highlights.has("zt-sentence-outgoing-dim"), true);
    runtime.clock.advance(1);
    assert.equal(runtime.highlights.has("zt-sentence-outgoing-dim"), false);

    inputMode.setBothOff();
    assert.equal(runtime.highlights.size, 0, "OFF clears current and outgoing sentence highlights");
  } finally {
    destroyRipple();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("FLIP interruption freezes the rendered position and rebases the next edit", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime);
  const secondBlock = new FakeElement({
    dataNodeId: "block-second",
    contentEditable: true,
  });
  const secondText = new FakeText("second");
  secondBlock.rect = rect(0, 100, 1000, 20);
  append(secondBlock, secondText);
  append(fixture.wysiwyg, secondBlock);

  secondBlock.getBoundingClientRect = () => {
    if (secondBlock.style.transition.includes("250ms") && secondBlock.style.transform === "") {
      return rect(0, 90, 1000, 20);
    }
    const match = secondBlock.style.transform.match(/^translateY\((-?\d+(?:\.\d+)?)px\)$/);
    if (match) return rect(0, secondBlock.rect.top + Number(match[1]), 1000, 20);
    return secondBlock.rect;
  };

  try {
    flip.reset();
    const range = new FakeRange(fixture.text, 0);

    flip.start(fixture.wysiwyg, range as unknown as Range, runtime.raf.request);
    secondBlock.rect = rect(0, 80, 1000, 20);
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(secondBlock.style.transform, "translateY(20px)");
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(secondBlock.style.transition.includes("250ms"), true);
    assert.equal(flip.hasShiftedBlocks(), true);
    assert.deepEqual(runtime.clock.delays(), [300]);

    flip.start(fixture.wysiwyg, range as unknown as Range, runtime.raf.request);
    assert.equal(secondBlock.style.transform, "translateY(10px)");
    assert.deepEqual(runtime.clock.delays(), [], "the old cleanup timer is cancelled at interruption");

    secondBlock.rect = rect(0, 60, 1000, 20);
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(
      secondBlock.style.transform,
      "translateY(30px)",
      "the new Invert phase starts from the frozen rendered position",
    );
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(secondBlock.style.transform, "");
    assert.equal(secondBlock.style.transition.includes("250ms"), true);

    runtime.clock.advance(300);
    assert.equal(secondBlock.style.transform, "");
    assert.equal(secondBlock.style.transition, "");
    assert.equal(flip.hasShiftedBlocks(), false);
  } finally {
    flip.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("FLIP interruption batches baseline and logical geometry phases", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime);
  const secondBlock = new FakeElement({ dataNodeId: "block-second", contentEditable: true });
  const thirdBlock = new FakeElement({ dataNodeId: "block-third", contentEditable: true });
  append(secondBlock, new FakeText("second"));
  append(thirdBlock, new FakeText("third"));
  secondBlock.rect = rect(0, 100, 1000, 20);
  thirdBlock.rect = rect(0, 140, 1000, 20);
  append(fixture.wysiwyg, secondBlock, thirdBlock);

  const phases: string[] = [];
  const trackedBlocks: Array<[string, FakeElement]> = [
    ["second", secondBlock],
    ["third", thirdBlock],
  ];
  trackedBlocks.forEach(([name, block]) => {
    block.getBoundingClientRect = () => {
      phases.push(`read:${name}`);
      if (block.style.transition.includes("250ms") && block.style.transform === "") {
        return rect(0, block.rect.top + 10, 1000, 20);
      }
      const match = block.style.transform.match(/^translateY\((-?\d+(?:\.\d+)?)px\)$/);
      if (match) return rect(0, block.rect.top + Number(match[1]), 1000, 20);
      return block.rect;
    };
    const setProperty = block.style.setProperty.bind(block.style);
    block.style.setProperty = (property, value, priority = "") => {
      phases.push(`write:${name}:${property}`);
      setProperty(property, value, priority);
    };
  });
  Object.defineProperty(fixture.wysiwyg, "offsetHeight", {
    configurable: true,
    get: () => {
      phases.push("sync");
      return fixture.wysiwyg.rect.height;
    },
  });

  try {
    flip.reset();
    const range = new FakeRange(fixture.text, 0);
    flip.start(fixture.wysiwyg, range as unknown as Range, runtime.raf.request);
    secondBlock.rect = rect(0, 80, 1000, 20);
    thirdBlock.rect = rect(0, 120, 1000, 20);
    runtime.raf.flushNext(runtime.clock.now);
    runtime.raf.flushNext(runtime.clock.now);
    phases.length = 0;

    flip.start(fixture.wysiwyg, range as unknown as Range, runtime.raf.request);

    const firstWrite = phases.findIndex((phase) => phase.startsWith("write:"));
    const sync = phases.indexOf("sync");
    assert.ok(firstWrite >= 0);
    assert.ok(sync > firstWrite);
    assert.equal(
      phases.slice(firstWrite, sync).some((phase) => phase.startsWith("read:")),
      false,
      "baseline writes must finish before the synchronization marker",
    );
    assert.equal(phases.filter((phase) => phase === "sync").length, 1);
    for (const name of ["second", "third"]) {
      assert.equal(phases.includes(`write:${name}:transition`), true);
      assert.equal(phases.includes(`write:${name}:transform`), true);
    }

    const logicalReads = phases
      .map((phase, index) => phase.startsWith("read:") ? index : -1)
      .filter((index) => index > sync);
    assert.equal(logicalReads.length >= 2, true);
    const firstRebaseWrite = phases.findIndex((phase, index) =>
      index > sync && phase.endsWith(":transform"));
    assert.ok(firstRebaseWrite > Math.max(...logicalReads));
  } finally {
    flip.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("scroll callbacks are reserved for active-loop retarget completion", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime);
  let initialCallbackCount = 0;
  let retargetCallbackCount = 0;

  try {
    scroll.reset();
    scroll.scrollTo(fixture.content, { deltaY: 100 }, () => { initialCallbackCount++; });
    const initialFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(initialFrame);
    runtime.raf.flush(initialFrame, runtime.clock.now);
    const initialProgressFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(initialProgressFrame);
    runtime.clock.advance(600);
    runtime.raf.flush(initialProgressFrame, runtime.clock.now);
    assert.equal(initialCallbackCount, 0, "an initial scroll does not request resync");
    assert.equal(runtime.raf.pending.size, 0);

    scroll.scrollTo(fixture.content, { deltaY: 100 });
    const activeFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(activeFrame);
    runtime.raf.flush(activeFrame, runtime.clock.now);
    const retainedFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(retainedFrame);

    scroll.scrollTo(
      fixture.content,
      { deltaY: 50 },
      () => { retargetCallbackCount++; },
    );
    assert.equal(runtime.raf.pending.size, 1);
    assert.equal(runtime.raf.pending.has(retainedFrame), true);
    runtime.clock.advance(400);
    runtime.raf.flush(retainedFrame, runtime.clock.now);
    assert.equal(retargetCallbackCount, 1);
    assert.equal(runtime.raf.pending.size, 0);

    scroll.scrollTo(fixture.content, { deltaY: 100 });
    const cancellableFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(cancellableFrame);
    scroll.scrollTo(
      fixture.content,
      { deltaY: 50 },
      () => { retargetCallbackCount++; },
    );
    scroll.cancel();
    assert.equal(runtime.raf.pending.size, 0);
    runtime.clock.advance(1000);
    assert.equal(retargetCallbackCount, 1, "cancel prevents a stale retarget callback");
  } finally {
    scroll.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("FLIP skips invalid local sampling without scanning the full editor", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime);
  const neutral = new FakeElement();
  const neutralText = new FakeText("neutral");
  append(neutral, neutralText);
  append(fixture.wysiwyg, neutral);
  fixture.wysiwyg.querySelectorAll = () => {
    throw new Error("FLIP must not perform a full-editor fallback scan");
  };

  try {
    flip.reset();
    const range = new FakeRange(neutralText, 0);
    flip.start(fixture.wysiwyg, range as unknown as Range, runtime.raf.request);
    assert.equal(runtime.raf.pending.size, 0);
    assert.equal(flip.hasShiftedBlocks(), false);
  } finally {
    flip.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("FLIP composes Ripple's opacity transition into ripple blocks during play", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime);
  const rippleBlock = new FakeElement({
    classes: ["zentype-ripple-block"],
    dataNodeId: "block-ripple",
    contentEditable: true,
  });
  append(rippleBlock, new FakeText("ripple"));
  rippleBlock.rect = rect(0, 100, 1000, 20);
  const plainBlock = new FakeElement({ dataNodeId: "block-plain", contentEditable: true });
  append(plainBlock, new FakeText("plain"));
  plainBlock.rect = rect(0, 140, 1000, 20);
  append(fixture.wysiwyg, rippleBlock, plainBlock);

  try {
    flip.reset();
    const range = new FakeRange(fixture.text, 0);
    flip.start(fixture.wysiwyg, range as unknown as Range, runtime.raf.request);
    rippleBlock.rect = rect(0, 60, 1000, 20);
    plainBlock.rect = rect(0, 100, 1000, 20);

    let playFrames = 0;
    while (!rippleBlock.style.transition.includes("250ms")) {
      assert.ok(playFrames++ < 8, "FLIP must reach its play phase");
      runtime.raf.flushNext(runtime.clock.now);
    }

    assert.equal(
      rippleBlock.style.getPropertyPriority("transition"),
      "important",
      "the composed transition must beat Ripple's important stylesheet shorthand",
    );
    assert.equal(
      rippleBlock.style.transition,
      "opacity var(--zt-ripple-transition-duration) ease, transform 250ms cubic-bezier(0.25, 0.1, 0.25, 1)",
    );
    assert.equal(plainBlock.style.getPropertyPriority("transition"), "");
    assert.match(plainBlock.style.transition, /^transform 250ms/);
    assert.equal(rippleBlock.style.transform, "");
    assert.equal(plainBlock.style.transform, "");
  } finally {
    flip.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("FLIP readiness inverts on the first frame geometry actually moves", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime);
  const secondBlock = new FakeElement({ dataNodeId: "block-second", contentEditable: true });
  append(secondBlock, new FakeText("second"));
  secondBlock.rect = rect(0, 100, 1000, 20);
  append(fixture.wysiwyg, secondBlock);

  try {
    flip.reset();
    const range = new FakeRange(fixture.text, 0);
    flip.start(fixture.wysiwyg, range as unknown as Range, runtime.raf.request);

    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(secondBlock.style.transform, "", "frame 1 with unchanged geometry must not invert");
    assert.equal(flip.hasShiftedBlocks(), false);

    secondBlock.rect = rect(0, 60, 1000, 20);
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(secondBlock.style.transform, "translateY(40px)", "the invert uses the structural delta");
    assert.equal(flip.hasShiftedBlocks(), true);
  } finally {
    flip.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("FLIP readiness fails open when geometry never changes", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime);

  try {
    flip.reset();
    const range = new FakeRange(fixture.text, 0);
    flip.start(fixture.wysiwyg, range as unknown as Range, runtime.raf.request);

    let drained = 0;
    while (runtime.raf.pending.size > 0) {
      assert.ok(drained++ < 20, "the readiness loop must stop on its own");
      runtime.raf.flushNext(runtime.clock.now);
    }
    assert.equal(flip.hasShiftedBlocks(), false, "an expired window inverts into a no-op");
    assert.equal(fixture.block.style.transform, "");
  } finally {
    flip.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("FLIP readiness stops polling after its elapsed bound", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime);

  try {
    flip.reset();
    const range = new FakeRange(fixture.text, 0);
    flip.start(fixture.wysiwyg, range as unknown as Range, runtime.raf.request);

    runtime.clock.advance(600);
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(runtime.raf.pending.size, 0, "the elapsed bound stops further polling");
    assert.equal(flip.hasShiftedBlocks(), false);
  } finally {
    flip.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("a new FLIP generation kills the previous readiness loop", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime);
  const secondBlock = new FakeElement({ dataNodeId: "block-second", contentEditable: true });
  append(secondBlock, new FakeText("second"));
  secondBlock.rect = rect(0, 100, 1000, 20);
  append(fixture.wysiwyg, secondBlock);

  try {
    flip.reset();
    const range = new FakeRange(fixture.text, 0);
    flip.start(fixture.wysiwyg, range as unknown as Range, runtime.raf.request);
    flip.reset();

    secondBlock.rect = rect(0, 60, 1000, 20);
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(runtime.raf.pending.size, 0, "the dead loop must not reschedule");
    assert.equal(secondBlock.style.transform, "", "a dead generation never inverts");
    assert.equal(flip.hasShiftedBlocks(), false);
  } finally {
    flip.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("viewport scrolling alone never arms FLIP readiness", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime);
  const secondBlock = new FakeElement({ dataNodeId: "block-second", contentEditable: true });
  append(secondBlock, new FakeText("second"));
  secondBlock.rect = rect(0, 100, 1000, 20);
  append(fixture.wysiwyg, secondBlock);

  try {
    flip.reset();
    const range = new FakeRange(fixture.text, 0);
    flip.start(fixture.wysiwyg, range as unknown as Range, runtime.raf.request);

    // The container scrolls under its own rect: block rects move with the
    // viewport while the container box stays put, so content space is stable.
    fixture.content.scrollTop = 30;
    for (const el of [fixture.block, secondBlock]) {
      el.rect = rect(0, el.rect.top - 30, 1000, 20);
    }

    let drained = 0;
    while (runtime.raf.pending.size > 0) {
      assert.ok(drained++ < 20, "pure scrolling must not hold the loop open");
      runtime.raf.flushNext(runtime.clock.now);
    }
    assert.equal(secondBlock.style.transform, "", "viewport motion is not structural motion");
    assert.equal(flip.hasShiftedBlocks(), false);
  } finally {
    flip.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("stable Enter structural authority uses the inner lower settle target", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime, "enter");
  runtime.clock.now = 39_000;

  try {
    inputMode.reset();
    initTypewriter();
    runtime.setCaret(fixture.text, 1, rect(20, 550));
    runtime.document.dispatch("keydown", eventFor(fixture.block, {
      key: "Enter",
      isComposing: false,
      defaultPrevented: false,
    }));

    let settleFrames = 0;
    while (isStructuralEditPending()) {
      assert.ok(settleFrames++ < 10, "the coordinator must settle in a bounded number of frames");
      runtime.clock.advance(16);
      runtime.raf.flushNext(runtime.clock.now);
    }

    // The fake never models the structural geometry shift, so the FLIP
    // readiness loop keeps polling until its bounded window fails open.
    runtime.clock.advance(200);
    let readinessDrain = 0;
    while (runtime.raf.pending.size > 1) {
      assert.ok(readinessDrain++ < 8, "FLIP readiness polling must remain bounded");
      runtime.raf.flushNext(runtime.clock.now);
    }

    assert.equal(runtime.raf.pending.size, 1, "stable structural authority starts one scroll");
    const firstScrollFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(firstScrollFrame);
    runtime.raf.flush(firstScrollFrame, runtime.clock.now);
    const scrollFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(scrollFrame);
    runtime.clock.advance(1000);
    runtime.raf.flush(scrollFrame, runtime.clock.now);
    assert.equal(
      Math.round(fixture.content.scrollTop),
      70,
      "Enter uses the shared 48% lower settle edge",
    );
  } finally {
    destroyTypewriter();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("Enter on an empty block waits for a stable structural commit", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime, "");
  runtime.clock.now = 40_000;

  try {
    inputMode.reset();
    initTypewriter();
    runtime.setCaret(fixture.text, 0, rect(20, 800));
    runtime.document.dispatch("keydown", eventFor(fixture.block, {
      key: "Enter",
      isComposing: false,
      defaultPrevented: false,
    }));
    assert.equal(isStructuralEditPending(), true);
    let settleFrames = 0;
    while (isStructuralEditPending()) {
      assert.ok(settleFrames++ < 10, "the coordinator must settle in a bounded number of frames");
      runtime.clock.advance(16);
      runtime.raf.flushNext(runtime.clock.now);
    }
    assert.equal(settleFrames >= 2, true, "the authoritative check waits for quiet frames");
    // The fake never models the structural geometry shift, so the FLIP
    // readiness loop keeps polling until its bounded window fails open.
    runtime.clock.advance(200);
    let readinessDrain = 0;
    while (runtime.raf.pending.size > 1) {
      assert.ok(readinessDrain++ < 8, "FLIP readiness polling must remain bounded");
      runtime.raf.flushNext(runtime.clock.now);
    }

    assert.equal(runtime.raf.pending.size, 1, "the stable commit starts the smooth scroll");
    assert.equal(fixture.content.scrollTop, 0);
  } finally {
    destroyTypewriter();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("Backspace character deletion and block merge retain separate characterization paths", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime, "ab");
  runtime.clock.now = 50_000;

  try {
    inputMode.reset();
    initTypewriter();
    runtime.setCaret(fixture.text, 2, rect(20, 400));
    runtime.document.dispatch("keydown", eventFor(fixture.block, {
      key: "Backspace",
      isComposing: false,
      defaultPrevented: false,
    }));
    assert.equal(runtime.raf.pending.size, 0, "ordinary character deletion does not start a structural transaction");
    assert.equal(fixture.block.style.transform, "");
    assert.equal(fixture.block.style.transition, "");

    destroyTypewriter();
    inputMode.reset();
    runtime.raf.pending.clear();
    runtime.clock.pending.clear();

    const secondBlock = new FakeElement({ dataNodeId: "block-next", contentEditable: true });
    const secondText = new FakeText("next");
    secondBlock.rect = rect(0, 100, 1000, 20);
    append(secondBlock, secondText);
    append(fixture.wysiwyg, secondBlock);
    initTypewriter();
    runtime.setCaret(fixture.text, 0, rect(20, 400));
    runtime.selection.range?.setEnd(secondText, 0);
    runtime.document.dispatch("keydown", eventFor(fixture.block, {
      key: "Backspace",
      isComposing: false,
      defaultPrevented: false,
    }));
    secondBlock.rect = rect(0, 80, 1000, 20);

    let firstMotionFrames = 0;
    while (!secondBlock.style.transition.includes("250ms")) {
      assert.ok(firstMotionFrames++ < 8, "the first block FLIP must reach its play phase");
      runtime.raf.flushNext(runtime.clock.now);
    }
    assert.match(secondBlock.style.transition, /transform 250ms/);
    const firstCleanupDelays = runtime.clock.delays();
    assert.deepEqual(firstCleanupDelays, [300]);

    runtime.document.dispatch("keydown", eventFor(fixture.block, {
      key: "Backspace",
      isComposing: false,
      defaultPrevented: false,
    }));
    secondBlock.rect = rect(0, 50, 1000, 20);
    assert.deepEqual(runtime.clock.delays(), [], "a new FLIP cancels the old cleanup timer");

    let secondMotionFrames = 0;
    while (!secondBlock.style.transition.includes("250ms")) {
      assert.ok(secondMotionFrames++ < 8, "the second block FLIP must reach its play phase");
      runtime.raf.flushNext(runtime.clock.now);
    }
    assert.match(secondBlock.style.transition, /transform 250ms/);
    runtime.clock.advance(300);
    assert.equal(secondBlock.style.transition, "");
  } finally {
    destroyTypewriter();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});

test("stable block Backspace uses the shared inner lower settle target", () => {
  const runtime = new FakeRuntime();
  installRuntime(runtime);
  const fixture = createEditorFixture(runtime, "ab");
  const secondBlock = new FakeElement({
    dataNodeId: "block-next",
    contentEditable: true,
  });
  const secondText = new FakeText("next");
  append(secondBlock, secondText);
  append(fixture.wysiwyg, secondBlock);
  runtime.clock.now = 42_000;

  try {
    inputMode.reset();
    initTypewriter();
    runtime.setCaret(fixture.text, 0, rect(20, 550));
    runtime.selection.range?.setEnd(secondText, 0);
    runtime.document.dispatch("keydown", eventFor(fixture.block, {
      key: "Backspace",
      isComposing: false,
      defaultPrevented: false,
    }));

    assert.equal(isStructuralEditPending(), true);
    let settleFrames = 0;
    while (isStructuralEditPending()) {
      assert.ok(settleFrames++ < 10, "the coordinator must settle in a bounded number of frames");
      runtime.clock.advance(16);
      runtime.raf.flushNext(runtime.clock.now);
    }

    // The fake never models the structural geometry shift, so the FLIP
    // readiness loop keeps polling until its bounded window fails open.
    runtime.clock.advance(200);
    let readinessDrain = 0;
    while (runtime.raf.pending.size > 1) {
      assert.ok(readinessDrain++ < 8, "FLIP readiness polling must remain bounded");
      runtime.raf.flushNext(runtime.clock.now);
    }

    assert.equal(runtime.raf.pending.size, 1, "stable Backspace starts one scroll");
    const firstScrollFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(firstScrollFrame);
    runtime.raf.flush(firstScrollFrame, runtime.clock.now);
    const scrollFrame = [...runtime.raf.pending.keys()][0];
    assert.ok(scrollFrame);
    runtime.clock.advance(1000);
    runtime.raf.flush(scrollFrame, runtime.clock.now);
    assert.equal(Math.round(fixture.content.scrollTop), 70);
  } finally {
    destroyTypewriter();
    inputMode.reset();
    setActiveEditor(null);
    runtime.restore();
  }
});
