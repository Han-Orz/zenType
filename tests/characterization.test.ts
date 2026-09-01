import assert from "node:assert/strict";
import test from "node:test";
import { setActiveEditor } from "siyuan";
import * as inputMode from "../src/modules/inputMode";
import * as inputModeTriggers from "../src/modules/inputModeTriggers";
import {
  bindCursorDocumentEvents,
  destroyCursorDocumentEvents,
} from "../src/modules/cursor/events";
import {
  destroyTypewriter,
  initTypewriter,
} from "../src/modules/typewriter";
import * as flip from "../src/modules/typewriter/flip";
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
  constructor(public readonly ranges: FakeRange[]) {}
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

test("typewriter retargets one active scroll after a new caret change", () => {
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

    const firstScrollFrame = [...runtime.raf.pending.keys()][0];
    runtime.clock.advance(401);
    runtime.setCaret(fixture.text, 1, rect(20, 850));
    runtime.document.dispatch("selectionchange");
    const resyncCheckFrame = [...runtime.raf.pending.keys()][1];
    assert.ok(resyncCheckFrame);
    runtime.raf.flush(resyncCheckFrame, runtime.clock.now);
    assert.equal(runtime.raf.pending.size, 2, "layout defer keeps the active loop and one check");

    const layoutCheckFrame = [...runtime.raf.pending.keys()].find((id) => id !== firstScrollFrame);
    assert.ok(layoutCheckFrame);
    runtime.raf.flush(layoutCheckFrame, runtime.clock.now);
    assert.equal(runtime.raf.pending.size, 1, "retargeting keeps the original scroll loop");
    assert.equal(runtime.raf.pending.has(firstScrollFrame), true);

    runtime.clock.advance(600);
    runtime.raf.flush(firstScrollFrame, runtime.clock.now);
    assert.equal(Math.round(fixture.content.scrollTop), 350, "the latest caret target owns the completed scroll");
    assert.equal(runtime.raf.pending.size, 1, "completion schedules one final geometry check");
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(runtime.raf.pending.size, 0, "the final check does not create a second loop");
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
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(replacement.style.getPropertyValue("--zt-ripple-opacity"), "1");
    assert.equal(fixture.alternateContent.style.getPropertyValue("--zt-ripple-opacity"), "");
    assert.equal(fixture.topSibling.style.getPropertyValue("--zt-ripple-opacity"), "0.4");

    const topSiblingText = fixture.topSibling.childNodes[0];
    assert.ok(topSiblingText instanceof FakeText);
    runtime.setCaret(topSiblingText, 1, rect(20, 400));
    runtime.document.dispatch("selectionchange");
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

test("Enter on an empty block waits for both deferred settle frames", () => {
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
    assert.equal(runtime.raf.pending.size, 2, "FLIP and the first settle frame are both deferred");

    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(fixture.content.scrollTop, 0);
    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(runtime.raf.pending.size, 1, "the first settle frame must queue the second");
    assert.equal(fixture.content.scrollTop, 0);

    runtime.raf.flushNext(runtime.clock.now);
    assert.equal(runtime.raf.pending.size, 1, "the eventual check starts smooth scroll");
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
    assert.equal(runtime.raf.pending.size, 1, "ordinary deletion still defers its check");
    runtime.raf.flushNext(runtime.clock.now);
    runtime.raf.flushNext(runtime.clock.now);
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

    runtime.raf.flushNext(runtime.clock.now);
    runtime.raf.flushNext(runtime.clock.now);
    runtime.raf.flushNext(runtime.clock.now);
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

    runtime.raf.flushNext(runtime.clock.now);
    runtime.raf.flushNext(runtime.clock.now);
    runtime.raf.flushNext(runtime.clock.now);
    runtime.raf.flushNext(runtime.clock.now);
    runtime.raf.flushNext(runtime.clock.now);
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
