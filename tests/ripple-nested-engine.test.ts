import assert from "node:assert/strict";
import test from "node:test";
import { RIPPLE_CONFIG } from "../src/config";
import { createNestedRippleEngine } from "../src/modules/ripple/nestedEngine";

const OPACITY_PROPERTY = "--zt-ripple-opacity";
const RIPPLE_CLASS = "zentype-ripple-block";

interface ReadStats {
  attributeReads: number;
}

class FakeStyle {
  private readonly values = new Map<string, string>();
  setPropertyCount = 0;

  getPropertyValue(property: string): string {
    return this.values.get(property) ?? "";
  }

  getPropertyPriority(): string {
    return "";
  }

  setProperty(property: string, value: string): void {
    this.setPropertyCount++;
    if (value === "") this.values.delete(property);
    else this.values.set(property, value);
  }
}

class FakeClassList {
  private readonly names: Set<string>;

  constructor(names: readonly string[] = []) {
    this.names = new Set(names);
  }

  contains(name: string): boolean {
    return this.names.has(name);
  }

  add(name: string): void {
    this.names.add(name);
  }

  remove(name: string): void {
    this.names.delete(name);
  }
}

interface FakeElementOptions {
  classes?: readonly string[];
  dataNodeId?: string;
  dataType?: string;
  tagName?: string;
}

class FakeElement {
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  readonly classList: FakeClassList;
  readonly style = new FakeStyle();
  readonly tagName: string;

  constructor(
    private readonly stats: ReadStats,
    options: FakeElementOptions = {},
  ) {
    this.classList = new FakeClassList(options.classes);
    this.tagName = options.tagName ?? "DIV";
    this.attributes = new Map<string, string>();
    if (options.dataNodeId !== undefined) this.attributes.set("data-node-id", options.dataNodeId);
    if (options.dataType !== undefined) this.attributes.set("data-type", options.dataType);
  }

  private readonly attributes: Map<string, string>;

  getAttribute(name: string): string | null {
    this.stats.attributeReads++;
    return this.attributes.get(name) ?? null;
  }

  contains(node: Node): boolean {
    let current = node as unknown as FakeElement | null;
    while (current) {
      if (current === this) return true;
      current = current.parentElement;
    }
    return false;
  }
}

interface NestedFixture {
  wysiwyg: FakeElement;
  itemA: FakeElement;
  itemB: FakeElement;
  itemB1: FakeElement;
  itemB2: FakeElement;
  focusB1: FakeElement;
  focusB2: FakeElement;
  childList: FakeElement;
}

function element(stats: ReadStats, options: FakeElementOptions = {}): FakeElement {
  return new FakeElement(stats, options);
}

function append(parent: FakeElement, ...children: FakeElement[]): void {
  for (const child of children) {
    child.parentElement = parent;
    parent.children.push(child);
  }
}

function list(stats: ReadStats): FakeElement {
  return element(stats, { dataType: "NodeList" });
}

function content(stats: ReadStats, id: string): FakeElement {
  return element(stats, { dataType: "NodeParagraph", dataNodeId: id });
}

function action(stats: ReadStats): FakeElement {
  const marker = element(stats, { classes: ["protyle-action"] });
  append(marker, element(stats, { tagName: "svg" }), element(stats, { tagName: "use" }));
  return marker;
}

function item(
  stats: ReadStats,
  id: string,
): { item: FakeElement; focus: FakeElement } {
  const itemElement = element(stats, { dataType: "NodeListItem", dataNodeId: `item:${id}` });
  const itemContent = content(stats, `block:${id}`);
  append(itemElement, action(stats), itemContent, element(stats, { classes: ["protyle-attr"] }));
  return { item: itemElement, focus: itemContent };
}

function buildFixture(stats: ReadStats): NestedFixture {
  const wysiwyg = element(stats);
  const rootList = list(stats);
  const a = item(stats, "A");
  const b = item(stats, "B");
  const b1 = item(stats, "B.1");
  const b2 = item(stats, "B.2");
  const childList = list(stats);

  append(childList, b1.item, b2.item);
  append(b.item, childList);
  append(rootList, a.item, b.item);
  append(wysiwyg, rootList);

  return {
    wysiwyg,
    itemA: a.item,
    itemB: b.item,
    itemB1: b1.item,
    itemB2: b2.item,
    focusB1: b1.focus,
    focusB2: b2.focus,
    childList,
  };
}

function asHTMLElement(elementToCast: FakeElement): HTMLElement {
  return elementToCast as unknown as HTMLElement;
}

function opacity(elementToRead: FakeElement): string {
  return elementToRead.style.getPropertyValue(OPACITY_PROPERTY);
}

