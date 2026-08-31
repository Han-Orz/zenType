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
}

function item(
  id: string,
  parentListId: string,
  options: ItemOptions = {},
): SemanticItem {
  return {
    id,
    parentListId,
    markerId: options.markerId === undefined ? `marker:${id}` : options.markerId,
    directContentIds: options.directContentIds ?? [`content:${id}`],
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
      item("A", "root"),
      item("A.1", "list-A"),
      item("A.2", "list-A"),
      item("B", "root"),
      item("B.1", "list-B"),
      item("B.2", "list-B"),
      item("B.3", "list-B"),
      item("B.1.a", "list-B.1"),
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

test("single-level sibling distance uses parent list itemIds as its order source", () => {
  const input = tree(
    [list("root", null, ["A", "B", "C", "D"])],
    [
      item("D", "root"),
      item("B", "root"),
      item("A", "root"),
      item("C", "root"),
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

test("deep single chain follows parentListId and parentItemId for each ancestor", () => {
  const lists: SemanticList[] = [list("list-0", null, ["item-0"])];
  const items: SemanticItem[] = [];
  for (let index = 0; index < 6; index++) {
    const itemId = `item-${index}`;
    items.push(item(itemId, `list-${index}`));
    if (index < 5) lists.push(list(`list-${index + 1}`, itemId, [`item-${index + 1}`]));
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
      item("focus", "root"),
      item("branch", "root"),
      item("branch-child", "branch-list"),
      item("branch-child-2", "branch-list"),
      item("branch-grandchild", "grandchild-list"),
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
    [item("focus", "root", {
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
      item("focus", "root", { markerId: null }),
      item("sibling", "root"),
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
    itemIds.map((id) => item(id, "root")),
  );

  const plan = requirePlan(input, "focus");
  assertTarget(plan, "six", "branch-root", 6);
  assertTarget(plan, "seven", "branch-root", 7);
  assertTarget(plan, "eight", "branch-root", 8);
  assert.equal(plan.targets.every((target) => Number.isInteger(target.distance) && target.distance >= 0), true);
});

test("missing focus and invalid model return null", () => {
  const valid = tree([list("root", null, ["focus"])], [item("focus", "root")]);
  assert.equal(planRippleTargets(valid, "missing"), null);

  const invalid = tree(
    [list("root", null, ["focus"])],
    [item("focus", "missing-list")],
  );
  assert.equal(planRippleTargets(invalid, "focus"), null);

  const brokenParent = tree(
    [
      list("root", null, ["parent"]),
      list("child", "missing-parent", ["focus"]),
    ],
    [
      item("parent", "root"),
      item("focus", "child"),
    ],
  );
  assert.equal(planRippleTargets(brokenParent, "focus"), null);

  const missingSibling = tree(
    [list("root", null, ["focus", "missing-sibling"])],
    [item("focus", "root")],
  );
  assert.equal(planRippleTargets(missingSibling, "focus"), null);

  const cyclic = tree(
    [
      list("list-a", "item-b", ["item-a"]),
      list("list-b", "item-a", ["item-b"]),
    ],
    [
      item("item-a", "list-a"),
      item("item-b", "list-b"),
    ],
  );
  assert.equal(planRippleTargets(cyclic, "item-a"), null);
});
