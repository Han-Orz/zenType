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
import {
  diffSentenceSets,
  resolveActiveSentenceRanges,
  sameSentenceRangeSet,
  splitSentences,
} from "../src/modules/ripple/sentenceModel";

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

// --- Sentence model (Intl.Segmenter is the single boundary source) ---

test("splitSentences delegates to Intl.Segmenter with UTF-16 offsets", () => {
  const text = "第一句话。第二句话。";
  assert.deepEqual(splitSentences(text), [
    { start: 0, end: 5 },
    { start: 5, end: 10 },
  ]);

  // 😀 occupies two code units; boundaries stay in UTF-16 coordinate space.
  const astral = "你好😀。下一句。";
  const astralRanges = splitSentences(astral);
  assert.deepEqual(astralRanges, [
    { start: 0, end: 5 },
    { start: 5, end: 9 },
  ]);
  for (const { start, end } of astralRanges) {
    assert.equal(astral.slice(start, end).length, end - start);
  }
});

test("splitSentences keeps decimals, domains and ellipses intact", () => {
  assert.deepEqual(splitSentences("价格是 3.14 元。下一句。"), [
    { start: 0, end: 11 },
    { start: 11, end: 15 },
  ]);
  assert.deepEqual(splitSentences("Node.js works. Next."), [
    { start: 0, end: 15 },
    { start: 15, end: 20 },
  ]);
  // Locked runtime behavior: an ellipsis run does not split the sentence.
  assert.deepEqual(splitSentences("我想……还是算了。"), [{ start: 0, end: 9 }]);
  // Closing quote stays attached to the quoted sentence.
  assert.deepEqual(splitSentences("他说：“你好。”然后走了。"), [
    { start: 0, end: 8 },
    { start: 8, end: 13 },
  ]);
});

test("splitSentences covers empty and unterminated text", () => {
  assert.deepEqual(splitSentences(""), []);
  assert.deepEqual(splitSentences("Hello"), [{ start: 0, end: 5 }]);
  assert.deepEqual(splitSentences("。"), [{ start: 0, end: 1 }]);
});

test("resolveActiveSentenceRanges activates both sentences on the shared boundary", () => {
  const ranges = splitSentences("第一句话。第二句话。");
  const [a, b] = ranges;

  assert.deepEqual(resolveActiveSentenceRanges(ranges, 2, 10), [a]); // 句内
  assert.deepEqual(resolveActiveSentenceRanges(ranges, 5, 10), [a, b]); // 公共边界
  assert.deepEqual(resolveActiveSentenceRanges(ranges, 4, 10), [a]); // 边界前一字符
  assert.deepEqual(resolveActiveSentenceRanges(ranges, 6, 10), [b]); // 边界后一字符
  assert.deepEqual(resolveActiveSentenceRanges(ranges, 0, 10), [a]); // BOF
  assert.deepEqual(resolveActiveSentenceRanges(ranges, 10, 10), [b]); // EOF
  assert.deepEqual(resolveActiveSentenceRanges(ranges, 99, 10), [b]); // 越界防御
  assert.deepEqual(resolveActiveSentenceRanges(ranges, -1, 10), [a]);
});

test("resolveActiveSentenceRanges keeps a lone sentence active at every offset", () => {
  const ranges = splitSentences("Hello");
  assert.deepEqual(resolveActiveSentenceRanges(ranges, 0, 5), ranges);
  assert.deepEqual(resolveActiveSentenceRanges(ranges, 3, 5), ranges);
  assert.deepEqual(resolveActiveSentenceRanges(ranges, 5, 5), ranges);
  assert.deepEqual(resolveActiveSentenceRanges([], 3, 5), []);
});

test("diffSentenceSets classifies leaving and entering ranges", () => {
  const a = { start: 0, end: 5 };
  const b = { start: 5, end: 10 };
  assert.deepEqual(diffSentenceSets([a], [b]), { leaving: [a], entering: [b] });
  assert.deepEqual(diffSentenceSets([a], [a, b]), { leaving: [], entering: [b] });
  assert.deepEqual(diffSentenceSets([a, b], [b]), { leaving: [a], entering: [] });
  assert.deepEqual(diffSentenceSets([a, b], [a, b]), { leaving: [], entering: [] });
});

test("sameSentenceRangeSet compares by start/end values, not identity", () => {
  assert.equal(sameSentenceRangeSet([{ start: 0, end: 5 }], [{ start: 0, end: 5 }]), true);
  assert.equal(sameSentenceRangeSet([{ start: 0, end: 5 }], [{ start: 0, end: 6 }]), false);
  assert.equal(sameSentenceRangeSet([{ start: 0, end: 5 }], []), false);
  assert.equal(
    sameSentenceRangeSet(
      [{ start: 0, end: 5 }, { start: 5, end: 9 }],
      [{ start: 0, end: 5 }, { start: 5, end: 9 }],
    ),
    true,
  );
});
