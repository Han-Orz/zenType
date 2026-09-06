import assert from "node:assert/strict";
import test from "node:test";
import {
  createSentenceTransitionCore,
  easeInOutCubic,
  mixColor,
  type Rgba,
  type SentenceRange,
  type SentenceTransitionCore,
} from "../src/modules/ripple/sentenceTransition";

const TEXT: Rgba = { r: 0, g: 0, b: 0, a: 1 };
const DIM: Rgba = { r: 0, g: 0, b: 0, a: 0.6 };
const EPS = 1e-6;

function range(start: number, end: number): SentenceRange {
  return { start, end };
}

function core(): SentenceTransitionCore {
  return createSentenceTransitionCore();
}

function update(
  engine: SentenceTransitionCore,
  options: {
    sentenceRanges: readonly SentenceRange[];
    activeRanges: readonly SentenceRange[];
    textChanged?: boolean;
    animate?: boolean;
  },
) {
  return engine.update({
    blockKey: "block",
    sentenceRanges: options.sentenceRanges,
    activeRanges: options.activeRanges,
    textChanged: options.textChanged ?? false,
    textColor: TEXT,
    dimColor: DIM,
    animate: options.animate ?? true,
  });
}

function closeColor(a: Rgba, b: Rgba): boolean {
  return (
    Math.abs(a.r - b.r) < EPS &&
    Math.abs(a.g - b.g) < EPS &&
    Math.abs(a.b - b.b) < EPS &&
    Math.abs(a.a - b.a) < EPS
  );
}

function slotByRange(
  slots: readonly { range: SentenceRange }[],
  start: number,
) {
  const slot = slots.find((candidate) => candidate.range.start === start);
  assert.ok(slot, `expected an active slot for sentence starting at ${start}`);
  return slot;
}

function assertNoSlot(
  slots: readonly { range: SentenceRange }[],
  start: number,
) {
  assert.equal(
    slots.some((candidate) => candidate.range.start === start),
    false,
    `expected no slot for sentence starting at ${start}`,
  );
}

// A=[0,5), B=[5,10)
const AB: readonly SentenceRange[] = [range(0, 5), range(5, 10)];

test("normal A -> B: A releases text->dim 600ms, B acquires dim->text 400ms", () => {
  const engine = core();

  // Cold start settles (first apply in a block never animates).
  let result = update(engine, { sentenceRanges: AB, activeRanges: [AB[0]] });
  assert.equal(result.settled, true);
  assert.equal(result.slots.length, 0);
  assert.deepEqual(result.stableRanges, [AB[1]]);

  result = update(engine, { sentenceRanges: AB, activeRanges: [AB[1]] });
  assert.equal(result.settled, false);
  assert.equal(result.slots.length, 2);
  const dimSlot = slotByRange(result.slots, 0);
  const activeSlot = slotByRange(result.slots, 5);
  assert.equal(dimSlot.target, "dim");
  assert.equal(dimSlot.duration, 600);
  assert.equal(dimSlot.from.a, TEXT.a); // text endpoint, not a restart from dim
  assert.equal(dimSlot.to.a, DIM.a);
  assert.equal(activeSlot.target, "active");
  assert.equal(activeSlot.duration, 400);
  assert.equal(activeSlot.from.a, DIM.a);
  assert.equal(activeSlot.to.a, TEXT.a);
  assert.deepEqual(result.stableRanges, []); // both sentences are covered by slots

  // Frame 0 anchors; after 400ms the acquisition completes and releases the
  // slot; the release (600ms) still runs and hands the sentence to stable dim.
  engine.advance(0);
  result = engine.advance(400);
  assert.equal(result.completed.length, 1);
  assert.equal(result.completed[0].target, "active");
  assert.equal(engine.slots().length, 1);

  result = engine.advance(600);
  assert.equal(result.completed.length, 1);
  assert.equal(result.completed[0].target, "dim");
  assert.equal(engine.hasAnimating(), false);
  assert.equal(engine.hasStable(), true);
  assert.deepEqual(engine.stableRanges(), [AB[0]]);
});

