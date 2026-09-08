import assert from "node:assert/strict";
import test from "node:test";
import { approach } from "../src/motion";
import { createTypewriter } from "../src/modules/typewriter";
import { createCursor } from "../src/modules/cursor";
import { mapUnchangedBoundaries } from "../src/modules/ripple/textProjection";
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
    assert.equal(overlay.style.transform, "translate3d(100px,170px,0)");
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
