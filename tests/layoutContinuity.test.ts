import assert from "node:assert/strict";
import test from "node:test";
import { createLayoutContinuity } from "../src/modules/layoutContinuity";

class FakeClassList {
  private values = new Set<string>();
  add(value: string) { this.values.add(value); }
  remove(value: string) { this.values.delete(value); }
  contains(value: string) { return this.values.has(value); }
}

class FakeElement {
  dataset: Record<string, string> = {};
  classList = new FakeClassList();
  parentElement: FakeElement | null = null;
  nextElementSibling: FakeElement | null = null;
  children: FakeElement[] = [];
  isConnected = true;
  style = { transform: "", computedTransform: "none" };
  rect = { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };

  getBoundingClientRect() {
    let dx = 0, dy = 0;
    const match = this.style.transform.match(/^translate\((-?[\d.]+)px, (-?[\d.]+)px\)$/);
    if (match) { dx = Number(match[1]); dy = Number(match[2]); }
    return { ...this.rect,
      x: this.rect.left + dx, y: this.rect.top + dy,
      left: this.rect.left + dx, right: this.rect.right + dx,
      top: this.rect.top + dy, bottom: this.rect.bottom + dy };
  }

  contains(other: unknown): boolean {
    if (other === this) return true;
    return this.children.some(child => child.contains(other));
  }

  closest<T = FakeElement>(selector: string): T | null {
    for (let node: FakeElement | null = this; node; node = node.parentElement) {
      if (selector === '[data-type="NodeListItem"]' && node.dataset.type === "NodeListItem") return node as unknown as T;
    }
    return null;
  }
}

Object.assign(globalThis, {
  HTMLElement: FakeElement,
  getComputedStyle: (element: FakeElement) => ({ transform: element.style.computedTransform }),
});

function element(key: string, top: number, type?: string) {
  const value = new FakeElement();
  value.dataset.nodeId = key;
  if (type) value.dataset.type = type;
  value.rect = { left: 0, top, right: 100, bottom: top + 20, width: 100, height: 20 };
  return value;
}

function append(parent: FakeElement, ...children: FakeElement[]) {
  parent.children = children;
  children.forEach((child, index) => {
    child.parentElement = parent;
    child.nextElementSibling = children[index + 1] ?? null;
  });
}

function moveY(node: FakeElement, delta: number) {
  node.rect = { ...node.rect, top: node.rect.top + delta, bottom: node.rect.bottom + delta };
}

test("viewport-bounded impact path is not a fixed 24-sibling window", () => {
  const editor = element("editor", 0);
  const anchor = element("anchor", 0);
  const following = Array.from({ length: 30 }, (_, index) => element(`s${index}`, 20 + index * 12));
  append(editor, anchor, ...following);
  const motion = createLayoutContinuity();
  motion.capture(1, "enter", anchor as unknown as HTMLElement, editor as unknown as HTMLElement,
    { top: 0, bottom: 500 }, 0, null);
  following.forEach(node => moveY(node, 18));
  assert.equal(motion.attach(1, 4, false, [], anchor as unknown as HTMLElement), true);
  assert.equal(following[29].style.transform, "translate(0px, -18px)");
});

test("nested impact propagates to following siblings on ancestor planes", () => {
  const editor = element("editor", 0);
  const outer = element("outer", 0, "NodeListItem");
  const outerAfter = element("outer-after", 120, "NodeListItem");
  const focus = element("focus", 20);
  const innerAfter = element("inner-after", 50);
  append(outer, focus, innerAfter);
  append(editor, outer, outerAfter);

  const motion = createLayoutContinuity();
  motion.capture(1, "enter", focus as unknown as HTMLElement, editor as unknown as HTMLElement,
    { top: 0, bottom: 400 }, 0, null);
  moveY(innerAfter, 24);
  moveY(outerAfter, 24);
  motion.attach(1, 4, false, [], focus as unknown as HTMLElement);
  assert.equal(innerAfter.style.transform, "translate(0px, -24px)");
  assert.equal(outerAfter.style.transform, "translate(0px, -24px)");
});

test("Enter may carry a new focused block from the old caret origin", () => {
  const editor = element("editor", 0);
  const anchor = element("anchor", 0);
  append(editor, anchor);
  const motion = createLayoutContinuity();
  motion.capture(1, "enter", anchor as unknown as HTMLElement, editor as unknown as HTMLElement,
    { top: 0, bottom: 400 }, 0, { x: 42, y: 10 });

  const continuation = element("new-block", 40);
  continuation.rect.left = 4;
  continuation.rect.right = 104;
  append(editor, anchor, continuation);
  assert.equal(motion.attach(1, 4, false, [continuation as unknown as HTMLElement],
    continuation as unknown as HTMLElement), true);
  assert.equal(continuation.style.transform, "translate(38px, -30px)");

  const before = continuation.style.transform;
  motion.step(20, false);
  assert.notEqual(continuation.style.transform, before, "first Session frame must advance instead of holding for a zero frame");
});

test("same-key replacement rebases a running state instead of dropping it", () => {
  const editor = element("editor", 0);
  const anchor = element("anchor", 0);
  const survivor = element("survivor", 40);
  append(editor, anchor, survivor);
  const motion = createLayoutContinuity();
  motion.capture(1, "enter", anchor as unknown as HTMLElement, editor as unknown as HTMLElement,
    { top: 0, bottom: 400 }, 0, null);
  moveY(survivor, 30);
  motion.attach(1, 4, false, [], anchor as unknown as HTMLElement);
  motion.step(20, false);
  const running = survivor.style.transform;
  assert.notEqual(running, "");

  // Capture the next edit while the survivor is still being presented.
  motion.capture(2, "enter", anchor as unknown as HTMLElement, editor as unknown as HTMLElement,
    { top: 0, bottom: 400 }, 24, null);
  const replacement = element("survivor", survivor.rect.top + 20);
  survivor.isConnected = false;
  append(editor, anchor, replacement);
  motion.attach(2, 28, false, [replacement as unknown as HTMLElement], anchor as unknown as HTMLElement);
  assert.notEqual(replacement.style.transform, "", "replacement must inherit/rebase the running presentation");
  assert.equal(survivor.style.transform, "", "old actuator must be released");
});
