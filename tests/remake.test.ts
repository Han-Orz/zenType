import assert from "node:assert/strict";
import test from "node:test";
import { approach } from "../src/motion";
import { MOTION, CURSOR_MOTION_CSS, RIPPLE_LEVELS } from "../src/config";
import { createRipple } from "../src/modules/ripple";
import { createWritingSession } from "../src/session";
import { createTypewriter } from "../src/modules/typewriter";
import { createCursor } from "../src/modules/cursor";
import { mapUnchangedBoundaries, projectText } from "../src/modules/ripple/textProjection";
import { splitSentences, resolveActiveSentenceRanges } from "../src/modules/ripple/sentenceModel";
import type { EditorFrame } from "../src/types";

function frame(overrides: Partial<EditorFrame> = {}): EditorFrame {
  return { root: {} as HTMLElement, editor: {} as HTMLElement, scroll: {} as HTMLElement,
    editable: null, block: null, range: null, selection: "caret",
    caret: { x: 100, y: 550, height: 20 },
    viewport: { top: 0, bottom: 600, left: 0, right: 800 },
    scrollViewport: { top: 0, bottom: 600, left: 0 },
    scrollTop: 300, scrollLeft: 0, origin: { x: 0, y: 0 }, nestedScroll: [],
    maxScroll: 2000, reducedMotion: false, zIndex: 1, ...overrides };
}

test("interrupted motion reverses from the displayed value without overshoot", () => {
  const current = approach(0, 100, 16, 50);
  const reversed = approach(current, -100, 16, 50);
  assert.ok(reversed < current && reversed > -100);
  assert.equal(approach(current, -100, 0, 50), current);
});

test("motion is independent of frame subdivision", () => {
  assert.ok(Math.abs(approach(0, 100, 32, 50) - approach(approach(0, 100, 16, 50), 100, 16, 50)) < 1e-10);
});

