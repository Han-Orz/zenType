import assert from "node:assert/strict";
import test from "node:test";
import type { EventBus } from "siyuan";
import {
  initDebugHook,
  serializeStructuralEditSnapshot,
} from "../src/modules/debugHook";
import * as structuralEdit from "../src/modules/structuralEdit";

class FakeElement {
  readonly nodeType = 1;
  readonly childNodes: FakeElement[] = [];
  readonly children: FakeElement[] = [];
  readonly attributes: Array<{ name: string; value: string }> = [];
  readonly classList = new Set<string>();
  parentElement: FakeElement | null = null;
  isConnected = true;
  scrollTop = 0;
  scrollLeft = 0;
  scrollHeight = 100;
  scrollWidth = 100;
  clientHeight = 100;
  clientWidth = 100;
  textContent = "";
  tagName: string;

  constructor(tagName = "DIV", attrs: Record<string, string> = {}) {
    this.tagName = tagName;
    for (const [name, value] of Object.entries(attrs)) {
      this.attributes.push({ name, value });
      if (name === "class") {
        for (const className of value.split(/\s+/).filter(Boolean)) this.classList.add(className);
      }
    }
  }

  appendChild(child: FakeElement): void {
    child.parentElement = this;
    this.childNodes.push(child);
    this.children.push(child);
  }

  getAttribute(name: string): string | null {
    return this.attributes.find((attribute) => attribute.name === name)?.value ?? null;
  }

  closest(selector: string): FakeElement | null {
    let current: FakeElement | null = this;
    while (current) {
      if (selector === ".protyle" && current.getAttribute("class")?.split(/\s+/).includes("protyle")) {
        return current;
      }
      if (selector === "[data-node-id]" && current.getAttribute("data-node-id")) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  contains(node: object | null): boolean {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }

  querySelector(_selector: string): FakeElement | null {
    return this.querySelectorAll(_selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches: FakeElement[] = [];
    const matchesSelector = (element: FakeElement): boolean => (
      selector === ".protyle"
        ? element.getAttribute("class")?.split(/\s+/).includes("protyle") ?? false
        : selector === ".protyle-wysiwyg"
          ? element.classList.has("protyle-wysiwyg")
          : selector === "[data-node-id]"
            ? element.getAttribute("data-node-id") !== null
            : false
    );
    const visit = (element: FakeElement): void => {
      if (matchesSelector(element)) matches.push(element);
      for (const child of element.children) visit(child);
    };
    for (const child of this.children) visit(child);
    return matches;
  }

  getBoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      top: 0,
      right: 100,
      bottom: 20,
      left: 0,
      toJSON: () => ({}),
    } as DOMRect;
  }
}

class FakeSelection {
  rangeCount = 0;
  anchorNode: FakeElement | null = null;
  focusNode: FakeElement | null = null;
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
  roots: FakeElement[] = [];
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor() {
    this.documentElement.appendChild(this.body);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return selector === ".protyle" ? this.roots : [];
  }

  dispatch(type: string, event: Event): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  getSelection(): FakeSelection {
    return this.selection;
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

  flushNext(): void {
    const entry = this.pending.entries().next().value as [number, FrameRequestCallback] | undefined;
    assert.ok(entry, "expected a pending animation frame");
    this.pending.delete(entry[0]);
    entry[1](0);
  }
}

class FakeMutationObserver {
  constructor(readonly callback: (records: MutationRecord[]) => void) {}

  observe(_target: object): void {}

  disconnect(): void {}
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
  readonly raf = new FakeRafQueue();
  readonly mutationObservers: FakeMutationObserver[] = [];
  private readonly originalGlobals = new Map<string, PropertyDescriptor | undefined>();

