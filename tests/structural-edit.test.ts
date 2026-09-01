import assert from "node:assert/strict";
import test from "node:test";
import * as inputMode from "../src/modules/inputMode";
import {
  beginStructuralEdit,
  destroyStructuralEditCoordinator,
  getStructuralEditSnapshot,
  initStructuralEditCoordinator,
  isStructuralEditPending,
  resetStructuralEdit,
  structuralKindFromInputType,
  subscribeStructuralEditFinish,
} from "../src/modules/structuralEdit";

class FakeDocument {
  private readonly listeners = new Map<string, Set<() => void>>();
  selection: { rangeCount: number; anchorNode: object | null } = {
    rangeCount: 0,
    anchorNode: null,
  };

  addEventListener(event: string, listener: () => void): void {
    const listeners = this.listeners.get(event) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeEventListener(event: string, listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  dispatch(event: string): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  getSelection(): typeof this.selection {
    return this.selection;
  }
}

class FakeWindow {
  constructor(private readonly document: FakeDocument) {}

  getSelection(): typeof this.document.selection {
    return this.document.getSelection();
  }
}

class FakeEditor {
  readonly child = {};

  contains(node: object | null): boolean {
    return node === this || node === this.child;
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
    assert.ok(entry, "expected a pending stability frame");
    this.pending.delete(entry[0]);
    entry[1](0);
  }
}

class FakeMutationObserver {
  disconnected = false;
  readonly observed: object[] = [];

  constructor(
    readonly callback: (records: MutationRecord[]) => void,
  ) {}

  observe(target: object): void {
    this.disconnected = false;
    this.observed.push(target);
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeRuntime {
  readonly document = new FakeDocument();
  readonly window = new FakeWindow(this.document);
  readonly raf = new FakeRafQueue();
  readonly mutationObservers: FakeMutationObserver[] = [];
  private readonly originalGlobals = new Map<string, PropertyDescriptor | undefined>();

  install(): void {
    const define = (name: string, value: unknown): void => {
      if (!this.originalGlobals.has(name)) {
        this.originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      }
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value,
      });
    };

    define("document", this.document);
    define("window", this.window);
    define("requestAnimationFrame", this.raf.request);
    define("cancelAnimationFrame", this.raf.cancel);
    const runtime = this;
    define("MutationObserver", class extends FakeMutationObserver {
      constructor(callback: (records: MutationRecord[]) => void) {
        super(callback);
        runtime.mutationObservers.push(this);
      }
    });
  }

  restore(): void {
    for (const [name, descriptor] of this.originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as unknown as Record<string, unknown>)[name];
    }
  }
}

function setup(): { runtime: FakeRuntime; editor: FakeEditor } {
  const runtime = new FakeRuntime();
  runtime.install();
  inputMode.reset();
  destroyStructuralEditCoordinator();
  initStructuralEditCoordinator();
  return { runtime, editor: new FakeEditor() };
}

function teardown(runtime: FakeRuntime): void {
  destroyStructuralEditCoordinator();
  inputMode.reset();
  runtime.restore();
}

test("structural edit begins in mutating phase and is not immediately stable", () => {
  const { runtime, editor } = setup();
  const finishes: unknown[] = [];
  const unsubscribe = subscribeStructuralEditFinish((finish) => finishes.push(finish));

  try {
    const generation = beginStructuralEdit("enter", editor as unknown as HTMLElement);
    assert.equal(getStructuralEditSnapshot().generation, generation);
    assert.equal(getStructuralEditSnapshot().phase, "mutating");
    assert.equal(isStructuralEditPending(), true);
    assert.equal(runtime.raf.pending.size, 1);
    assert.equal(finishes.length, 0);
  } finally {
    unsubscribe();
    teardown(runtime);
  }
});

test("two quiet frames produce one stable finish", () => {
  const { runtime, editor } = setup();
  const finishes: Array<{ generation: number; stable: boolean }> = [];
  const unsubscribe = subscribeStructuralEditFinish((finish) => finishes.push(finish));

  try {
    const generation = beginStructuralEdit("backspace", editor as unknown as HTMLElement);
    runtime.raf.flushNext();
    assert.equal(finishes.length, 0);
    assert.equal(getStructuralEditSnapshot().phase, "stabilizing");
    runtime.raf.flushNext();
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0].generation, generation);
    assert.equal(finishes[0].kind, "backspace");
    assert.equal(finishes[0].stable, true);
    assert.equal(isStructuralEditPending(), false);
    assert.equal(runtime.raf.pending.size, 0);
  } finally {
    unsubscribe();
    teardown(runtime);
  }
});

test("mutation activity resets the quiet-frame count", () => {
  const { runtime, editor } = setup();
  const finishes: Array<{ stable: boolean }> = [];
  const unsubscribe = subscribeStructuralEditFinish((finish) => finishes.push(finish));

  try {
    beginStructuralEdit("list-change", editor as unknown as HTMLElement);
    runtime.raf.flushNext();
    const observer = runtime.mutationObservers[0];
    observer.callback([]);
    runtime.raf.flushNext();
    assert.equal(finishes.length, 0);
    runtime.raf.flushNext();
    assert.equal(finishes.length, 0);
    runtime.raf.flushNext();
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0].kind, "list-change");
    assert.equal(finishes[0].stable, true);
  } finally {
    unsubscribe();
    teardown(runtime);
  }
});

