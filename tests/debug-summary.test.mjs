import assert from "node:assert/strict";
import test from "node:test";
import {
  createDebugSummary,
  summarizeEnvelopes,
} from "../scripts/debug-summary.mjs";

function envelope(name, monotonicMs, payload = {}) {
  return {
    schema: "zentype-debug/v1",
    sessionId: "test-session",
    sequence: monotonicMs + 1,
    kind: "event",
    payload: { name, monotonicMs, ...payload },
  };
}

function structuralState(generation, phase = "mutating", kind = "enter") {
  return { generation, phase, kind };
}

test("summarizer aggregates one structural Enter with stable timing", () => {
  const session = createDebugSummary("test-session");
  session.accept(envelope("structural-edit-begin", 10, {
    kind: "enter",
    transactionStartedAt: 10,
    structural: structuralState(1),
  }));
  session.accept(envelope("structural-edit-activity", 20, {
    structural: structuralState(1),
    lastActivityAt: 20,
  }));
  session.accept(envelope("mutation", 25, {
    structural: structuralState(1),
    structuralGeneration: 1,
    structuralPhase: "mutating",
    structuralKind: "enter",
    semanticClassification: "structural",
    childListCount: 2,
    addedBlockIds: ["block-a"],
  }));
  session.accept(envelope("structural-edit-finish", 80, {
    generation: 1,
    kind: "enter",
    stable: true,
    transactionStartedAt: 10,
    lastActivityAt: 25,
    finishedAt: 80,
    settleFrames: 4,
  }));

  const [record] = session.flush(180);
  assert.equal(record.operation, "structural");
  assert.equal(record.generation, 1);
  assert.equal(record.status, "completed");
  assert.equal(record.elapsedMs, 70);
  assert.equal(record.quietMs, 55);
  assert.equal(record.stable, true);
  assert.deepEqual(record.addedBlockIds, ["block-a"]);
});

test("idle semantic mutation is emitted as an anomaly observation", () => {
  const session = createDebugSummary("test-session");
  session.accept(envelope("mutation", 10, {
    structural: structuralState(4, "idle", "enter"),
    structuralGeneration: 4,
    structuralPhase: "idle",
    structuralKind: "enter",
    semanticClassification: "structural",
    addedBlockIds: ["nested-block"],
  }));

  const [record] = session.flush(110);
  assert.equal(record.status, "observed");
  assert.deepEqual(record.anomalies, ["IDLE_SEMANTIC_MUTATION"]);
  assert.equal(record.forensicRecommended, true);
  assert.deepEqual(record.anomalyDetails[0].blockIds, ["nested-block"]);
});

test("character Backspace representation replacement is an ordinary edit", () => {
  const session = createDebugSummary("test-session");
  session.accept(envelope("keydown", 10, {
    key: "Backspace",
    currentBlockId: "block-a",
    structural: structuralState(7, "idle", null),
  }));
  session.accept(envelope("input", 12, {
    inputType: "deleteContentBackward",
    currentBlockId: "block-a",
    structural: structuralState(7, "idle", null),
  }));
  session.accept(envelope("mutation", 14, {
    structural: structuralState(7, "idle", null),
    structuralGeneration: 7,
    structuralPhase: "idle",
    semanticClassification: "representation",
  }));

  const [record] = session.flush(114);
  assert.equal(record.operation, "character-backspace");
  assert.equal(record.structural, false);
  assert.equal(record.semanticMutation, "representation");
  assert.deepEqual(record.anomalies, []);
});

test("ordinary character Backspace followed by a structural generation is flagged", () => {
  const session = createDebugSummary("test-session");
  session.accept(envelope("keydown", 10, { key: "Backspace", currentBlockId: "block-a" }));
  session.accept(envelope("input", 12, {
    inputType: "deleteContentBackward",
    currentBlockId: "block-a",
  }));
  session.accept(envelope("mutation", 20, {
    structural: structuralState(8),
    structuralGeneration: 8,
    structuralPhase: "mutating",
    semanticClassification: "structural",
    addedBlockIds: ["block-b"],
  }));
  session.accept(envelope("structural-edit-finish", 60, {
    generation: 8,
    kind: "backspace",
    stable: true,
    transactionStartedAt: 20,
    lastActivityAt: 20,
    finishedAt: 60,
  }));

  const records = session.flush(160);
  const record = records.find((candidate) => candidate.operation === "character-backspace");
  assert.ok(record);
  assert.deepEqual(record.anomalies, ["CHAR_BACKSPACE_STRUCTURAL_FALSE_POSITIVE"]);
  assert.equal(record.forensicRecommended, true);
});

test("semantic mutation within the late window is flagged on the transaction", () => {
  const session = createDebugSummary("test-session");
  session.accept(envelope("structural-edit-finish", 50, {
    generation: 3,
    kind: "enter",
    stable: true,
    transactionStartedAt: 0,
    lastActivityAt: 0,
    finishedAt: 50,
  }));
  session.accept(envelope("mutation", 90, {
    structural: structuralState(3, "idle", "enter"),
    structuralGeneration: 3,
    structuralPhase: "idle",
    semanticClassification: "structural",
    removedBlockIds: ["late-block"],
  }));

  const [record] = session.flush(150);
  assert.ok(record.anomalies.includes("LATE_SEMANTIC_MUTATION"));
  assert.ok(record.anomalies.includes("IDLE_SEMANTIC_MUTATION"));
});

test("a newer structural generation makes the previous one superseded", () => {
  const session = createDebugSummary("test-session");
  session.accept(envelope("structural-edit-begin", 0, {
    generation: 1,
    kind: "enter",
    structural: structuralState(1),
  }));
  const superseded = session.accept(envelope("structural-edit-begin", 8, {
    generation: 2,
    kind: "list-change",
    structural: structuralState(2),
  }));
  assert.equal(superseded.length, 1);
  assert.equal(superseded[0].generation, 1);
  assert.equal(superseded[0].status, "superseded");
});

test("IME representation mutations remain ordinary and do not create false positives", () => {
  const session = createDebugSummary("test-session");
  session.accept(envelope("compositionstart", 0, { currentBlockId: "block-a" }));
  session.accept(envelope("mutation", 8, {
    structural: structuralState(5, "idle", null),
    structuralGeneration: 5,
    structuralPhase: "idle",
    semanticClassification: "representation",
  }));
  const [record] = session.accept(envelope("compositionend", 20, {
    currentBlockId: "block-a",
  }));
  assert.equal(record.operation, "ime");
  assert.equal(record.structuralTransactions, 0);
  assert.equal(record.semanticStructuralMutations, 0);
  assert.deepEqual(record.anomalies, []);
});

test("report contains compact timing and instrumentation counters only", () => {
  const { report } = summarizeEnvelopes([
    {
      schema: "zentype-debug/v1",
      sessionId: "report-session",
      kind: "status",
      payload: {
        monotonicMs: 0,
        timingEvents: 5,
        forensicSnapshots: 1,
        mutationBatches: 2,
        serializedMutationRecords: 0,
      },
    },
    envelope("structural-edit-finish", 80, {
      generation: 1,
      kind: "enter",
      stable: true,
      transactionStartedAt: 10,
      lastActivityAt: 25,
      finishedAt: 80,
    }),
  ], { sessionId: "report-session" });
  assert.equal(report.transactions, 1);
  assert.deepEqual(report.counters, {
    timingEvents: 5,
    forensicSnapshots: 1,
    mutationBatches: 2,
    serializedMutationRecords: 0,
  });
  assert.equal(JSON.stringify(report).includes("document text"), false);
});