test("dual boundary {A} -> {A,B}: only B transitions, A keeps its state", () => {
  const engine = core();
  update(engine, { sentenceRanges: AB, activeRanges: [AB[0]] });

  const result = update(engine, {
    sentenceRanges: AB,
    activeRanges: [AB[0], AB[1]],
  });
  assert.equal(result.slots.length, 1);
  const slot = slotByRange(result.slots, 5);
  assert.equal(slot.target, "active");
  assert.equal(slot.from.a, DIM.a);

  engine.advance(0);
  const done = engine.advance(400);
  assert.equal(done.completed.length, 1);
  assert.equal(done.completed[0].range.start, 5);
  assert.equal(engine.hasAnimating(), false);
  assert.equal(engine.hasStable(), false); // A is the only dim sentence and it is active too
});

test("{A,B} -> {B}: A releases while B stays active", () => {
  const engine = core();
  update(engine, {
    sentenceRanges: AB,
    activeRanges: [AB[0], AB[1]],
  });

  const result = update(engine, { sentenceRanges: AB, activeRanges: [AB[1]] });
  assert.equal(result.slots.length, 1);
  const slot = slotByRange(result.slots, 0);
  assert.equal(slot.target, "dim");
  assert.equal(slot.duration, 600);
  assert.equal(slot.from.a, TEXT.a);
});

test("rapid reversal resumes from the sampled current color, never from an endpoint", () => {
  const engine = core();
  update(engine, { sentenceRanges: AB, activeRanges: [AB[0]] }); // settle {A}
  update(engine, { sentenceRanges: AB, activeRanges: [AB[1]] }); // A dim 600 / B active 400

  engine.advance(0); // anchor
  const at100 = engine.advance(100);
  const aBefore = slotByRange(at100.slots, 0);
  const bBefore = slotByRange(at100.slots, 5);
  assert.equal(aBefore.target, "dim");
  assert.equal(bBefore.target, "active");

  // Reverse back to {A} at ~100ms — both in-flight transitions retarget.
  const reversed = update(engine, { sentenceRanges: AB, activeRanges: [AB[0]] });
  assert.equal(reversed.slots.length, 2);
  const aAfter = slotByRange(reversed.slots, 0);
  const bAfter = slotByRange(reversed.slots, 5);

  // A was dimming (text -> dim): retarget toward active from its current color.
  assert.equal(aAfter.target, "active");
  assert.equal(aAfter.duration, 400);
  assert.ok(closeColor(aAfter.from, aBefore.current), "A must resume from its sampled color");
  assert.equal(aAfter.from.a, aBefore.current.a);
  assert.equal(aAfter.startTime, null); // fresh timeline, no start-time inheritance
  assert.equal(aAfter.current.a, aAfter.from.a);

  // B was acquiring (dim -> text): retarget toward dim from its current color.
  assert.equal(bAfter.target, "dim");
  assert.equal(bAfter.duration, 600);
  assert.ok(closeColor(bAfter.from, bBefore.current), "B must resume from its sampled color");
  assert.ok(Math.abs(bAfter.from.a - DIM.a) > 0.01, "B must not restart from the dim endpoint");
  assert.ok(Math.abs(bAfter.from.a - TEXT.a) > 0.01, "B must not restart from the text endpoint");
  assert.equal(bAfter.startTime, null);
});

test("multiple reversals inside 600ms keep per-slot timelines and sample continuity", () => {
  const engine = core();
  // B stays active throughout; A flaps dim <-> active via {B}->{A,B}->{B}.
  update(engine, { sentenceRanges: AB, activeRanges: [AB[1]] }); // settle {B}
  assert.deepEqual(engine.stableRanges(), [AB[0]]);

  // {B} -> {A,B}: A acquires (dim -> text, 400ms).
  let result = update(engine, { sentenceRanges: AB, activeRanges: [AB[0], AB[1]] });
  assert.equal(result.slots.length, 1);
  let slot = slotByRange(result.slots, 0);
  assert.equal(slot.target, "active");
  engine.advance(0); // anchor
  engine.advance(60);
  const sample1 = slotByRange(engine.slots(), 0).current;

  // {A,B} -> {B} at ~60ms: A retargets toward dim from its sampled color.
  result = update(engine, { sentenceRanges: AB, activeRanges: [AB[1]] });
  assert.equal(result.slots.length, 1);
  slot = slotByRange(result.slots, 0);
  assert.equal(slot.target, "dim");
  assert.equal(slot.duration, 600);
  assert.equal(slot.startTime, null); // fresh timeline, no inheritance
  assert.ok(closeColor(slot.from, sample1), "reverse must resume from the sampled color");
  engine.advance(90);

  // -> {A,B} again inside 150ms total: retarget toward active, same invariants.
  const sample2 = slotByRange(engine.slots(), 0).current;
  result = update(engine, { sentenceRanges: AB, activeRanges: [AB[0], AB[1]] });
  slot = slotByRange(result.slots, 0);
  assert.equal(slot.target, "active");
  assert.equal(slot.duration, 400);
  assert.equal(slot.startTime, null);
  assert.ok(closeColor(slot.from, sample2), "every retarget samples the last rendered color");
  engine.advance(120);

  // -> {B} one last time, still well inside 600ms of wall motion.
  const sample3 = slotByRange(engine.slots(), 0).current;
  result = update(engine, { sentenceRanges: AB, activeRanges: [AB[1]] });
  slot = slotByRange(result.slots, 0);
  assert.equal(slot.target, "dim");
  assert.equal(slot.startTime, null);
  assert.ok(closeColor(slot.from, sample3));
  assert.ok(engine.slots().length <= 2, "bounded slot pool");

  // The final release completes into stable dim (A [0,5)).
  engine.advance(1000); // anchor the fresh timeline
  assert.equal(engine.hasAnimating(), true);
  engine.advance(1700);
  assert.equal(engine.hasAnimating(), false);
  assert.deepEqual(engine.stableRanges(), [AB[0]]);
});