test("selection activity resets the quiet-frame count only inside the active editor", () => {
  const { runtime, editor } = setup();
  const finishes: Array<{ stable: boolean }> = [];
  const unsubscribe = subscribeStructuralEditFinish((finish) => finishes.push(finish));

  try {
    beginStructuralEdit("unknown", editor as unknown as HTMLElement);
    runtime.raf.flushNext();
    runtime.document.selection = { rangeCount: 1, anchorNode: editor.child };
    runtime.document.dispatch("selectionchange");
    runtime.raf.flushNext();
    assert.equal(finishes.length, 0);
    runtime.raf.flushNext();
    assert.equal(finishes.length, 0);
    runtime.raf.flushNext();
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0].kind, "unknown");
    assert.equal(finishes[0].stable, true);
  } finally {
    unsubscribe();
    teardown(runtime);
  }
});

test("a rapid second begin supersedes the first generation", () => {
  const { runtime, editor } = setup();
  const finishes: Array<{ generation: number; kind: string }> = [];
  const unsubscribe = subscribeStructuralEditFinish((finish) => finishes.push(finish));

  try {
    const firstGeneration = beginStructuralEdit("enter", editor as unknown as HTMLElement);
    const firstObserver = runtime.mutationObservers[0];
    const secondGeneration = beginStructuralEdit("backspace", editor as unknown as HTMLElement);
    assert.notEqual(secondGeneration, firstGeneration);
    assert.equal(firstObserver.disconnected, true);
    assert.equal(runtime.raf.pending.size, 1);
    runtime.raf.flushNext();
    runtime.raf.flushNext();
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0].generation, secondGeneration);
    assert.equal(finishes[0].kind, "backspace");
    assert.equal(finishes[0].stable, true);
  } finally {
    unsubscribe();
    teardown(runtime);
  }
});

test("reset cancels the transaction and releases observer, listener, and rAF", () => {
  const { runtime, editor } = setup();
  let finishCount = 0;
  const unsubscribe = subscribeStructuralEditFinish(() => { finishCount++; });

  try {
    beginStructuralEdit("enter", editor as unknown as HTMLElement);
    const observer = runtime.mutationObservers[0];
    assert.equal(runtime.document.listenerCount("selectionchange"), 1);
    resetStructuralEdit();
    assert.equal(finishCount, 0);
    assert.equal(runtime.raf.pending.size, 0);
    assert.equal(observer.disconnected, true);
    assert.equal(runtime.document.listenerCount("selectionchange"), 0);
    assert.equal(isStructuralEditPending(), false);
  } finally {
    unsubscribe();
    teardown(runtime);
  }
});

test("turning the input session off cancels a pending structural transaction", () => {
  const { runtime, editor } = setup();
  let finishCount = 0;
  const unsubscribe = subscribeStructuralEditFinish(() => { finishCount++; });

  try {
    inputMode.setBothOn();
    beginStructuralEdit("enter", editor as unknown as HTMLElement);
    const observer = runtime.mutationObservers[0];
    inputMode.setBothOff();
    assert.equal(isStructuralEditPending(), false);
    assert.equal(finishCount, 0);
    assert.equal(runtime.raf.pending.size, 0);
    assert.equal(runtime.document.listenerCount("selectionchange"), 0);
    assert.equal(observer.disconnected, true);
  } finally {
    unsubscribe();
    teardown(runtime);
  }
});

test("idle coordinator owns no pending observer or animation frame", () => {
  const { runtime } = setup();
  try {
    assert.equal(isStructuralEditPending(), false);
    assert.equal(runtime.raf.pending.size, 0);
    assert.equal(runtime.mutationObservers.length, 0);
    assert.equal(runtime.document.listenerCount("selectionchange"), 0);
  } finally {
    teardown(runtime);
  }
});

test("the bounded settle window finishes unstable transactions fail-open", () => {
  const { runtime, editor } = setup();
  const finishes: Array<{ stable: boolean }> = [];
  const unsubscribe = subscribeStructuralEditFinish((finish) => finishes.push(finish));

  try {
    beginStructuralEdit("unknown", editor as unknown as HTMLElement);
    const observer = runtime.mutationObservers[0];
    for (let frame = 0; frame < 8; frame++) {
      observer.callback([]);
      runtime.raf.flushNext();
    }
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0].kind, "unknown");
    assert.equal(finishes[0].stable, false);
    assert.equal(isStructuralEditPending(), false);
    assert.equal(runtime.raf.pending.size, 0);
    assert.equal(runtime.document.listenerCount("selectionchange"), 0);
    assert.equal(observer.disconnected, true);
  } finally {
    unsubscribe();
    teardown(runtime);
  }
});

test("input types classify only definite structural edits", () => {
  assert.equal(structuralKindFromInputType("insertParagraph"), "enter");
  assert.equal(structuralKindFromInputType("insertLineBreak"), "enter");
  assert.equal(structuralKindFromInputType("formatIndent"), "list-change");
  assert.equal(structuralKindFromInputType("historyUndo"), "history");
  assert.equal(structuralKindFromInputType("deleteByDrag"), "cut-drag");
  assert.equal(structuralKindFromInputType("deleteContentBackward"), null);
  assert.equal(structuralKindFromInputType("deleteContentForward"), null);
  assert.equal(structuralKindFromInputType("insertText"), null);
});
