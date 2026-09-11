import assert from "node:assert/strict";
import test from "node:test";
import { stepCritical, type CriticalState } from "../src/motion";
import { MOTION, RIPPLE_LEVELS } from "../src/config";
import { createRipple } from "../src/modules/ripple";
import { createBlockPainter } from "../src/modules/ripple/blockPainter";
import { createWritingSession } from "../src/session";
import { createTypewriter } from "../src/modules/typewriter";
import { createCursor } from "../src/modules/cursor";
import { initDebugHook } from "../src/modules/debugHook";
import { mapUnchangedBoundaries, projectText } from "../src/modules/ripple/textProjection";
import { splitSentences, resolveActiveSentenceRanges } from "../src/modules/ripple/sentenceModel";
import type { EditorFrame } from "../src/types";
import { createStructureGate } from "../src/structure";

function frame(overrides: Partial<EditorFrame> = {}): EditorFrame {
  return { root: {} as HTMLElement, editor: {} as HTMLElement, scroll: {} as HTMLElement,
    editable: null, block: null, range: null, selection: "caret",
    caret: { x: 100, y: 550, height: 20 },
    viewport: { top: 0, bottom: 600, left: 0, right: 800 },
    scrollViewport: { top: 0, bottom: 600, left: 0 },
    scrollTop: 300, scrollLeft: 0, origin: { x: 0, y: 0 }, nestedScroll: [],
    maxScroll: 2000, reducedMotion: false, zIndex: 1, ...overrides };
}

test("critical motion keeps value and velocity continuous across retarget", () => {
  const state: CriticalState = { value: 0, velocity: 0 };
  stepCritical(state, 100, 16, 100);
  const before = { ...state };
  stepCritical(state, -100, 0, 100);
  assert.deepEqual(state, before);
});

test("critical motion is independent of frame subdivision", () => {
  const one: CriticalState = { value: 0, velocity: 0 };
  const two: CriticalState = { value: 0, velocity: 0 };
  stepCritical(one, 100, 32, 100);
  stepCritical(two, 100, 16, 100);
  stepCritical(two, 100, 16, 100);
  assert.ok(Math.abs(one.value - two.value) < 1e-10);
  assert.ok(Math.abs(one.velocity - two.velocity) < 1e-10);
});

test("response time reaches approximately 90 percent from rest", () => {
  const state: CriticalState = { value: 0, velocity: 0 };
  stepCritical(state, 100, 100, 100);
  assert.ok(Math.abs(state.value - 90) < 0.001);
});

test("critical motion accepts a large elapsed interval without a frame-time clamp", () => {
  const state: CriticalState = { value: 0, velocity: 0 };
  const settled = stepCritical(state, 100, 5000, 100);
  assert.equal(settled, true);
  assert.equal(state.value, 100);
  assert.equal(state.velocity, 0);
});

test("critical motion settles position and velocity together", () => {
  const state: CriticalState = { value: 0, velocity: 0 };
  let settled = false;
  for (let i = 0; i < 200 && !settled; i++) settled = stepCritical(state, 100, 16, 100, 0.01);
  assert.equal(settled, true);
  assert.equal(state.value, 100);
  assert.equal(state.velocity, 0);
});

test("reduced critical motion settles an arbitrary state directly", () => {
  const state: CriticalState = { value: 17.25, velocity: -3.5 };
  const settled = stepCritical(state, -42.75, 200, 0);
  assert.equal(settled, true);
  assert.equal(state.value, -42.75);
  assert.equal(state.velocity, 0);
});

test("scroll retarget accepts reverse editing while it is moving", () => {
  const writer = createTypewriter();
  const first = writer.next(frame(), 1000, true, 0);
  assert.ok(first > 300 && first < 600);
  writer.written(first);
  let next = writer.next(frame({ scrollTop: first, caret: { x: 100, y: 60, height: 20 } }), 1016, true, 1000);
  for (let now = 1032; now <= 2000 && next >= first; now += 16) {
    writer.written(next);
    next = writer.next(frame({ scrollTop: next, caret: { x: 100, y: 60, height: 20 } }), now, true, 1000);
  }
  assert.ok(next < first);
  assert.ok(next >= 0);
});

test("external scrolling cancels an outstanding endpoint", () => {
  const writer = createTypewriter();
  const first = writer.next(frame(), 1000, true, 0);
  writer.written(first);
  assert.equal(writer.next(frame({ scrollTop: 800 }), 1016, true, 0), 800);
  assert.equal(writer.isMoving(), false);
});

test("scroll stays bounded and cancellation does not make another write", () => {
  const writer = createTypewriter();
  assert.equal(writer.next(frame({ maxScroll: 0, scrollTop: 0 }), 1000, true, 0), 0);
  writer.next(frame(), 1016, true, 0);
  assert.equal(writer.next(frame(), 1032, false, 0), 300);
  assert.equal(writer.isMoving(), false);
});

test("comfort waits for a pause but edge protection does not", () => {
  const writer = createTypewriter();
  const comfortable = frame({ caret: { x: 100, y: 350, height: 20 } });
  assert.equal(writer.next(comfortable, 1000, true, 990), 300);
  assert.ok(writer.next(frame({ caret: { x: 100, y: 580, height: 20 } }), 1016, true, 1000) > 300);
});

test("local insertion preserves surrounding sentence boundaries", () => {
  assert.deepEqual(mapUnchangedBoundaries("Hello. Next.", "Hello there. Next.",
    [{ start: 0, end: 7 }, { start: 7, end: 12 }]), [{ start: 0, end: 13 }, { start: 13, end: 18 }]);
});

test("a boundary deleted inside a changed interval cannot be rebound", () => {
  assert.deepEqual(mapUnchangedBoundaries("abcdef", "aZf", [{ start: 2, end: 4 }]), [null]);
});

test("sentence navigation keeps shared boundaries bright and UTF-16 offsets", () => {
  const text = "你好😀。下一句。";
  const ranges = splitSentences(text);
  assert.equal(ranges.at(-1)?.end, text.length);
  assert.equal(resolveActiveSentenceRanges(ranges, ranges[0].end, text.length).length, 2);
});

class ElementStub {
  hidden = false;
  style: Record<string, string> = {};
  children: ElementStub[] = [];
  classes = new Set<string>();
  classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, on: boolean) => on ? this.classes.add(name) : this.classes.delete(name),
  };
  setAttribute() {}
  append(child: ElementStub) { this.children.push(child); }
  remove() {}
}

