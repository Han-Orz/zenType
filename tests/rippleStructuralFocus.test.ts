import assert from "node:assert/strict";
import test from "node:test";
import { RIPPLE_LEVELS } from "../src/config";
import { BLOCK_ALPHA_CARRIER_MS, createBlockPainter } from "../src/modules/ripple/blockPainter";

interface AnimationStub {
  id: string;
  frames: Keyframe[];
  currentTime: number;
  playState: string;
  cancel(): void;
  pause(): void;
}

class TestElement {
  parentElement: TestElement | null = null;
  children: TestElement[] = [];
  dataset: Record<string, string> = {};
  isConnected = true;
  animations: AnimationStub[] = [];
  private readonly classes = new Set<string>();
  style: Record<string, string> = { opacity: "" };
  classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
  };

  contains(element: TestElement | null): boolean {
    return !!element && (element === this || this.contains(element.parentElement));
  }

  animate(frames: Keyframe[]): AnimationStub {
    const animation: AnimationStub = {
      id: "", frames, currentTime: 0, playState: "running",
      cancel() { this.playState = "idle"; },
      pause() { this.playState = "paused"; },
    };
    this.animations.push(animation);
    return animation;
  }
}

function link(parent: TestElement, children: TestElement[]) {
  parent.children = children;
  for (const child of children) parent === child ? null : child.parentElement = parent;
}

function alpha(element: TestElement): number | null {
  const animation = element.animations.at(-1);
  if (!animation || animation.playState === "idle") return null;
  return Number(animation.frames[0].opacity) * (1 - animation.currentTime / BLOCK_ALPHA_CARRIER_MS);
}

function withDom(run: () => void) {
  const values: Record<string, unknown> = {
    HTMLElement: TestElement,
    Element: TestElement,
    getComputedStyle: (element: TestElement) => ({ opacity: element.style.opacity || "1" }),
  };
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  try { run(); } finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("indent preserves the old parent's dim while the focused item's marker stays neutral", () => withDom(() => {
  const editor = new TestElement();
  const parentItem = new TestElement();
  const parentMarker = new TestElement();
  const parentContent = new TestElement();
  const nestedList = new TestElement();
  const focusedItem = new TestElement();
  const focusedMarker = new TestElement();
  const focusedContent = new TestElement();

  parentItem.dataset.nodeId = "parent";
  parentItem.dataset.type = "NodeListItem";
  parentContent.dataset.nodeId = "parent-content";
  parentContent.dataset.type = "NodeParagraph";
  nestedList.dataset.nodeId = "nested-list";
  nestedList.dataset.type = "NodeList";
  focusedItem.dataset.nodeId = "focused-item";
  focusedItem.dataset.type = "NodeListItem";
  focusedContent.dataset.nodeId = "focused-content";
  focusedContent.dataset.type = "NodeParagraph";
  parentMarker.classList.add("protyle-action");
  focusedMarker.classList.add("protyle-action");

  // Before Tab the dim parent and the focused item are independent siblings.
  link(editor, [parentItem, focusedItem]);
  link(parentItem, [parentMarker, parentContent, nestedList]);
  link(focusedItem, [focusedMarker, focusedContent]);

  const painter = createBlockPainter();
  const el = (element: TestElement) => element as unknown as HTMLElement;
  painter.prepare(new Map([
    [el(focusedContent), 1],
    [el(parentItem), RIPPLE_LEVELS[1]],
  ]), el(editor), true)();
  assert.equal(alpha(parentItem), RIPPLE_LEVELS[1]);
  assert.equal(alpha(parentMarker), null);
  assert.equal(alpha(focusedMarker), null);

  // Host Tab reparents the entire focused item below the old dim parent.
  link(editor, [parentItem]);
  link(nestedList, [focusedItem]);
  painter.protectFocus(el(focusedContent));

  // The parent's own chrome/content keeps exactly the old presentation.
  assert.equal(alpha(parentItem), null);
  assert.equal(alpha(parentMarker), RIPPLE_LEVELS[1]);
  assert.equal(alpha(parentContent), RIPPLE_LEVELS[1]);

  // The moved focus branch was never covered before the reparent. Its own marker,
  // content and item therefore must not inherit the stale ancestor's dim factor.
  assert.equal(alpha(focusedItem), null);
  assert.equal(alpha(focusedMarker), null);
  assert.equal(alpha(focusedContent), null);
  painter.clear();
}));