test("same-sentence text edit rebinds geometry only: no restart, no retarget", () => {
  const engine = core();
  update(engine, { sentenceRanges: AB, activeRanges: [AB[1]] }); // settle {B}
  update(engine, { sentenceRanges: AB, activeRanges: [AB[0]] }); // A active 400 / B dim 600

  engine.advance(0);
  engine.advance(100);
  const before = engine.slots();
  const aBefore = slotByRange(before, 0);
  const bBefore = slotByRange(before, 5);
  const aAnchor = aBefore.startTime;
  const bAnchor = bBefore.startTime;
  assert.notEqual(aAnchor, null);
  assert.notEqual(bAnchor, null);

  // User keeps typing in the active sentence A: A [0,5) -> [0,6), B shifts.
  const grown = [range(0, 6), range(6, 11)];
  const result = update(engine, {
    sentenceRanges: grown,
    activeRanges: [grown[0]],
    textChanged: true,
  });
  assert.equal(result.slots.length, 2);
  const aAfter = slotByRange(result.slots, 0);
  const bAfter = slotByRange(result.slots, 6);

  assert.equal(aAfter.target, "active");
  assert.equal(aAfter.startTime, aAnchor); // timeline continues
  assert.deepEqual(aAfter.range, grown[0]); // geometry rebind only
  assert.ok(closeColor(aAfter.from, aBefore.from)); // from color untouched
  assert.equal(bAfter.target, "dim");
  assert.equal(bAfter.startTime, bAnchor);
  assert.deepEqual(bAfter.range, grown[1]);
});

test("earlier-text offset shift keeps ordinal continuity (start 5 -> 4)", () => {
  const engine = core();
  update(engine, { sentenceRanges: AB, activeRanges: [AB[1]] }); // settle {B}
  assert.deepEqual(engine.stableRanges(), [AB[0]]);

  // Deleting a character in the earlier sentence moves B's start 5 -> 4 but
  // the sentence count is stable: ordinal rebind, still the same presentation.
  const shifted = [range(0, 4), range(4, 9)];
  const result = update(engine, {
    sentenceRanges: shifted,
    activeRanges: [shifted[1]],
    textChanged: true,
  });
  assert.equal(result.settled, false);
  assert.equal(result.slots.length, 0); // target unchanged, no transition
  assert.deepEqual(result.stableRanges, [shifted[0]]);
  assert.deepEqual(engine.stableRanges(), [shifted[0]]);
});

test("topology change settles deterministically and leaves no stale slots", () => {
  const engine = core();
  const before = [range(0, 2), range(2, 4)]; // 甲。 乙。
  update(engine, { sentenceRanges: before, activeRanges: [before[0]] });
  update(engine, { sentenceRanges: before, activeRanges: [before[1]] }); // start transitions
  assert.equal(engine.slots().length, 2);

  engine.advance(0);
  engine.advance(120);

  // Delete the 句号: 2 sentences merge into 1 (甲乙). Deterministic settle.
  const merged = [range(0, 3)];
  const result = update(engine, {
    sentenceRanges: merged,
    activeRanges: [merged[0]],
    textChanged: true,
  });
  assert.equal(result.settled, true);
  assert.equal(result.slots.length, 0); // no stale slots
  assert.deepEqual(result.stableRanges, []);
  assert.equal(engine.hasAnimating(), false);
  assert.equal(engine.hasStable(), false);
});

