import assert from "node:assert/strict";
import test from "node:test";
import { stepCritical, type CriticalState } from "../src/motion";
import { MOTION, RIPPLE_LEVELS, SENTENCE_ALPHA } from "../src/config";
import { createRipple } from "../src/modules/ripple";
import { createBlockPainter, BLOCK_ALPHA_CARRIER_MS } from "../src/modules/ripple/blockPainter";
import { createWritingSession } from "../src/session";
import { createStructurePresentation } from "../src/modules/structurePresentation";
import { createTypewriter } from "../src/modules/typewriter";
import { createCursor } from "../src/modules/cursor";
import { initDebugHook } from "../src/modules/debugHook";
import { mapUnchangedBoundaries, projectText } from "../src/modules/ripple/textProjection";
import { splitSentences, resolveActiveSentenceRanges } from "../src/modules/ripple/sentenceModel";
import type { EditorFrame } from "../src/types";
import { createStructureGate } from "../src/structure";
import { getCursorRect } from "../src/utils/getCursorRect";
import { resolveRangeTextPoint } from "../src/utils/rangeTextPoint";

function frame(overrides: Partial<EditorFrame> = {}): EditorFrame {
  return { root: {} as HTMLElement, editor: {} as HTMLElement, scroll: {} as HTMLElement,
    editable: null, block: null, range: null, selection: "caret",
    caret: { x: 100, y: 550, height: 20 },
    viewport: { top: 0, bottom: 600, left: 0, right: 800 },
    scrollViewport: { top: 0, bottom: 600, left: 0 },
    scrollTop: 300, scrollLeft: 0, origin: { x: 0, y: 0 }, nestedScroll: [],
    maxScroll: 2000, reducedMotion: false, zIndex: 1, ...overrides };
}

function paintRect(element: PaintElement, left: number, top: number) {
  element.rect = { x: left, y: top, left, top, right: left + 100, bottom: top + 20, width: 100, height: 20 };
}

/** Visible alpha of a block owner's carrier: base * (1 - encodedValue). Null when unowned. */
function carrierAlpha(element: PaintElement): number | null {
  const animation = element.animations.at(-1);
  if (!animation || animation.playState === "idle") return null;
  return Number(animation.frames[0].opacity) * (1 - animation.currentTime / BLOCK_ALPHA_CARRIER_MS);
}

/** The carrier decodes alpha through float math, so owners are compared approximately. */
function assertAlpha(actual: number | null, expected: number, message?: string) {
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-6,
    `${message ? message + ": " : ""}expected alpha ${expected}, got ${actual}`);
}

/** One Session frame at a time until a painter/ripple reports block motion stopped. */
function settleBlocks(drive: (now: number) => boolean, from = 0) {
  let now = from;
  if (!drive(now)) return now;
  for (let step = 0; step < 500; step++) {
    now += 16;
    if (!drive(now)) break;
  }
  return now;
}

test("a structural displacement holds the visual position and hands the host back its transform", () => withPresentation(() => {
  const element = new PaintElement();
  element.dataset.nodeId = "item";
  paintRect(element, 100, 50);
  const presentation = createStructurePresentation();
  presentation.capture(1, element as unknown as HTMLElement, 0);

  // The Host reparents the item: same node, new committed position.
  paintRect(element, 130, 50);
  assert.deepEqual(presentation.attach(1, 4, false), { x: -30, y: 0 });
  assert.equal(element.style.transform, "translate(-30px, 0px)");

  let offset: { x: number; y: number } | null = { x: -30, y: 0 };
  for (let now = 20; now <= 2000 && offset; now += 16) offset = presentation.step(now, false);
  assert.equal(offset, null);
  assert.equal(element.style.transform, "");
}));

test("a structural displacement refuses replacement, host transform and reduced motion", () => withPresentation(() => {
  const element = new PaintElement();
  element.dataset.nodeId = "item";
  paintRect(element, 100, 50);
  const presentation = createStructurePresentation();

  // A replacement is not continuity, even when the semantic key is the same.
  presentation.capture(1, element as unknown as HTMLElement, 0);
  element.isConnected = false;
  const replacement = new PaintElement();
  replacement.dataset.nodeId = "item";
  paintRect(replacement, 130, 50);
  assert.equal(presentation.attach(1, 4, false), null);
  assert.equal(element.style.transform, "");
  element.isConnected = true;

  // Nothing may animate through a capture the Host never acted on.
  presentation.capture(2, element as unknown as HTMLElement, 0);
  paintRect(element, 130, 50);
  assert.equal(presentation.attach(2, MOTION.structureDeadlineMs + 1, false), null);
  assert.equal(element.style.transform, "");

  presentation.capture(3, element as unknown as HTMLElement, 0);
  assert.equal(presentation.attach(3, 4, true), null);
  assert.equal(element.style.transform, "");

  // A Host that owns its own inline transform keeps it.
  element.style.transform = "translateX(2px)";
  presentation.capture(4, element as unknown as HTMLElement, 0);
  assert.equal(presentation.attach(4, 4, false), null);
  assert.equal(element.style.transform, "translateX(2px)");
}));

test("a superseding capture continues from the current visual position with one transform", () => withPresentation(() => {
  const element = new PaintElement();
  element.dataset.nodeId = "item";
  paintRect(element, 100, 50);
  const presentation = createStructurePresentation();
  presentation.capture(1, element as unknown as HTMLElement, 0);
  paintRect(element, 130, 50);
  assert.deepEqual(presentation.attach(1, 4, false), { x: -30, y: 0 });

  // Part way through, the Host layout is where it is and the element draws the
  // offset on top of it.
  const running = presentation.step(36, false)!;
  paintRect(element, 130 + running.x, 50);
  presentation.capture(2, element as unknown as HTMLElement, 40);

  // A second reparent: the new handoff has to keep the visual position.
  paintRect(element, 160 + running.x, 50);
  const second = presentation.attach(2, 44, false)!;
  assert.ok(Math.abs(second.x - (running.x - 30)) < 0.001, String(second.x));
  // One owner, one transform value: no accumulation across handoffs.
  assert.equal(element.style.transform, `translate(${second.x}px, 0px)`);
  presentation.cancel();
  assert.equal(element.style.transform, "");
}));

test("a structural capture is consumed only by its matching generation", () => withPresentation(() => {
  const element = new PaintElement();
  element.dataset.nodeId = "item";
  paintRect(element, 100, 50);
  const presentation = createStructurePresentation();
  presentation.capture(41, element as unknown as HTMLElement, 0);
  paintRect(element, 130, 50);

  assert.equal(presentation.attach(42, 4, false), null);
  assert.equal(element.style.transform, "");
  assert.deepEqual(presentation.attach(41, 5, false), { x: -30, y: 0 });
  presentation.cancel();
}));

test("Host transform ownership fails closed and mid-motion takeover wins", () => withPresentation(() => {
  const element = new PaintElement();
  element.dataset.nodeId = "item";
  paintRect(element, 100, 50);
  const presentation = createStructurePresentation();

  element.style.computedTransform = "matrix(1, 0, 0, 1, 2, 0)";
  presentation.capture(1, element as unknown as HTMLElement, 0);
  paintRect(element, 130, 50);
  assert.equal(presentation.attach(1, 4, false), null);
  assert.equal(element.style.transform, "");

  element.style.computedTransform = "none";
  paintRect(element, 100, 50);
  presentation.capture(2, element as unknown as HTMLElement, 10);
  paintRect(element, 130, 50);
  assert.deepEqual(presentation.attach(2, 14, false), { x: -30, y: 0 });
  element.style.transform = "scale(1.01)";
  assert.equal(presentation.step(30, false), null);
  assert.equal(element.style.transform, "scale(1.01)");
  presentation.cancel();
  assert.equal(element.style.transform, "scale(1.01)");
}));

test("CSSOM-normalized fractional transforms remain owned", () => withPresentation(() => {
  const element = new PaintElement();
  element.dataset.nodeId = "item";
  paintRect(element, 100, 50);
  let normalized = "";
  Object.defineProperty(element.style, "transform", {
    configurable: true,
    get: () => normalized,
    set: (value: string) => {
      normalized = value.replace(/(-?\d+\.\d{4})\d+(?=px)/g, "$1");
    },
  });
  const presentation = createStructurePresentation();
  presentation.capture(1, element as unknown as HTMLElement, 0);
  paintRect(element, 130, 50);
  assert.deepEqual(presentation.attach(1, 4, false), { x: -30, y: 0 });

  presentation.step(36, false);
  const moving = presentation.step(52, false);
  assert.ok(moving);
  assert.notEqual(normalized, "");
  assert.notEqual(presentation.step(68, false), null);

  presentation.cancel();
  assert.equal(normalized, "");
}));

test("matching keydown and beforeinput share one structural generation", () => withPresentation(() => {
  const editor = new PaintElement();
  const gate = createStructureGate();
  const indent = gate.intent(editor as unknown as HTMLElement, 0, "indent", null, "keydown");
  const matched = gate.intent(editor as unknown as HTMLElement, 1, "indent", null, "beforeinput");
  const outdent = gate.intent(editor as unknown as HTMLElement, 2, "outdent", null, "beforeinput");
  assert.equal(indent, 1);
  assert.equal(matched, indent);
  assert.equal(outdent, 2);
}));

