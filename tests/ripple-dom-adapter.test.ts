import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRippleDomSnapshot,
  type RippleDomSnapshot,
} from "../src/modules/ripple/domAdapter";
import {
  planRippleTargets,
  type RippleTarget,
  type RippleTargetPlan,
  type RippleTargetRole,
} from "../src/modules/ripple/semanticPlanner";

interface FakeElementOptions {
  classes?: readonly string[];
  dataNodeId?: string;
  dataType?: string;
  tagName?: string;
}

class FakeClassList {
  private readonly names: Set<string>;

  constructor(
    names: readonly string[],
    private readonly onMutation: () => void,
  ) {
    this.names = new Set(names);
  }

  contains(name: string): boolean {
    return this.names.has(name);
  }

  add(): void {
    this.onMutation();
    throw new Error("adapter must not mutate classList");
  }

  remove(): void {
    this.onMutation();
    throw new Error("adapter must not mutate classList");
  }
}

class FakeElement {
  readonly nodeType = 1;
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  readonly classList: FakeClassList;
  readonly tagName: string;
  mutationCount = 0;
  private readonly attributes = new Map<string, string>();

  constructor(options: FakeElementOptions = {}) {
    this.classList = new FakeClassList(options.classes ?? [], () => {
      this.mutationCount++;
    });
    this.tagName = options.tagName ?? "DIV";
    if (options.dataType !== undefined) this.attributes.set("data-type", options.dataType);
    if (options.dataNodeId !== undefined) this.attributes.set("data-node-id", options.dataNodeId);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(): void {
    this.mutate();
  }

  removeAttribute(): void {
    this.mutate();
  }

  appendChild(): void {
    this.mutate();
  }

  removeChild(): void {
    this.mutate();
  }

  replaceChild(): void {
    this.mutate();
  }

  insertBefore(): void {
    this.mutate();
  }

  focus(): void {
    this.mutate();
  }

  private mutate(): never {
    this.mutationCount++;
    throw new Error("adapter must be read-only");
  }
}

function element(options: FakeElementOptions = {}): FakeElement {
  return new FakeElement(options);
}

function append(parent: FakeElement, ...children: FakeElement[]): void {
  for (const child of children) {
    child.parentElement = parent;
    parent.children.push(child);
  }
}

function asHTMLElement(element: FakeElement): HTMLElement {
  return element as unknown as HTMLElement;
}

function list(): FakeElement {
  return element({ dataType: "NodeList" });
}

function content(dataType = "NodeParagraph", dataNodeId = dataType): FakeElement {
  return element({ dataType, dataNodeId });
}

function attr(): FakeElement {
  return element({ classes: ["protyle-attr"] });
}

function action(): FakeElement {
  const marker = element({ classes: ["protyle-action"] });
  append(marker, element({ tagName: "svg" }), element({ tagName: "use" }));
  return marker;
}

function item(
  id: string,
  itemChildren: FakeElement[] = [action(), content("NodeParagraph", `block:${id}`), attr()],
): FakeElement {
  const itemElement = element({ dataType: "NodeListItem", dataNodeId: `item:${id}` });
  append(itemElement, ...itemChildren);
  return itemElement;
}

function boundId(snapshot: RippleDomSnapshot, elementToFind: FakeElement): string {
  const entry = [...snapshot.bindings.entries()].find(([, element]) =>
    element === asHTMLElement(elementToFind));
  assert.ok(entry, `expected binding for ${elementToFind.getAttribute("data-node-id") ?? "element"}`);
  return entry[0];
}

function hasBinding(snapshot: RippleDomSnapshot, elementToFind: FakeElement): boolean {
  return [...snapshot.bindings.values()].some((boundElement) =>
    boundElement === asHTMLElement(elementToFind));
}

function itemId(snapshot: RippleDomSnapshot, itemElement: FakeElement): string {
  const id = boundId(snapshot, itemElement);
  assert.equal(snapshot.tree.items.has(id), true);
  return id;
}

function listForParent(snapshot: RippleDomSnapshot, parentItemId: string | null) {
  const entry = [...snapshot.tree.lists.values()].find((candidate) =>
    candidate.parentItemId === parentItemId);
  assert.ok(entry);
  return entry;
}

function assertTarget(
  plan: RippleTargetPlan,
  semanticId: string,
  role: RippleTargetRole,
  distance: number,
): void {
  assert.deepEqual(
    plan.targets.filter((target) => target.semanticId === semanticId),
    [{ semanticId, role, distance } satisfies RippleTarget],
  );
}

function assertElementTarget(
  snapshot: RippleDomSnapshot,
  plan: RippleTargetPlan,
  elementToFind: FakeElement,
  role: RippleTargetRole,
  distance: number,
): void {
  assertTarget(plan, boundId(snapshot, elementToFind), role, distance);
}

function assertNoElementTarget(
  snapshot: RippleDomSnapshot,
  plan: RippleTargetPlan,
  elementToFind: FakeElement,
): void {
  assert.equal(
    plan.targets.some((target) => target.semanticId === boundId(snapshot, elementToFind)),
    false,
  );
}

function allElements(...roots: FakeElement[]): FakeElement[] {
  const result: FakeElement[] = [];
  const visit = (current: FakeElement) => {
    result.push(current);
    current.children.forEach(visit);
  };
  roots.forEach(visit);
  return result;
}

test("canonical nested DOM builds the semantic tree and preserves planner distances", () => {
  const wysiwyg = element();
  const rootList = list();
  const itemA = item("A");
  const itemB = item("B");
  const itemA1 = item("A.1");
  const itemA2 = item("A.2");
  const itemB1 = item("B.1");
  const itemB2 = item("B.2");
  const itemB3 = item("B.3");
  const itemB1a = item("B.1.a");
  const focusCarrier = element();
  const focusContent = itemB1a.children[1];

  append(focusContent, focusCarrier);
  append(rootList, itemA, itemB);
  append(wysiwyg, rootList);
  const listA = list();
  const listB = list();
  const listB1 = list();
  append(itemA, listA);
  append(listA, itemA1, itemA2);
  append(itemB, listB);
  append(listB, itemB1, itemB2, itemB3);
  append(itemB1, listB1);
  append(listB1, itemB1a);

  const snapshot = buildRippleDomSnapshot(asHTMLElement(wysiwyg), asHTMLElement(focusCarrier));
  assert.ok(snapshot);
  assert.equal(snapshot.tree.lists.size, 4);
  assert.equal(snapshot.tree.items.size, 8);

  const idA = itemId(snapshot, itemA);
  const idB = itemId(snapshot, itemB);
  const idB1 = itemId(snapshot, itemB1);
  const idB1a = itemId(snapshot, itemB1a);
  assert.equal(snapshot.focusItemId, idB1a);
  assert.deepEqual(listForParent(snapshot, null).itemIds, [idA, idB]);
  assert.equal(listForParent(snapshot, idB).itemIds[0], idB1);
  assert.equal(listForParent(snapshot, idB1).itemIds[0], idB1a);
  assert.equal(snapshot.tree.items.get(idB1a)?.parentListId, listForParent(snapshot, idB1).id);

  const plan = planRippleTargets(snapshot.tree, snapshot.focusItemId);
  assert.ok(plan);
  assertElementTarget(snapshot, plan, itemB1a.children[0], "marker", 0);
  assertElementTarget(snapshot, plan, focusContent, "direct-content", 0);
  assertElementTarget(snapshot, plan, itemB1.children[0], "marker", 1);
  assertElementTarget(snapshot, plan, itemB1.children[1], "direct-content", 1);
  assertElementTarget(snapshot, plan, itemB.children[0], "marker", 2);
  assertElementTarget(snapshot, plan, itemB.children[1], "direct-content", 2);
  assertElementTarget(snapshot, plan, itemB2, "branch-root", 2);
  assertElementTarget(snapshot, plan, itemB3, "branch-root", 3);
  assertElementTarget(snapshot, plan, itemA, "branch-root", 3);

  for (const branchDescendant of [itemA1, itemA2]) {
    assertNoElementTarget(snapshot, plan, branchDescendant);
    assertNoElementTarget(snapshot, plan, branchDescendant.children[0]);
    assertNoElementTarget(snapshot, plan, branchDescendant.children[1]);
  }
  assert.equal(plan.targets.some((target) => target.semanticId === idB), false);
  assert.equal(plan.targets.some((target) => target.semanticId === idB1), false);
});

test("marker binding excludes nested SVG/use descendants", () => {
  const wysiwyg = element();
  const rootList = list();
  const listItem = item("marker");
  append(rootList, listItem);
  append(wysiwyg, rootList);

  const snapshot = buildRippleDomSnapshot(asHTMLElement(wysiwyg), asHTMLElement(listItem));
  assert.ok(snapshot);
  const markerId = boundId(snapshot, listItem.children[0]);
  assert.equal(snapshot.bindings.get(markerId), asHTMLElement(listItem.children[0]));
  assert.equal(hasBinding(snapshot, listItem.children[0].children[0]), false);
  assert.equal(hasBinding(snapshot, listItem.children[0].children[1]), false);
});

test("direct block children become content while attr, wrappers, and SVG stay neutral", () => {
  const wysiwyg = element();
  const rootList = list();
  const wrapper = element({ dataNodeId: undefined });
  const paragraph = content("NodeParagraph", "paragraph");
  const heading = content("NodeHeading", "heading");
  const listItem = item("content", [action(), paragraph, heading, attr(), wrapper]);
  append(rootList, listItem);
  append(wysiwyg, rootList);

  const snapshot = buildRippleDomSnapshot(asHTMLElement(wysiwyg), asHTMLElement(paragraph));
  assert.ok(snapshot);
  const semanticItem = snapshot.tree.items.get(snapshot.focusItemId);
  assert.ok(semanticItem);
  assert.equal(semanticItem.directContentIds.length, 2);
  assert.equal(semanticItem.directContentIds.includes(boundId(snapshot, paragraph)), true);
  assert.equal(semanticItem.directContentIds.includes(boundId(snapshot, heading)), true);
  assert.equal(hasBinding(snapshot, listItem.children[3]), false);
  assert.equal(hasBinding(snapshot, wrapper), false);
});

test("multiple child lists are represented structurally without list bindings", () => {
  const wysiwyg = element();
  const rootList = list();
  const owner = item("owner", [action(), attr()]);
  const childListA = list();
  const childListB = list();
  const childA = item("child-a");
  const childB = item("child-b");
  append(owner, childListA, childListB);
  append(childListA, childA);
  append(childListB, childB);
  append(rootList, owner);
  append(wysiwyg, rootList);

  const snapshot = buildRippleDomSnapshot(asHTMLElement(wysiwyg), asHTMLElement(childB));
  assert.ok(snapshot);
  assert.equal(snapshot.tree.lists.size, 3);
  assert.equal(snapshot.tree.items.size, 3);
  const ownerId = itemId(snapshot, owner);
  const childListRecords = [...snapshot.tree.lists.values()].filter((candidate) =>
    candidate.parentItemId === ownerId);
  assert.deepEqual(childListRecords.map((candidate) => candidate.itemIds.length), [1, 1]);
  assert.equal(hasBinding(snapshot, childListA), false);
  assert.equal(hasBinding(snapshot, childListB), false);
});

test("deep carrier focus resolves to its owning list item", () => {
  const wysiwyg = element();
  const rootList = list();
  const listItem = item("carrier");
  const paragraph = listItem.children[1];
  const carrier = element();
  const nestedCarrier = element();
  append(paragraph, carrier);
  append(carrier, nestedCarrier);
  append(rootList, listItem);
  append(wysiwyg, rootList);

  const snapshot = buildRippleDomSnapshot(asHTMLElement(wysiwyg), asHTMLElement(nestedCarrier));
  assert.ok(snapshot);
  assert.equal(snapshot.focusItemId, itemId(snapshot, listItem));
  assert.equal(snapshot.tree.items.get(snapshot.focusItemId)?.directContentIds.length, 1);
  assert.equal(snapshot.bindings.get(boundId(snapshot, paragraph)), asHTMLElement(paragraph));
});

test("empty item without a marker remains a valid empty semantic item", () => {
  const wysiwyg = element();
  const rootList = list();
  const emptyItem = item("empty", [attr()]);
  append(rootList, emptyItem);
  append(wysiwyg, rootList);

  const snapshot = buildRippleDomSnapshot(asHTMLElement(wysiwyg), asHTMLElement(emptyItem));
  assert.ok(snapshot);
  const semanticItem = snapshot.tree.items.get(snapshot.focusItemId);
  assert.ok(semanticItem);
  assert.equal(semanticItem.markerId, null);
  assert.deepEqual(semanticItem.directContentIds, []);
});

test("explicit WYSIWYG root isolates multiple Protyles and rejects outside focus", () => {
  const wysiwygA = element();
  const listA = list();
  const itemA = item("A");
  append(listA, itemA);
  append(wysiwygA, listA);

  const wysiwygB = element();
  const listB = list();
  const itemB = item("B");
  append(listB, itemB);
  append(wysiwygB, listB);

  const snapshot = buildRippleDomSnapshot(asHTMLElement(wysiwygB), asHTMLElement(itemB));
  assert.ok(snapshot);
  assert.equal(snapshot.tree.items.has(itemId(snapshot, itemB)), true);
  assert.equal(hasBinding(snapshot, itemA), false);
  assert.equal(buildRippleDomSnapshot(asHTMLElement(wysiwygA), asHTMLElement(itemB)), null);
});

test("focus in a non-list top-level paragraph is not applicable to the adapter", () => {
  const wysiwyg = element();
  const paragraph = content("NodeParagraph", "top-level");
  append(wysiwyg, paragraph);

  assert.equal(
    buildRippleDomSnapshot(asHTMLElement(wysiwyg), asHTMLElement(paragraph)),
    null,
  );
});

test("adapter performs no DOM mutations while classifying structural noise", () => {
  const wysiwyg = element();
  const rootList = list();
  const listItem = item("readonly", [
    action(),
    attr(),
    element(),
    element({ tagName: "svg", dataNodeId: "not-content" }),
    element({ tagName: "use", dataNodeId: "not-content" }),
  ]);
  append(rootList, listItem);
  append(wysiwyg, rootList);
  const nodes = allElements(wysiwyg);

  const snapshot = buildRippleDomSnapshot(asHTMLElement(wysiwyg), asHTMLElement(listItem));
  assert.ok(snapshot);
  assert.equal(hasBinding(snapshot, listItem.children[3]), false);
  assert.equal(hasBinding(snapshot, listItem.children[4]), false);
  assert.equal(nodes.reduce((count, node) => count + node.mutationCount, 0), 0);
});
