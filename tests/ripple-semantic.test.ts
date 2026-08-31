import assert from "node:assert/strict";
import test from "node:test";
import {
  createRippleSemanticTree,
  type RippleSemanticTree,
  type SemanticItem,
  type SemanticList,
} from "../src/modules/ripple/semanticModel";
import {
  planRippleTargets,
  type RippleTarget,
  type RippleTargetPlan,
  type RippleTargetRole,
} from "../src/modules/ripple/semanticPlanner";

interface ItemOptions {
  markerId?: string | null;
  directContentIds?: readonly string[];
  childListIds?: readonly string[];
}

function item(
  id: string,
  parentListId: string,
  siblingIndex: number,
  options: ItemOptions = {},
): SemanticItem {
  return {
    id,
    parentListId,
    siblingIndex,
    markerId: options.markerId === undefined ? `marker:${id}` : options.markerId,
    directContentIds: options.directContentIds ?? [`content:${id}`],
    childListIds: options.childListIds ?? [],
  };
}

function list(
  id: string,
  parentItemId: string | null,
  itemIds: readonly string[],
): SemanticList {
  return { id, parentItemId, itemIds };
}

function tree(lists: readonly SemanticList[], items: readonly SemanticItem[]): RippleSemanticTree {
  return createRippleSemanticTree(lists, items);
}