  install(): void {
    this.defineGlobal("document", this.document);
    this.defineGlobal("window", this.window);
    this.defineGlobal("Node", { ELEMENT_NODE: 1, TEXT_NODE: 3 });
    this.defineGlobal("Element", FakeElement);
    this.defineGlobal("HTMLElement", FakeElement);
    this.defineGlobal("requestAnimationFrame", this.raf.request);
    this.defineGlobal("cancelAnimationFrame", this.raf.cancel);
    const runtime = this;
    this.defineGlobal("MutationObserver", class extends FakeMutationObserver {
      constructor(callback: (records: MutationRecord[]) => void) {
        super(callback);
        runtime.mutationObservers.push(this);
      }
    });
    this.defineGlobal("getComputedStyle", () => ({
      display: "block",
      position: "static",
      opacity: "1",
      visibility: "visible",
      color: "rgb(0, 0, 0)",
      backgroundColor: "transparent",
      fontSize: "16px",
      lineHeight: "20px",
      transform: "none",
      transition: "none",
      filter: "none",
      mixBlendMode: "normal",
      overflow: "visible",
      zIndex: "auto",
      margin: "0px",
      padding: "0px",
      pointerEvents: "auto",
      getPropertyValue: () => "",
    }));
    this.defineGlobal("fetch", () => Promise.resolve({}));
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

function setup(): FakeRuntime {
  const runtime = new FakeRuntime();
  runtime.install();
  structuralEdit.destroyStructuralEditCoordinator();
  structuralEdit.initStructuralEditCoordinator();
  return runtime;
}

function teardown(runtime: FakeRuntime): void {
  structuralEdit.destroyStructuralEditCoordinator();
  runtime.restore();
}

test("structural debug snapshots serialize editor references without document text", () => {
  const runtime = setup();
  try {
    const root = new FakeElement("DIV", { class: "protyle" });
    const editor = new FakeElement("DIV", { "data-type": "protyle-wysiwyg" });
    editor.textContent = "private document text";
    root.appendChild(editor);

    const serialized = serializeStructuralEditSnapshot({
      generation: 7,
      phase: "mutating",
      kind: "enter",
      editor: editor as unknown as HTMLElement,
    }, root as unknown as Element);

    assert.equal(serialized.generation, 7);
    assert.equal(serialized.phase, "mutating");
    assert.equal(serialized.kind, "enter");
    assert.equal(serialized.editorPath, "div.protyle > div[data-type=\"protyle-wysiwyg\"]");
    assert.equal(serialized.editorConnected, true);
    assert.equal("editor" in serialized, false);
    assert.equal(JSON.stringify(serialized).includes("private document text"), false);
  } finally {
    teardown(runtime);
  }
});

test("debug hook emits structural finish diagnostics and removes its subscriber on destroy", () => {
  const runtime = setup();
  const eventBus = new FakeEventBus();
  const controller = initDebugHook(eventBus as unknown as EventBus);
  const editor = new FakeElement("DIV", { "data-type": "protyle-wysiwyg" });

  try {
    const generation = structuralEdit.beginStructuralEdit(
      "enter",
      editor as unknown as HTMLElement,
    );
    runtime.raf.flushNext();
    runtime.raf.flushNext();

    const finishEvent = controller.getRecentEvents().find(
      (event) => event.payload.name === "structural-edit-finish",
    );
    assert.ok(finishEvent);
    assert.equal(finishEvent.payload.source, "structural-edit");
    assert.equal(finishEvent.payload.generation, generation);
    assert.equal(finishEvent.payload.kind, "enter");
    assert.equal(finishEvent.payload.stable, true);
    assert.equal(
      (finishEvent.payload.structuralStateAfterFinish as { phase: string }).phase,
      "idle",
    );
    assert.equal(typeof finishEvent.payload.monotonicMs, "number");
    assert.doesNotThrow(() => JSON.stringify(finishEvent.payload));

    controller.destroy();
    const eventCountAfterDestroy = controller.getRecentEvents().length;
    structuralEdit.beginStructuralEdit("backspace", editor as unknown as HTMLElement);
    runtime.raf.flushNext();
    runtime.raf.flushNext();
    assert.equal(controller.getRecentEvents().length, eventCountAfterDestroy);
  } finally {
    controller.destroy();
    teardown(runtime);
  }
});

test("DOM and mutation diagnostics carry the current structural state", () => {
  const runtime = setup();
  const root = new FakeElement("DIV", { class: "protyle" });
  const editor = new FakeElement("DIV", { class: "protyle-wysiwyg", "data-type": "protyle-wysiwyg" });
  root.appendChild(editor);
  runtime.document.roots = [root];
  const controller = initDebugHook(new FakeEventBus() as unknown as EventBus);

  try {
    const generation = structuralEdit.beginStructuralEdit(
      "enter",
      editor as unknown as HTMLElement,
    );
    const event = {
      type: "input",
      target: editor,
      composedPath: () => [editor, root],
      defaultPrevented: false,
      cancelBubble: false,
      eventPhase: 1,
      timeStamp: 12,
      inputType: "insertParagraph",
      isComposing: false,
      data: null,
    } as unknown as Event;
    runtime.document.dispatch("input", event);

    const inputEvent = controller.getRecentEvents().find(
      (item) => item.payload.name === "input",
    );
    assert.ok(inputEvent);
    const inputState = inputEvent.payload.structuralEdit as {
      generation: number;
      phase: string;
      editorPath: string | null;
    };
    assert.equal(inputState.generation, generation);
    assert.equal(inputState.phase, "mutating");
    assert.equal(inputState.editorPath, "div.protyle > div[data-type=\"protyle-wysiwyg\"]");
    assert.deepEqual(inputEvent.payload.typewriterScroll, { active: false });
    assert.equal(typeof inputEvent.payload.monotonicMs, "number");

    const observer = runtime.mutationObservers[0];
    observer.callback([{
      type: "childList",
      target: root,
      attributeName: null,
      oldValue: null,
      addedNodes: [],
      removedNodes: [],
    } as unknown as MutationRecord]);
    const mutationEvent = controller.getRecentEvents().find(
      (item) => item.payload.name === "mutation",
    );
    assert.ok(mutationEvent);
    assert.equal(
      (mutationEvent.payload.structuralEdit as { generation: number }).generation,
      generation,
    );
  } finally {
    controller.destroy();
    teardown(runtime);
  }
});

test("disabled debug hook does not inspect a structural editor at finish", () => {
  const runtime = setup();
  const eventBus = new FakeEventBus();
  const controller = initDebugHook(eventBus as unknown as EventBus);
  let accessed = false;
  const editor = new Proxy({}, {
    get() {
      accessed = true;
      throw new Error("disabled debug hook inspected editor");
    },
  });

  try {
    controller.setEnabled(false);
    structuralEdit.beginStructuralEdit("enter", editor as unknown as HTMLElement);
    runtime.raf.flushNext();
    runtime.raf.flushNext();
    assert.equal(accessed, false);
  } finally {
    controller.destroy();
    teardown(runtime);
  }
});