test("a carried caret is placed instead of approached", () => withPresentation(body => {
  const renders: Array<Record<string, unknown>> = [];
  const cursor = createCursor({
    record: (_source: string, name: string, payload: Record<string, unknown>) => {
      if (name === "render") renders.push(payload);
    },
  } as never);
  const input = frame({ editable: new PaintElement() as unknown as HTMLElement, reducedMotion: false,
    caret: { x: 100, y: 400, height: 20 } });
  cursor.render(input, 1000, "structural", false, { authoritativeTarget: true });
  const moved = { ...input, caret: { x: 140, y: 400, height: 20 } };

  // The structural presentation owns this displacement, so the cursor must be
  // exactly where the glyphs are rather than chasing them a second time.
  cursor.render(moved, 1016, "structural", false, { carried: true });
  const overlay = body.children[0];
  const carriedX = Number(overlay.style.transform.match(/translate3d\(([^p]+)/)![1]);
  assert.equal(carriedX, 140);
  assert.equal(Number(renders.at(-1)!.currentX), 140);

  cursor.destroy();
}));

test("without a carried displacement the cursor still approaches its target", () => withPresentation(body => {
  const cursor = createCursor();
  const input = frame({ editable: new PaintElement() as unknown as HTMLElement, reducedMotion: false,
    caret: { x: 100, y: 400, height: 20 } });
  cursor.render(input, 1000, "structural", false, { authoritativeTarget: true });
  cursor.render({ ...input, caret: { x: 140, y: 400, height: 20 } }, 1016, "structural");
  const overlay = body.children[0];
  const x = Number(overlay.style.transform.match(/translate3d\(([^p]+)/)![1]);
  assert.ok(x > 100 && x < 140, String(x));
  cursor.destroy();
}));

test("critical motion keeps value and velocity continuous across retarget", () => {
  const state: CriticalState = { value: 0, velocity: 0 };  stepCritical(state, 100, 16, 100);
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
    cursor.render(input, 1000, "typing");
    cursor.render({ ...input, scrollTop: 30, caret: { x: 100, y: 170, height: 20 } }, 1016, "typing");
    const overlay = body.children[0];
    assert.equal(overlay.style.transform, `translate3d(${input.caret!.x}px,${input.caret!.y - 30 - MOTION.caretLiftPx}px,0)`);
    cursor.render({ ...input, editable: secondOwner as unknown as HTMLElement, scrollTop: 30,
      caret: { x: 140, y: 170, height: 20 } }, 1032, "typing");
    const x = Number(overlay.style.transform.match(/translate3d\(([^p]+)/)![1]);
    assert.ok(x > 100 && x < 140);
    assert.equal(firstOwner.classes.has("zentype-custom-caret-active"), false);
    assert.equal(secondOwner.classes.has("zentype-custom-caret-active"), true);
    cursor.render({ ...input, editable: secondOwner as unknown as HTMLElement, scrollTop: 30, caret: null }, 1048, "typing");
    assert.equal(overlay.hidden, false);
    cursor.render({ ...input, editable: secondOwner as unknown as HTMLElement, scrollTop: 30, caret: null }, 1300, "typing");
    assert.equal(overlay.hidden, true);
    assert.equal(secondOwner.classes.has("zentype-custom-caret-active"), true);
    cursor.destroy();
    assert.equal(secondOwner.classes.has("zentype-custom-caret-active"), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("fresh authoritative caret rebases transport without moving the displayed origin first", () => withPresentation(body => {
  const renders: Array<Record<string, unknown>> = [];
  const cursor = createCursor({
    record: (_source: string, name: string, payload: Record<string, unknown>) => {
      if (name === "render") renders.push(payload);
    },
  } as never);
  const nested = new PaintElement();
  const input = frame({ editable: new PaintElement() as unknown as HTMLElement, reducedMotion: false,
    scrollTop: 0, nestedScroll: [{ element: nested as unknown as HTMLElement, left: 0, top: 0 }],
    caret: { x: 100, y: 400, height: 20 } });
  cursor.render(input, 1000, "structural", false, { authoritativeTarget: true });
  const moved = { ...input, scrollTop: 40,
    nestedScroll: [{ element: nested as unknown as HTMLElement, left: 0, top: 30 }],
    caret: { x: 300, y: 200, height: 20 } };
  cursor.render(moved, 1016, "structural", false, { authoritativeTarget: true });

  const sample = renders.at(-1)!;
  assert.equal(sample.targetAuthority, "fresh");
  assert.equal(sample.transportApplied, false);
  assert.equal(sample.transportDx, 0);
  assert.equal(sample.transportDy, 0);
  const expectedY: CriticalState = { value: 400 - MOTION.caretLiftPx, velocity: 0 };
  const distance = Math.hypot(100 - 300, 400 - MOTION.caretLiftPx - (200 - MOTION.caretLiftPx));
  stepCritical(expectedY, 200 - MOTION.caretLiftPx, 16,
    MOTION.caretNavigationResponseMs + Math.min(120, distance * 0.3), MOTION.cursorSettlePx);
  assert.equal(sample.currentY, expectedY.value);
  assert.ok(Number(sample.yVelocity) < 0);
  cursor.destroy();
}));

test("carry targets preserve outer and nested scroll transport", () => withPresentation(body => {
  const nested = new PaintElement();
  const renders: Array<Record<string, unknown>> = [];
  const cursor = createCursor({
    record: (_source: string, name: string, payload: Record<string, unknown>) => {
      if (name === "render") renders.push(payload);
    },
  } as never);
  const input = frame({ editable: new PaintElement() as unknown as HTMLElement, reducedMotion: true,
    scrollTop: 0, caret: { x: 100, y: 400, height: 20 },
    nestedScroll: [{ element: nested as unknown as HTMLElement, left: 0, top: 0 }] });
  cursor.render(input, 1000, "navigation", false, { authoritativeTarget: true });
  cursor.render({ ...input, scrollTop: 40, caret: { x: 100, y: 360, height: 20 },
    nestedScroll: [{ element: nested as unknown as HTMLElement, left: 0, top: 30 }] }, 1016, "navigation");

  const sample = renders.at(-1)!;
  assert.equal(sample.targetAuthority, "carry");
  assert.equal(sample.transportApplied, true);
  assert.equal(sample.transportDx, 0);
  assert.equal(sample.transportDy, -70);
  assert.equal(sample.currentY, 359);
  assert.equal(sample.targetY, 359);
  cursor.destroy();
}));

test("repeated fresh structural targets continue Critical Motion through scroll changes", () => withPresentation(body => {
  const renders: Array<Record<string, unknown>> = [];
  const cursor = createCursor({
    record: (_source: string, name: string, payload: Record<string, unknown>) => {
      if (name === "render") renders.push(payload);
    },
  } as never);
  const input = frame({ editable: new PaintElement() as unknown as HTMLElement, reducedMotion: false,
    scrollTop: 0, caret: { x: 100, y: 400, height: 20 } });
  cursor.render(input, 1000, "structural", false, { authoritativeTarget: true });
  cursor.render({ ...input, scrollTop: 40, caret: { x: 100, y: 200, height: 20 } }, 1016, "structural", false, { authoritativeTarget: true });
  cursor.render({ ...input, scrollTop: 80, caret: { x: 100, y: 100, height: 20 } }, 1032, "structural", false, { authoritativeTarget: true });

  const samples = renders.slice(-2);
  assert.deepEqual(samples.map(sample => sample.targetY), [199, 99]);
  assert.ok(samples.every(sample => sample.targetAuthority === "fresh" && sample.transportApplied === false));
  assert.ok(Number(samples[0].currentY) > Number(samples[1].currentY));
  assert.ok(Number(samples[1].yVelocity) < 0);
  cursor.destroy();
}));

test("semantic commit with the same caret carries motion provenance without a restart", () => withPresentation(body => {
  const renders: Array<Record<string, unknown>> = [];
  const cursor = createCursor({
    record: (_source: string, name: string, payload: Record<string, unknown>) => {
      if (name === "render") renders.push(payload);
    },
  } as never);
  const input = frame({ editable: new PaintElement() as unknown as HTMLElement, reducedMotion: false,
    caret: { x: 100, y: 400, height: 20 } });
  cursor.render(input, 1000, "navigation", false, { authoritativeTarget: true });
  const structural = { ...input, caret: { x: 400, y: 200, height: 20 } };
  cursor.render(structural, 1016, "structural", false, { authoritativeTarget: true });
  const before = renders.at(-1)!;
  const expectedY: CriticalState = { value: Number(before.currentY), velocity: Number(before.yVelocity) };
  const distance = Math.hypot(Number(before.currentX) - Number(before.targetX),
    Number(before.currentY) - Number(before.targetY));
  stepCritical(expectedY, Number(before.targetY), 16,
    MOTION.caretNavigationResponseMs + Math.min(120, distance * 0.3), MOTION.cursorSettlePx);
  cursor.render(structural, 1032, "structural");
  const after = renders.at(-1)!;

  assert.equal(after.targetAuthority, "carry");
  assert.equal(after.targetX, before.targetX);
  assert.equal(after.targetY, before.targetY);
  assert.equal(after.currentY, expectedY.value);
  assert.equal(after.yVelocity, expectedY.velocity);
  assert.equal(after.intent, "structural");
  cursor.destroy();
}));

test("cursor advances x, y and height on the same retarget frame", () => withPresentation(body => {
  const cursor = createCursor();
  const input = frame({ editable: new PaintElement() as unknown as HTMLElement,
    caret: { x: 100, y: 200, height: 20 } });
  cursor.render(input, 1000, "typing");
  const overlay = body.children[0];
  cursor.render({ ...input, caret: { x: 400, y: 360, height: 36 } }, 1016, "typing");
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
      transform: element.style.computedTransform || "none",
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
  rect = { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  constructor() {
    super();
    Object.assign(this.style, {
      transform: "",
      getPropertyValue: (key: string) => this.style[key] ?? "",
      getPropertyPriority: () => "",
      setProperty: (key: string, value: string) => { this.style[key] = value; },
      removeProperty: (key: string) => { delete this.style[key]; },
    });
  }
  matches() { return !!this.dataset.nodeId || this.classes.has("protyle-action"); }
  /** Fixtures that need ancestry assign their own `closest` over this default. */
  closest(): PaintElement | null { return null; }
  getBoundingClientRect(): DOMRect { return this.rect as DOMRect; }
  contains(element: PaintElement | null): boolean {
    return !!element && (element === this || this.contains(element.parentElement));
  }
  animate(frames: Keyframe[]): AnimationStub {
    const animation: AnimationStub = { id: "", frames, currentTime: 0, playState: "running",
      cancel() { this.playState = "idle"; }, pause() { this.playState = "paused"; },
      play() { this.playState = "running"; },
      // The painter never completes a carrier on its own; this only models an
      // external completion for tests that check lifecycle state.
      finish() { this.playState = "finished"; },
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

interface CursorRectFixture {
  block: PaintElement;
  editable: PaintElement;
  point: Text;
  range: Range;
  style: Record<string, string>;
  setProbeRect(node: Node, rect: DOMRect): void;
  setWalkerNodes(nodes: Text[]): void;
  probeCount(): number;
}

function withCursorRectFixture(blockText: string, pointValue: string, run: (fixture: CursorRectFixture) => void) {
  withPresentation(() => {
    const block = new PaintElement();
    const editable = new PaintElement();
    const editor = new PaintElement();
    block.parentElement = editor;
    editable.parentElement = block;
    editor.children = [block];
    block.children = [editable];
    block.dataset.nodeId = "empty-block";
    const closest = (selector: string) => selector === "[data-node-id]" ? block : selector === ".protyle-wysiwyg" ? editor : null;
    Object.assign(block, {
      textContent: blockText,
      closest,
      querySelector: () => null,
      getBoundingClientRect: () => ({ left: 50, right: 900, top: 10, bottom: 50 }),
    });
    Object.assign(editable, {
      closest,
      getBoundingClientRect: () => ({ left: 100, right: 500, top: 20, bottom: 40 }),
    });
    const point = { nodeType: 3, nodeValue: pointValue, data: pointValue,
      parentElement: editable, isConnected: true } as unknown as Text;
    let probeCount = 0;
    let probeNode: Node | null = null;
    let probeRectNode: Node | null = null;
    let probeRect: DOMRect | null = null;
    let walkerNodes: Text[] = [];
    const documentObject = document as unknown as Record<string, unknown>;
    documentObject.createRange = () => {
      probeCount += 1;
      return {
        setStart(node: Node) { probeNode = node; },
        setEnd() {},
        collapse() {},
        getClientRects: () => probeNode === probeRectNode && probeRect ? [probeRect] : [],
      };
    };
    documentObject.createTreeWalker = (_root: Node, _whatToShow: number,
      filter: { acceptNode(node: Node): number }) => {
      const accepted = walkerNodes.filter(node => filter.acceptNode(node) === NodeFilter.FILTER_ACCEPT);
      return {
        currentNode: null as Node | null,
        previousNode: () => accepted[0] ?? null,
        nextNode: () => accepted[1] ?? null,
      };
    };
    const style = {
      lineHeight: "20px", fontSize: "16px", direction: "ltr", textAlign: "left",
      borderLeftWidth: "0px", borderRightWidth: "0px", borderTopWidth: "0px",
      paddingLeft: "10px", paddingRight: "20px", paddingTop: "0px",
    };
    const previousStyle = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
    const previousFilter = Object.getOwnPropertyDescriptor(globalThis, "NodeFilter");
    const previousRect = Object.getOwnPropertyDescriptor(globalThis, "DOMRect");
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => style });
    Object.defineProperty(globalThis, "NodeFilter", { configurable: true, value: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_SKIP: 2 } });
    Object.defineProperty(globalThis, "DOMRect", { configurable: true, value: class TestDOMRect {
      x: number; y: number; width: number; height: number; top: number; right: number; bottom: number; left: number;
      constructor(x: number, y: number, width: number, height: number) {
        this.x = this.left = x; this.y = this.top = y; this.width = width; this.height = height;
        this.right = x + width; this.bottom = y + height;
      }
    } });
    const range = { collapsed: true, startContainer: point, startOffset: pointValue.length,
      getClientRects: () => [] } as unknown as Range;
    try {
      run({ block, editable, point, range, style,
        setProbeRect(node, rect) { probeRectNode = node; probeRect = rect; },
        setWalkerNodes(nodes) { walkerNodes = nodes; },
        probeCount: () => probeCount });
    } finally {
      if (previousStyle) Object.defineProperty(globalThis, "getComputedStyle", previousStyle);
      else Reflect.deleteProperty(globalThis, "getComputedStyle");
      if (previousFilter) Object.defineProperty(globalThis, "NodeFilter", previousFilter);
      else Reflect.deleteProperty(globalThis, "NodeFilter");
      if (previousRect) Object.defineProperty(globalThis, "DOMRect", previousRect);
      else Reflect.deleteProperty(globalThis, "DOMRect");
    }
  });
}

function testRect(left: number, top: number, right: number, height: number): DOMRect {
  return { x: left, y: top, left, top, right, bottom: top + height, width: right - left, height } as DOMRect;
}

test("range deletion prefers the empty block content-host caret start", () => {
  withCursorRectFixture("\u200B", "\u200B", fixture => {
    const caret = getCursorRect(fixture.range, fixture.editable as unknown as HTMLElement);
    assert.deepEqual(caret, { x: 110, y: 19.5, height: 21 });
    assert.equal(fixture.probeCount(), 0);
  });
});

test("placeholder-only text is not glyph evidence for caret recovery", () => {
  for (const value of ["\u200B", "\uFEFF", "\u00A0"]) withCursorRectFixture("real", value, fixture => {
    const placeholder = { nodeType: 3, nodeValue: value, data: value } as unknown as Text;
    const real = { nodeType: 3, nodeValue: "real", data: "real" } as unknown as Text;
    fixture.setWalkerNodes([placeholder, real]);
    fixture.setProbeRect(placeholder, testRect(700, 20, 720, 20));
    assert.equal(getCursorRect(fixture.range, fixture.editable as unknown as HTMLElement), null, value);
  });
});

test("element range resolution retains ordinary whitespace for Ripple offsets", () => {
  const space = { nodeType: 3, nodeValue: " ", data: " " } as unknown as Text;
  const real = { nodeType: 3, nodeValue: "real", data: "real" } as unknown as Text;
  const container = { childNodes: [space, real] } as unknown as Node;
  assert.equal(resolveRangeTextPoint(container, 0)?.textNode, space);
});

test("a non-empty block still recovers from a meaningful sibling around an empty text node", () => {
  withCursorRectFixture("real", "", fixture => {
    const real = { nodeType: 3, nodeValue: "real", data: "real", parentElement: fixture.editable } as unknown as Text;
    fixture.setWalkerNodes([real]);
    fixture.setProbeRect(real, testRect(240, 20, 260, 20));
    const caret = getCursorRect(fixture.range, fixture.editable as unknown as HTMLElement);
    assert.equal(caret?.x, 260);
    assert.ok(fixture.probeCount() > 0);
  });
});

test("structural blocks still do not manufacture a text caret", () => {
  withCursorRectFixture("", "", fixture => {
    fixture.block.dataset.type = "NodeImage";
    Object.assign(fixture.range, { getClientRects: () => [testRect(700, 20, 720, 20)] });
    assert.equal(getCursorRect(fixture.range, fixture.editable as unknown as HTMLElement), null);
    Object.assign(fixture.range, { getClientRects: () => [] });
    assert.equal(getCursorRect(fixture.range, fixture.editable as unknown as HTMLElement), null);
  });
});

test("empty block caret follows text alignment and logical inline start", () => {
  const cases: Array<[string, string, number]> = [
    ["ltr", "left", 110], ["ltr", "right", 480], ["ltr", "center", 295],
    ["ltr", "start", 110], ["ltr", "end", 480], ["ltr", "justify", 110],
    ["rtl", "left", 110], ["rtl", "right", 480], ["rtl", "center", 295],
    ["rtl", "start", 480], ["rtl", "end", 110], ["rtl", "justify", 480],
  ];
  for (const [direction, textAlign, expectedX] of cases) withCursorRectFixture("\u200B", "\u200B", fixture => {
    fixture.style.direction = direction;
    fixture.style.textAlign = textAlign;
    assert.equal(getCursorRect(fixture.range, fixture.editable as unknown as HTMLElement)?.x, expectedX,
      `${direction}/${textAlign}`);
  });
});

interface SessionHarness {
  body: PaintElement;
  editor: PaintElement;
  editable: PaintElement;
  scroll: PaintElement & { scrollTop: number };
  events: Array<{ name: string; payload: Record<string, unknown> }>;
  getFrame(): EditorFrame;
  setFrame(next: EditorFrame | null): void;
  setSelection(mode: "caret" | "range", focusNode?: Node): void;
  dispatch(at: number, type: string, event?: Record<string, unknown>): void;
  mutate(at: number, records: MutationRecord[]): void;
  tick(at: number, rafTimestamp?: number): void;
  readCount(): number;
  rafCount(): number;
  timerCount(): number;
  setReducedMotion(matches: boolean): void;
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
    let selectionMode: "caret" | "range" = "caret";
    let reducedMotionMatches = true;
    const editor = new PaintElement();
    editor.classes.add("protyle-wysiwyg");
    const editable = new PaintElement();
    editable.dataset.nodeId = "active";
    editable.parentElement = editor;
    Object.assign(editable, { closest: (selector: string) => selector === ".protyle-wysiwyg" ? editor :
      selector === "[data-node-id]" ? editable : null });
    let selectionFocusNode: Node = editable as unknown as Node;
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
        getSelection: () => ({ isCollapsed: selectionMode === "caret", focusNode: selectionFocusNode }),
      },
      MutationObserver: Observer,
      ResizeObserver: Resize,
      matchMedia: () => ({ get matches() { return reducedMotionMatches; }, addEventListener() {} }),
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
        setSelection(mode, focusNode = editable as unknown as Node) {
          selectionMode = mode;
          selectionFocusNode = focusNode;
        },
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
        setReducedMotion: matches => { reducedMotionMatches = matches; },
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

function textRange(editable: PaintElement, value = "abcdef", offset = 3): Range {
  const node = { nodeType: 3, nodeValue: value, parentElement: editable } as unknown as Node;
  return { collapsed: true, startContainer: node, startOffset: offset } as unknown as Range;
}

function setTextCaret(harness: SessionHarness, offset = 3, value = "abcdef") {
  harness.setFrame({ ...harness.getFrame(), range: textRange(harness.editable, value, offset),
    selection: "caret", caretless: false, caret: { x: 120, y: 540, height: 20 } });
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
  for (let now = 1000; now <= 2000; now += 100) cursor.render(input, now, "typing");
  const breathStart = 2000 + MOTION.breatheIdleDelayMs;
  cursor.render(input, breathStart, "navigation");
  cursor.render(input, breathStart + 16, "navigation");
  const downSample = renders.at(-1)!;
  const expectedRecovery: CriticalState = {
    value: Number(downSample.alpha), velocity: Number(downSample.alphaVelocity),
  };
  stepCritical(expectedRecovery, 1, 16, MOTION.cursorAppearResponseMs, MOTION.alphaSettleEpsilon);
  const overlay = body.children[0];
  const breathingOpacity = Number(overlay.style.opacity);
  assert.ok(breathingOpacity < 1);
  const interruptAt = breathStart + 32;
  cursor.render(input, interruptAt, "navigation", true);
  const interruptSample = renders.at(-1)!;
  const interruptedOpacity = Number(overlay.style.opacity);
  assert.ok(interruptedOpacity > 0 && interruptedOpacity < 1);
  assert.equal(interruptSample.breathPhase, "normal");
  assert.ok(Math.abs(Number(interruptSample.alpha) - expectedRecovery.value) < 1e-10);
  assert.ok(Math.abs(Number(interruptSample.alphaVelocity) - expectedRecovery.velocity) < 1e-10);
  assert.ok(Number(downSample.alphaVelocity) < 0);
  assert.ok(Number(interruptSample.alphaVelocity) < 0);
  const recoveredAt = interruptAt + MOTION.cursorAppearResponseMs * 3;
  cursor.render(input, recoveredAt, "navigation", true);
  assert.ok(Number(overlay.style.opacity) > breathingOpacity);
  assert.ok(Number(overlay.style.opacity) > interruptedOpacity);
  assert.ok(cursor.yieldSelection(recoveredAt + 16, false));
  assert.equal(overlay.hidden, false);
  assert.ok(Number(overlay.style.opacity) > 0 && Number(overlay.style.opacity) < 1);
  cursor.yieldSelection(recoveredAt + 116, false);
  cursor.render(input, recoveredAt + 132, "navigation");
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
  for (let now = 1000; now <= 2000; now += 16) cursor.render(input, now, "typing");
  const breathStart = 2000 + MOTION.breatheIdleDelayMs;
  assert.equal(cursor.render(input, breathStart, "navigation"), true);
  const overlay = body.children[0];
  const downResponseAt = breathStart + MOTION.breathDownResponseMs;
  cursor.render(input, downResponseAt, "navigation");
  assert.ok(Math.abs(Number(overlay.style.opacity) - 0.1) < 0.001);
  let lowSettledAt = 0;
  for (let now = downResponseAt + 16; now <= breathStart + 3000; now += 16) {
    cursor.render(input, now, "navigation");
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
  assert.equal(cursor.render(input, upAt, "navigation"), true);
  assert.equal(renders.at(-1)?.breathPhase, "up");
  assert.equal(Number(overlay.style.opacity), lowOpacity);
  cursor.render(input, upAt + 16, "navigation");
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
  for (let now = 1000; now <= 2000; now += 16) cursor.render(input, now, "typing");

  const activityAt = 5000;
  cursor.render(input, activityAt, "navigation", true);
  assert.equal(phases.at(-1), "normal");
  cursor.render(input, activityAt + MOTION.breatheIdleDelayMs - 1, "navigation");
  assert.equal(phases.at(-1), "normal");
  cursor.render(input, activityAt + MOTION.breatheIdleDelayMs, "navigation");
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
  for (let now = 1000; now <= 2000; now += 16) cursor.render(input, now, "typing");
  const downAt = 2000 + MOTION.breatheIdleDelayMs;
  cursor.render(input, downAt, "navigation");
  let lowSettledAt = 0;
  for (let now = downAt + 16; now <= downAt + 3000; now += 16) {
    cursor.render(input, now, "navigation");
    if (phases.at(-1) === "hold") {
      lowSettledAt = now;
      break;
    }
  }
  assert.ok(lowSettledAt > downAt);
  const upAt = lowSettledAt + 16;
  assert.equal(cursor.render(input, upAt, "navigation"), true);
  assert.equal(phases.at(-1), "up");
  let upSettledAt = 0;
  for (let now = upAt + 16; now <= upAt + 3000; now += 16) {
    if (!cursor.render(input, now, "navigation")) {
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
  for (let now = 1000; now <= 2000; now += 16) cursor.render(input, now, "typing");
  const downAt = 2000 + MOTION.breatheIdleDelayMs;
  cursor.render(input, downAt, "navigation");
  let lowSettledAt = 0;
  for (let now = downAt + 16; now <= downAt + 3000; now += 16) {
    cursor.render(input, now, "navigation");
    if (phases.at(-1) === "hold") {
      lowSettledAt = now;
      break;
    }
  }
  assert.ok(lowSettledAt > downAt);
  const upAt = lowSettledAt + 16;
  assert.equal(cursor.render(input, upAt, "navigation"), true);
  assert.equal(phases.at(-1), "up");
  let upSettledAt = 0;
  for (let now = upAt + 16; now <= upAt + 3000; now += 16) {
    if (!cursor.render(input, now, "navigation")) {
      upSettledAt = now;
      break;
    }
  }
  assert.ok(upSettledAt > upAt);
  assert.equal(cursor.wakeDelay(upSettledAt), MOTION.breatheRestMs);
  const beforeRest = upSettledAt + MOTION.breatheRestMs - 1;
  assert.equal(cursor.render(input, beforeRest, "navigation"), false);
  assert.equal(phases.at(-1), "normal");
  cursor.render(input, upSettledAt + MOTION.breatheRestMs, "navigation");
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
  for (let now = 1000; now <= 2000; now += 16) cursor.render(input, now, "typing");
  const downAt = 2000 + MOTION.breatheIdleDelayMs;
  assert.equal(cursor.render(input, downAt, "navigation"), true);
  assert.equal(cursor.wakeDelay(downAt), null);
  let lowSettledAt = 0;
  for (let now = downAt + 16; now <= downAt + 3000; now += 16) {
    cursor.render(input, now, "navigation");
    if (phases.at(-1) === "hold") {
      lowSettledAt = now;
      break;
    }
  }
  assert.ok(lowSettledAt > downAt);
  assert.equal(cursor.wakeDelay(lowSettledAt), null);
  const upAt = lowSettledAt + 16;
  assert.equal(cursor.render(input, upAt, "navigation"), true);
  assert.equal(phases.at(-1), "up");
  assert.equal(cursor.wakeDelay(upAt), null);
  cursor.destroy();
}));

test("geometry release freezes breathing and fades the outer cursor promptly", () => withPresentation(body => {
  const cursor = createCursor();
  const input = frame({ editable: new PaintElement() as unknown as HTMLElement });
  for (let now = 1000; now <= 2000; now += 16) cursor.render(input, now, "typing");
  const breathStart = 2000 + MOTION.breatheIdleDelayMs;
  cursor.render(input, breathStart, "navigation");
  cursor.render(input, breathStart + 16, "navigation");
  const overlay = body.children[0];
  assert.ok(Number(overlay.style.opacity) < 1);
  cursor.release(breathStart + 32, false);
  for (let now = breathStart + 48; now <= breathStart + 1000 && !overlay.hidden; now += 16) cursor.release(now, false);
  assert.equal(overlay.hidden, true);
  cursor.render({ ...input, caret: { x: 300, y: 200, height: 20 } }, breathStart + 1016, "navigation");
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
  for (let i = 0; i < 7; i++) cursor.render(input, 1000 + i * 16, "navigation");
  assert.equal(overlay.hidden, true);
  const moved = { ...input, caret: { x: 200, y: 300, height: 24 } };
  for (let i = 0; i < 7; i++) cursor.render(moved, 1112 + i * 16, "navigation");
  assert.equal(overlay.hidden, true);
  cursor.render(moved, 1224, "navigation");
  assert.equal(cursor.isSettling(), true);
  assert.equal(overlay.hidden, true);
  assert.equal(overlay.style.opacity, "0");
  assert.equal(overlay.style.transform, `translate3d(200px,${300 - MOTION.caretLiftPx}px,0)`);
  const hiddenCommit = records.find(record => record.name === "switch-commit-hidden");
  assert.ok(hiddenCommit);
  assert.equal(hiddenCommit.payload.alpha, 0);
  assert.equal(hiddenCommit.payload.alphaVelocity, 0);
  assert.equal(hiddenCommit.payload.revealElapsed, 0);

  cursor.render(moved, 1240, "navigation");
  assert.equal(cursor.isSettling(), true);
  assert.equal(overlay.hidden, false);
  assert.equal(overlay.style.opacity, "0");
  assert.equal(records.at(-1)?.payload.revealElapsed, 0);
  cursor.render(moved, 1256, "navigation");
  assert.ok(Number(overlay.style.opacity) > 0 && Number(overlay.style.opacity) < 1);
  const expectedReveal: CriticalState = { value: 0, velocity: 0 };
  stepCritical(expectedReveal, 1, 16, MOTION.cursorAppearResponseMs, MOTION.alphaSettleEpsilon);
  assert.ok(Math.abs(Number(overlay.style.opacity) - expectedReveal.value) < 1e-10);
  assert.equal(records.at(-1)?.payload.revealElapsed, 16);

  let settledAt = 0;
  for (let now = 1272; now <= 5000; now += 16) {
    cursor.render(moved, now, "navigation");
    if (!cursor.isSettling()) { settledAt = now; break; }
  }
  assert.ok(settledAt > 1256);
  assert.equal(Number(overlay.style.opacity), 1);
  cursor.destroy();
}));

test("shared authority withholds a transient caret until mutation and geometry settle", () => withPresentation(body => {
  const cursor = createCursor();
  const records: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const gate = createStructureGate({
    record: (_source: string, name: string, payload: Record<string, unknown>) => records.push({ name, payload }),
  } as never);
  const input = frame({ editable: new PaintElement() as unknown as HTMLElement });
  cursor.render(input, 1000, "typing");
  const overlay = body.children[0];
  const original = overlay.style.transform;
  gate.intent(input.editor, 1016);
  assert.equal(gate.sample({ ...input, caret: { x: 500, y: 300, height: 20 } }, 1032), "wait");
  assert.equal(overlay.style.transform, original);
  gate.mutation(input.editor, 1040, "structural");
  const final = { ...input, caret: { x: 200, y: 300, height: 20 } };
  assert.equal(gate.sample(final, 1048), "wait");
  assert.equal(overlay.style.transform, original);
  assert.equal(gate.sample(final, 1064), "geometry");
  const geometry = records.find(record => record.name === "structure-geometry-ready");
  assert.ok(geometry);
  assert.equal(geometry.payload.stableFrames, 2);
  assert.equal(geometry.payload.quiet, 24);
  assert.deepEqual(geometry.payload.caret, final.caret);
  assert.equal(gate.sample(final, 1088), "commit");
  cursor.render(final, 1088, "structural");
  assert.notEqual(overlay.style.transform, `translate3d(500px,${300 - MOTION.caretLiftPx}px,0)`);
  cursor.destroy();
}));

test("structural handoff binds geometry stability to semantic block identity", () => withPresentation(() => {
  const editor = new PaintElement();
  const original = new PaintElement();
  const replacement = new PaintElement();
  original.dataset.nodeId = replacement.dataset.nodeId = "same-block";
  const initial = frame({ editor: editor as unknown as HTMLElement,
    block: original as unknown as HTMLElement, caret: { x: 100, y: 200, height: 20 } });
  const gate = createStructureGate();

  assert.equal(gate.sample(initial, 0), "ordinary");
  gate.intent(editor as unknown as HTMLElement, 4);
  gate.mutation(editor as unknown as HTMLElement, 8, "structural");
  const replaced = { ...initial, block: replacement as unknown as HTMLElement,
    caret: { x: 320, y: 360, height: 20 } };
  assert.equal(gate.sample(replaced, 16), "wait");
  assert.equal(gate.sample(replaced, 32), "geometry");
  assert.deepEqual(gate.handoff(), {
    generation: 1, topologyChanged: true, fromBlockKey: "same-block", toBlockKey: "same-block",
    geometryReady: true, semanticReady: false,
  });
  assert.equal(gate.sample(replaced, 56), "commit");
  assert.equal(gate.handoff()?.semanticReady, true);

  const different = new PaintElement();
  different.dataset.nodeId = "different-block";
  const nextGate = createStructureGate();
  assert.equal(nextGate.sample(initial, 0), "ordinary");
  nextGate.intent(editor as unknown as HTMLElement, 4);
  nextGate.mutation(editor as unknown as HTMLElement, 8, "structural");
  assert.equal(nextGate.sample(initial, 16), "wait");
  assert.equal(nextGate.sample({ ...initial, block: different as unknown as HTMLElement }, 32), "wait");
  assert.equal(nextGate.sample({ ...initial, block: different as unknown as HTMLElement }, 48), "geometry");
  assert.equal(nextGate.handoff()?.toBlockKey, "different-block");
}));

test("unknown structural origin remains null instead of being backfilled from the destination", () => withPresentation(() => {
  const editor = new PaintElement();
  const destination = new PaintElement();
  destination.dataset.nodeId = "destination-block";
  const gate = createStructureGate();

  gate.intent(editor as unknown as HTMLElement, 0);
  gate.mutation(editor as unknown as HTMLElement, 4, "structural");
  const destinationFrame = frame({ editor: editor as unknown as HTMLElement,
    block: destination as unknown as HTMLElement, caret: { x: 320, y: 360, height: 20 } });
  assert.equal(gate.sample(destinationFrame, 16), "wait");
  assert.equal(gate.sample(destinationFrame, 32), "geometry");
  assert.equal(gate.handoff()?.fromBlockKey, null);
  assert.equal(gate.handoff()?.toBlockKey, "destination-block");
  assert.equal(gate.sample(destinationFrame, 80), "commit");
  assert.equal(gate.handoff()?.fromBlockKey, null);
}));

test("unstable structural samples never replace the trusted origin", () => withPresentation(() => {
  const editor = new PaintElement();
  const trusted = new PaintElement();
  const unstableA = new PaintElement();
  const unstableB = new PaintElement();
  const destination = new PaintElement();
  trusted.dataset.nodeId = "trusted-block";
  unstableA.dataset.nodeId = "unstable-a";
  unstableB.dataset.nodeId = "unstable-b";
  destination.dataset.nodeId = "destination-block";
  const gate = createStructureGate();

  const initial = frame({ editor: editor as unknown as HTMLElement,
    block: trusted as unknown as HTMLElement, caret: { x: 100, y: 200, height: 20 } });
  assert.equal(gate.sample(initial, 0), "ordinary");
  gate.intent(editor as unknown as HTMLElement, 4);
  gate.mutation(editor as unknown as HTMLElement, 8, "structural");
  assert.equal(gate.sample({ ...initial, block: unstableA as unknown as HTMLElement,
    caret: { x: 200, y: 300, height: 20 } }, 16), "wait");
  assert.equal(gate.sample({ ...initial, block: unstableB as unknown as HTMLElement,
    caret: { x: 210, y: 310, height: 20 } }, 32), "wait");

  gate.intent(editor as unknown as HTMLElement, 40);
  gate.mutation(editor as unknown as HTMLElement, 44, "structural");
  const destinationFrame = { ...initial, block: destination as unknown as HTMLElement,
    caret: { x: 320, y: 360, height: 20 } };
  assert.equal(gate.sample(destinationFrame, 56), "wait");
  assert.equal(gate.sample(destinationFrame, 72), "geometry");
  assert.equal(gate.handoff()?.generation, 2);
  assert.equal(gate.handoff()?.fromBlockKey, "trusted-block");
  assert.equal(gate.handoff()?.toBlockKey, "destination-block");
}));

test("geometry-ready caret becomes the trusted origin for the next structural generation", () => withPresentation(() => {
  const editor = new PaintElement();
  const first = new PaintElement();
  const second = new PaintElement();
  const third = new PaintElement();
  first.dataset.nodeId = "first-block";
  second.dataset.nodeId = "second-block";
  third.dataset.nodeId = "third-block";
  const gate = createStructureGate();
  const initial = frame({ editor: editor as unknown as HTMLElement,
    block: first as unknown as HTMLElement, caret: { x: 100, y: 200, height: 20 } });

  assert.equal(gate.sample(initial, 0), "ordinary");
  gate.intent(editor as unknown as HTMLElement, 4);
  gate.mutation(editor as unknown as HTMLElement, 8, "structural");
  const secondFrame = { ...initial, block: second as unknown as HTMLElement,
    caret: { x: 220, y: 320, height: 20 } };
  assert.equal(gate.sample(secondFrame, 16), "wait");
  assert.equal(gate.sample(secondFrame, 32), "geometry");
  assert.equal(gate.handoff()?.fromBlockKey, "first-block");

  gate.intent(editor as unknown as HTMLElement, 40);
  gate.mutation(editor as unknown as HTMLElement, 44, "structural");
  const thirdFrame = { ...initial, block: third as unknown as HTMLElement,
    caret: { x: 340, y: 440, height: 20 } };
  assert.equal(gate.sample(thirdFrame, 56), "wait");
  assert.equal(gate.sample(thirdFrame, 72), "geometry");
  assert.equal(gate.handoff()?.generation, 2);
  assert.equal(gate.handoff()?.fromBlockKey, "second-block");
  assert.equal(gate.handoff()?.toBlockKey, "third-block");
}));

test("Cursor structural intent uses the navigation distance-aware response law", () => withPresentation(body => {
  const records: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const cursor = createCursor({
    record: (_source: string, name: string, payload: Record<string, unknown>) => records.push({ name, payload }),
  } as never);
  const input = frame({ editable: new PaintElement() as unknown as HTMLElement, reducedMotion: false,
    caret: { x: 100, y: 200, height: 20 } });
  cursor.render(input, 1000, "navigation");
  const moved = { ...input, caret: { x: 500, y: 200, height: 20 } };
  cursor.render(moved, 1016, "structural");

  const expectedStructural: CriticalState = { value: 100, velocity: 0 };
  stepCritical(expectedStructural, 500, 16, MOTION.caretNavigationResponseMs + 120, MOTION.cursorSettlePx);
  const expectedTyping: CriticalState = { value: 100, velocity: 0 };
  stepCritical(expectedTyping, 500, 16, MOTION.caretTypingResponseMs, MOTION.cursorSettlePx);
  const actualX = Number(body.children[0].style.transform.match(/translate3d\(([-\d.]+)px/)![1]);
  assert.equal(records.at(-1)?.payload.intent, "structural");
  assert.equal(actualX, expectedStructural.value);
  assert.notEqual(actualX, expectedTyping.value);
  assert.equal(typeof records.at(-1)?.payload.xVelocity, "number");
  assert.equal(typeof records.at(-1)?.payload.yVelocity, "number");
  assert.equal(typeof records.at(-1)?.payload.heightVelocity, "number");
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
  assert.equal(overlay.style.transform, original);
  const commitsBeforeGeometry = harness.events.filter(event => event.name === "frame-commit").length;
  const preparedBeforeGeometry = harness.events.filter(event => event.name === "prepare").length;
  const typewriterBeforeGeometry = harness.events.filter(event => event.name === "frame" && "requestedScroll" in event.payload).length;
  harness.tick(64);
  assert.equal(overlay.style.transform, `translate3d(200px,${300 - MOTION.caretLiftPx}px,0)`);
  const geometryRender = harness.events.filter(event => event.name === "render" && "targetAuthority" in event.payload).at(-1);
  assert.equal(geometryRender?.payload.targetAuthority, "fresh");
  assert.equal(geometryRender?.payload.transportApplied, false);
  assert.equal(harness.events.filter(event => event.name === "frame-commit").length, commitsBeforeGeometry);
  assert.equal(harness.events.filter(event => event.name === "prepare").length, preparedBeforeGeometry);
  assert.equal(harness.events.filter(event => event.name === "frame" && "requestedScroll" in event.payload).length, typewriterBeforeGeometry);
  assert.ok(harness.events.some(event => event.name === "structure-geometry-ready" && event.payload.caret));
  assert.ok(harness.events.some(event => event.name === "structure-sample" &&
    event.payload.geometryReady === true && event.payload.semanticReady === false));
  harness.tick(80);

  assert.equal(overlay.style.transform, `translate3d(200px,${300 - MOTION.caretLiftPx}px,0)`);
  const semanticRender = harness.events.filter(event => event.name === "render" && "targetAuthority" in event.payload).at(-1);
  assert.equal(semanticRender?.payload.targetAuthority, "carry");
  assert.ok(harness.events.some(event => event.name === "structure-commit"));
  assert.ok(harness.events.filter(event => event.name === "prepare").length > prepared);
}, { typewriter: true, ripple: true }));

/** Presentation fixture with a working sentence model (CSS Highlight + TreeWalker). */
interface SentenceCtx {
  editor: PaintElement;
  blockA: PaintElement;
  blockB: PaintElement;
  editableA: PaintElement;
  editableB: PaintElement;
  textA: { value: string };
  textB: { value: string };
  textNodeA: Text;
  textNodeB: Text;
  highlights: Map<string, unknown>;
}

function withSentencePresentation(run: (ctx: SentenceCtx) => void) {
  const body = new PaintElement();
  const highlights = new Map<string, unknown>();
  const editor = new PaintElement();
  editor.classes.add("protyle-wysiwyg");
  const make = (key: string) => {
    const block = new PaintElement();
    block.dataset.nodeId = key;
    block.parentElement = editor;
    const editable = new PaintElement();
    editable.parentElement = block;
    Object.assign(editable, { closest: (selector: string) =>
      selector === ".protyle-wysiwyg" ? editor : selector === "[data-node-id]" ? block : null });
    const text = { value: "" };
    const textNode = { nodeType: 3,
      get nodeValue() { return text.value; }, get data() { return text.value; },
      parentElement: editable } as unknown as Text;
    return { block, editable, text, textNode };
  };
  const a = make("A");
  const b = make("B");
  a.block.nextElementSibling = b.block;
  b.block.previousElementSibling = a.block;
  editor.children = [a.block, b.block];
  const nodes = new Map<unknown, Text>([[a.editable, a.textNode], [b.editable, b.textNode]]);
  const values: Record<string, unknown> = {
    document: { body, head: new PaintElement(), createElement: () => new PaintElement(),
      createTreeWalker: (root: unknown) => {
        const node = nodes.get(root) ?? null;
        let done = false;
        return { nextNode: () => (done || !node ? null : (done = true, node)) };
      },
      createRange: () => ({ setStart() {}, setEnd() {} }) },
    HTMLElement: PaintElement, Element: PaintElement,
    Node: { TEXT_NODE: 3, DOCUMENT_POSITION_FOLLOWING: 4 },
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    CSS: { supports: () => true, highlights },
    Highlight: class { constructor(...ranges: unknown[]) { void ranges; } },
    getComputedStyle: (element: PaintElement) => ({ opacity: element.style.opacity || "1", color: "rgb(200, 210, 220)" }),
  };
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  try {
    run({ editor, blockA: a.block, blockB: b.block, editableA: a.editable, editableB: b.editable,
      textA: a.text, textB: b.text, textNodeA: a.textNode, textNodeB: b.textNode, highlights });
  } finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function sentenceFrame(ctx: SentenceCtx, block: PaintElement, editable: PaintElement, node: Text, offset: number): EditorFrame {
  return frame({ editor: ctx.editor as unknown as HTMLElement, block: block as unknown as HTMLElement,
    editable: editable as unknown as HTMLElement,
    range: { startContainer: node, startOffset: offset } as unknown as Range });
}

test("the painter reports a role invalidation only when the replacement carried a committed role", () => withPresentation(() => {
  const editor = new PaintElement();
  const old = new PaintElement();
  old.dataset.nodeId = "A";
  old.parentElement = editor;
  const painter = createBlockPainter();
  const reported: Array<{ key: string; value: number }> = [];
  const report = (presentation: { key: string; value: number }) => { reported.push(presentation); };

  const fresh = new PaintElement();
  fresh.dataset.nodeId = "A";
  fresh.parentElement = editor;
  painter.rebind([fresh as unknown as HTMLElement], undefined, "A", report);
  assert.deepEqual(reported, []);

  painter.prepare(new Map([[old as unknown as HTMLElement, RIPPLE_LEVELS[1]]]), editor as unknown as HTMLElement, false)();
  settleBlocks(now => painter.step(now, false), MOTION.blockAlphaResponseMs * 3);
  assertAlpha(carrierAlpha(old), RIPPLE_LEVELS[1]);
  old.isConnected = false;
  const replaced = new PaintElement();
  replaced.dataset.nodeId = "A";
  replaced.parentElement = editor;
  painter.rebind([replaced as unknown as HTMLElement], undefined, "A", report);
  // The last sampled value travels with the invalidation so the sentence layer
  // can continue the presentation the user was actually looking at.
  assert.deepEqual(reported, [{ key: "A", value: RIPPLE_LEVELS[1] }]);
  painter.clear();
}));

test("an ordinary sentence rebuild keeps its full-brightness entrance", () => withSentencePresentation(ctx => {
  ctx.textB.value = "Bravo one. Bravo two. Bravo three.";
  ctx.textA.value = "Alpha one. Alpha two. Alpha three.";
  const ripple = createRipple();
  ripple.prepare(sentenceFrame(ctx, ctx.blockB, ctx.editableB, ctx.textNodeB, ctx.textB.value.length), false, true, true);

  // Focus moves to A without any structural replacement authority.
  ripple.prepare(sentenceFrame(ctx, ctx.blockA, ctx.editableA, ctx.textNodeA, ctx.textA.value.length), true, true, true);
  assert.equal(ripple.render(1000, false), true);
  ripple.destroy();
}));

test("a focused structural replacement starts fresh non-active sentences at their new role", () => withSentencePresentation(ctx => {
  ctx.textB.value = "Bravo one. Bravo two.";
  ctx.textA.value = "Alpha one. Alpha two. Alpha three. Alpha four.";
  const ripple = createRipple();

  // B is focused; A is its dim neighbour and therefore holds a committed owner.
  ripple.prepare(sentenceFrame(ctx, ctx.blockB, ctx.editableB, ctx.textNodeB, ctx.textB.value.length), false, true, true);

  // Host merge: A is replaced by a fresh same-key element, B is removed, and the
  // live collapsed Selection made the replacement the focused block.
  const replacement = new PaintElement();
  replacement.dataset.nodeId = "A";
  replacement.parentElement = ctx.editor;
  ctx.blockA.isConnected = false;
  ctx.blockB.isConnected = false;
  ctx.editor.children = [replacement];
  ripple.rebind([replacement as unknown as HTMLElement], "A");

  const caret = ctx.textA.value.indexOf("Alpha three") + 2;
  ripple.prepare(sentenceFrame(ctx, replacement, ctx.editableA, ctx.textNodeA, caret), true, true, true);
  // Sentences before the caret that continue the previous dim presentation start
  // at the inherited value and travel to their new role, so the first rendered
  // frame still has sentence motion.
  assert.equal(ripple.render(1000, false), true);
  ripple.destroy();
}));

test("only the previous block's prefix continues its presentation; the focused suffix does not", () => withSentencePresentation(ctx => {
  ctx.textB.value = "Bravo one. Bravo two.";
  ctx.textA.value = "Alpha one. Alpha two. Bravo one. Bravo two.";
  const ripple = createRipple();
  ripple.prepare(sentenceFrame(ctx, ctx.blockB, ctx.editableB, ctx.textNodeB, 0), false, true, true);
  // Settle the dim neighbour at its semantic presentation value of 0.4.
  settleBlocks(now => ripple.render(now, false), MOTION.blockAlphaResponseMs * 3);

  const replacement = new PaintElement();
  replacement.dataset.nodeId = "A";
  replacement.parentElement = ctx.editor;
  ctx.blockA.isConnected = false;
  ctx.blockB.isConnected = false;
  ctx.editor.children = [replacement];
  ripple.rebind([replacement as unknown as HTMLElement], "A");

  // Caret sits at the old A/B merge boundary; the trailing sentences came from
  // the previously focused block and must not inherit the dim neighbour value.
  const caret = ctx.textA.value.indexOf("Bravo one");
  ripple.presentSentences(sentenceFrame(ctx, replacement, ctx.editableA, ctx.textNodeA, caret), 1000, false);

  const buckets = [...ctx.highlights.keys()].map(key => Number(String(key).replace("zentype-remake-sentence-", "")));
  // Prefix sentences are seeded from the inherited 0.4 and travel to their role,
  // so the first committed frame must contain a bucket well below the
  // SENTENCE_ALPHA bucket. Nothing may sit below that inherited value.
  assert.ok(buckets.length > 0);
  const lowest = Math.min(...buckets);
  assert.ok(lowest < Math.round(SENTENCE_ALPHA * 64), JSON.stringify({ buckets, caret }));
  assert.ok(lowest >= Math.round(0.4 * 64) - 1, JSON.stringify({ buckets, caret }));
  ripple.destroy();
}));

test("first-frame sentence presentation commits highlights without touching block ownership", () => withSentencePresentation(ctx => {
  ctx.textB.value = "Bravo one. Bravo two.";
  ctx.textA.value = "Alpha one. Alpha two. Alpha three.";
  const ripple = createRipple();
  ripple.prepare(sentenceFrame(ctx, ctx.blockB, ctx.editableB, ctx.textNodeB, 0), false, true, true);

  const replacement = new PaintElement();
  replacement.dataset.nodeId = "A";
  replacement.parentElement = ctx.editor;
  ctx.blockA.isConnected = false;
  ctx.blockB.isConnected = false;
  ctx.editor.children = [replacement];
  ripple.rebind([replacement as unknown as HTMLElement], "A");

  // First authoritative post-mutation frame: sentence only, no block plan.
  const moving = ripple.presentSentences(
    sentenceFrame(ctx, replacement, ctx.editableA, ctx.textNodeA, 0), 1000, false);
  assert.equal(replacement.animations.length, 0);
  assert.equal(moving, false);
  ripple.destroy();
}));

test("a content-dirty sentences-only frame re-projects instead of keeping collapsed highlights", () => {
  const recorded: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const debug = {
    record: (_source: string, name: string, payload: Record<string, unknown>) => recorded.push({ name, payload }),
    recordEvent() {}, recordMutations() {}, recordFrame() {},
  };
  withSentencePresentation(ctx => {
    ctx.textA.value = "Alpha one. Alpha two.";
    const ripple = createRipple(debug as never);
    ripple.prepare(sentenceFrame(ctx, ctx.blockA, ctx.editableA, ctx.textNodeA, 3), false, true, true);

    // The host rewrites the block's text nodes while the contenteditable element
    // itself survives: the registered Highlight ranges are left collapsed at an
    // element boundary. Only the frame's content evidence invalidates the
    // projection, so the sentences-only path must receive it.
    ctx.textA.value = "Alpha one. Alpha two. Alpha three.";
    ripple.presentSentences(sentenceFrame(ctx, ctx.blockA, ctx.editableA, ctx.textNodeA, 3), 1000, false, false);
    assert.equal(recorded.at(-1)?.payload.sentenceCount, 2);
    ripple.presentSentences(sentenceFrame(ctx, ctx.blockA, ctx.editableA, ctx.textNodeA, 3), 1000, false, true);
    assert.equal(recorded.at(-1)?.payload.sentenceCount, 3);
    ripple.destroy();
  });
});

test("a rebuilt sentence without the structural role seed still travels from full brightness", () => withSentencePresentation(ctx => {
  ctx.textB.value = "Bravo one. Bravo two.";
  ctx.textA.value = "Alpha one. Alpha two. Alpha three. Alpha four.";
  const ripple = createRipple();
  ripple.prepare(sentenceFrame(ctx, ctx.blockB, ctx.editableB, ctx.textNodeB, ctx.textB.value.length), false, true, true);

  // Same block switch as above, but the live Selection never made a replacement
  // the focused block, so no role seed exists.
  const replacement = new PaintElement();
  replacement.dataset.nodeId = "A";
  replacement.parentElement = ctx.editor;
  ctx.blockA.isConnected = false;
  ctx.blockB.isConnected = false;
  ctx.editor.children = [replacement];

  const caret = ctx.textA.value.indexOf("Alpha three") + 2;
  ripple.prepare(sentenceFrame(ctx, replacement, ctx.editableA, ctx.textNodeA, caret), true, true, true);
  assert.equal(ripple.render(1000, false), true);
  ripple.destroy();
}));

/** Ad-hoc harness blocks need their own closest() for the live-Selection probe. */
function linkBlock(element: PaintElement, nodeId: string, editor: PaintElement): PaintElement {
  element.dataset.nodeId = nodeId;
  element.parentElement = editor;
  Object.assign(element, { closest: (selector: string) =>
    selector === "[data-node-id]" ? element : selector === ".protyle-wysiwyg" ? editor : null });
  return element;
}

/** Tick a Session until a block owner reaches its semantic value; returns the frame time. */
function settleOwner(harness: SessionHarness, element: PaintElement, target: number) {
  let now = 0;
  for (let frame = 0; frame < 400; frame++) {
    const alpha = carrierAlpha(element);
    if (alpha !== null && Math.abs(alpha - target) < 1e-6) return now;
    now += 16;
    harness.tick(now);
  }
  return now;
}

test("a structural replacement that becomes the focused block does not inherit the dim role", () => withSessionHarness(harness => {
  const focused = harness.editable;
  const destination = new PaintElement();
  focused.dataset.nodeId = "B";
  destination.dataset.nodeId = "A";
  destination.parentElement = focused.parentElement = harness.editor;
  destination.nextElementSibling = focused;
  focused.previousElementSibling = destination;
  harness.editor.children = [destination, focused];
  harness.setFrame({ ...harness.getFrame(), reducedMotion: false, range: {} as Range });
  harness.dispatch(0, "input", { inputType: "insertText", isComposing: false });
  harness.tick(0);
  // A stable neighbour holds its dim owner as a critical state, not a finished effect.
  settleOwner(harness, destination, RIPPLE_LEVELS[1]);

  // Host merge: the destination is re-rendered as a fresh same-key element, the
  // focused source is removed, and the live collapsed Selection already sits
  // inside the replacement.
  const replacement = linkBlock(new PaintElement(), "A", harness.editor);
  destination.isConnected = false;
  focused.isConnected = false;
  harness.setSelection("caret", replacement as unknown as Node);
  harness.setFrame({ ...harness.getFrame(), editable: replacement as unknown as HTMLElement,
    block: replacement as unknown as HTMLElement, range: {} as Range,
    caret: { x: 220, y: 420, height: 20 } });
  harness.mutate(6, [{ type: "childList", target: harness.editor,
    addedNodes: [replacement], removedNodes: [destination, focused] } as unknown as MutationRecord]);

  assert.equal(replacement.animations.length, 0);
  assert.ok(harness.events.some(event => event.name === "replacement-role-invalidated" &&
    event.payload.key === "A" && event.payload.reason === "focused-structural-replacement"));

  // The semantic commit must not fold the detached predecessor back either.
  harness.tick(16);
  harness.tick(32);
  harness.tick(80);
  assert.ok(harness.events.some(event => event.name === "structure-commit"));
  assert.equal(replacement.animations.length, 0);
}, { typewriter: false, ripple: true }));

test("a structural reparent releases a dim ancestor before the semantic commit", () => withSessionHarness(harness => {
  const focused = harness.editable;
  focused.dataset.nodeId = "B";
  const neighbor = new PaintElement();
  neighbor.dataset.nodeId = "A";
  neighbor.parentElement = harness.editor;
  neighbor.nextElementSibling = focused;
  focused.previousElementSibling = neighbor;
  harness.editor.children = [neighbor, focused];
  harness.setFrame({ ...harness.getFrame(), reducedMotion: false, range: {} as Range });
  harness.dispatch(0, "input", { inputType: "insertText", isComposing: false });
  harness.tick(0);
  const dim = neighbor.animations.at(-1)!;
  settleOwner(harness, neighbor, RIPPLE_LEVELS[1]);

  // Tab reparents the focused block under its formerly dim neighbour. The Host
  // has already moved the DOM, but the semantic commit is still pending.
  focused.parentElement = neighbor;
  harness.editor.children = [neighbor];
  neighbor.children = [focused];
  harness.setSelection("caret", focused as unknown as Node);
  harness.setFrame({ ...harness.getFrame(), block: focused as unknown as HTMLElement,
    editable: focused as unknown as HTMLElement, range: {} as Range,
    caret: { x: 220, y: 420, height: 20 } });
  harness.mutate(6, [
    { type: "childList", target: harness.editor, addedNodes: [], removedNodes: [focused] } as unknown as MutationRecord,
    { type: "childList", target: neighbor, addedNodes: [focused], removedNodes: [] } as unknown as MutationRecord,
  ]);

  // Before any frame or semantic commit, the owner on the focused subtree's new
  // ancestor must already have moved: the wrapper is released and its own visible
  // content carries the same dim, while the focused block stays unowned.
  assert.equal(dim.playState, "idle");
  assert.equal(focused.animations.length, 0);
  assert.ok(harness.events.some(event => event.name === "focus-ancestor-replaced" && event.payload.released === 1));
  assert.equal(harness.events.some(event => event.name === "structure-commit"), false);
}, { typewriter: false, ripple: true }));

test("Shift+Tab outdent keeps the focused block unowned and releases its former ancestors", () => withSessionHarness(harness => {
  const focused = harness.editable;
  focused.dataset.nodeId = "B";
  const neighbor = new PaintElement();
  neighbor.dataset.nodeId = "A";
  const wrapper = new PaintElement();
  wrapper.parentElement = harness.editor;
  neighbor.parentElement = focused.parentElement = wrapper;
  neighbor.nextElementSibling = focused;
  focused.previousElementSibling = neighbor;
  wrapper.children = [neighbor, focused];
  harness.editor.children = [wrapper];
  harness.setFrame({ ...harness.getFrame(), reducedMotion: false, range: {} as Range });
  harness.setReducedMotion(false);
  harness.dispatch(0, "input", { inputType: "insertText", isComposing: false });
  harness.tick(0);
  settleOwner(harness, neighbor, RIPPLE_LEVELS[1]);

  // Shift+Tab outdents the focused block to the editor level, beside its wrapper.
  harness.dispatch(20, "keydown", { key: "Tab", shiftKey: true, defaultPrevented: false });
  assert.ok(harness.events.some(event => event.name === "structure-intent" && event.payload.intent === "outdent"));
  harness.editor.children = [wrapper, focused];
  wrapper.children = [neighbor];
  focused.parentElement = harness.editor;
  focused.previousElementSibling = wrapper;
  wrapper.nextElementSibling = focused;
  harness.setSelection("caret", focused as unknown as Node);
  harness.setFrame({ ...harness.getFrame(), block: focused as unknown as HTMLElement,
    editable: focused as unknown as HTMLElement, range: {} as Range,
    caret: { x: 260, y: 300, height: 20 } });
  harness.mutate(24, [
    { type: "childList", target: wrapper, addedNodes: [], removedNodes: [focused] } as unknown as MutationRecord,
    { type: "childList", target: harness.editor, addedNodes: [focused], removedNodes: [] } as unknown as MutationRecord,
  ]);

  // The focused block is represented by having no owner: not during the reparent,
  // not on any frame before or after the semantic commit.
  for (let now = 32; now <= 240; now += 16) {
    harness.tick(now);
    assert.equal(focused.animations.length, 0, `focused block owned at ${now}`);
  }
  assert.ok(harness.events.some(event => event.name === "structure-commit" && event.payload.topologyChanged === true));
  assert.equal(harness.events.some(event => event.name === "structure-timeout"), false);
}, { typewriter: false, ripple: true }));

test("IME composition leaves existing block owners untouched", () => withSessionHarness(harness => {
  const focused = harness.editable;
  focused.dataset.nodeId = "B";
  const neighbor = new PaintElement();
  neighbor.dataset.nodeId = "A";
  neighbor.parentElement = harness.editor;
  neighbor.nextElementSibling = focused;
  focused.previousElementSibling = neighbor;
  harness.editor.children = [neighbor, focused];
  harness.setFrame({ ...harness.getFrame(), reducedMotion: false, range: {} as Range });
  harness.setReducedMotion(false);
  harness.dispatch(0, "input", { inputType: "insertText", isComposing: false });
  harness.tick(0);
  settleOwner(harness, neighbor, RIPPLE_LEVELS[1]);
  const before = carrierAlpha(neighbor)!;

  // Composition entry cancels structural intent; it must not open a new generation,
  // disturb the committed block presentation, or churn the carrier.
  harness.dispatch(40, "compositionstart", {});
  harness.tick(56);
  const intents = harness.events.filter(event => event.name === "structure-intent").length;
  harness.dispatch(60, "compositionend", {});
  harness.tick(76);
  harness.tick(92);
  assert.equal(harness.events.filter(event => event.name === "structure-intent").length, intents);
  assertAlpha(carrierAlpha(neighbor), before, "composition must not move a committed owner");
  assert.equal(neighbor.animations.length, 1, "composition must not churn carriers");
}, { typewriter: false, ripple: true }));

test("a representation replacement keeps its committed presentation role", () => withSessionHarness(harness => {
  const focused = harness.editable;
  focused.dataset.nodeId = "B";
  const neighbor = new PaintElement();
  neighbor.dataset.nodeId = "A";
  neighbor.parentElement = harness.editor;
  neighbor.nextElementSibling = focused;
  focused.previousElementSibling = neighbor;
  harness.editor.children = [neighbor, focused];
  harness.setFrame({ ...harness.getFrame(), reducedMotion: false, range: {} as Range });
  harness.dispatch(0, "input", { inputType: "insertText", isComposing: false });
  harness.tick(0);
  const dim = neighbor.animations.at(-1)!;
  settleOwner(harness, neighbor, RIPPLE_LEVELS[1]);

  // Balanced same-key remove/add: representation, not a topology change.
  const replacement = new PaintElement();
  replacement.dataset.nodeId = "A";
  replacement.parentElement = harness.editor;
  neighbor.isConnected = false;
  harness.mutate(6, [{ type: "childList", target: harness.editor,
    addedNodes: [replacement], removedNodes: [neighbor] } as unknown as MutationRecord]);

  // The same semantic state moves to the new actuator: value and target continue.
  assertAlpha(carrierAlpha(replacement), RIPPLE_LEVELS[1]);
  assert.equal(dim.playState, "idle");
  assert.equal(harness.events.some(event => event.name === "replacement-role-invalidated"), false);
}, { typewriter: false, ripple: true }));

test("a structural replacement outside the focused block still carries", () => withSessionHarness(harness => {
  const focused = harness.editable;
  focused.dataset.nodeId = "B";
  const neighbor = new PaintElement();
  const removed = new PaintElement();
  neighbor.dataset.nodeId = "A";
  removed.dataset.nodeId = "C";
  neighbor.parentElement = removed.parentElement = harness.editor;
  neighbor.nextElementSibling = focused;
  focused.previousElementSibling = neighbor;
  harness.editor.children = [neighbor, focused, removed];
  harness.setFrame({ ...harness.getFrame(), reducedMotion: false, range: {} as Range });
  harness.dispatch(0, "input", { inputType: "insertText", isComposing: false });
  harness.tick(0);
  settleOwner(harness, neighbor, RIPPLE_LEVELS[1]);

  // Structural, but the live Selection stays in the untouched focused block.
  const replacement = new PaintElement();
  replacement.dataset.nodeId = "A";
  replacement.parentElement = harness.editor;
  neighbor.isConnected = false;
  removed.isConnected = false;
  harness.setSelection("caret", focused as unknown as Node);
  harness.mutate(6, [{ type: "childList", target: harness.editor,
    addedNodes: [replacement], removedNodes: [neighbor, removed] } as unknown as MutationRecord]);

  assertAlpha(carrierAlpha(replacement), RIPPLE_LEVELS[1]);
  assert.equal(harness.events.some(event => event.name === "replacement-role-invalidated"), false);
}, { typewriter: false, ripple: true }));

test("a range selection never invalidates a replacement role", () => withSessionHarness(harness => {
  const focused = harness.editable;
  focused.dataset.nodeId = "B";
  const neighbor = new PaintElement();
  const removed = new PaintElement();
  neighbor.dataset.nodeId = "A";
  removed.dataset.nodeId = "C";
  neighbor.parentElement = removed.parentElement = harness.editor;
  neighbor.nextElementSibling = focused;
  focused.previousElementSibling = neighbor;
  harness.editor.children = [neighbor, focused, removed];
  harness.setFrame({ ...harness.getFrame(), reducedMotion: false, range: {} as Range });
  harness.dispatch(0, "input", { inputType: "insertText", isComposing: false });
  harness.tick(0);
  settleOwner(harness, neighbor, RIPPLE_LEVELS[1]);

  const replacement = linkBlock(new PaintElement(), "A", harness.editor);
  neighbor.isConnected = false;
  removed.isConnected = false;
  harness.setSelection("range");
  harness.mutate(6, [{ type: "childList", target: harness.editor,
    addedNodes: [replacement], removedNodes: [neighbor, removed] } as unknown as MutationRecord]);

  assertAlpha(carrierAlpha(replacement), RIPPLE_LEVELS[1]);
  assert.equal(harness.events.some(event => event.name === "replacement-role-invalidated"), false);
}, { typewriter: false, ripple: true }));

test("invalidating a focused replacement is a no-op when the block had no owner", () => withSessionHarness(harness => {
  const focused = harness.editable;
  focused.dataset.nodeId = "F";
  const removed = new PaintElement();
  removed.dataset.nodeId = "X";
  removed.parentElement = harness.editor;
  harness.setFrame({ ...harness.getFrame(), reducedMotion: false, range: {} as Range });
  harness.dispatch(0, "input", { inputType: "insertText", isComposing: false });
  harness.tick(0);
  // The focused block is represented by having no block opacity owner.
  assert.equal(focused.animations.length, 0);

  const replacement = linkBlock(new PaintElement(), "F", harness.editor);
  focused.isConnected = false;
  removed.isConnected = false;
  harness.setSelection("caret", replacement as unknown as Node);
  harness.mutate(6, [{ type: "childList", target: harness.editor,
    addedNodes: [replacement], removedNodes: [focused, removed] } as unknown as MutationRecord]);
  assert.equal(replacement.animations.length, 0);
}, { typewriter: false, ripple: true }));

test("a detached owner no longer enters the current semantic projection", () => withPresentation(() => {
  const editor = new PaintElement();
  const old = new PaintElement();
  const fresh = new PaintElement();
  old.dataset.nodeId = fresh.dataset.nodeId = "K";
  fresh.parentElement = editor;
  const painter = createBlockPainter();
  painter.prepare(new Map([[old as unknown as HTMLElement, RIPPLE_LEVELS[1]]]), editor as unknown as HTMLElement, false)();
  painter.step(0, false);
  settleBlocks(now => painter.step(now, false), MOTION.blockAlphaResponseMs);
  old.isConnected = false;

  painter.prepare(new Map([[fresh as unknown as HTMLElement, 1]]), editor as unknown as HTMLElement, false)();
  assert.equal(fresh.animations.length, 0);
  assert.equal(painter.size(), 0);
  painter.clear();
}));

test("a paused replacement retains its moving baseline and semantic target at commit", () => withPresentation(() => {
  const editor = new PaintElement();
  const old = new PaintElement();
  const fresh = new PaintElement();
  old.dataset.nodeId = fresh.dataset.nodeId = "K";
  old.parentElement = fresh.parentElement = editor;
  const painter = createBlockPainter();
  painter.prepare(new Map([[old as unknown as HTMLElement, 0.4]]), editor as unknown as HTMLElement, false)();
  painter.step(0, false);
  painter.step(MOTION.blockAlphaResponseMs, false);
  // Capture the moving state at the moment the structural gate holds motion.
  const held = carrierAlpha(old)!;
  painter.freeze();
  old.isConnected = false;
  painter.rebind([fresh as unknown as HTMLElement])();
  // The held value crosses unchanged to the new actuator; it does not restart.
  assert.ok(Math.abs(carrierAlpha(fresh)! - held) < 1e-9);
  painter.prepare(new Map([[fresh as unknown as HTMLElement, 0.4]]), editor as unknown as HTMLElement, false)();
  // The critical state continues from the held value toward the same target.
  assert.equal(held >= RIPPLE_LEVELS[1] && held < 1, true);
  const settled = settleBlocks(now => painter.step(now, false), MOTION.blockAlphaResponseMs * 2);
  assert.ok(settled > 0);
  assert.ok(Math.abs(carrierAlpha(fresh)! - 0.4) < 1e-6);
  assert.equal(old.animations.at(-1)!.playState, "idle");
  painter.clear();
}));

test("a connected replacement still contributes its carried value", () => withPresentation(() => {
  const editor = new PaintElement();
  const old = new PaintElement();
  const fresh = new PaintElement();
  old.dataset.nodeId = fresh.dataset.nodeId = "K";
  fresh.parentElement = editor;
  const painter = createBlockPainter();
  painter.prepare(new Map([[old as unknown as HTMLElement, RIPPLE_LEVELS[1]]]), editor as unknown as HTMLElement, false)();
  painter.step(0, false);
  settleBlocks(now => painter.step(now, false), MOTION.blockAlphaResponseMs);
  old.isConnected = false;
  const carry = painter.rebind([fresh as unknown as HTMLElement]);
  painter.freeze();
  carry();
  assertAlpha(carrierAlpha(fresh), RIPPLE_LEVELS[1]);

  painter.prepare(new Map([[fresh as unknown as HTMLElement, RIPPLE_LEVELS[2]]]), editor as unknown as HTMLElement, false)();
  settleBlocks(now => painter.step(now, false), MOTION.blockAlphaResponseMs * 2);
  assertAlpha(carrierAlpha(fresh), RIPPLE_LEVELS[2]);
  painter.clear();
}));

test("Session routes typing, navigation and structural CursorIntent independently", () => withSessionHarness(harness => {
  harness.tick(0);
  harness.setFrame({ ...harness.getFrame(), reducedMotion: false, caret: { x: 150, y: 300, height: 20 } });
  harness.dispatch(0, "input", { inputType: "insertText", isComposing: false });
  harness.tick(16);
  assert.equal(harness.events.filter(event => event.name === "render" && "intent" in event.payload).at(-1)?.payload.intent, "typing");
  assert.equal(harness.events.filter(event => event.name === "render" && "targetAuthority" in event.payload).at(-1)?.payload.targetAuthority, "fresh");

  harness.dispatch(20, "keydown", { key: "ArrowRight", defaultPrevented: false });
  harness.setFrame({ ...harness.getFrame(), caret: { x: 220, y: 300, height: 20 } });
  harness.tick(36);
  assert.equal(harness.events.filter(event => event.name === "render" && "intent" in event.payload).at(-1)?.payload.intent, "navigation");
  assert.equal(harness.events.filter(event => event.name === "render" && "targetAuthority" in event.payload).at(-1)?.payload.targetAuthority, "fresh");

  const typewriterFrames = harness.events.filter(event => event.name === "frame" && "requestedScroll" in event.payload).length;
  const ripplePrepares = harness.events.filter(event => event.name === "prepare").length;
  harness.dispatch(40, "keydown", { key: "Enter", defaultPrevented: false });
  const removed = new PaintElement();
  removed.dataset.nodeId = "removed";
  harness.mutate(44, [{ type: "childList", target: harness.editor,
    addedNodes: [], removedNodes: [removed] } as unknown as MutationRecord]);
  harness.setFrame({ ...harness.getFrame(), reducedMotion: false, caret: { x: 500, y: 420, height: 20 } });
  harness.tick(56);
  harness.tick(72);

  assert.equal(harness.events.filter(event => event.name === "render" && "intent" in event.payload).at(-1)?.payload.intent, "structural");
  assert.equal(harness.events.filter(event => event.name === "frame" && "requestedScroll" in event.payload).length, typewriterFrames);
  assert.equal(harness.events.filter(event => event.name === "prepare").length, ripplePrepares);
  assert.ok(harness.events.some(event => event.name === "structure-geometry-ready" &&
    event.payload.topologyChanged === true && event.payload.fromBlockKey === "active" && event.payload.toBlockKey === "active"));
}, { typewriter: true, ripple: true }));

test("Session carries a logical caret through host-only scroll invalidation", () => withSessionHarness(harness => {
  harness.tick(0);
  harness.scroll.scrollTop = 330;
  harness.setFrame({ ...harness.getFrame(), scrollTop: 330, caret: { x: 100, y: 520, height: 20 } });
  harness.dispatch(20, "scroll", { target: harness.scroll });
  harness.tick(36);

  const render = harness.events.filter(event => event.name === "render" && "targetAuthority" in event.payload).at(-1);
  assert.equal(render?.payload.targetAuthority, "carry");
  assert.equal(render?.payload.transportApplied, true);
  assert.equal(render?.payload.transportDy, -30);
}, { typewriter: false, ripple: false }));

test("structural CursorIntent stays with its target through commit, then yields to new targets", () => withSessionHarness(harness => {
  harness.tick(0);
  harness.setFrame({ ...harness.getFrame(), reducedMotion: false, caret: { x: 500, y: 420, height: 20 } });
  harness.dispatch(0, "keydown", { key: "Enter", defaultPrevented: false });
  const removed = new PaintElement();
  removed.dataset.nodeId = "removed";
  harness.mutate(4, [{ type: "childList", target: harness.editor,
    addedNodes: [], removedNodes: [removed] } as unknown as MutationRecord]);
  harness.tick(16);
  harness.tick(32);
  harness.tick(80);

  const renders = () => harness.events.filter(event => event.name === "render" && "intent" in event.payload);
  assert.equal(renders().at(-1)?.payload.intent, "structural");
  assert.ok(harness.events.some(event => event.name === "structure-commit"));

  harness.tick(5000);
  assert.equal(renders().at(-1)?.payload.intent, "structural");
  harness.dispatch(5016, "selectionchange");
  harness.tick(5016);
  assert.equal(renders().at(-1)?.payload.intent, "navigation");

  harness.dispatch(5020, "keydown", { key: "ArrowRight", defaultPrevented: false });
  harness.setFrame({ ...harness.getFrame(), caret: { x: 520, y: 420, height: 20 } });
  harness.tick(5036);
  assert.equal(renders().at(-1)?.payload.intent, "navigation");
  assert.equal(renders().at(-1)?.payload.targetX, 520);

  harness.dispatch(5040, "input", { inputType: "insertText", isComposing: false });
  harness.setFrame({ ...harness.getFrame(), caret: { x: 540, y: 420, height: 20 } });
  harness.tick(5056);
  assert.equal(renders().at(-1)?.payload.intent, "typing");
  assert.equal(renders().at(-1)?.payload.targetX, 540);
}, { typewriter: false, ripple: false }));

test("ordinary character deletion admits at the first safe text sample", () => withSessionHarness(harness => {
  harness.tick(0);
  const overlay = harness.body.children[0];
  const original = overlay.style.transform;
  setTextCaret(harness);
  harness.dispatch(0, "keydown", { key: "Backspace", defaultPrevented: false });
  harness.dispatch(4, "input", { inputType: "deleteContentBackward", isComposing: false });
  harness.mutate(6, [{ type: "characterData", target: harness.editable,
    addedNodes: [], removedNodes: [] } as unknown as MutationRecord]);
  harness.tick(16);

  assert.notEqual(overlay.style.transform, original);
  assert.ok(harness.events.some(event => event.name === "ordinary-delete-admitted"));
  assert.equal(harness.events.some(event => event.name === "structure-sample" &&
    event.payload.reason === "awaiting-post-input-quiet"), false);
}));

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

test("ordinary deletion fast path fails closed at boundaries and replacements", () => {
  const cases: Array<{ name: string; key: string; admitted: boolean; setup: (harness: SessionHarness) => void;
    mutation: (harness: SessionHarness) => MutationRecord[] }> = [
    {
      name: "interior Backspace", key: "Backspace", admitted: true,
      setup: harness => setTextCaret(harness, 3),
      mutation: harness => [{ type: "characterData", target: harness.editable,
        addedNodes: [], removedNodes: [] } as unknown as MutationRecord],
    },
    {
      name: "text-node end Backspace", key: "Backspace", admitted: true,
      setup: harness => setTextCaret(harness, 6),
      mutation: harness => [{ type: "characterData", target: harness.editable,
        addedNodes: [], removedNodes: [] } as unknown as MutationRecord],
    },
    {
      name: "text-node start Backspace", key: "Backspace", admitted: false,
      setup: harness => setTextCaret(harness, 0),
      mutation: harness => [{ type: "characterData", target: harness.editable,
        addedNodes: [], removedNodes: [] } as unknown as MutationRecord],
    },
    {
      name: "interior Delete", key: "Delete", admitted: true,
      setup: harness => setTextCaret(harness, 3),
      mutation: harness => [{ type: "characterData", target: harness.editable,
        addedNodes: [], removedNodes: [] } as unknown as MutationRecord],
    },
    {
      name: "text-node start Delete", key: "Delete", admitted: true,
      setup: harness => setTextCaret(harness, 0),
      mutation: harness => [{ type: "characterData", target: harness.editable,
        addedNodes: [], removedNodes: [] } as unknown as MutationRecord],
    },
    {
      name: "text-node end Delete", key: "Delete", admitted: false,
      setup: harness => setTextCaret(harness, 6),
      mutation: harness => [{ type: "characterData", target: harness.editable,
        addedNodes: [], removedNodes: [] } as unknown as MutationRecord],
    },
    {
      name: "empty block", key: "Backspace", admitted: false,
      setup: harness => harness.setFrame({ ...harness.getFrame(), range: null, caretless: true }),
      mutation: harness => [{ type: "characterData", target: harness.editable,
        addedNodes: [], removedNodes: [] } as unknown as MutationRecord],
    },
    {
      name: "list boundary", key: "Backspace", admitted: false,
      setup: harness => { harness.editable.dataset.type = "NodeListItem"; setTextCaret(harness); },
      mutation: harness => [{ type: "characterData", target: harness.editable,
        addedNodes: [], removedNodes: [] } as unknown as MutationRecord],
    },
    {
      name: "selection deletion", key: "Backspace", admitted: false,
      setup: harness => harness.setFrame({ ...harness.getFrame(), selection: "range", range: null, caret: null }),
      mutation: harness => [{ type: "characterData", target: harness.editable,
        addedNodes: [], removedNodes: [] } as unknown as MutationRecord],
    },
    {
      name: "replacement mutation", key: "Backspace", admitted: false,
      setup: harness => setTextCaret(harness),
      mutation: harness => {
        const removed = new PaintElement();
        const replacement = new PaintElement();
        removed.dataset.nodeId = replacement.dataset.nodeId = "normalized";
        return [{ type: "childList", target: harness.editor,
          addedNodes: [replacement], removedNodes: [removed] } as unknown as MutationRecord];
      },
    },
  ];
  for (const scenario of cases) withSessionHarness(harness => {
    harness.tick(0);
    scenario.setup(harness);
    harness.dispatch(0, "keydown", { key: scenario.key, defaultPrevented: false });
    harness.dispatch(4, "input", { inputType: scenario.key === "Delete" ? "deleteContentForward" : "deleteContentBackward", isComposing: false });
    harness.mutate(6, scenario.mutation(harness));
    harness.tick(16);
    assert.equal(harness.events.some(event => event.name === "ordinary-delete-admitted"), scenario.admitted, scenario.name);
  }, { typewriter: false, ripple: false });
});

test("repeated ordinary Backspace generations admit at text-node end without quiet waits", () => withSessionHarness(harness => {
  harness.tick(0);
  for (const at of [0, 40, 80]) {
    setTextCaret(harness, 6);
    harness.dispatch(at, "keydown", { key: "Backspace", defaultPrevented: false });
    harness.dispatch(at + 4, "input", { inputType: "deleteContentBackward", isComposing: false });
    harness.mutate(at + 6, [{ type: "characterData", target: harness.editable,
      addedNodes: [], removedNodes: [] } as unknown as MutationRecord]);
    harness.tick(at + 16);
  }

  const admissions = harness.events.filter(event => event.name === "ordinary-delete-admitted");
  assert.deepEqual(admissions.map(event => event.payload.generation), [1, 2, 3]);
  assert.equal(harness.events.filter(event => event.name === "structure-sample" &&
    event.payload.reason === "awaiting-post-input-quiet").length, 0);
}, { typewriter: false, ripple: false }));

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

test("repeated structural intent supersedes the old deadline without releasing presentation", () => withSessionHarness(harness => {
  harness.tick(0);
  const overlay = harness.body.children[0];
  const prepared = harness.events.filter(event => event.name === "prepare").length;
  harness.dispatch(0, "keydown", { key: "Backspace", defaultPrevented: false });
  const firstRemoved = new PaintElement();
  firstRemoved.dataset.nodeId = "first-removed";
  harness.mutate(4, [{ type: "childList", target: harness.editor,
    addedNodes: [], removedNodes: [firstRemoved] } as unknown as MutationRecord]);
  harness.tick(16);

  harness.dispatch(140, "keydown", { key: "Backspace", defaultPrevented: false });
  const secondRemoved = new PaintElement();
  secondRemoved.dataset.nodeId = "second-removed";
  harness.mutate(144, [{ type: "childList", target: harness.editor,
    addedNodes: [], removedNodes: [secondRemoved] } as unknown as MutationRecord]);
  harness.tick(160);

  assert.equal(harness.events.some(event => event.name === "structure-generation-superseded"), true);
  assert.equal(harness.events.some(event => event.name === "structure-release" && event.payload.reason === "timeout"), false);
  assert.equal(overlay.hidden, false);
  assert.equal(harness.events.filter(event => event.name === "prepare").length, prepared);

  harness.tick(192);
  assert.equal(harness.events.some(event => event.name === "structure-commit"), true);
}, { typewriter: false, ripple: true }));

test("repeated structural generations retarget Cursor at each geometry-ready handoff", () => withSessionHarness(harness => {
  harness.tick(0);
  const overlay = harness.body.children[0];
  harness.dispatch(0, "keydown", { key: "Enter", defaultPrevented: false });
  const firstRemoved = new PaintElement();
  firstRemoved.dataset.nodeId = "first-removed";
  harness.mutate(4, [{ type: "childList", target: harness.editor, addedNodes: [], removedNodes: [firstRemoved] } as unknown as MutationRecord]);
  harness.setFrame({ ...harness.getFrame(), caret: { x: 200, y: 300, height: 20 } });
  harness.tick(16);
  harness.tick(32);
  assert.equal(overlay.style.transform, `translate3d(200px,${300 - MOTION.caretLiftPx}px,0)`);

  harness.dispatch(36, "keydown", { key: "Enter", defaultPrevented: false });
  const secondRemoved = new PaintElement();
  secondRemoved.dataset.nodeId = "second-removed";
  harness.mutate(40, [{ type: "childList", target: harness.editor, addedNodes: [], removedNodes: [secondRemoved] } as unknown as MutationRecord]);
  harness.setFrame({ ...harness.getFrame(), caret: { x: 360, y: 420, height: 20 } });
  harness.tick(48);
  harness.tick(64);
  assert.equal(overlay.style.transform, `translate3d(360px,${420 - MOTION.caretLiftPx}px,0)`);
  assert.equal(harness.events.filter(event => event.name === "structure-geometry-ready").length, 2);
  assert.ok(harness.events.some(event => event.name === "structure-generation-superseded"));
  assert.equal(harness.events.some(event => event.name === "structure-release" && event.payload.reason === "timeout"), false);
  assert.equal(harness.events.some(event => event.name === "structure-commit"), false);

  harness.tick(96);
  assert.equal(harness.events.some(event => event.name === "structure-commit"), true);
}, { typewriter: true, ripple: true }));

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
  assert.equal(harness.events.filter(event => event.name === "render" && "intent" in event.payload).at(-1)?.payload.intent, "typing");
  harness.tick(MOTION.typingPauseMs + 1, MOTION.typingPauseMs + 135);
  assert.ok(harness.scroll.scrollTop > 300);
  assert.equal(harness.events.filter(event => event.name === "render" && "intent" in event.payload).at(-1)?.payload.intent, "navigation");
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
  assert.equal(harness.events.some(event => event.name === "structure-geometry-ready" && event.payload.caret === null), false);
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
  for (let now = 16; now <= MOTION.structureDeadlineMs; now += 16) {
    harness.setFrame({ ...harness.getFrame(), caret: { x: 220 + now, y: 310 + now / 10, height: 20 } });
    harness.tick(now);
  }

  assert.equal(harness.events.filter(event => event.name === "frame-commit").length, committed);
  assert.ok(harness.events.some(event => event.name === "structure-release" && event.payload.reason === "timeout"));
  assert.equal(harness.events.some(event => event.name === "structure-geometry-ready"), false);
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
  harness.setReducedMotion(false);
  harness.dispatch(0, "input", { inputType: "insertText", isComposing: false });
  harness.tick(0);
  assert.ok(carrierAlpha(previous) !== null);

  harness.session.suspend();

  // A suspension that leaves the renderer visible retargets the owner to neutral
  // on the ordinary Session frame instead of tearing the semantic state down.
  const released = settleBlocks(now => {
    harness.tick(now);
    return carrierAlpha(previous) !== null;
  }, MOTION.typingPauseMs + 1);
  assert.ok(released > 0);
  assert.equal(previous.animations.at(-1)!.playState, "idle");
  assert.equal(harness.events.some(event => event.name === "clear"), false);
  harness.session.suspend();
  assert.equal(previous.animations.at(-1)!.playState, "idle");
}, { typewriter: false, ripple: true }));

function withDimNeighbour(harness: SessionHarness) {
  const previous = new PaintElement();
  previous.dataset.nodeId = "previous";
  previous.parentElement = harness.editor;
  previous.nextElementSibling = harness.editable;
  harness.editable.previousElementSibling = previous;
  harness.editor.children = [previous, harness.editable];
  harness.setFrame({ ...harness.getFrame(), reducedMotion: false, range: {} as Range });
  harness.setReducedMotion(false);
  harness.dispatch(0, "input", { inputType: "insertText", isComposing: false });
  harness.tick(0);
  assert.ok(carrierAlpha(previous) !== null);
  // A fully dimmed neighbour is the presentation a window blur actually sees.
  settleOwner(harness, previous, RIPPLE_LEVELS[1]);
  return previous;
}

test("window blur releases a dim Ripple from its current value instead of clearing it", () => withSessionHarness(harness => {
  const previous = withDimNeighbour(harness);

  harness.dispatch(16, "blur");

  assert.ok(harness.events.some(event => event.name === "suspend" && event.payload.reason === "window-blur"));
  assert.equal(harness.events.some(event => event.name === "clear"), false);
  const released = settleBlocks(now => {
    harness.tick(now);
    return carrierAlpha(previous) !== null;
  }, 100);
  assert.ok(released > 0);
  assert.equal(previous.animations.at(-1)!.playState, "idle");

  // The released state finishes and leaves nothing retained behind.
  harness.tick(1000);
  assert.equal(harness.rafCount(), 0);
  assert.equal(harness.timerCount(), 0);
}, { typewriter: false, ripple: true }));

test("window blur preserves Cursor presentation while a hidden document tears down synchronously", () => withSessionHarness(harness => {
  const previous = withDimNeighbour(harness);
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
  assert.equal(harness.timerCount(), 0);
  assert.ok(harness.events.some(event => event.name === "structure-cancel" && event.payload.reason === "lifecycle"));
  assert.equal(harness.events.some(event => event.name === "clear"), false);
  assert.ok(carrierAlpha(previous) !== null);

  harness.dispatch(100, "focus");
  harness.tick(100);
  assert.ok(harness.readCount() > readsBeforeFocus);
  assert.equal(harness.scroll.scrollTop, scrollBeforeBlur);
  assert.equal(harness.events.filter(event => event.name === "prepare").at(-1)?.payload.enabled, false);
  assert.equal(harness.events.filter(event => event.name === "frame-commit").at(-1)?.payload.typewriterMoving, false);

  // A hidden document cannot show the release, so it must not keep one alive.
  const hidden = Object.getOwnPropertyDescriptor(document, "hidden")!;
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  try {
    harness.dispatch(120, "visibilitychange");
    assert.equal(harness.events.some(event => event.name === "clear"), true);
    assert.equal(overlay.hidden, true);
    assert.equal(previous.animations.at(-1)!.playState, "idle");
    // A hidden renderer must not keep a background animation loop alive.
    harness.tick(121);
    assert.equal(harness.rafCount(), 0);
  } finally {
    Object.defineProperty(document, "hidden", hidden);
  }
}, { typewriter: true, ripple: true }));

test("mutation delivery rebinds a semantic replacement before the next rAF", () => withSessionHarness(harness => {
  const old = new PaintElement();
  old.dataset.nodeId = "previous";
  old.parentElement = harness.editor;
  old.nextElementSibling = harness.editable;
  harness.editable.previousElementSibling = old;
  harness.editor.children = [old, harness.editable];
  harness.setFrame({ ...harness.getFrame(), reducedMotion: false, range: {} as Range });
  harness.setReducedMotion(false);
  harness.dispatch(0, "input", { inputType: "insertText", isComposing: false });
  harness.tick(0);
  // Stop the neighbour mid-flight so its state is a real moving value.
  harness.tick(MOTION.blockAlphaResponseMs);
  const moving = carrierAlpha(old)!;
  assert.ok(moving > RIPPLE_LEVELS[1] && moving < 1);

  const replacement = new PaintElement();
  replacement.dataset.nodeId = old.dataset.nodeId;
  replacement.parentElement = harness.editor;
  // The Host puts the replacement into the removed element's sibling position.
  replacement.nextElementSibling = harness.editable;
  harness.editable.previousElementSibling = replacement;
  harness.editor.children = [replacement, harness.editable];
  old.isConnected = false;
  harness.mutate(4, [{ type: "childList", target: harness.editor,
    addedNodes: [replacement], removedNodes: [old] } as unknown as MutationRecord]);

  // The same semantic state continues on the new actuator: no restart from full.
  assert.ok(Math.abs(carrierAlpha(replacement)! - moving) < 1e-9);
  const continued = carrierAlpha(replacement)!;
  // The hold restarts the frame clock, so the first resumed frame only establishes
  // the baseline; the next one advances the same trajectory toward the dim role.
  harness.tick(MOTION.blockAlphaResponseMs);
  harness.tick(MOTION.blockAlphaResponseMs * 3);
  const settled = carrierAlpha(replacement)!;
  assert.ok(settled < continued, `expected continued descent, got ${continued} -> ${settled}`);
  // It converged to the dim role, never bounced back toward full brightness.
  assert.ok(Math.abs(settled - RIPPLE_LEVELS[1]) < 0.01, `expected dim role, got ${settled}`);
}, { typewriter: false, ripple: true }));

test("switch settling is bounded through missing geometry and cancelled by lifecycle", () => withPresentation(body => {
  const cursor = createCursor();
  const input = frame({ editable: new PaintElement() as unknown as HTMLElement });
  const overlay = body.children[0];
  cursor.switched(input.editor, 1000);
  for (let i = 0; i < 7; i++) cursor.render(input, 1000 + i * 16, "navigation");
  cursor.render({ ...input, caret: null }, 1112, "navigation");
  cursor.render(input, 1128, "navigation");
  assert.equal(overlay.hidden, true);
  cursor.render({ ...input, caret: { x: 400, y: 300, height: 20 } }, 1700, "navigation");
  assert.equal(cursor.isSettling(), true);
  assert.equal(overlay.hidden, true);
  assert.equal(overlay.style.transform, `translate3d(400px,${300 - MOTION.caretLiftPx}px,0)`);
  cursor.render({ ...input, caret: { x: 400, y: 300, height: 20 } }, 1716, "navigation");
  assert.equal(cursor.isSettling(), true);
  assert.equal(overlay.hidden, false);
  assert.equal(overlay.style.opacity, "0");
  for (let now = 1732; now <= 5000 && cursor.isSettling(); now += 16) {
    cursor.render({ ...input, caret: { x: 400, y: 300, height: 20 } }, now, "navigation");
  }
  assert.equal(cursor.isSettling(), false);
  cursor.switched(input.editor, 2000);
  cursor.render({ ...input, caret: null }, 2700, "navigation");
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
  cursor.render({ ...input, reducedMotion: true }, 6000, "navigation");
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
  cursor.render(input, 1000, "navigation");
  for (let now = 1016; now < 1400; now += 16) {
    cursor.render({ ...input, editable: second as unknown as HTMLElement,
      caret: null, caretless: true }, now, "navigation");
  }
  assert.equal(overlay.hidden, true);
  assert.equal(first.classes.has("zentype-custom-caret-active"), false);
  assert.equal(second.classes.has("zentype-custom-caret-active"), true);
  assert.equal(cursor.yieldSelection(1400, false, first as unknown as HTMLElement), false);
  assert.equal(second.classes.has("zentype-custom-caret-active"), false);
  assert.equal(first.classes.has("zentype-custom-caret-active"), true);
  cursor.render(input, 1416, "navigation");
  assert.equal(overlay.hidden, false);
  cursor.release(1432, false);
  assert.equal(first.classes.has("zentype-custom-caret-active"), false);
  cursor.render({ ...input, caret: null }, 2000, "navigation");
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

test("list reparenting transfers parent alpha to its children without restarting stable fades", () => withPresentation(() => {
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
  // Let the parent settle to its dim role, then reparent.
  settleBlocks(now => ripple.render(now, false), MOTION.blockAlphaResponseMs * 3);
  assertAlpha(carrierAlpha(parent), RIPPLE_LEVELS[1]);

  // Tab moves the active block under the formerly dim sibling.
  active.parentElement = child.parentElement = parent;
  active.nextElementSibling = child; child.previousElementSibling = active;
  parent.previousElementSibling = null;
  ripple.prepare(input, false, true, true);
  assert.equal(parent.classes.has("zentype-ripple-block"), false);
  // The newly exposed child starts at the parent's presented alpha, not at full.
  assert.ok(carrierAlpha(child)! < 1);
  // The focused block moved under the dim sibling, but this same plan releases
  // that ancestor, so nothing dims the focused block: it must never render a
  // dark frame it never had.
  assert.equal(active.animations.length, 0);
  const moving = ripple.render(1000, false);
  // Nothing may keep the focused subtree dim while the plan converges.
  assert.equal(carrierAlpha(active), null);
  ripple.prepare(input, false, false, false);
  settleBlocks(now => ripple.render(now, false), 1000 + MOTION.blockAlphaResponseMs * 3);
  // The focused block stays unowned through the whole plan.
  assert.equal(carrierAlpha(active), null);
  assert.equal(carrierAlpha(child), null);
  void moving;
  ripple.destroy();
}));

test("Tab handoff preserves a moving marker baseline across a new list wrapper", () => withPresentation(() => {
  const editor = new PaintElement();
  const outer = new PaintElement();
  const item = new PaintElement();
  const marker = new PaintElement();
  const content = new PaintElement();
  const outerContent = new PaintElement();
  const wrapper = new PaintElement();
  for (const [element, key] of [[outer, "outer"], [item, "item"], [marker, "marker"],
    [content, "content"], [outerContent, "outer-content"], [wrapper, "new-list"]] as const) element.dataset.nodeId = key;
  outer.parentElement = item.parentElement = editor;
  marker.parentElement = content.parentElement = item;
  outerContent.parentElement = outer;
  const painter = createBlockPainter();
  const asElement = (element: PaintElement) => element as unknown as HTMLElement;
  painter.prepare(new Map([[asElement(outer), 0.4], [asElement(marker), 0.4], [asElement(content), 1]]), asElement(editor), false)();
  // Put both owners mid-flight so a restart would be visible.
  painter.step(0, false);
  painter.step(MOTION.blockAlphaResponseMs, false);
  const markerState = carrierAlpha(marker)!;
  const outerState = carrierAlpha(outer)!;
  painter.freeze();
  wrapper.parentElement = outer;
  item.parentElement = wrapper;
  painter.prepare(new Map([[asElement(outerContent), 0.4], [asElement(marker), 0.4], [asElement(content), 1]]), asElement(editor), false)();
  // A stable marker trajectory must not restart from alpha squared.
  assert.ok(Math.abs(carrierAlpha(marker)! - markerState) < 1e-9);
  // The new inherited content owner starts from the outer owner's presented alpha,
  // continuing the same trajectory instead of restarting from full brightness.
  assert.ok(Math.abs(carrierAlpha(outerContent)! - outerState) < 1e-9);
  // The old outer owner is released by the repartition, not restarted.
  assert.equal(outer.animations.at(-1)!.playState, "idle");
  assert.equal(content.animations.length, 0);
  assert.equal(wrapper.animations.length, 0);
  // Reverse reparent while the inherited content owner is still in flight.
  painter.step(MOTION.blockAlphaResponseMs * 2, false);
  const carried = carrierAlpha(outerContent)!;
  item.parentElement = editor;
  painter.prepare(new Map([[asElement(outer), 0.4], [asElement(marker), 0.4], [asElement(content), 1]]), asElement(editor), false)();
  assert.ok(Math.abs(carrierAlpha(outer)! - carried) < 1e-9);
  assert.ok(Math.abs(carrierAlpha(marker)! - markerState) < 1e-9);
  painter.clear();
}));

test("nested residual owners hand back their composite presentation without multiplying twice", () => withPresentation(() => {
  const editor = new PaintElement();
  const parent = new PaintElement();
  const bright = new PaintElement();
  const dim = new PaintElement();
  parent.parentElement = editor;
  bright.parentElement = dim.parentElement = parent;
  const el = (element: PaintElement) => element as unknown as HTMLElement;
  const painter = createBlockPainter();
  painter.prepare(new Map([[el(bright), 0.4], [el(dim), 0.1]]), el(editor), true)();
  painter.prepare(new Map([[el(parent), 0.2]]), el(editor), false)();
  // Children fold into the parent: the composite is expressed by the parent owner
  // plus at most one local residual on a surviving child.
  assert.ok(painter.size() >= 1 && painter.size() <= 2, String(painter.size()));
  painter.step(0, false);
  painter.step(MOTION.blockAlphaResponseMs, false);
  const parentAlpha = carrierAlpha(parent)!;
  const residualAlpha = carrierAlpha(dim)!;
  const brightAlpha = carrierAlpha(bright)!;
  // The residual is a local factor; the composite stays above the local value.
  assert.ok(parentAlpha < 0.4 && parentAlpha > 0.2);
  assert.ok(residualAlpha > parentAlpha, "residual child carries a normalized local factor");
  painter.prepare(new Map(), el(editor), false)();
  // Neutral release keeps the residual trajectory converging to its own target.
  settleBlocks(now => painter.step(now, false), MOTION.blockAlphaResponseMs * 4);
  assert.equal(painter.size(), 0);
  void brightAlpha;
  painter.clear();
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
  assertAlpha(carrierAlpha(outerMarker), carrierAlpha(outerContent)!);
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
      settleBlocks(now => ripple.render(now, false), MOTION.blockAlphaResponseMs * 3);
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
      // The host inline opacity is never read back into or written by the owner.
      assert.equal(merged.style.opacity, replacementStyle);
      // A still-connected predecessor still contributes its committed value.
      assert.equal(merged.animations.length, connected ? 1 : 0);
      assert.equal(merged.style.opacity ?? "", replacementStyle);
      assert.equal(merged.classes.has("zentype-ripple-block"), false);
      ripple.clear();
      assert.equal(merged.style.opacity ?? "", replacementStyle);
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
  // The held sentence floor is adopted as the owner's current state, not restarted.
  assertAlpha(carrierAlpha(replacement), 0.6);

  painter.prepare(new Map([[replacement as unknown as HTMLElement, RIPPLE_LEVELS[1]]]),
    editor as unknown as HTMLElement, false)();
  settleBlocks(now => painter.step(now, false), MOTION.blockAlphaResponseMs * 3);
  assertAlpha(carrierAlpha(replacement), RIPPLE_LEVELS[1]);
  painter.clear();
}));

test("ownership telemetry reports only changed owner values and targets", () => withPresentation(() => {
  const records: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const debug = {
    record: (_source: string, name: string, payload: Record<string, unknown>) => records.push({ name, payload }),
  } as never;
  const editor = new PaintElement();
  const target = new PaintElement();
  target.dataset.nodeId = "target";
  target.parentElement = editor;
  const painter = createBlockPainter(debug);
  const dim = RIPPLE_LEVELS[1];
  const targets = new Map([[target as unknown as HTMLElement, dim]]);

  painter.prepare(targets, editor as unknown as HTMLElement, false)();
  const initial = records.at(-1)!;
  assert.equal(initial.name, "ownership-commit");
  assert.deepEqual(initial.payload.changes, [{ key: "target", previousValue: null,
    startValue: 1, target: dim, hadPreviousKey: false }]);

  // Settling to the semantic value keeps the owner, so the plan is unchanged.
  settleBlocks(now => painter.step(now, false), MOTION.blockAlphaResponseMs * 3);
  painter.prepare(targets, editor as unknown as HTMLElement, false)();
  assert.equal(records.at(-1)!.payload.changedCount, 0);
  assert.deepEqual(records.at(-1)!.payload.changes, []);

  painter.prepare(new Map([[target as unknown as HTMLElement, 1]]), editor as unknown as HTMLElement, false)();
  const bright = records.at(-1)!;
  assert.deepEqual(bright.payload.changes, [{ key: "target", previousValue: dim,
    startValue: dim, target: 1, hadPreviousKey: true }]);
  painter.clear();
}));

test("ownership telemetry caps changed owner detail", () => withPresentation(() => {
  const records: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const debug = {
    record: (_source: string, name: string, payload: Record<string, unknown>) => records.push({ name, payload }),
  } as never;
  const editor = new PaintElement();
  const targets = new Map<HTMLElement, number>();
  for (let index = 0; index < 20; index++) {
    const target = new PaintElement();
    target.dataset.nodeId = `target-${index}`;
    target.parentElement = editor;
    targets.set(target as unknown as HTMLElement, RIPPLE_LEVELS[1]);
  }
  const painter = createBlockPainter(debug);
  painter.prepare(targets, editor as unknown as HTMLElement, false)();

  const payload = records.at(-1)!.payload;
  assert.equal(payload.targetCount, 20);
  assert.equal(payload.previousCount, 0);
  assert.equal(payload.changedCount, 20);
  assert.equal(payload.truncated, true);
  assert.equal((payload.changes as unknown[]).length, 16);
  painter.clear();
}));

test("a Session frame only steps existing owners and never re-reads host topology", () => withPresentation(() => {
  const editor = new PaintElement();
  const focused = new PaintElement();
  const neighbour = new PaintElement();
  focused.dataset.nodeId = "focused"; neighbour.dataset.nodeId = "neighbour";
  focused.parentElement = neighbour.parentElement = editor;
  focused.nextElementSibling = neighbour;
  const reads: string[] = [];
  const previousStyle = getComputedStyle;
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true,
    value: (element: PaintElement) => { reads.push(String(element.dataset.nodeId)); return previousStyle(element as unknown as Element); } });
  try {
    const painter = createBlockPainter();
    painter.prepare(new Map([[focused as unknown as HTMLElement, 1], [neighbour as unknown as HTMLElement, RIPPLE_LEVELS[1]]]),
      editor as unknown as HTMLElement, false)();
    const afterPrepare = reads.length;
    // Many frames of motion must cost zero topology reads and zero planning.
    const moving = settleBlocks(now => painter.step(now, false), 0);
    assert.ok(moving > 0, "the neighbour must actually be moving");
    assert.equal(reads.length, afterPrepare);
    painter.clear();
  } finally {
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: previousStyle });
  }
}));

test("a rapid block role retarget continues critical motion without a restart", () => withPresentation(() => {
  const editor = new PaintElement();
  const block = new PaintElement();
  block.dataset.nodeId = "block";
  block.parentElement = editor;
  const painter = createBlockPainter();
  const el = block as unknown as HTMLElement;

  painter.prepare(new Map([[el, RIPPLE_LEVELS[1]]]), editor as unknown as HTMLElement, false)();
  let now = 0;
  painter.step(now, false);
  now += MOTION.blockAlphaResponseMs;
  painter.step(now, false);
  const before = carrierAlpha(block)!;
  assert.ok(before > RIPPLE_LEVELS[1] && before < 1);

  // A second structural edit retargets to a different dim role mid-flight. The same
  // owner must continue from its current value and velocity, not restart from full.
  painter.prepare(new Map([[el, RIPPLE_LEVELS[2]]]), editor as unknown as HTMLElement, false)();
  assert.ok(Math.abs(carrierAlpha(block)! - before) < 1e-9, "retarget jumped the current value");
  const ownerAfter = block.animations.at(-1)!;
  now += MOTION.blockAlphaResponseMs / 4;
  painter.step(now, false);
  const stepped = carrierAlpha(block)!;
  assert.ok(stepped < before, `expected motion to continue downward, got ${before} -> ${stepped}`);
  // It steps toward the new role from the old value: not a restart to full, and
  // not a teleport straight to the new target in one frame.
  assert.ok(stepped > RIPPLE_LEVELS[2], `expected an intermediate value, got ${stepped}`);
  settleBlocks(t => { now = t; return painter.step(t, false); }, now);
  assertAlpha(carrierAlpha(block), RIPPLE_LEVELS[2]);
  assert.equal(block.animations.at(-1), ownerAfter, "retarget must reuse one carrier, not build a second");
  painter.clear();
}));

test("alternating block role retargets reuse one owner and never restart from full", () => withPresentation(() => {
  const editor = new PaintElement();
  const block = new PaintElement();
  block.dataset.nodeId = "block";
  block.parentElement = editor;
  const painter = createBlockPainter();
  const el = block as unknown as HTMLElement;
  const roles = [RIPPLE_LEVELS[1], RIPPLE_LEVELS[2], RIPPLE_LEVELS[3], RIPPLE_LEVELS[1]];

  painter.prepare(new Map([[el, roles[0]]]), editor as unknown as HTMLElement, false)();
  let now = 0;
  painter.step(now, false);
  for (let round = 1; round < 12; round++) {
    const target = roles[round % roles.length];
    const before = carrierAlpha(block)!;
    // A retarget must not move the presented value: it only changes the destination.
    painter.prepare(new Map([[el, target]]), editor as unknown as HTMLElement, false)();
    assert.ok(Math.abs(carrierAlpha(block)! - before) < 1e-9, `round ${round} jumped on retarget`);
    // Off by one frame deliberately: a retarget lands mid-flight, as rapid Tab /
    // Shift+Tab does. The step continues from the current value toward the new role
    // and never teleports to it in one frame.
    now += MOTION.blockAlphaResponseMs / 3;
    painter.step(now, false);
    const alpha = carrierAlpha(block)!;
    assert.ok(Math.abs(alpha - target) > 1e-9, `round ${round} teleported to target`);
    assert.ok(alpha < 1, `round ${round} returned to full brightness: ${alpha}`);
  }
  // One semantic owner, one carrier: no WAAPI churn across the whole alternation.
  assert.equal(painter.size(), 1);
  assert.equal(block.animations.length, 1, "alternating retargets must not build new carriers");
  painter.clear();
}));

test("reduced motion commits a block owner at its role without an animated tail", () => withPresentation(() => {
  const editor = new PaintElement();
  const target = new PaintElement();
  target.dataset.nodeId = "target";
  target.parentElement = editor;
  const painter = createBlockPainter();
  const e = target as unknown as HTMLElement;
  const ed = editor as unknown as HTMLElement;

  // The commit snaps straight to the role: no partial value is ever presented.
  painter.prepare(new Map([[e, RIPPLE_LEVELS[1]]]), ed, true)();
  assertAlpha(carrierAlpha(target), RIPPLE_LEVELS[1]);
  painter.step(0, true);
  assertAlpha(carrierAlpha(target), RIPPLE_LEVELS[1]);

  // A held dim owner resumed under reduced motion keeps its role immediately: the
  // reduced-motion contract removes the transition, not the presentation.
  painter.freeze();
  painter.resume(true);
  assert.equal(painter.size(), 1);
  assertAlpha(carrierAlpha(target), RIPPLE_LEVELS[1]);

  // A neutral role has nowhere to settle but release, so it does not linger.
  painter.prepare(new Map([[e, 1]]), ed, true)();
  assert.equal(painter.size(), 0);
  assert.equal(carrierAlpha(target), null);
  painter.clear();
}));

test("a dim ancestor's alpha moves onto its own content instead of flashing bright", () => withPresentation(() => {
  const editor = new PaintElement();
  const focused = new PaintElement();
  const ancestor = new PaintElement();
  const label = new PaintElement();
  const marker = new PaintElement();
  const nested = new PaintElement();
  focused.dataset.nodeId = "focused"; ancestor.dataset.nodeId = "ancestor"; label.dataset.nodeId = "label";
  nested.dataset.nodeId = "nested"; nested.dataset.type = "NodeList";
  marker.classes.add("protyle-action");
  focused.parentElement = ancestor.parentElement = editor;
  focused.nextElementSibling = ancestor; ancestor.previousElementSibling = focused;
  // The parent's own visible content is a marker and a paragraph directly under the
  // covering element, exactly like a NodeListItem. Its nested list, which will carry
  // the focused block after Tab, is the third child.
  label.parentElement = marker.parentElement = nested.parentElement = ancestor;
  ancestor.children = [marker, label, nested];
  const painter = createBlockPainter();
  const el = (element: PaintElement) => element as unknown as HTMLElement;

  // The ancestor is committed dim. Its marker, label and nested list are uncovered,
  // so their dim is produced by the ancestor owner alone.
  painter.prepare(new Map([[el(focused), 1], [el(ancestor), RIPPLE_LEVELS[1]]]), el(editor), false)();
  settleBlocks(now => painter.step(now, false), 0);
  assertAlpha(carrierAlpha(ancestor), RIPPLE_LEVELS[1]);
  assert.equal(carrierAlpha(label), null);
  assert.equal(carrierAlpha(marker), null);

  // Tab reparents the focused block into the nested list. The ancestor now covers the
  // focused subtree, so it may not stay on the wrapper; its own marker and label must
  // inherit the dim instead, and the nested list on the focus path must not.
  focused.parentElement = nested;
  nested.children = [focused];
  painter.protectFocus(el(focused));
  assert.equal(carrierAlpha(ancestor), null, "the wrapper owner releases");
  assert.equal(carrierAlpha(focused), null, "the focused block is never dimmed");
  assert.equal(carrierAlpha(nested), null, "the focus path carries no block owner");
  assertAlpha(carrierAlpha(label), RIPPLE_LEVELS[1], "the parent's own paragraph keeps the dim");
  assertAlpha(carrierAlpha(marker), RIPPLE_LEVELS[1], "the parent's own marker keeps the dim");

  // No frame before the commit may brighten the parent's visible content.
  let previous = carrierAlpha(label)!;
  for (let step = 1; step <= 200; step++) {
    painter.step(step * 16, false);
    const alpha = carrierAlpha(label);
    if (alpha === null) break;
    assert.ok(alpha <= previous + 1e-9, `parent content brightened: ${previous} -> ${alpha}`);
    previous = alpha;
  }
  assertAlpha(previous, RIPPLE_LEVELS[1]);
  painter.clear();
}));

test("nested covering owners are removed exactly once regardless of iteration order", () => withPresentation(() => {
  // owner O (outer) > owner I (inner) > focused. Both are ancestors of the focused
  // block, so both factors must come off, and each inner region must keep exactly
  // the composite it was already showing.
  const editor = new PaintElement();
  const outer = new PaintElement();
  const outerLabel = new PaintElement();
  const inner = new PaintElement();
  const innerLabel = new PaintElement();
  const focused = new PaintElement();
  const branch = new PaintElement();
  outer.dataset.nodeId = "outer"; outerLabel.dataset.nodeId = "outer-label";
  inner.dataset.nodeId = "inner"; innerLabel.dataset.nodeId = "inner-label";
  focused.dataset.nodeId = "focused"; branch.dataset.nodeId = "branch";
  const el = (element: PaintElement) => element as unknown as HTMLElement;
  outer.parentElement = editor;
  outer.children = [outerLabel, inner];
  outerLabel.parentElement = inner.parentElement = outer;
  // inner holds one off-path child (branch) and the path child that contains focus.
  inner.children = [innerLabel, branch];
  innerLabel.parentElement = branch.parentElement = inner;
  branch.children = [focused];
  focused.parentElement = branch;

  const painter = createBlockPainter();
  // Hand-crafted steady state: outer 0.4, inner a further 0.2, so the region under
  // inner composites at 0.4 * 0.2 = 0.08.
  painter.prepare(new Map([[el(focused), 1], [el(outer), RIPPLE_LEVELS[1]], [el(inner), RIPPLE_LEVELS[2]]]), el(editor), false)();
  painter.step(0, false);
  painter.step(MOTION.blockAlphaResponseMs * 2, false);
  const outerLocal = carrierAlpha(outer)!;
  const innerLocalBefore = carrierAlpha(inner)!;
  const innerRegionComposite = outerLocal * innerLocalBefore;

  painter.protectFocus(el(focused));

  assert.equal(carrierAlpha(outer), null, "outer covering owner releases");
  assert.equal(carrierAlpha(inner), null, "inner covering owner releases");
  assert.equal(carrierAlpha(focused), null, "the focused block is never owned");
  // Nothing that was dim may brighten: each leftover region keeps its composite.
  assert.ok(carrierAlpha(outerLabel)! <= outerLocal + 1e-9, "outer label brightened");
  assert.ok(carrierAlpha(innerLabel)! <= innerRegionComposite + 1e-9, "inner label brightened");
  assert.ok(carrierAlpha(branch)! <= innerRegionComposite + 1e-9, "inner branch brightened");
  painter.clear();
}));

test("a deep dim sibling keeps its dim when the focused block is indented past it", () => withPresentation(() => {
  // The reported document shape:
  //   - A
  //       - B
  //   - C     (focused, indented under A)
  // B is a grandchild of the covering element, not a direct child.
  const editor = new PaintElement();
  const rootList = new PaintElement();
  const itemA = new PaintElement();
  const markerA = new PaintElement();
  const paraA = new PaintElement();
  const listA = new PaintElement();
  const itemB = new PaintElement();
  const markerB = new PaintElement();
  const paraB = new PaintElement();
  const itemC = new PaintElement();
  const markerC = new PaintElement();
  const paraC = new PaintElement();
  rootList.dataset.nodeId = "root"; itemA.dataset.nodeId = "A"; paraA.dataset.nodeId = "A-p";
  listA.dataset.nodeId = "A-list"; itemB.dataset.nodeId = "B"; paraB.dataset.nodeId = "B-p";
  itemC.dataset.nodeId = "C"; paraC.dataset.nodeId = "C-p";
  rootList.dataset.type = "NodeList"; itemA.dataset.type = "NodeListItem"; itemB.dataset.type = "NodeListItem";
  itemC.dataset.type = "NodeListItem"; listA.dataset.type = "NodeList";
  paraA.dataset.type = "NodeParagraph"; paraB.dataset.type = "NodeParagraph"; paraC.dataset.type = "NodeParagraph";
  for (const m of [markerA, markerB, markerC]) m.classes.add("protyle-action");
  const link = (parent: PaintElement, children: PaintElement[]) => {
    parent.children = children;
    children.forEach((c, i) => { c.parentElement = parent; c.previousElementSibling = children[i - 1] ?? null; c.nextElementSibling = children[i + 1] ?? null; });
  };
  link(editor, [rootList]);
  // Before Tab: A (dim) and C (focused) are siblings under the root list.
  link(rootList, [itemA, itemC]);
  link(itemA, [markerA, paraA, listA]);
  link(listA, [itemB]);
  link(itemB, [markerB, paraB]);
  link(itemC, [markerC, paraC]);
  const painter = createBlockPainter();
  const el = (element: PaintElement) => element as unknown as HTMLElement;

  painter.prepare(new Map([[el(paraC), 1], [el(itemA), RIPPLE_LEVELS[1]]]), el(editor), false)();
  settleBlocks(now => painter.step(now, false), 0);
  assertAlpha(carrierAlpha(itemA), RIPPLE_LEVELS[1]);
  // B is deep: its dim comes from A's owner across two levels.
  assert.equal(carrierAlpha(itemB), null);

  // Tab indents C under A's list, so A now covers the focused block. B is a
  // grandchild of A and must keep the exact dim it already had.
  link(listA, [itemB, itemC]);
  link(rootList, [itemA]);
  painter.protectFocus(el(paraC));

  assert.equal(carrierAlpha(itemA), null, "the covering owner releases");
  assert.equal(carrierAlpha(paraC), null, "the focused block is never dimmed");
  assert.equal(carrierAlpha(itemC), null, "the focused item carries no block owner");
  assertAlpha(carrierAlpha(markerA), RIPPLE_LEVELS[1], "A's own marker keeps the dim");
  assertAlpha(carrierAlpha(paraA), RIPPLE_LEVELS[1], "A's own paragraph keeps the dim");
  assertAlpha(carrierAlpha(itemB), RIPPLE_LEVELS[1], "the deep sibling B keeps the dim");

  // Nothing in the covering subtree may brighten on any frame before the commit.
  const watched = [markerA, paraA, itemB];
  let previous = watched.map(carrierAlpha) as number[];
  for (let step = 1; step <= 200; step++) {
    painter.step(step * 16, false);
    const current = watched.map(carrierAlpha);
    current.forEach((alpha, index) => {
      if (alpha === null) return;
      assert.ok(alpha <= previous[index] + 1e-9, `${watched[index].dataset.nodeId} brightened: ${previous[index]} -> ${alpha}`);
      previous[index] = alpha;
    });
  }
  painter.clear();
}));

test("an owner already inside the covering subtree absorbs the removed factor", () => withPresentation(() => {
  const editor = new PaintElement();
  const focused = new PaintElement();
  const ancestor = new PaintElement();
  const label = new PaintElement();
  const nested = new PaintElement();
  const inner = new PaintElement();
  focused.dataset.nodeId = "focused"; ancestor.dataset.nodeId = "ancestor"; label.dataset.nodeId = "label";
  nested.dataset.nodeId = "nested"; inner.dataset.nodeId = "inner";
  const el = (element: PaintElement) => element as unknown as HTMLElement;
  ancestor.children = [label, nested]; label.parentElement = nested.parentElement = ancestor;
  ancestor.parentElement = editor;
  nested.children = [inner, focused]; inner.parentElement = focused.parentElement = nested;
  const painter = createBlockPainter();
  // The covering ancestor is dim, and its inner sibling is itself an owner that is
  // one level further dimmed: its local factor sits under the ancestor's factor.
  painter.prepare(new Map([[el(focused), 1], [el(ancestor), RIPPLE_LEVELS[1]], [el(inner), RIPPLE_LEVELS[2]]]), el(editor), false)();
  painter.step(0, false);
  painter.step(MOTION.blockAlphaResponseMs * 2, false);
  // label is uncovered, so the ancestor owner alone produces its dim; inner owns
  // only its residual local factor and composites under the ancestor.
  assert.equal(carrierAlpha(label), null, "label is covered by the ancestor owner");
  const ancestorLocal = carrierAlpha(ancestor)!;
  const innerLocalBefore = carrierAlpha(inner)!;
  const innerCompositeBefore = ancestorLocal * innerLocalBefore;

  // The focused block is reparented so the ancestor covers it; the ancestor owner
  // must go, and the inner owner must absorb exactly the removed factor.
  focused.parentElement = nested;
  painter.protectFocus(el(focused));
  assert.equal(carrierAlpha(ancestor), null, "the covering owner releases");
  assertAlpha(carrierAlpha(label), ancestorLocal, "the leftover content keeps the ancestor's factor");
  // inner is a sibling of the focused block, not on the focus path, so it keeps the
  // dim too: its new local value now equals the composite it was already showing.
  assertAlpha(carrierAlpha(inner), innerCompositeBefore, "inner keeps its composite");
  assert.ok(carrierAlpha(inner)! <= innerLocalBefore + 1e-9, "inner never brightens");
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

test("selection collapse reacquires fresh authority before immediate structural Backspace", () => withSessionHarness(harness => {
  harness.tick(0);
  harness.dispatch(2, "keydown", { key: "Tab", defaultPrevented: false });

  harness.setSelection("range");
  harness.setFrame({ ...harness.getFrame(), selection: "range", range: null, caret: null });
  harness.dispatch(4, "selectionchange");
  harness.tick(16);

  harness.editable.dataset.nodeId = "source-block";
  harness.setSelection("caret");
  harness.setFrame({ ...harness.getFrame(), selection: "caret", range: textRange(harness.editable, "abcdef", 0),
    caret: { x: 100, y: 220, height: 20 }, block: harness.editable as unknown as HTMLElement, caretless: false });
  harness.dispatch(20, "selectionchange");
  harness.dispatch(21, "keydown", { key: "Backspace", defaultPrevented: false });

  const survivor = new PaintElement();
  survivor.dataset.nodeId = "survivor-block";
  const removed = new PaintElement();
  removed.dataset.nodeId = "source-block";
  harness.mutate(22, [{ type: "childList", target: harness.editor,
    addedNodes: [survivor], removedNodes: [removed] } as unknown as MutationRecord]);
  harness.setFrame({ ...harness.getFrame(), caret: { x: 260, y: 420, height: 20 },
    block: survivor as unknown as HTMLElement });
  harness.tick(38);
  harness.tick(54);

  const geometry = harness.events.find(event => event.name === "structure-geometry-ready");
  assert.ok(harness.events.some(event => event.name === "structure-cancel" && event.payload.reason === "selection"));
  assert.ok(geometry);
  assert.ok(harness.events.some(event => event.name === "structure-intent" &&
    event.payload.fromBlockKey === "source-block"));
  assert.equal(geometry.payload.fromBlockKey, "source-block");
  assert.equal(geometry.payload.toBlockKey, "survivor-block");
  assert.equal(geometry.payload.topologyChanged, true);
  assert.equal(harness.events.filter(event => event.name === "structure-geometry-ready").length, 1);
  harness.tick(70);
  assert.ok(harness.events.some(event => event.name === "structure-commit"));
}, { typewriter: false, ripple: false }));
