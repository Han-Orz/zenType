import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SCROLL_TARGET_POLICY,
  resolveScrollTarget,
} from "../src/modules/typewriter/targetResolver";

function inputFor(
  cursorPct: number,
  overrides: Partial<Parameters<typeof resolveScrollTarget>[0]> = {},
) {
  return {
    cursorY: cursorPct * 1000,
    editorTop: 0,
    editorBottom: 1000,
    currentScrollTop: 500,
    maxScrollTop: 1500,
    ...overrides,
  };
}

test("scroll target resolver holds caret positions inside the trigger zone", () => {
  const middle = resolveScrollTarget(inputFor(0.44));
  const oldLowerBoundary = resolveScrollTarget(inputFor(0.37));

  assert.deepEqual(middle, {
    action: "hold",
    reason: "within-trigger-zone",
    cursorPct: 0.44,
  });
  assert.deepEqual(oldLowerBoundary, {
    action: "hold",
    reason: "within-trigger-zone",
    cursorPct: 0.37,
  });
});

test("scroll target resolver moves to the inner settle edge outside the trigger zone", () => {
  const above = resolveScrollTarget(inputFor(0.33));
  const below = resolveScrollTarget(inputFor(0.55));

  assert.deepEqual(above, {
    action: "move",
    reason: "above-trigger",
    cursorPct: 0.33,
    targetPct: 0.4,
    targetScrollTop: 430,
    deltaY: -70,
  });
  assert.deepEqual(below, {
    action: "move",
    reason: "below-trigger",
    cursorPct: 0.55,
    targetPct: 0.48,
    targetScrollTop: 570,
    deltaY: 70,
  });
});

test("scroll target resolver uses strict outer boundaries and moves just outside them", () => {
  for (const cursorPct of [0.34, 0.54]) {
    assert.equal(resolveScrollTarget(inputFor(cursorPct)).action, "hold");
  }
  for (const cursorPct of [0.339, 0.541]) {
    assert.equal(resolveScrollTarget(inputFor(cursorPct)).action, "move");
  }
});

test("scroll target resolver keeps the deadband after an upper or lower correction", () => {
  const upperCorrection = resolveScrollTarget(inputFor(0.33));
  const lowerCorrection = resolveScrollTarget(inputFor(0.55));

  assert.equal(upperCorrection.action, "move");
  assert.equal(
    resolveScrollTarget(inputFor(0.39, { currentScrollTop: upperCorrection.action === "move"
      ? upperCorrection.targetScrollTop
      : 500 })).action,
    "hold",
  );
  assert.equal(lowerCorrection.action, "move");
  assert.equal(
    resolveScrollTarget(inputFor(0.49, { currentScrollTop: lowerCorrection.action === "move"
      ? lowerCorrection.targetScrollTop
      : 500 })).action,
    "hold",
  );
});

test("scroll target resolver clamps absolute endpoints at the document boundaries", () => {
  const top = resolveScrollTarget(inputFor(0.33, { currentScrollTop: 20, maxScrollTop: 1500 }));
  const bottom = resolveScrollTarget(inputFor(0.55, { currentScrollTop: 1480, maxScrollTop: 1500 }));

  assert.equal(top.action, "move");
  assert.equal(top.targetScrollTop, 0);
  assert.equal(top.deltaY, -20);
  assert.equal(bottom.action, "move");
  assert.equal(bottom.targetScrollTop, 1500);
  assert.equal(bottom.deltaY, 20);
});

test("scroll target resolver holds when clamping leaves no meaningful movement", () => {
  const resolution = resolveScrollTarget(inputFor(0.33, {
    currentScrollTop: 0,
    maxScrollTop: 1500,
  }));

  assert.deepEqual(resolution, {
    action: "hold",
    reason: "clamped-noop",
    cursorPct: 0.33,
  });
});

test("scroll target resolver fails open on invalid geometry", () => {
  const cases = [
    inputFor(0.44, { editorTop: 100, editorBottom: 100 }),
    inputFor(0.44, { cursorY: Number.NaN }),
    inputFor(0.44, { editorBottom: Number.POSITIVE_INFINITY }),
    inputFor(0.44, { currentScrollTop: Number.NEGATIVE_INFINITY }),
    inputFor(0.44, { maxScrollTop: -1 }),
  ];

  for (const input of cases) {
    assert.deepEqual(resolveScrollTarget(input), {
      action: "hold",
      reason: "invalid-geometry",
      cursorPct: null,
    });
  }
});

test("default scroll target policy expresses the trigger and settle invariants", () => {
  assert.deepEqual(DEFAULT_SCROLL_TARGET_POLICY, {
    triggerLow: 0.34,
    triggerHigh: 0.54,
    settleLow: 0.4,
    settleHigh: 0.48,
    minMovementPx: 1,
  });
  assert.equal(DEFAULT_SCROLL_TARGET_POLICY.triggerLow < DEFAULT_SCROLL_TARGET_POLICY.settleLow, true);
  assert.equal(DEFAULT_SCROLL_TARGET_POLICY.settleLow <= DEFAULT_SCROLL_TARGET_POLICY.settleHigh, true);
  assert.equal(DEFAULT_SCROLL_TARGET_POLICY.settleHigh < DEFAULT_SCROLL_TARGET_POLICY.triggerHigh, true);
});