test("applies nested plan through adapter, planner, and style applier", () => {
  const fixture = buildFixture({ attributeReads: 0 });
  const engine = createNestedRippleEngine();

  assert.equal(
    engine.apply(asHTMLElement(fixture.wysiwyg), asHTMLElement(fixture.focusB1)),
    true,
  );
  assert.equal(opacity(fixture.itemB1.children[1]), "1");
  assert.equal(opacity(fixture.itemB.children[1]), String(RIPPLE_CONFIG.BLOCK_LEVELS[1]));
  assert.equal(opacity(fixture.itemB2), String(RIPPLE_CONFIG.BLOCK_LEVELS[1]));
  assert.equal(fixture.itemB2.classList.contains(RIPPLE_CLASS), true);
});

test("reuses a snapshot for the same root and focus without style writes", () => {
  const stats = { attributeReads: 0 };
  const fixture = buildFixture(stats);
  const engine = createNestedRippleEngine();
  const wysiwyg = asHTMLElement(fixture.wysiwyg);
  const focus = asHTMLElement(fixture.focusB1);

  assert.equal(engine.apply(wysiwyg, focus), true);
  const readsAfterBuild = stats.attributeReads;
  fixture.itemB1.children[1].style.setPropertyCount = 0;
  fixture.itemB.children[1].style.setPropertyCount = 0;
  fixture.itemB2.style.setPropertyCount = 0;
  engine.apply(wysiwyg, focus);

  assert.equal(stats.attributeReads, readsAfterBuild);
  assert.equal(fixture.itemB1.children[1].style.setPropertyCount, 0);
  assert.equal(fixture.itemB.children[1].style.setPropertyCount, 0);
  assert.equal(fixture.itemB2.style.setPropertyCount, 0);
});

test("invalidateStructure forces a fresh snapshot after a DOM structure change", () => {
  const stats = { attributeReads: 0 };
  const fixture = buildFixture(stats);
  const engine = createNestedRippleEngine();
  const wysiwyg = asHTMLElement(fixture.wysiwyg);
  const focus = asHTMLElement(fixture.focusB1);

  assert.equal(engine.apply(wysiwyg, focus), true);
  const readsBeforeChange = stats.attributeReads;
  const b3 = item(stats, "B.3");
  append(fixture.childList, b3.item);

  engine.invalidateStructure();
  assert.equal(engine.apply(wysiwyg, focus), true);

  assert.equal(stats.attributeReads > readsBeforeChange, true);
  assert.equal(opacity(b3.item), String(RIPPLE_CONFIG.BLOCK_LEVELS[2]));
  assert.equal(b3.item.classList.contains(RIPPLE_CLASS), true);
});

test("focus and root identity changes rebuild and release old target styles", () => {
  const stats = { attributeReads: 0 };
  const fixture = buildFixture(stats);
  const engine = createNestedRippleEngine();
  const wysiwyg = asHTMLElement(fixture.wysiwyg);

  assert.equal(engine.apply(wysiwyg, asHTMLElement(fixture.focusB1)), true);
  assert.equal(engine.apply(wysiwyg, asHTMLElement(fixture.focusB2)), true);
  assert.equal(opacity(fixture.itemB2.children[1]), "1");
  assert.equal(opacity(fixture.itemB1.children[1]), "");
  assert.equal(fixture.itemB1.classList.contains(RIPPLE_CLASS), true);

  const otherStats = { attributeReads: 0 };
  const other = buildFixture(otherStats);
  assert.equal(
    engine.apply(asHTMLElement(other.wysiwyg), asHTMLElement(other.focusB1)),
    true,
  );
  assert.equal(opacity(fixture.itemB2.children[1]), "");
  assert.equal(fixture.itemB1.classList.contains(RIPPLE_CLASS), false);
  assert.equal(fixture.itemB2.classList.contains(RIPPLE_CLASS), false);
});

test("non-list focus falls back with clear semantics and clear is idempotent", () => {
  const stats = { attributeReads: 0 };
  const fixture = buildFixture(stats);
  const paragraph = content(stats, "top-level");
  append(fixture.wysiwyg, paragraph);
  const engine = createNestedRippleEngine();
  const wysiwyg = asHTMLElement(fixture.wysiwyg);

  assert.equal(engine.apply(wysiwyg, asHTMLElement(fixture.focusB1)), true);
  assert.equal(engine.apply(wysiwyg, asHTMLElement(paragraph)), false);
  assert.equal(opacity(fixture.itemB1.children[1]), "");
  assert.equal(fixture.itemB1.classList.contains(RIPPLE_CLASS), false);

  engine.clear();
  engine.clear();
  assert.equal(opacity(fixture.itemB.children[1]), "");
  assert.equal(fixture.itemB2.classList.contains(RIPPLE_CLASS), false);
});
