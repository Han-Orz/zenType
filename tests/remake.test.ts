import assert from "node:assert/strict";
import test from "node:test";
import { approach } from "../src/motion";
import { MOTION, CURSOR_MOTION_CSS, RIPPLE_LEVELS } from "../src/config";
import { createRipple } from "../src/modules/ripple";
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
    assert.equal(overlay.hidden, false);
    const fading = Number(overlay.style.opacity);
    for (let now = 1316; now <= 1556; now += 16) {
      cursor.render({ ...input, editable: secondOwner as unknown as HTMLElement, scrollTop: 30, caret: null }, now, true);
    }
    assert.ok(fading > 0 && fading < 1);
    assert.equal(overlay.hidden, true);
    assert.equal(secondOwner.classes.has("zentype-custom-caret-active"), true);
    cursor.destroy();
    assert.equal(secondOwner.classes.has("zentype-custom-caret-active"), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

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
      opacity: element.classes.has("zentype-breathing") ? "0.4" : element.style.opacity || "1",
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

class PaintElement extends ElementStub {
  parentElement: PaintElement | null = null;
  previousElementSibling: PaintElement | null = null;
  nextElementSibling: PaintElement | null = null;
  dataset: Record<string, string> = {};
  isConnected = true;
  animations: Array<{ frames: Keyframe[]; currentTime: number; playState: string;
    cancel(): void; pause(): void; play(): void; finish(): void; onfinish: (() => void) | null }> = [];
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
  animate(frames: Keyframe[]) {
    const animation = { frames, currentTime: 0, playState: "running",
      cancel() { this.playState = "idle"; }, pause() { this.playState = "paused"; },
      play() { this.playState = "running"; },
      finish() { this.currentTime = MOTION.blockFadeMs; this.playState = "finished"; this.onfinish?.(); },
      onfinish: null as (() => void) | null };
    this.animations.push(animation);
    return animation;
  }
}

test("breathing CSS takes its delay, period and minimum alpha from config", () => {
  assert.ok(CURSOR_MOTION_CSS.includes(`${MOTION.breatheCycleMs}ms`));
  assert.ok(CURSOR_MOTION_CSS.includes(`${MOTION.breatheAnimationDelayMs}ms`));
  assert.ok(CURSOR_MOTION_CSS.includes(`--zt-breathe-min-alpha: ${MOTION.breatheMinAlpha}`));
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

test("geometry release freezes breathing and reaches 95 percent fade in 120ms", () => withPresentation(body => {
  const cursor = createCursor();
  const input = frame({ editable: new PaintElement() as unknown as HTMLElement });
  for (let now = 1000; now <= 2000; now += 16) cursor.render(input, now, true);
  cursor.render(input, 4000, false);
  const overlay = body.children[0];
  const ink = overlay.children[0];
  assert.equal(ink.classes.has("zentype-breathing"), true);
  cursor.release(10000, false);
  assert.equal(ink.style.opacity, "0.4");
  assert.equal(ink.classes.has("zentype-breathing"), false);
  cursor.release(10060, false);
  cursor.release(10120, false);
  assert.ok(Number(overlay.style.opacity) < 0.05);
  cursor.render({ ...input, caret: { x: 300, y: 200, height: 20 } }, 10136, false);
  assert.equal(overlay.style.transform, `translate3d(300px,${200 - MOTION.caretLiftPx}px,0)`);
  assert.ok(Number(overlay.style.opacity) > 0.05);
  cursor.release(10152, true);
  assert.equal(overlay.hidden, true);
  cursor.destroy();
}));

test("editor switch reveals after eight stable samples and resets on geometry changes", () => withPresentation(body => {
  const cursor = createCursor();
  const input = frame({ editable: new PaintElement() as unknown as HTMLElement });
  cursor.switched(input.editor, 1000);
  const overlay = body.children[0];
  for (let i = 0; i < 7; i++) cursor.render(input, 1000 + i * 16, false);
  assert.equal(overlay.hidden, true);
  const moved = { ...input, caret: { x: 200, y: 300, height: 24 } };
  for (let i = 0; i < 7; i++) cursor.render(moved, 1112 + i * 16, false);
  assert.equal(overlay.hidden, true);
  cursor.render(moved, 1224, false);
  assert.equal(cursor.isSettling(), false);
  assert.equal(overlay.hidden, false);
  assert.equal(overlay.style.transform, `translate3d(200px,${300 - MOTION.caretLiftPx}px,0)`);
  assert.deepEqual((overlay.children[0] as PaintElement).animations.at(-1)?.frames,
    [{ opacity: 0 }, { opacity: 1 }]);
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
  assert.equal(cursor.isSettling(), false);
  assert.equal(overlay.hidden, false);
  assert.equal(overlay.style.transform, `translate3d(400px,${300 - MOTION.caretLiftPx}px,0)`);
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

test("range selection cancels structural intent without leaving a recovery loop", () => withPresentation(() => {
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
    assert.equal(timers.size, 0);
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