test("animate=false (reduced motion) settles to the final semantic state", () => {
  const engine = core();
  update(engine, { sentenceRanges: AB, activeRanges: [AB[0]] });
  const result = update(engine, {
    sentenceRanges: AB,
    activeRanges: [AB[1]],
    animate: false,
  });
  assert.equal(result.settled, true);
  assert.equal(result.slots.length, 0);
  assert.deepEqual(result.stableRanges, [AB[0]]);
  assert.equal(engine.hasAnimating(), false);
});

test("a finished dim slot re-enters active from the settled dim color", () => {
  const engine = core();
  update(engine, { sentenceRanges: AB, activeRanges: [AB[0]] }); // settle {A}
  update(engine, { sentenceRanges: AB, activeRanges: [AB[1]] }); // A release, B acquire
  engine.advance(0);
  engine.advance(600); // B acquired at 400, A finished dimming and joined stable dim
  assert.deepEqual(engine.stableRanges(), [AB[0]]);
  assert.equal(engine.hasAnimating(), false);

  // {B} -> {A}: A leaves the settled dim color, B releases from active.
  const result = update(engine, { sentenceRanges: AB, activeRanges: [AB[0]] });
  assert.equal(result.slots.length, 2);
  const aSlot = slotByRange(result.slots, 0);
  const bSlot = slotByRange(result.slots, 5);
  assert.equal(aSlot.target, "active");
  assert.equal(aSlot.duration, 400);
  assert.equal(aSlot.from.a, DIM.a); // resumes from the stable dim endpoint
  assert.equal(bSlot.target, "dim");
  assert.equal(bSlot.duration, 600);
  assert.equal(bSlot.from.a, TEXT.a); // releases from the natural text color
  assert.deepEqual(result.stableRanges, []); // no sentence is statically dim yet
});

test("clear() drops slots and stable state; a later update settles again", () => {
  const engine = core();
  update(engine, { sentenceRanges: AB, activeRanges: [AB[0]] });
  update(engine, { sentenceRanges: AB, activeRanges: [AB[1]] });
  engine.advance(0);
  engine.advance(100);
  assert.equal(engine.hasAnimating(), true);

  engine.clear();
  assert.equal(engine.hasAnimating(), false);
  assert.equal(engine.hasStable(), false);
  assert.deepEqual(engine.slots(), []);
  assert.deepEqual(engine.stableRanges(), []);
  engine.clear(); // idempotent

  // Post-clear update is a fresh presentation domain: settle, no animation.
  const result = update(engine, { sentenceRanges: AB, activeRanges: [AB[1]] });
  assert.equal(result.settled, true);
  assert.equal(result.slots.length, 0);
  assert.deepEqual(result.stableRanges, [AB[0]]);
});

test("block switch settles and a second update can transition within the block", () => {
  const engine = core();
  update(engine, { sentenceRanges: AB, activeRanges: [AB[0]] });
  update(engine, { sentenceRanges: AB, activeRanges: [AB[1]] }); // transitions run
  engine.advance(0);
  engine.advance(50);
  assert.equal(engine.hasAnimating(), true);

  // Caret jumps to another block: same text, new block key -> settle.
  const switched = engine.update({
    blockKey: "other-block",
    sentenceRanges: AB,
    activeRanges: [AB[1]],
    textChanged: false,
    textColor: TEXT,
    dimColor: DIM,
    animate: true,
  });
  assert.equal(switched.settled, true);
  assert.equal(switched.slots.length, 0);
  assert.deepEqual(switched.stableRanges, [AB[0]]);

  // Within the new block, sentence-to-sentence movement animates again.
  const moved = engine.update({
    blockKey: "other-block",
    sentenceRanges: AB,
    activeRanges: [AB[0]],
    textChanged: false,
    textColor: TEXT,
    dimColor: DIM,
    animate: true,
  });
  assert.equal(moved.slots.length, 2);
  assert.equal(slotByRange(moved.slots, 5).target, "dim");
});

test("easing and color mixing helpers behave deterministically", () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  assert.equal(easeInOutCubic(0.5), 0.5);
  const mid = mixColor(DIM, TEXT, 0.5);
  assert.equal(mid.a, 0.8);
  assert.ok(closeColor(mixColor(DIM, TEXT, 0), DIM));
  assert.ok(closeColor(mixColor(DIM, TEXT, 1), TEXT));
});