function requirePlan(input: RippleSemanticTree, focusItemId: string): RippleTargetPlan {
  const plan = planRippleTargets(input, focusItemId);
  assert.ok(plan);
  return plan;
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

function assertNoTarget(plan: RippleTargetPlan, semanticId: string): void {
  assert.equal(plan.targets.some((target) => target.semanticId === semanticId), false);
}

test("canonical nested example assigns path distances and suppresses off-path descendants", () => {
  const input = tree(
    [
      list("root", null, ["A", "B"]),
      list("list-A", "A", ["A.1", "A.2"]),
      list("list-B", "B", ["B.1", "B.2", "B.3"]),
      list("list-B.1", "B.1", ["B.1.a"]),
    ],
    [
      item("A", "root", 0, { childListIds: ["list-A"] }),
      item("A.1", "list-A", 0),
      item("A.2", "list-A", 1),
      item("B", "root", 1, { childListIds: ["list-B"] }),
      item("B.1", "list-B", 0, { childListIds: ["list-B.1"] }),
      item("B.2", "list-B", 1),
      item("B.3", "list-B", 2),
      item("B.1.a", "list-B.1", 0),
    ],
  );

  const plan = requirePlan(input, "B.1.a");
  for (const [itemId, distance] of [
    ["B.1.a", 0],
    ["B.1", 1],
    ["B", 2],
  ] as const) {
    assertTarget(plan, `marker:${itemId}`, "marker", distance);
    assertTarget(plan, `content:${itemId}`, "direct-content", distance);
  }
  assertTarget(plan, "B.2", "branch-root", 2);
  assertTarget(plan, "B.3", "branch-root", 3);
  assertTarget(plan, "A", "branch-root", 3);

  for (const itemId of ["B.1.a", "B.1", "B", "A.1", "A.2"]) {
    assertNoTarget(plan, itemId);
  }
  for (const itemId of ["A.1", "A.2", "B.2", "B.3", "A"]) {
    assertNoTarget(plan, `marker:${itemId}`);
    assertNoTarget(plan, `content:${itemId}`);
  }
  assert.equal(plan.targets.some((target) => target.role === "branch-root" && target.semanticId === "B"), false);
});

test("single-level siblings use absolute sibling index distance", () => {
  const input = tree(
    [list("root", null, ["A", "B", "C", "D"])],
    [
      item("A", "root", 0),
      item("B", "root", 1),
      item("C", "root", 2),
      item("D", "root", 3),
    ],
  );

  const plan = requirePlan(input, "B");
  assertTarget(plan, "marker:B", "marker", 0);
  assertTarget(plan, "content:B", "direct-content", 0);
  assertTarget(plan, "A", "branch-root", 1);
  assertTarget(plan, "C", "branch-root", 1);
  assertTarget(plan, "D", "branch-root", 2);
  assertNoTarget(plan, "B");
});

test("deep single chain increments distance for each ancestor", () => {
  const lists: SemanticList[] = [list("list-0", null, ["item-0"])];
  const items: SemanticItem[] = [];
  for (let index = 0; index < 6; index++) {
    const itemId = `item-${index}`;
    const childListId = `list-${index + 1}`;
    items.push(item(itemId, `list-${index}`, 0, {
      childListIds: index < 5 ? [childListId] : [],
    }));
    if (index < 5) lists.push(list(childListId, itemId, [`item-${index + 1}`]));
  }

  const plan = requirePlan(tree(lists, items), "item-5");
  for (let index = 0; index < 6; index++) {
    assertTarget(plan, `marker:item-${index}`, "marker", 5 - index);
    assertTarget(plan, `content:item-${index}`, "direct-content", 5 - index);
    assertNoTarget(plan, `item-${index}`);
  }
});

test("an off-path sibling with a subtree is emitted only as one branch root", () => {
  const input = tree(
    [
      list("root", null, ["focus", "branch"]),
      list("branch-list", "branch", ["branch-child", "branch-child-2"]),
      list("grandchild-list", "branch-child", ["branch-grandchild"]),
    ],
    [
      item("focus", "root", 0),
      item("branch", "root", 1, { childListIds: ["branch-list"] }),
      item("branch-child", "branch-list", 0, { childListIds: ["grandchild-list"] }),
      item("branch-child-2", "branch-list", 1),
      item("branch-grandchild", "grandchild-list", 0),
    ],
  );

  const plan = requirePlan(input, "focus");
  assertTarget(plan, "branch", "branch-root", 1);
  for (const semanticId of [
    "marker:branch",
    "content:branch",
    "branch-child",
    "marker:branch-child",
    "content:branch-child",
    "branch-child-2",
    "marker:branch-child-2",
    "content:branch-child-2",
    "branch-grandchild",
    "marker:branch-grandchild",
    "content:branch-grandchild",
  ]) {
    assertNoTarget(plan, semanticId);
  }
});

test("multiple direct contents share the owning item's distance", () => {
  const input = tree(
    [list("root", null, ["focus"])],
    [item("focus", "root", 0, {
      directContentIds: ["content:first", "content:second"],
    })],
  );

  const plan = requirePlan(input, "focus");
  assertTarget(plan, "content:first", "direct-content", 0);
  assertTarget(plan, "content:second", "direct-content", 0);
});

test("a null marker is omitted without affecting the rest of the plan", () => {
  const input = tree(
    [list("root", null, ["focus", "sibling"])],
    [
      item("focus", "root", 0, { markerId: null }),
      item("sibling", "root", 1),
    ],
  );

  const plan = requirePlan(input, "focus");
  assertTarget(plan, "content:focus", "direct-content", 0);
  assertTarget(plan, "sibling", "branch-root", 1);
  assert.equal(plan.targets.some((target) => target.role === "marker"), false);
});

test("large semantic distances remain unclamped and are non-negative integers", () => {
  const itemIds = ["focus", "one", "two", "three", "four", "five", "six", "seven", "eight"];
  const input = tree(
    [list("root", null, itemIds)],
    itemIds.map((id, siblingIndex) => item(id, "root", siblingIndex)),
  );

  const plan = requirePlan(input, "focus");
  assertTarget(plan, "six", "branch-root", 6);
  assertTarget(plan, "seven", "branch-root", 7);
  assertTarget(plan, "eight", "branch-root", 8);
  assert.equal(plan.targets.every((target) => Number.isInteger(target.distance) && target.distance >= 0), true);
});

test("missing focus and invalid model return null", () => {
  const valid = tree([list("root", null, ["focus"])], [item("focus", "root", 0)]);
  assert.equal(planRippleTargets(valid, "missing"), null);

  const invalid = tree(
    [list("root", null, ["focus"])],
    [item("focus", "missing-list", 0)],
  );
  assert.equal(planRippleTargets(invalid, "focus"), null);
});