test("cursor transports scroll, transfers editable ownership, and survives a short geometry gap", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  const body = new ElementStub();
  Object.defineProperty(globalThis, "document", { configurable: true, value: { body, createElement: () => new ElementStub() } });
  try {
    const cursor = createCursor();
    const firstOwner = new ElementStub();
    const secondOwner = new ElementStub();
    const input = frame({ editable: firstOwner as unknown as HTMLElement, scrollTop: 0,
      caret: { x: 100, y: 200, height: 20 } });
    cursor.render(input, 1000, true);
    cursor.render({ ...input, scrollTop: 30, caret: { x: 100, y: 170, height: 20 } }, 1016, true);
    const overlay = body.children[0];
    assert.equal(overlay.style.transform, `translate3d(${input.caret!.x}px,${input.caret!.y - 30 - MOTION.caretLiftPx}px,0)`);
    cursor.render({ ...input, editable: secondOwner as unknown as HTMLElement, scrollTop: 30,
      caret: { x: 140, y: 170, height: 20 } }, 1032, true);
    const x = Number(overlay.style.transform.match(/translate3d\(([^p]+)/)![1]);
    assert.ok(x > 100 && x < 140);
    assert.equal(firstOwner.classes.has("zentype-custom-caret-active"), false);
    assert.equal(secondOwner.classes.has("zentype-custom-caret-active"), true);
    cursor.render({ ...input, editable: secondOwner as unknown as HTMLElement, scrollTop: 30, caret: null }, 1048, true);
    assert.equal(overlay.hidden, false);
    cursor.render({ ...input, editable: secondOwner as unknown as HTMLElement, scrollTop: 30, caret: null }, 1300, true);
    assert.equal(overlay.hidden, true);
    assert.equal(secondOwner.classes.has("zentype-custom-caret-active"), true);
    cursor.destroy();
    assert.equal(secondOwner.classes.has("zentype-custom-caret-active"), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("cursor advances x, y and height on the same retarget frame", () => withPresentation(body => {
  const cursor = createCursor();
  const input = frame({ editable: new PaintElement() as unknown as HTMLElement,
    caret: { x: 100, y: 200, height: 20 } });
  cursor.render(input, 1000, true);
  const overlay = body.children[0];
  cursor.render({ ...input, caret: { x: 400, y: 360, height: 36 } }, 1016, true);
  const coordinates = overlay.style.transform.match(/translate3d\(([-\d.]+)px,([-\d.]+)px,0\)/);
  assert.ok(coordinates);
  assert.notEqual(Number(coordinates[1]), 100);
  assert.notEqual(Number(coordinates[2]), 200 - MOTION.caretLiftPx);
  assert.notEqual(overlay.style.height, "20px");
  cursor.destroy();
}));

test("text projection reports cloned colors without writing during the read phase", () => {
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const savedFilter = Object.getOwnPropertyDescriptor(globalThis, "NodeFilter");
  function parent() {
    const properties = new Map([["--zentype-text-color", "rgb(20, 30, 40)"]]);
    return { style: {
      getPropertyValue: (name: string) => properties.get(name) ?? "",
      removeProperty: (name: string) => properties.delete(name),
    } } as unknown as HTMLElement;
  }
  const owned = parent();
  const cloned = parent();
  const nodes = [{ nodeValue: "owned", parentElement: owned }, { nodeValue: "clone", parentElement: cloned }];
  Object.defineProperty(globalThis, "NodeFilter", { configurable: true, value: { SHOW_ELEMENT: 1, SHOW_TEXT: 4 } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createTreeWalker: () => {
      let index = 0;
      return { nextNode: () => nodes[index++] ?? null };
    },
  } });
  try {
    const clones: HTMLElement[] = [];
    const projection = projectText({} as HTMLElement, new Map([[owned, {}]]), clones);
    assert.equal(projection?.text, "ownedclone");
    assert.deepEqual(clones, [cloned]);
    assert.equal(cloned.style.getPropertyValue("--zentype-text-color"), "rgb(20, 30, 40)");
    assert.equal(owned.style.getPropertyValue("--zentype-text-color"), "rgb(20, 30, 40)");
  } finally {
    if (savedDocument) Object.defineProperty(globalThis, "document", savedDocument);
    else Reflect.deleteProperty(globalThis, "document");
    if (savedFilter) Object.defineProperty(globalThis, "NodeFilter", savedFilter);
    else Reflect.deleteProperty(globalThis, "NodeFilter");
  }
});

function withPresentation(run: (body: PaintElement) => void) {
  const body = new PaintElement();
  const values: Record<string, unknown> = {
    document: { body, head: new PaintElement(), createElement: () => new PaintElement() },
    HTMLElement: PaintElement, Element: PaintElement,
    CSS: { supports: () => false },
    getComputedStyle: (element: PaintElement) => ({
      opacity: element.style.opacity || "1",
      color: "rgb(200, 210, 220)",
    }),
  };
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  try { run(body); } finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

interface AnimationStub {
  id: string;
  frames: Keyframe[];
  currentTime: number;
  playState: string;
  cancel(): void;
  pause(): void;
  play(): void;
  finish(): void;
  onfinish: (() => void) | null;
}

class PaintElement extends ElementStub {
  parentElement: PaintElement | null = null;
  previousElementSibling: PaintElement | null = null;
  nextElementSibling: PaintElement | null = null;
  dataset: Record<string, string> = {};
  isConnected = true;
  animations: AnimationStub[] = [];
  constructor() {
    super();
    Object.assign(this.style, {
      getPropertyValue: (key: string) => this.style[key] ?? "",
      getPropertyPriority: () => "",
      setProperty: (key: string, value: string) => { this.style[key] = value; },
      removeProperty: (key: string) => { delete this.style[key]; },
    });
  }
  matches() { return !!this.dataset.nodeId || this.classes.has("protyle-action"); }
  contains(element: PaintElement | null): boolean {
    return !!element && (element === this || this.contains(element.parentElement));
  }
  animate(frames: Keyframe[]): AnimationStub {
    const animation: AnimationStub = { id: "", frames, currentTime: 0, playState: "running",
      cancel() { this.playState = "idle"; }, pause() { this.playState = "paused"; },
      play() { this.playState = "running"; },
      finish() { this.currentTime = MOTION.blockFadeMs; this.playState = "finished"; this.onfinish?.(); },
      onfinish: null as (() => void) | null };
    this.animations.push(animation);
    return animation;
  }
  getAnimations(options?: { subtree?: boolean }): AnimationStub[] {
    return options?.subtree
      ? [...this.animations, ...this.children.flatMap(child => (child as PaintElement).getAnimations(options))]
      : [...this.animations];
  }
}

interface SessionHarness {
  body: PaintElement;
  editor: PaintElement;
  editable: PaintElement;
  scroll: PaintElement & { scrollTop: number };
  events: Array<{ name: string; payload: Record<string, unknown> }>;
  getFrame(): EditorFrame;
  setFrame(next: EditorFrame | null): void;
  dispatch(at: number, type: string, event?: Record<string, unknown>): void;
  mutate(at: number, records: MutationRecord[]): void;
  tick(at: number, rafTimestamp?: number): void;
  readCount(): number;
  rafCount(): number;
  timerCount(): number;
  session: ReturnType<typeof createWritingSession>;
}

function withSessionHarness(run: (harness: SessionHarness) => void, features = { typewriter: true, ripple: false }) {
  withPresentation(body => {
    const callbacks = new Map<string, (event: Record<string, unknown>) => void>();
    const raf = new Map<number, FrameRequestCallback>();
    const timers = new Map<number, { at: number; callback: () => void }>();
    const observers: Array<{ callback: (records: MutationRecord[]) => void }> = [];
    const events: SessionHarness["events"] = [];
    let serial = 0;
    let now = 0;
    let reads = 0;
    const editor = new PaintElement();
    editor.classes.add("protyle-wysiwyg");
    const editable = new PaintElement();
    editable.dataset.nodeId = "active";
    editable.parentElement = editor;
    Object.assign(editable, { closest: (selector: string) => selector === ".protyle-wysiwyg" ? editor : null });
    const scroll = Object.assign(new PaintElement(), { scrollTop: 300 });
    let current: EditorFrame | null = frame({ editor: editor as unknown as HTMLElement, editable: editable as unknown as HTMLElement,
      block: editable as unknown as HTMLElement, scroll: scroll as unknown as HTMLElement, reducedMotion: true });
    class Observer {
      callback: (records: MutationRecord[]) => void;
      constructor(callback: (records: MutationRecord[]) => void) {
        this.callback = callback;
        observers.push(this);
      }
      observe() {}
      disconnect() {}
      takeRecords() { return []; }
    }
    class Resize { observe() {} disconnect() {} }
    const doc = document as unknown as Record<string, unknown>;
    Object.assign(doc, {
      documentElement: new PaintElement(),
      activeElement: editable,
      hidden: false,
      hasFocus: () => true,
      fonts: { addEventListener() {} },
      addEventListener: (name: string, callback: (event: Record<string, unknown>) => void) => callbacks.set(name, callback),
    });
    const values: Record<string, unknown> = {
      window: {
        addEventListener: (name: string, callback: (event: Record<string, unknown>) => void) => callbacks.set("window:" + name, callback),
      },
      MutationObserver: Observer,
      ResizeObserver: Resize,
      matchMedia: () => ({ matches: true, addEventListener() {} }),
      requestAnimationFrame: (callback: FrameRequestCallback) => { raf.set(++serial, callback); return serial; },
      cancelAnimationFrame: (id: number) => raf.delete(id),
      setTimeout: (callback: () => void, delay = 0) => { timers.set(++serial, { at: now + delay, callback }); return serial; },
      clearTimeout: (id: number) => timers.delete(id),
      performance: { now: () => now },
      sessionFixture: { read: () => { reads++; return current; }, editableAt: () => editable },
    };
    const saved = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
    const debug = {
      record: (_source: string, name: string, payload: Record<string, unknown>) => events.push({ name, payload }),
      recordEvent() {}, recordMutations() {}, recordFrame() {},
    };
    try {
      const session = createWritingSession(features, debug as never);
      const harness: SessionHarness = {
        body, editor, editable, scroll, events, session,
        getFrame: () => { assert.ok(current); return current; },
        setFrame: next => { current = next; },
        dispatch(at, type, event = {}) {
          now = at;
          const callback = callbacks.get(type) ?? callbacks.get("window:" + type);
          assert.ok(callback, `missing ${type} listener`);
          callback({ type, target: editable, ...event });
        },
        mutate(at, records) {
          now = at;
          assert.ok(observers[0], "missing editor MutationObserver");
          observers[0].callback(records);
        },
        tick(at, rafTimestamp = at) {
          now = at;
          for (const [id, timer] of [...timers]) if (timer.at <= at) {
            timers.delete(id);
            timer.callback();
          }
          const pending = [...raf.values()];
          raf.clear();
          for (const callback of pending) callback(rafTimestamp);
        },
        readCount: () => reads,
        rafCount: () => raf.size,
        timerCount: () => timers.size,
      };
      run(harness);
      session.destroy();
    } finally {
      for (const [key, descriptor] of Object.entries(saved)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}

test("motion configuration exposes explicit responseMs semantics", () => {
  assert.equal(MOTION.caretTypingResponseMs, 55);
  assert.equal(MOTION.caretNavigationResponseMs, 110);
  assert.equal(MOTION.scrollResponseMs, 300);
  assert.equal(MOTION.breatheIdleDelayMs, 3000);
  assert.equal(MOTION.breatheRestMs, 2000);
  assert.equal(MOTION.breathDownResponseMs, 900);
  assert.equal(MOTION.breathUpResponseMs, 600);
  assert.equal(MOTION.breatheLowAlpha, 0);
  assert.equal(MOTION.breatheLowHoldMs, 0);
  assert.equal(MOTION.cursorAppearResponseMs, 370);
  assert.equal(MOTION.scrollPositionEpsilonPx, 0.21);
});

test("DebugKit defaults to full, records current-session evidence, and exports after stop", async () => {
  const previousDebug = globalThis.__zentypeDebug;
  const previousDebugHook = globalThis.__zentypeDebugHook;
  const debug = initDebugHook();
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  try {
    const started = await debug.start("debugkit-test");
    assert.equal(started.profile, "full");
    debug.record("session", "test-event", { value: 7, nested: { ok: true } });
    debug.mark("circular-payload", { circular });
    debug.recordFrame(frame(), { sampled: true });
    await debug.stop();
    assert.equal(debug.getState().active, false);
    assert.ok(debug.getState().snapshotsCaptured >= 2);
    assert.ok(debug.getRecentEvents().some(event => event.payload.name === "test-event"));
    const bundle = JSON.parse(debug.exportRecording()) as {
      schema: string;
      session: { profile: string };
      timeline: { events: unknown[] };
      forensic: { events: unknown[] };
    };
    assert.equal(bundle.schema, "zentype-debug-bundle/v1");
    assert.equal(bundle.session.profile, "full");
    assert.ok(bundle.timeline.events.length > 0);
    assert.ok(bundle.forensic.events.length > 0);
  } finally {
    debug.destroy();
    if (previousDebug) globalThis.__zentypeDebug = previousDebug;
    else delete globalThis.__zentypeDebug;
    if (previousDebugHook) globalThis.__zentypeDebugHook = previousDebugHook;
    else delete globalThis.__zentypeDebugHook;
  }
});

test("cursor interrupts breathing from displayed opacity and fades through selection", () => withPresentation(body => {
  const renders: Array<Record<string, unknown>> = [];
  const debug = {
    record: (_source: string, name: string, payload: Record<string, unknown>) => {
      if (name === "render") renders.push(payload);
    },
  } as never;
  const cursor = createCursor(debug);
  const input = frame({ editable: new PaintElement() as unknown as HTMLElement });
  for (let now = 1000; now <= 2000; now += 100) cursor.render(input, now, true);
  const breathStart = 2000 + MOTION.breatheIdleDelayMs;
  cursor.render(input, breathStart, false);
  cursor.render(input, breathStart + 16, false);
  const downSample = renders.at(-1)!;
  const expectedRecovery: CriticalState = {
    value: Number(downSample.alpha), velocity: Number(downSample.alphaVelocity),
  };
  stepCritical(expectedRecovery, 1, 16, MOTION.cursorAppearResponseMs, MOTION.alphaSettleEpsilon);
  const overlay = body.children[0];
  const breathingOpacity = Number(overlay.style.opacity);
  assert.ok(breathingOpacity < 1);
  const interruptAt = breathStart + 32;
  cursor.render(input, interruptAt, false, true);
  const interruptSample = renders.at(-1)!;
  const interruptedOpacity = Number(overlay.style.opacity);
  assert.ok(interruptedOpacity > 0 && interruptedOpacity < 1);
  assert.equal(interruptSample.breathPhase, "normal");
  assert.ok(Math.abs(Number(interruptSample.alpha) - expectedRecovery.value) < 1e-10);
  assert.ok(Math.abs(Number(interruptSample.alphaVelocity) - expectedRecovery.velocity) < 1e-10);
  assert.ok(Number(downSample.alphaVelocity) < 0);
  assert.ok(Number(interruptSample.alphaVelocity) < 0);
  const recoveredAt = interruptAt + MOTION.cursorAppearResponseMs * 3;
  cursor.render(input, recoveredAt, false, true);
  assert.ok(Number(overlay.style.opacity) > breathingOpacity);
  assert.ok(Number(overlay.style.opacity) > interruptedOpacity);
  assert.ok(cursor.yieldSelection(recoveredAt + 16, false));
  assert.equal(overlay.hidden, false);
  assert.ok(Number(overlay.style.opacity) > 0 && Number(overlay.style.opacity) < 1);
  cursor.yieldSelection(recoveredAt + 116, false);
  cursor.render(input, recoveredAt + 132, false);
  assert.equal(overlay.hidden, false);
  assert.ok(Number(overlay.style.opacity) > 0);
  cursor.destroy();
}));

test("breathing reaches exact low alpha and hands off without a low-hold timer", () => withPresentation(body => {
  const renders: Array<Record<string, unknown>> = [];
  const debug = {
    record: (_source: string, name: string, payload: Record<string, unknown>) => {
      if (name === "render") renders.push(payload);
    },
  } as never;
  const cursor = createCursor(debug);
  const input = frame({ editable: new PaintElement() as unknown as HTMLElement });
  for (let now = 1000; now <= 2000; now += 16) cursor.render(input, now, true);
  const breathStart = 2000 + MOTION.breatheIdleDelayMs;
  assert.equal(cursor.render(input, breathStart, false), true);
  const overlay = body.children[0];
  const downResponseAt = breathStart + MOTION.breathDownResponseMs;
  cursor.render(input, downResponseAt, false);
  assert.ok(Math.abs(Number(overlay.style.opacity) - 0.1) < 0.001);
  let lowSettledAt = 0;
  for (let now = downResponseAt + 16; now <= breathStart + 3000; now += 16) {
    cursor.render(input, now, false);
    if (renders.at(-1)?.breathPhase === "hold") {
      lowSettledAt = now;
      break;
    }
  }
  assert.ok(lowSettledAt > breathStart);
  const lowOpacity = Number(overlay.style.opacity);
  assert.equal(lowOpacity, 0);
  assert.equal(lowOpacity, MOTION.breatheLowAlpha);
  assert.equal(cursor.wakeDelay(lowSettledAt), null);
  const upAt = lowSettledAt + 16;
  assert.equal(cursor.render(input, upAt, false), true);
  assert.equal(renders.at(-1)?.breathPhase, "up");
  assert.equal(Number(overlay.style.opacity), lowOpacity);
  cursor.render(input, upAt + 16, false);
  assert.ok(Number(overlay.style.opacity) > lowOpacity);
  assert.ok(Number(overlay.style.opacity) < 1);
  cursor.destroy();
}));

test("cursor activity restarts the full breathing idle deadline", () => withPresentation(body => {
  const phases: string[] = [];
  const debug = {
    record: (_source: string, name: string, payload: Record<string, unknown>) => {
      if (name === "render") phases.push(String(payload.breathPhase));
    },
  } as never;
  const cursor = createCursor(debug);
  const input = frame({ editable: new PaintElement() as unknown as HTMLElement });
  for (let now = 1000; now <= 2000; now += 16) cursor.render(input, now, true);

  const activityAt = 5000;
  cursor.render(input, activityAt, false, true);
  assert.equal(phases.at(-1), "normal");
  cursor.render(input, activityAt + MOTION.breatheIdleDelayMs - 1, false);
  assert.equal(phases.at(-1), "normal");
  cursor.render(input, activityAt + MOTION.breatheIdleDelayMs, false);
  assert.equal(phases.at(-1), "down");
  cursor.destroy();
}));

test("cursor breathing follows normal, down, hold, up, normal phases", () => withPresentation(body => {
  const phases: string[] = [];
  const debug = {
    record: (_source: string, name: string, payload: Record<string, unknown>) => {
      if (name === "render") phases.push(String(payload.breathPhase));
    },
  } as never;
  const cursor = createCursor(debug);
  const input = frame({ editable: new PaintElement() as unknown as HTMLElement });
  for (let now = 1000; now <= 2000; now += 16) cursor.render(input, now, true);
  const downAt = 2000 + MOTION.breatheIdleDelayMs;
  cursor.render(input, downAt, false);
  let lowSettledAt = 0;
  for (let now = downAt + 16; now <= downAt + 3000; now += 16) {
    cursor.render(input, now, false);
    if (phases.at(-1) === "hold") {
      lowSettledAt = now;
      break;
    }
  }
  assert.ok(lowSettledAt > downAt);
  const upAt = lowSettledAt + 16;
  assert.equal(cursor.render(input, upAt, false), true);
  assert.equal(phases.at(-1), "up");
  let upSettledAt = 0;
  for (let now = upAt + 16; now <= upAt + 3000; now += 16) {
    if (!cursor.render(input, now, false)) {
      upSettledAt = now;
      break;
    }
  }
  assert.ok(upSettledAt > upAt);
  const ordered = phases.filter((phase, index) => index === 0 || phase !== phases[index - 1]);
  assert.deepEqual(ordered, ["normal", "down", "hold", "up", "normal"]);
  cursor.destroy();
}));

test("next breathing starts only after the post-recovery bright rest", () => withPresentation(body => {
  const phases: string[] = [];
  const debug = {
    record: (_source: string, name: string, payload: Record<string, unknown>) => {
      if (name === "render") phases.push(String(payload.breathPhase));
    },
  } as never;
  const cursor = createCursor(debug);
  const input = frame({ editable: new PaintElement() as unknown as HTMLElement });
  for (let now = 1000; now <= 2000; now += 16) cursor.render(input, now, true);
  const downAt = 2000 + MOTION.breatheIdleDelayMs;
  cursor.render(input, downAt, false);
  let lowSettledAt = 0;
  for (let now = downAt + 16; now <= downAt + 3000; now += 16) {
    cursor.render(input, now, false);
    if (phases.at(-1) === "hold") {
      lowSettledAt = now;
      break;
    }
  }
  assert.ok(lowSettledAt > downAt);
  const upAt = lowSettledAt + 16;
  assert.equal(cursor.render(input, upAt, false), true);
  assert.equal(phases.at(-1), "up");
  let upSettledAt = 0;
  for (let now = upAt + 16; now <= upAt + 3000; now += 16) {
    if (!cursor.render(input, now, false)) {
      upSettledAt = now;
      break;
    }
  }
  assert.ok(upSettledAt > upAt);
  assert.equal(cursor.wakeDelay(upSettledAt), MOTION.breatheRestMs);
  const beforeRest = upSettledAt + MOTION.breatheRestMs - 1;
  assert.equal(cursor.render(input, beforeRest, false), false);
  assert.equal(phases.at(-1), "normal");
  cursor.render(input, upSettledAt + MOTION.breatheRestMs, false);
  assert.equal(phases.at(-1), "down");
  cursor.destroy();
}));

test("cursor avoids a zero-duration low wake and exposes one bounded bright-rest wake", () => withPresentation(body => {
  const phases: string[] = [];
  const debug = {
    record: (_source: string, name: string, payload: Record<string, unknown>) => {
      if (name === "render") phases.push(String(payload.breathPhase));
    },
  } as never;
  const cursor = createCursor(debug);
  const input = frame({ editable: new PaintElement() as unknown as HTMLElement });
  for (let now = 1000; now <= 2000; now += 16) cursor.render(input, now, true);
  const downAt = 2000 + MOTION.breatheIdleDelayMs;
  assert.equal(cursor.render(input, downAt, false), true);
  assert.equal(cursor.wakeDelay(downAt), null);
  let lowSettledAt = 0;
  for (let now = downAt + 16; now <= downAt + 3000; now += 16) {
    cursor.render(input, now, false);
    if (phases.at(-1) === "hold") {
      lowSettledAt = now;
      break;
    }
  }
  assert.ok(lowSettledAt > downAt);
  assert.equal(cursor.wakeDelay(lowSettledAt), null);
  const upAt = lowSettledAt + 16;
  assert.equal(cursor.render(input, upAt, false), true);
  assert.equal(phases.at(-1), "up");
  assert.equal(cursor.wakeDelay(upAt), null);
  cursor.destroy();
}));

test("geometry release freezes breathing and fades the outer cursor promptly", () => withPresentation(body => {
  const cursor = createCursor();
  const input = frame({ editable: new PaintElement() as unknown as HTMLElement });
  for (let now = 1000; now <= 2000; now += 16) cursor.render(input, now, true);
  const breathStart = 2000 + MOTION.breatheIdleDelayMs;
  cursor.render(input, breathStart, false);
  cursor.render(input, breathStart + 16, false);
  const overlay = body.children[0];
  assert.ok(Number(overlay.style.opacity) < 1);
  cursor.release(breathStart + 32, false);
  for (let now = breathStart + 48; now <= breathStart + 1000 && !overlay.hidden; now += 16) cursor.release(now, false);
  assert.equal(overlay.hidden, true);
  cursor.render({ ...input, caret: { x: 300, y: 200, height: 20 } }, breathStart + 1016, false);
  assert.equal(overlay.style.transform, `translate3d(300px,${200 - MOTION.caretLiftPx}px,0)`);
  assert.ok(Number(overlay.style.opacity) > 0);
  cursor.release(breathStart + 1032, true);
  assert.equal(overlay.hidden, true);
  cursor.destroy();
}));

test("editor switch commits hidden geometry before a full reveal motion", () => withPresentation(body => {
  const records: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const debug = {
    record: (_source: string, name: string, payload: Record<string, unknown>) => records.push({ name, payload }),
  } as never;
  const cursor = createCursor(debug);
  const input = frame({ editable: new PaintElement() as unknown as HTMLElement });
  cursor.switched(input.editor, 1000);
  const overlay = body.children[0];
  for (let i = 0; i < 7; i++) cursor.render(input, 1000 + i * 16, false);
  assert.equal(overlay.hidden, true);
  const moved = { ...input, caret: { x: 200, y: 300, height: 24 } };
  for (let i = 0; i < 7; i++) cursor.render(moved, 1112 + i * 16, false);
  assert.equal(overlay.hidden, true);
  cursor.render(moved, 1224, false);
  assert.equal(cursor.isSettling(), true);
  assert.equal(overlay.hidden, true);
  assert.equal(overlay.style.opacity, "0");
  assert.equal(overlay.style.transform, `translate3d(200px,${300 - MOTION.caretLiftPx}px,0)`);
  const hiddenCommit = records.find(record => record.name === "switch-commit-hidden");
  assert.ok(hiddenCommit);
  assert.equal(hiddenCommit.payload.alpha, 0);
  assert.equal(hiddenCommit.payload.alphaVelocity, 0);
  assert.equal(hiddenCommit.payload.revealElapsed, 0);

  cursor.render(moved, 1240, false);
  assert.equal(cursor.isSettling(), true);
  assert.equal(overlay.hidden, false);
  assert.equal(overlay.style.opacity, "0");
  assert.equal(records.at(-1)?.payload.revealElapsed, 0);
  cursor.render(moved, 1256, false);
  assert.ok(Number(overlay.style.opacity) > 0 && Number(overlay.style.opacity) < 1);
  const expectedReveal: CriticalState = { value: 0, velocity: 0 };
  stepCritical(expectedReveal, 1, 16, MOTION.cursorAppearResponseMs, MOTION.alphaSettleEpsilon);
  assert.ok(Math.abs(Number(overlay.style.opacity) - expectedReveal.value) < 1e-10);
  assert.equal(records.at(-1)?.payload.revealElapsed, 16);

  let settledAt = 0;
  for (let now = 1272; now <= 5000; now += 16) {
    cursor.render(moved, now, false);
    if (!cursor.isSettling()) { settledAt = now; break; }
  }
  assert.ok(settledAt > 1256);
  assert.equal(Number(overlay.style.opacity), 1);
  cursor.destroy();
}));

test("shared authority withholds a transient caret until mutation and geometry settle", () => withPresentation(body => {
  const cursor = createCursor();
  const gate = createStructureGate();
  const input = frame({ editable: new PaintElement() as unknown as HTMLElement });
  cursor.render(input, 1000, true);
  const overlay = body.children[0];
  const original = overlay.style.transform;
  gate.intent(input.editor, 1016);
  assert.equal(gate.sample({ ...input, caret: { x: 500, y: 300, height: 20 } }, 1032), "wait");
  assert.equal(overlay.style.transform, original);
  gate.mutation(input.editor, 1040, "structural");
  const final = { ...input, caret: { x: 200, y: 300, height: 20 } };
  assert.equal(gate.sample(final, 1048), "wait");
  assert.equal(overlay.style.transform, original);
  assert.equal(gate.sample(final, 1064), "wait");
  assert.equal(gate.sample(final, 1088), "commit");
  cursor.render(final, 1088, true);
  assert.notEqual(overlay.style.transform, `translate3d(500px,${300 - MOTION.caretLiftPx}px,0)`);
  cursor.destroy();
}));

test("Session withholds native text evidence until delayed host structure settles", () => withSessionHarness(harness => {
  harness.tick(0);
  const overlay = harness.body.children[0];
  const original = overlay.style.transform;
  const committed = harness.events.filter(event => event.name === "frame-commit").length;
  const prepared = harness.events.filter(event => event.name === "prepare").length;

  harness.dispatch(0, "keydown", { key: "Backspace", defaultPrevented: false });
  harness.dispatch(4, "input", { inputType: "deleteContentBackward", isComposing: false });
  harness.mutate(6, [{ type: "characterData", target: harness.editable,
    addedNodes: [], removedNodes: [] } as unknown as MutationRecord]);
  harness.setFrame({ ...harness.getFrame(), caret: { x: 500, y: 580, height: 20 } });
  harness.tick(16);

  assert.equal(overlay.style.transform, original);
  assert.equal(harness.scroll.scrollTop, 300);
  assert.equal(harness.events.filter(event => event.name === "frame-commit").length, committed);
  assert.equal(harness.events.filter(event => event.name === "prepare").length, prepared);

  const removed = new PaintElement();
  removed.dataset.nodeId = "removed";
  harness.mutate(18, [{ type: "childList", target: harness.editor, addedNodes: [], removedNodes: [removed] } as unknown as MutationRecord]);
  harness.dispatch(20, "selectionchange");
  harness.setFrame({ ...harness.getFrame(), caret: { x: 350, y: 320, height: 20 } });
  harness.tick(32);
  const final = { ...harness.getFrame(), caret: { x: 200, y: 300, height: 20 } };
  harness.setFrame(final);
  harness.tick(48);
  harness.tick(64);
  assert.equal(overlay.style.transform, original);
  harness.tick(80);

  assert.equal(overlay.style.transform, `translate3d(200px,${300 - MOTION.caretLiftPx}px,0)`);
  assert.ok(harness.events.some(event => event.name === "structure-commit"));
  assert.ok(harness.events.filter(event => event.name === "prepare").length > prepared);
}, { typewriter: true, ripple: true }));

test("ordinary Backspace commits after one bounded post-input quiet window", () => withSessionHarness(harness => {
  harness.tick(0);
  const overlay = harness.body.children[0];
  const original = overlay.style.transform;
  harness.dispatch(0, "keydown", { key: "Backspace", defaultPrevented: false });
  harness.dispatch(4, "input", { inputType: "deleteContentBackward", isComposing: false });
  harness.mutate(6, [{ type: "characterData", target: harness.editable,
    addedNodes: [], removedNodes: [] } as unknown as MutationRecord]);
  harness.setFrame({ ...harness.getFrame(), caret: { x: 120, y: 540, height: 20 } });
  harness.tick(16);

  assert.equal(overlay.style.transform, original);
  assert.ok(harness.events.some(event => event.name === "structure-sample" &&
    event.payload.decision === "wait" && event.payload.reason === "awaiting-post-input-quiet"));
  harness.tick(53);
  assert.equal(overlay.style.transform, original);
  harness.tick(54);

  assert.notEqual(overlay.style.transform, original);
  assert.ok(harness.events.some(event => event.name === "structure-sample" &&
    event.payload.decision === "ordinary" && event.payload.reason === "non-structural-quiet"));
  assert.equal(harness.events.some(event => event.name === "structure-evidence"), false);
}));

test("skewed rAF time never publishes transient ordinary Backspace geometry", () => withSessionHarness(harness => {
  harness.tick(0);
  const overlay = harness.body.children[0];
  const original = overlay.style.transform;
  const committed = harness.events.filter(event => event.name === "frame-commit").length;
  const prepared = harness.events.filter(event => event.name === "prepare").length;
  const typewriterFrames = harness.events.filter(event => event.name === "frame" && "requestedScroll" in event.payload).length;

  harness.dispatch(0, "keydown", { key: "Backspace", defaultPrevented: false });
  harness.dispatch(2, "beforeinput", { inputType: "deleteContentBackward", isComposing: false });
  harness.dispatch(4.5, "input", { inputType: "deleteContentBackward", isComposing: false });
  harness.mutate(4.6, [{ type: "characterData", target: harness.editable,
    addedNodes: [], removedNodes: [] } as unknown as MutationRecord]);
  harness.setFrame({ ...harness.getFrame(), caret: { x: 1114.199951171875, y: 302.75, height: 20 } });
  harness.tick(6, 140);

  const frameStart = harness.events.filter(event => event.name === "frame-start").at(-1)!;
  assert.equal(frameStart.payload.now, 6);
  assert.equal(frameStart.payload.clockNow, 6);
  assert.equal(frameStart.payload.rafTimestamp, 140);
  assert.equal(frameStart.payload.rafSkewMs, 134);
  assert.equal(overlay.style.transform, original);
  assert.equal(harness.scroll.scrollTop, 300);
  assert.equal(harness.events.filter(event => event.name === "frame-commit").length, committed);
  assert.equal(harness.events.filter(event => event.name === "prepare").length, prepared);
  assert.equal(harness.events.filter(event => event.name === "frame" && "requestedScroll" in event.payload).length, typewriterFrames);
  assert.ok(harness.events.some(event => event.name === "structure-sample" &&
    event.payload.decision === "wait" && event.payload.reason === "awaiting-post-input-quiet"));
  assert.equal(harness.events.some(event => event.payload.targetX === 1114.199951171875), false);

  harness.dispatch(9, "selectionchange");
  const removed = new PaintElement();
  const replacement = new PaintElement();
  removed.dataset.nodeId = replacement.dataset.nodeId = "normalized";
  harness.mutate(16, [{ type: "childList", target: harness.editor,
    addedNodes: [replacement], removedNodes: [removed] } as unknown as MutationRecord]);
  harness.dispatch(17, "selectionchange");
  harness.setFrame({ ...harness.getFrame(), caret: { x: 259, y: 323.75, height: 20 } });
  harness.tick(17, 151);
  assert.equal(harness.events.some(event => event.payload.targetX === 1114.199951171875), false);
  harness.tick(65, 199);

  assert.ok(harness.events.some(event => event.name === "structure-sample" &&
    event.payload.decision === "ordinary" && event.payload.reason === "non-structural-quiet"));
  assert.ok(harness.events.some(event => event.payload.targetX === 259));
  assert.equal(harness.events.some(event => event.payload.targetX === 1114.199951171875), false);
}, { typewriter: true, ripple: true }));

test("structure deadline uses the execution clock under rAF skew", () => withSessionHarness(harness => {
  harness.tick(0);
  harness.dispatch(0, "keydown", { key: "Tab", defaultPrevented: false });
  harness.tick(30, 164);

  assert.equal(harness.events.some(event => event.name === "structure-timeout"), false);
  assert.equal(harness.events.some(event => event.name === "structure-release" && event.payload.reason === "timeout"), false);
  assert.ok(harness.events.some(event => event.name === "structure-sample" && event.payload.elapsed === 30));
  harness.tick(MOTION.structureDeadlineMs, MOTION.structureDeadlineMs + 134);
  assert.ok(harness.events.some(event => event.name === "structure-release" && event.payload.reason === "timeout"));
}));

test("ordinary quiet window uses 48ms of execution time under rAF skew", () => withSessionHarness(harness => {
  harness.tick(0);
  harness.dispatch(0, "keydown", { key: "Backspace", defaultPrevented: false });
  harness.dispatch(4, "input", { inputType: "deleteContentBackward", isComposing: false });
  harness.mutate(6, [{ type: "characterData", target: harness.editable,
    addedNodes: [], removedNodes: [] } as unknown as MutationRecord]);
  harness.tick(53, 500);

  assert.equal(harness.events.some(event => event.name === "structure-sample" && event.payload.decision === "ordinary"), false);
  assert.ok(harness.events.some(event => event.name === "structure-sample" && event.payload.quiet === 47));
  harness.tick(54, 1000);
  assert.ok(harness.events.some(event => event.name === "structure-sample" &&
    event.payload.decision === "ordinary" && event.payload.quiet === MOTION.structureQuietMs));
}));

test("typing pause uses the execution clock under rAF skew", () => withSessionHarness(harness => {
  harness.tick(0);
  harness.setFrame({ ...harness.getFrame(), caret: { x: 100, y: 350, height: 20 } });
  harness.dispatch(0, "input", { inputType: "insertText", isComposing: false });
  harness.tick(300, 434);

  assert.equal(harness.scroll.scrollTop, 300);
  assert.equal(harness.events.filter(event => event.name === "render" && "typing" in event.payload).at(-1)?.payload.typing, true);
  harness.tick(MOTION.typingPauseMs + 1, MOTION.typingPauseMs + 135);
  assert.ok(harness.scroll.scrollTop > 300);
  assert.equal(harness.events.filter(event => event.name === "render" && "typing" in event.payload).at(-1)?.payload.typing, false);
}));

test("interaction hold uses the execution clock under rAF skew", () => withSessionHarness(harness => {
  harness.tick(0);
  harness.dispatch(100, "pointerdown");
  harness.dispatch(100, "pointerup");
  harness.tick(200, 334);

  assert.equal(harness.events.filter(event => event.name === "render" && "interacting" in event.payload).at(-1)?.payload.interacting, true);
  harness.dispatch(250, "selectionchange");
  harness.tick(250, 384);
  assert.equal(harness.events.filter(event => event.name === "render" && "interacting" in event.payload).at(-1)?.payload.interacting, false);
}));

test("recovery budget uses the execution clock under rAF skew", () => withSessionHarness(harness => {
  harness.tick(0);
  const overlay = harness.body.children[0];
  harness.setFrame(null);
  harness.dispatch(0, "focusin");
  harness.tick(30, 164);

  assert.equal(harness.events.filter(event => event.name === "frame-missing").at(-1)?.payload.withinRecovery, true);
  assert.equal(overlay.hidden, false);
  assert.equal(harness.timerCount(), 1);
  harness.tick(MOTION.recoveryMs, MOTION.recoveryMs + 134);
  assert.equal(harness.events.filter(event => event.name === "frame-missing").at(-1)?.payload.withinRecovery, false);
  assert.equal(overlay.hidden, true);
  assert.equal(harness.timerCount(), 0);
}));

test("intent without ordinary or structural evidence releases only at the bounded deadline", () => withSessionHarness(harness => {
  harness.tick(0);
  const committed = harness.events.filter(event => event.name === "frame-commit").length;
  harness.dispatch(0, "keydown", { key: "Tab", defaultPrevented: false });
  harness.setFrame({ ...harness.getFrame(), caret: { x: 500, y: 580, height: 20 } });
  harness.tick(MOTION.structureQuietMs);

  assert.equal(harness.events.filter(event => event.name === "frame-commit").length, committed);
  assert.equal(harness.events.some(event => event.name === "structure-timeout"), false);
  harness.tick(MOTION.structureDeadlineMs);
  assert.ok(harness.events.some(event => event.name === "structure-release" && event.payload.reason === "timeout"));
  assert.equal(harness.rafCount(), 0);
  assert.equal(harness.timerCount(), 0);
}));

test("structural evidence keeps bounded frame sampling through a caret gap", () => withSessionHarness(harness => {
  harness.tick(0);
  const overlay = harness.body.children[0];
  const original = overlay.style.transform;
  harness.dispatch(0, "keydown", { key: "Tab", defaultPrevented: false });
  const removed = new PaintElement();
  removed.dataset.nodeId = "removed";
  harness.mutate(4, [{ type: "childList", target: harness.editor,
    addedNodes: [], removedNodes: [removed] } as unknown as MutationRecord]);
  harness.setFrame({ ...harness.getFrame(), caret: null });
  harness.tick(16);
  assert.equal(harness.rafCount(), 1);
  harness.tick(32);
  assert.equal(harness.rafCount(), 1);
  const final = { ...harness.getFrame(), caret: { x: 220, y: 310, height: 20 } };
  harness.setFrame(final);
  harness.tick(48);
  harness.tick(64);

  assert.notEqual(overlay.style.transform, original);
  assert.equal(overlay.style.transform, `translate3d(220px,${310 - MOTION.caretLiftPx}px,0)`);
  assert.equal(harness.rafCount(), 0);
  assert.ok(harness.events.some(event => event.name === "structure-commit"));
  assert.equal(harness.events.some(event => event.name === "structure-timeout"), false);
}));

test("unstable structural geometry times out without committing or leaving work scheduled", () => withSessionHarness(harness => {
  harness.tick(0);
  const committed = harness.events.filter(event => event.name === "frame-commit").length;
  harness.dispatch(0, "keydown", { key: "Tab", defaultPrevented: false });
  const removed = new PaintElement();
  removed.dataset.nodeId = "removed";
  harness.mutate(4, [{ type: "childList", target: harness.editor,
    addedNodes: [], removedNodes: [removed] } as unknown as MutationRecord]);
  harness.setFrame({ ...harness.getFrame(), caret: null });
  for (let now = 16; now <= MOTION.structureDeadlineMs; now += 16) harness.tick(now);

  assert.equal(harness.events.filter(event => event.name === "frame-commit").length, committed);
  assert.ok(harness.events.some(event => event.name === "structure-release" && event.payload.reason === "timeout"));
  assert.equal(harness.rafCount(), 0);
  assert.equal(harness.timerCount(), 0);
}));

test("horizontal navigation cancels structure intent but keeps writing and Ripple active", () => {
  for (const key of ["ArrowLeft", "ArrowRight", "Home", "End", "Escape"]) {
    withSessionHarness(harness => {
      harness.tick(0);
      harness.dispatch(0, "input", { inputType: "insertText", isComposing: false });
      harness.tick(16);
      harness.dispatch(20, "keydown", { key: "Tab", defaultPrevented: false });
      harness.dispatch(24, "keydown", { key, defaultPrevented: false });
      harness.tick(40);

      assert.ok(harness.events.some(event => event.name === "structure-cancel" && event.payload.reason === "navigation"), key);
      const prepare = harness.events.filter(event => event.name === "prepare").at(-1);
      assert.equal(prepare?.payload.enabled, true, key);
    }, { typewriter: true, ripple: true });
  }
});

test("vertical navigation cancels structure intent and exits writing and Ripple", () => {
  for (const key of ["ArrowUp", "ArrowDown", "PageUp", "PageDown"]) {
    withSessionHarness(harness => {
      harness.tick(0);
      harness.dispatch(0, "input", { inputType: "insertText", isComposing: false });
      harness.tick(16);
      harness.dispatch(20, "keydown", { key: "Tab", defaultPrevented: false });
      harness.dispatch(24, "keydown", { key, defaultPrevented: false });
      harness.tick(40);

      assert.ok(harness.events.some(event => event.name === "structure-cancel" && event.payload.reason === "navigation"), key);
      const prepare = harness.events.filter(event => event.name === "prepare").at(-1);
      assert.equal(prepare?.payload.enabled, false, key);
    }, { typewriter: true, ripple: true });
  }
});

test("interaction and lifecycle interruptions cancel a pending structure gate", () => {
  for (const [type, reason] of [["pointerdown", "pointer"], ["wheel", "wheel"], ["blur", "lifecycle"]]) {
    withSessionHarness(harness => {
      harness.tick(0);
      harness.dispatch(0, "keydown", { key: "Tab", defaultPrevented: false });
      harness.dispatch(4, type);
      harness.tick(16);
      assert.ok(harness.events.some(event => event.name === "structure-cancel" && event.payload.reason === reason), type);
      assert.equal(harness.events.some(event => event.name === "structure-timeout"), false, type);
      assert.equal(harness.rafCount(), 0, type);
      assert.equal(harness.timerCount(), 0, type);
    });
  }
  withSessionHarness(harness => {
    harness.tick(0);
    harness.dispatch(0, "keydown", { key: "Tab", defaultPrevented: false });
    const editor = new PaintElement();
    const editable = new PaintElement();
    editable.parentElement = editor;
    harness.setFrame({ ...harness.getFrame(), editor: editor as unknown as HTMLElement,
      editable: editable as unknown as HTMLElement, block: editable as unknown as HTMLElement });
    harness.tick(16);
    assert.ok(harness.events.some(event => event.name === "structure-cancel" && event.payload.reason === "editor-switch"));
    assert.equal(harness.events.some(event => event.name === "structure-timeout"), false);
    assert.equal(harness.rafCount(), 0);
    harness.tick(MOTION.typingPauseMs + 1);
    assert.equal(harness.rafCount(), 0);
    assert.equal(harness.timerCount(), 0);
  });
});

test("explicit lifecycle suspension releases owned Ripple opacity instead of clearing it", () => withSessionHarness(harness => {
  const previous = new PaintElement();
  previous.dataset.nodeId = "previous";
  previous.parentElement = harness.editor;
  previous.nextElementSibling = harness.editable;
  harness.editable.previousElementSibling = previous;
  harness.editor.children = [previous, harness.editable];
  harness.setFrame({ ...harness.getFrame(), reducedMotion: false, range: {} as Range });
  harness.dispatch(0, "input", { inputType: "insertText", isComposing: false });
  harness.tick(0);
  const dim = previous.animations.at(-1);
  assert.ok(dim);
  dim.currentTime = MOTION.blockFadeMs;

  harness.session.suspend();

  const release = previous.animations.at(-1)!;
  assert.notEqual(release, dim);
  assert.equal(dim.playState, "idle");
  assert.equal(release.frames[0].opacity, RIPPLE_LEVELS[1]);
  assert.equal(release.frames[1].opacity, 1);
  assert.equal(release.playState, "running");
  harness.session.suspend();
  assert.equal(release.playState, "running");
}, { typewriter: false, ripple: true }));

test("window blur preserves Cursor presentation while hidden document still releases it", () => withSessionHarness(harness => {
  const previous = new PaintElement();
  previous.dataset.nodeId = "previous";
  previous.parentElement = harness.editor;
  previous.nextElementSibling = harness.editable;
  harness.editable.previousElementSibling = previous;
  harness.editor.children = [previous, harness.editable];
  harness.setFrame({ ...harness.getFrame(), reducedMotion: false, range: {} as Range });

  harness.dispatch(0, "input", { inputType: "insertText", isComposing: false });
  harness.tick(0);
  const overlay = harness.body.children[0];
  const opacityBefore = Number(overlay.style.opacity);
  const scrollBeforeBlur = harness.scroll.scrollTop;
  assert.equal(overlay.hidden, false);
  assert.ok(opacityBefore > 0);

  harness.dispatch(4, "keydown", { key: "Tab", defaultPrevented: false });
  const readsBeforeFocus = harness.readCount();
  harness.dispatch(16, "blur");

  assert.equal(overlay.hidden, false);
  assert.equal(Number(overlay.style.opacity), opacityBefore);
  assert.equal(harness.rafCount(), 0);
  assert.equal(harness.timerCount(), 0);
  assert.ok(harness.events.some(event => event.name === "structure-cancel" && event.payload.reason === "lifecycle"));
  assert.ok(harness.events.some(event => event.name === "clear"));
  assert.equal(previous.animations.some(animation => animation.playState === "running"), false);

  harness.dispatch(100, "focus");
  harness.tick(100);
  assert.ok(harness.readCount() > readsBeforeFocus);
  assert.equal(harness.scroll.scrollTop, scrollBeforeBlur);
  assert.equal(harness.events.filter(event => event.name === "prepare").at(-1)?.payload.enabled, false);
  assert.equal(harness.events.filter(event => event.name === "frame-commit").at(-1)?.payload.typewriterMoving, false);

  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  harness.dispatch(120, "visibilitychange");
  assert.equal(overlay.hidden, true);
}, { typewriter: true, ripple: true }));

test("mutation delivery rebinds a semantic replacement before the next rAF", () => withSessionHarness(harness => {
  const old = new PaintElement();
  old.dataset.nodeId = "previous";
  old.parentElement = harness.editor;
  old.nextElementSibling = harness.editable;
  harness.editable.previousElementSibling = old;
  harness.editor.children = [old, harness.editable];
  harness.setFrame({ ...harness.getFrame(), reducedMotion: false, range: {} as Range });
  harness.dispatch(0, "input", { inputType: "insertText", isComposing: false });
  harness.tick(0);
  const dim = old.animations.at(-1)!;
  dim.currentTime = MOTION.blockFadeMs / 2;

  const replacement = new PaintElement();
  replacement.dataset.nodeId = old.dataset.nodeId;
  replacement.parentElement = harness.editor;
  old.isConnected = false;
  harness.mutate(4, [{ type: "childList", target: harness.editor,
    addedNodes: [replacement], removedNodes: [old] } as unknown as MutationRecord]);

  const carry = replacement.animations.at(-1)!;
  assert.ok(carry);
  assert.equal(carry.frames[0].opacity, 1 + (RIPPLE_LEVELS[1] - 1) * 0.875);
  assert.equal(carry.frames[1].opacity, 1 + (RIPPLE_LEVELS[1] - 1) * 0.875);
  assert.equal(carry.playState, "paused");
}, { typewriter: false, ripple: true }));

test("switch settling is bounded through missing geometry and cancelled by lifecycle", () => withPresentation(body => {
  const cursor = createCursor();
  const input = frame({ editable: new PaintElement() as unknown as HTMLElement });
  const overlay = body.children[0];
  cursor.switched(input.editor, 1000);
  for (let i = 0; i < 7; i++) cursor.render(input, 1000 + i * 16, false);
  cursor.render({ ...input, caret: null }, 1112, false);
  cursor.render(input, 1128, false);
  assert.equal(overlay.hidden, true);
  cursor.render({ ...input, caret: { x: 400, y: 300, height: 20 } }, 1700, false);
  assert.equal(cursor.isSettling(), true);
  assert.equal(overlay.hidden, true);
  assert.equal(overlay.style.transform, `translate3d(400px,${300 - MOTION.caretLiftPx}px,0)`);
  cursor.render({ ...input, caret: { x: 400, y: 300, height: 20 } }, 1716, false);
  assert.equal(cursor.isSettling(), true);
  assert.equal(overlay.hidden, false);
  assert.equal(overlay.style.opacity, "0");
  for (let now = 1732; now <= 5000 && cursor.isSettling(); now += 16) {
    cursor.render({ ...input, caret: { x: 400, y: 300, height: 20 } }, now, false);
  }
  assert.equal(cursor.isSettling(), false);
  cursor.switched(input.editor, 2000);
  cursor.render({ ...input, caret: null }, 2700, false);
  assert.equal(cursor.isSettling(), false);
  assert.equal(overlay.hidden, true);
  cursor.switched(input.editor, 3000);
  cursor.hide();
  assert.equal(cursor.isSettling(), false);
  cursor.switched(input.editor, 4000);
  cursor.release(4016, false);
  assert.equal(cursor.isSettling(), false);
  cursor.switched(input.editor, 5000);
  cursor.yieldSelection(5016, false);
  assert.equal(cursor.isSettling(), false);
  cursor.switched(input.editor, 6000);
  cursor.render({ ...input, reducedMotion: true }, 6000, false);
  assert.equal(cursor.isSettling(), false);
  assert.equal(overlay.hidden, false);
  cursor.destroy();
}));

test("caretless and selected editables retain native suppression until host release", () => withPresentation(body => {
  const cursor = createCursor();
  const first = new PaintElement();
  const second = new PaintElement();
  const input = frame({ editable: first as unknown as HTMLElement });
  const overlay = body.children[0];
  cursor.render(input, 1000, false);
  for (let now = 1016; now < 1400; now += 16) {
    cursor.render({ ...input, editable: second as unknown as HTMLElement,
      caret: null, caretless: true }, now, false);
  }
  assert.equal(overlay.hidden, true);
  assert.equal(first.classes.has("zentype-custom-caret-active"), false);
  assert.equal(second.classes.has("zentype-custom-caret-active"), true);
  assert.equal(cursor.yieldSelection(1400, false, first as unknown as HTMLElement), false);
  assert.equal(second.classes.has("zentype-custom-caret-active"), false);
  assert.equal(first.classes.has("zentype-custom-caret-active"), true);
  cursor.render(input, 1416, false);
  assert.equal(overlay.hidden, false);
  cursor.release(1432, false);
  assert.equal(first.classes.has("zentype-custom-caret-active"), false);
  cursor.render({ ...input, caret: null }, 2000, false);
  assert.equal(first.classes.has("zentype-custom-caret-active"), true);
  cursor.hide();
  assert.equal(first.classes.has("zentype-custom-caret-active"), false);
  cursor.destroy();
}));

test("distant click is a single center alignment and nearby clicks do not scroll", () => {
  const writer = createTypewriter();
  assert.equal(writer.next(frame({ caret: { x: 0, y: 400, height: 20 } }), 1000, true, 0, true), 300);
  const located = writer.next(frame({ reducedMotion: true }), 1016, true, 0, true);
  assert.equal(located, 560);
  assert.equal(writer.isLocating(), false);
  assert.equal(writer.next(frame({ scrollTop: located }), 1032, false, 0), located);
});

test("host takeover remains yielded until newer input", () => {
  const writer = createTypewriter();
  writer.written(writer.next(frame(), 1000, true, 0));
  assert.equal(writer.next(frame({ scrollTop: 800 }), 1016, true, 0), 800);
  assert.equal(writer.next(frame({ scrollTop: 800 }), 1200, true, 0), 800);
  assert.ok(writer.next(frame({ scrollTop: 800 }), 1600, true, 1100) > 800);
});

test("quantized scroll readback cannot freeze virtual critical motion", () => {
  const writer = createTypewriter();
  const target = 572.37;
  let requested = writer.next(frame({ scrollTop: 300.37 }), 1000, true, 0);
  let progressed = 0;
  let lastActual = Math.round(requested);
  for (let now = 1016; now <= 5000 && writer.isMoving(); now += 16) {
    const actual = Math.round(requested);
    lastActual = actual;
    writer.written(actual);
    const next = writer.next(frame({
      scrollTop: actual,
      caret: { x: 100, y: 550.37 - (actual - 300), height: 20 },
    }), now, true, 0);
    if (next > requested) progressed++;
    requested = next;
  }
  assert.ok(progressed > 3);
  assert.equal(requested, target);
  assert.equal(Number.isInteger(lastActual), true);
  assert.notEqual(lastActual, target);
  assert.ok(Math.abs(lastActual - target) <= MOTION.scrollPositionEpsilonPx + 1);
  assert.equal(writer.isMoving(), false);
});

test("typewriter large elapsed advances as two smaller real intervals", () => {
  const targetFrame = (scrollTop: number) => frame({
    scrollTop,
    caret: { x: 100, y: 850 - scrollTop, height: 20 },
  });
  const large = createTypewriter();
  let largeValue = large.next(frame(), 1000, true, 0);
  large.written(largeValue);
  largeValue = large.next(targetFrame(largeValue), 1200, true, 0);

  const split = createTypewriter();
  let splitValue = split.next(frame(), 1000, true, 0);
  split.written(splitValue);
  splitValue = split.next(targetFrame(splitValue), 1100, true, 0);
  split.written(splitValue);
  splitValue = split.next(targetFrame(splitValue), 1200, true, 0);

  assert.ok(Math.abs(largeValue - splitValue) < 1e-10);
});

test("scroll snaps the final visual tail at the configured settle distance", () => {
  const writer = createTypewriter();
  const target = 572;
  let current = writer.next(frame(), 1000, true, 0);
  const requestedPositions = [current];
  const responseMs = MOTION.scrollResponseMs + Math.min(70, Math.abs(target - 300) * 0.12);
  writer.written(current);
  for (let now = 1016; now <= 5000; now += 16) {
    const before = writer.motionTelemetry();
    const next = writer.next(frame({
      scrollTop: current,
      caret: { x: 100, y: 550 - (current - 300), height: 20 },
    }), now, true, 0);
    requestedPositions.push(next);
    writer.written(next);
    if (Math.abs(target - next) < MOTION.scrollPositionEpsilonPx) {
      assert.equal(next, target);
      assert.equal(writer.isMoving(), false);
      const virtualBeforeSettle: CriticalState = {
        value: before.motionValue!, velocity: before.motionVelocity!,
      };
      stepCritical(virtualBeforeSettle, target, 16, responseMs, 0);
      const terminalSnap = Math.abs(target - virtualBeforeSettle.value);
      assert.ok(requestedPositions.length >= 3);
      assert.ok(Math.abs(target - requestedPositions.at(-2)!) < 0.5);
      assert.ok(terminalSnap <= MOTION.scrollPositionEpsilonPx + 1e-9);
      return;
    }
    current = next;
  }
  assert.fail("typewriter did not reach its configured visual settle tail");
});

test("English sentences retain the native Segmenter uppercase and lowercase rules", () => {
  for (const text of ["Hello. Next sentence.", "Hello. next sentence.", "Hello😀. Next."]) {
    const expected = [...new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(text)]
      .map(part => ({ start: part.index, end: part.index + part.segment.length }));
    assert.deepEqual(splitSentences(text), expected);
  }
});

test("list reparenting transfers parent alpha to disjoint children without restarting stable fades", () => withPresentation(() => {
  const editor = new PaintElement();
  const active = new PaintElement();
  const parent = new PaintElement();
  const child = new PaintElement();
  active.dataset.nodeId = "active"; parent.dataset.nodeId = "parent"; child.dataset.nodeId = "child";
  active.parentElement = parent.parentElement = editor;
  active.nextElementSibling = parent; parent.previousElementSibling = active;
  const ripple = createRipple();
  const input = frame({ editor: editor as unknown as HTMLElement, block: active as unknown as HTMLElement,
    editable: active as unknown as HTMLElement, range: {} as Range });
  ripple.prepare(input, false, true, true);
  const animation = parent.animations[0];
  animation.currentTime = MOTION.blockFadeMs / 2;
  ripple.prepare(input, false, false, true);
  assert.equal(parent.animations.length, 1);
  // Tab moves the active block under the formerly dim sibling.
  active.parentElement = child.parentElement = parent;
  active.nextElementSibling = child; child.previousElementSibling = active;
  parent.previousElementSibling = null;
  ripple.prepare(input, false, true, true);
  assert.equal(parent.classes.has("zentype-ripple-block"), false);
  const baseline = 1 + (RIPPLE_LEVELS[1] - 1) * 0.875;
  assert.equal(child.animations[0].frames[0].opacity, baseline);
  assert.equal(active.animations[0].frames[0].opacity, baseline);
  assert.equal(ripple.render(1000, false), false);
  ripple.prepare(input, false, false, false);
  assert.equal(child.animations.at(-1)?.frames[1].opacity, 1);
  ripple.destroy();
}));

test("ancestor markers share the alpha of their direct list content", () => withPresentation(() => {
  const editor = new PaintElement();
  const outer = new PaintElement();
  const outerMarker = new PaintElement();
  const outerContent = new PaintElement();
  const nested = new PaintElement();
  const active = new PaintElement();
  const activeMarker = new PaintElement();
  const activeContent = new PaintElement();
  outer.dataset.nodeId = "outer"; outer.dataset.type = "NodeListItem";
  outerMarker.classes.add("protyle-action");
  outerContent.dataset.nodeId = "outer-content"; outerContent.dataset.type = "NodeParagraph";
  nested.dataset.nodeId = "nested"; nested.dataset.type = "NodeList";
  active.dataset.nodeId = "active"; active.dataset.type = "NodeListItem";
  activeMarker.classes.add("protyle-action");
  activeContent.dataset.nodeId = "active-content"; activeContent.dataset.type = "NodeParagraph";
  const link = (parent: PaintElement, children: PaintElement[]) => {
    parent.children = children;
    children.forEach((child, index) => {
      child.parentElement = parent;
      child.previousElementSibling = children[index - 1] ?? null;
      child.nextElementSibling = children[index + 1] ?? null;
    });
  };
  link(editor, [outer]);
  link(outer, [outerMarker, outerContent, nested]);
  link(nested, [active]);
  link(active, [activeMarker, activeContent]);
  const ripple = createRipple();
  ripple.prepare(frame({ editor: editor as unknown as HTMLElement, block: activeContent as unknown as HTMLElement,
    editable: activeContent as unknown as HTMLElement, range: {} as Range }), false, true, true);
  assert.equal(outerMarker.animations[0].frames[1].opacity, outerContent.animations[0].frames[1].opacity);
  ripple.destroy();
}));

test("replacement handoff never writes host opacity or repairs ambiguous legacy values", () => withPresentation(() => {
  for (const connected of [false, true]) for (const original of ["", "0.7"]) {
    for (const replacementStyle of ["0.4", "0.8", ""]) {
      const editor = new PaintElement();
      const active = new PaintElement();
      const old = new PaintElement();
      active.dataset.nodeId = "active";
      old.dataset.nodeId = "merged";
      old.style.opacity = original;
      active.parentElement = old.parentElement = editor;
      active.previousElementSibling = old;
      old.nextElementSibling = active;
      const ripple = createRipple();
      const input = frame({ editor: editor as unknown as HTMLElement,
        block: active as unknown as HTMLElement, editable: active as unknown as HTMLElement, range: {} as Range });
      ripple.prepare(input, false, true, true);
      old.animations[0].currentTime = MOTION.blockFadeMs;
      assert.equal(old.style.opacity, original);
      const merged = new PaintElement();
      merged.dataset.nodeId = old.dataset.nodeId;
      merged.parentElement = editor;
      merged.style.opacity = replacementStyle;
      // Incoming opacity is host-owned, even when it equals a legacy Ripple level.
      old.isConnected = connected;
      active.isConnected = false;
      ripple.prepare({ ...input, block: merged as unknown as HTMLElement,
        editable: merged as unknown as HTMLElement }, true, true, true);
      assert.equal(merged.style.opacity, replacementStyle);
      merged.animations.at(-1)!.onfinish!();
      const expected = replacementStyle;
      assert.equal(merged.style.opacity ?? "", expected);
      assert.equal(merged.classes.has("zentype-ripple-block"), false);
      ripple.clear();
      assert.equal(merged.style.opacity ?? "", expected);
      ripple.destroy();
    }
  }
}));

test("same-id replacement carries the visible sentence floor into block ownership", () => withPresentation(() => {
  const editor = new PaintElement();
  const old = new PaintElement();
  const replacement = new PaintElement();
  old.dataset.nodeId = replacement.dataset.nodeId = "sentence-block";
  old.isConnected = false;
  replacement.parentElement = editor;
  const painter = createBlockPainter();

  const carry = painter.rebind([replacement] as unknown as HTMLElement[], {
    key: "sentence-block", value: 0.6,
  });
  painter.freeze();
  carry();
  const held = replacement.animations.at(-1)!;
  assert.equal(held.frames[0].opacity, 0.6);
  assert.equal(held.frames[1].opacity, 0.6);
  assert.equal(held.playState, "paused");

  painter.prepare(new Map([[replacement as unknown as HTMLElement, RIPPLE_LEVELS[1]]]),
    editor as unknown as HTMLElement, false)();
  const dim = replacement.animations.at(-1)!;
  assert.equal(dim.frames[0].opacity, 0.6);
  assert.equal(dim.frames[1].opacity, RIPPLE_LEVELS[1]);
  assert.equal(dim.playState, "running");
  painter.clear();
}));

test("editor bind recovers only stale plugin-owned WAAPI without touching host opacity", () => withPresentation(() => {
  const editor = new PaintElement();
  const target = new PaintElement();
  editor.append(target);
  target.style.opacity = "0.73";
  const stale = target.animate([{ opacity: 0.2 }, { opacity: 0.4 }]);
  stale.id = "zentype-ripple";
  const host = target.animate([{ opacity: 0.5 }, { opacity: 1 }]);
  host.id = "host-opacity";
  const ripple = createRipple();

  ripple.prepare(frame({ editor: editor as unknown as HTMLElement, block: null,
    editable: null, range: null }), false, false, false);

  assert.equal(stale.playState, "idle");
  assert.equal(host.playState, "running");
  assert.equal(target.style.opacity, "0.73");
  assert.equal(target.classes.has("zentype-ripple-block"), false);
  ripple.clear();
  const lifecycleStale = target.animate([{ opacity: 0.1 }, { opacity: 0.2 }]);
  lifecycleStale.id = "zentype-ripple";
  ripple.prepare(frame({ editor: editor as unknown as HTMLElement, block: null,
    editable: null, range: null }), false, false, false);
  assert.equal(lifecycleStale.playState, "idle");
  assert.equal(host.playState, "running");
  assert.equal(target.style.opacity, "0.73");
  ripple.destroy();
}));

test("range selection cancels structural intent without leaving a recovery loop", () => withSessionHarness(harness => {
  harness.tick(0);
  harness.dispatch(0, "keydown", { key: "Tab", defaultPrevented: false });
  harness.setFrame({ ...harness.getFrame(), selection: "range" });
  harness.tick(16);
  const sampled = harness.readCount();
  for (let now = 32; now <= 160; now += 16) harness.tick(now);
  assert.equal(harness.readCount(), sampled);
  assert.equal(harness.rafCount(), 0);
  assert.equal(harness.timerCount(), 0);
  harness.setFrame({ ...harness.getFrame(), selection: "caret" });
  harness.dispatch(176, "selectionchange");
  harness.tick(192);
  assert.equal(harness.readCount(), sampled + 1);
}, { typewriter: false, ripple: false }));