test("scroll retarget accepts reverse editing while it is moving", () => {
  const writer = createTypewriter();
  const first = writer.next(frame(), 1000, true, 0);
  assert.ok(first > 300 && first < 600);
  writer.written(first);
  const next = writer.next(frame({ scrollTop: first, caret: { x: 100, y: 60, height: 20 } }), 1016, true, 1000);
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
    assert.equal(secondOwner.classes.has("zentype-custom-caret-active"), false);
    cursor.destroy();
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("text projection removes cloned color attributes and preserves owned parents", () => {
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
    const projection = projectText({} as HTMLElement, new Map([[owned, {}]]));
    assert.equal(projection?.text, "ownedclone");
    assert.equal(cloned.style.getPropertyValue("--zentype-text-color"), "");
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
    getComputedStyle: () => ({ opacity: "0.4", color: "rgb(200, 210, 220)" }),
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

class PaintElement extends ElementStub {
  parentElement: PaintElement | null = null;
  previousElementSibling: PaintElement | null = null;
  nextElementSibling: PaintElement | null = null;
  dataset: Record<string, string> = {};
  isConnected = true;
  animations: Array<{ frames: Keyframe[]; currentTime: number; cancel(): void; onfinish: (() => void) | null }> = [];
  constructor() {
    super();
    Object.assign(this.style, {
      getPropertyValue: (key: string) => this.style[key] ?? "",
      setProperty: (key: string, value: string) => { this.style[key] = value; },
      removeProperty: (key: string) => { delete this.style[key]; },
    });
  }
  matches() { return !!this.dataset.nodeId; }
  contains(element: PaintElement | null): boolean {
    return !!element && (element === this || this.contains(element.parentElement));
  }
  animate(frames: Keyframe[]) {
    const animation = { frames, currentTime: 0, cancel() {}, onfinish: null as (() => void) | null };
    this.animations.push(animation);
    return animation;
  }
}

test("breathing CSS takes its delay, period and minimum alpha from config", () => {
  assert.ok(CURSOR_MOTION_CSS.includes(`${MOTION.breatheCycleMs}ms`));
  assert.ok(CURSOR_MOTION_CSS.includes(`${MOTION.breatheAnimationDelayMs}ms`));
  assert.ok(CURSOR_MOTION_CSS.includes(`--zt-breathe-min-alpha: ${MOTION.breatheMinAlpha}`));
});

test("cursor interrupts breathing from displayed opacity and fades through selection", () => withPresentation(body => {
  const cursor = createCursor();
  const input = frame({ editable: new PaintElement() as unknown as HTMLElement });
  for (let now = 1000; now <= 2000; now += 100) cursor.render(input, now, true);
  cursor.render(input, 2000 + MOTION.breatheDelayMs, false);
  const overlay = body.children[0];
  const ink = overlay.children[0] as PaintElement;
  assert.ok(ink.classes.has("zentype-breathing"));
  cursor.render(input, 3200, false, true);
  assert.equal(ink.classes.has("zentype-breathing"), false);
  assert.deepEqual(ink.animations.at(-1)?.frames, [{ opacity: "0.4" }, { opacity: 1 }]);
  assert.ok(cursor.yieldSelection(3216, false));
  assert.equal(overlay.hidden, false);
  assert.ok(Number(overlay.style.opacity) > 0 && Number(overlay.style.opacity) < 1);
  cursor.yieldSelection(3316, false);
  const faded = Number(overlay.style.opacity);
  assert.ok(faded > 0);
  cursor.render(input, 3332, false);
  assert.equal(overlay.hidden, false);
  assert.ok(Number(overlay.style.opacity) < 1);
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

test("scroll integrates a dropped 100ms frame without a 32ms lag", () => {
  const writer = createTypewriter();
  const first = writer.next(frame(), 1000, true, 0);
  writer.written(first);
  const response = MOTION.scrollResponseMs + Math.min(70, (572 - 300) * 0.12);
  const next = writer.next(frame({ scrollTop: first, caret: { x: 100, y: 550 - (first - 300), height: 20 } }), 1100, true, 0);
  assert.ok(Math.abs(next - approach(first, 572, 100, response)) < 1e-8);
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

test("structural recovery waits for an event or deadline instead of sampling every frame", () => withPresentation(() => {
  const callbacks = new Map<string, (event: unknown) => void>();
  const raf = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, () => void>();
  let serial = 0;
  let reads = 0;
  const editor = new PaintElement();
  const editable = Object.assign(new PaintElement(), { closest: () => editor });
  let input = frame({ editor: editor as unknown as HTMLElement, editable: editable as unknown as HTMLElement,
    reducedMotion: true });
  const observe = class { observe() {} disconnect() {} takeRecords() { return []; } };
  const doc = document as unknown as Record<string, unknown>;
  Object.assign(doc, { documentElement: new PaintElement(), hidden: false, hasFocus: () => true,
    addEventListener: (name: string, callback: (event: unknown) => void) => callbacks.set(name, callback) });
  const values: Record<string, unknown> = {
    window: { addEventListener() {} }, MutationObserver: observe, ResizeObserver: observe,
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    requestAnimationFrame: (callback: FrameRequestCallback) => { raf.set(++serial, callback); return serial; },
    cancelAnimationFrame: (id: number) => raf.delete(id),
    setTimeout: (callback: () => void) => { timers.set(++serial, callback); return serial; },
    clearTimeout: (id: number) => timers.delete(id),
    sessionFixture: { read: () => { reads++; return input; }, editableAt: () => editable },
  };
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const tick = () => {
    const pending = [...raf.values()]; raf.clear();
    for (const callback of pending) callback(performance.now());
  };
  try {
    const session = createWritingSession({ typewriter: false, ripple: false });
    tick();
    callbacks.get("keydown")!({ type: "keydown", key: "Tab", target: editable });
    input = { ...input, selection: "range" };
    tick();
    const sampled = reads;
    for (let i = 0; i < 10; i++) tick();
    assert.equal(reads, sampled);
    assert.equal(raf.size, 0);
    assert.equal(timers.size, 1);
    input = { ...input, selection: "caret" };
    callbacks.get("selectionchange")!({ type: "selectionchange", target: editable });
    tick();
    assert.equal(reads, sampled + 1);
    session.destroy();
  } finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}));
