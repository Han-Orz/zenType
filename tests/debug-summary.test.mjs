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
  assert.equal(record.operation, "structural-observation");
  assert.equal(record.observationId, "idle-1");
  assert.equal(record.generation, null);
  assert.equal(record.semanticClassification, "structural");
  assert.deepEqual(record.blockIds, ["nested-block"]);
  assert.equal(record.finalizeAt, 110);
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
  assert.equal(record.operation, "backspace");
  assert.equal(record.classification, "character");
  assert.equal(record.structural, false);
  assert.equal(record.semanticMutation, "representation");
  assert.deepEqual(record.anomalies, []);
});

test("genuine block Backspace with deleteContentBackward is block-structural", () => {
  const session = createDebugSummary("test-session");
  session.accept(envelope("keydown", 10, { key: "Backspace", currentBlockId: "block-b" }));
  session.accept(envelope("input", 12, {
    inputType: "deleteContentBackward",
    currentBlockId: "block-b",
  }));
  session.accept(envelope("mutation", 20, {
    structural: structuralState(8, "mutating", "backspace"),
    structuralGeneration: 8,
    structuralPhase: "mutating",
    structuralKind: "backspace",
    semanticClassification: "structural",
    removedBlockIds: ["block-b"],
    currentBlockId: "block-b",
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
  const record = records.find((candidate) => candidate.operation === "backspace");
  assert.ok(record);
  assert.equal(record.classification, "block-structural");
  assert.equal(record.structural, true);
  assert.equal(record.expectedStructural, true);
  assert.equal(record.semanticMutation, "structural");
  assert.equal(record.structuralMutationCount, 1);
  assert.equal(record.structuralTransactions[0].generation, 8);
  assert.equal(record.structuralTransactions[0].kind, "backspace");
  assert.equal(record.structuralTransactions[0].structuralMutationCount, 1);
  assert.deepEqual(record.anomalies, []);
});

test("Backspace transaction with representation-only mutation is a true false positive", () => {
  const session = createDebugSummary("test-session");
  session.accept(envelope("keydown", 10, { key: "Backspace", currentBlockId: "block-a" }));
  session.accept(envelope("input", 12, {
    inputType: "deleteContentBackward",
    currentBlockId: "block-a",
  }));
  session.accept(envelope("mutation", 20, {
    structural: structuralState(9, "mutating", null),
    semanticClassification: "representation",
    currentBlockId: "block-a",
  }));
  session.accept(envelope("structural-edit-finish", 60, {
    generation: 9,
    kind: "backspace",
    stable: true,
    transactionStartedAt: 20,
    lastActivityAt: 20,
    finishedAt: 60,
  }));

  const record = session.flush(160).find((candidate) => candidate.operation === "backspace");
  assert.ok(record);
  assert.equal(record.classification, "character");
  assert.equal(record.structural, true);
  assert.equal(record.semanticMutation, "representation");
  assert.deepEqual(record.anomalies, ["CHAR_BACKSPACE_STRUCTURAL_FALSE_POSITIVE"]);
  assert.deepEqual(record.structuralGenerations, [9]);
  assert.equal(record.structuralTransactions[0].generation, 9);
  assert.equal(record.structuralTransactions[0].kind, "backspace");
  assert.equal(record.structuralTransactions[0].structuralMutationCount, 0);
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
    currentBlockId: "block-a",
  }));
  session.accept(envelope("mutation", 90, {
    structural: structuralState(3, "idle", "enter"),
    structuralGeneration: 3,
    structuralPhase: "idle",
    semanticClassification: "structural",
    currentBlockId: "block-a",
    removedBlockIds: ["late-block"],
  }));

  const [record] = session.flush(150);
  assert.ok(record.anomalies.includes("LATE_SEMANTIC_MUTATION"));
  assert.equal(record.anomalies.includes("IDLE_SEMANTIC_MUTATION"), false);
  assert.equal(session.getReport().structuralObservations, 0);
});

test("real-style Single Enter discovers the transaction without begin/activity events", () => {
  const session = createDebugSummary("test-session");
  session.accept(envelope("keydown", 0, {
    key: "Enter",
    structural: structuralState(0, "idle", null),
  }));
  session.accept(envelope("mutation", 10, {
    structural: structuralState(1, "mutating", "enter"),
    semanticClassification: "structural",
    currentBlockId: "block-a",
    addedBlockIds: ["block-b"],
  }));
  session.accept(envelope("selectionchange", 20, {
    structural: structuralState(1, "stabilizing", "enter"),
    selection: { anchorBlockId: "block-b", focusBlockId: "block-b" },
  }));
  session.accept(envelope("structural-edit-finish", 50, {
    generation: 1,
    kind: "enter",
    stable: true,
    transactionStartedAt: 10,
    lastActivityAt: 20,
    finishedAt: 50,
    currentBlockId: "block-b",
  }));

  const records = session.flush(150);
  const transactions = records.filter((record) => record.operation === "structural");
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].generation, 1);
  assert.equal(transactions[0].status, "completed");
  assert.equal(session.getReport().structuralObservations, 0);
});

test("real-style rapid Enter overlap discovers and supersedes generations", () => {
  const session = createDebugSummary("test-session");
  const records = [];
  records.push(...session.accept(envelope("keydown", 0, { key: "Enter" })));
  records.push(...session.accept(envelope("keydown", 8, {
    key: "Enter",
    structural: structuralState(1, "mutating", "enter"),
  })));
  records.push(...session.accept(envelope("mutation", 12, {
    structural: structuralState(2, "mutating", "enter"),
    semanticClassification: "structural",
    addedBlockIds: ["block-c"],
  })));
  records.push(...session.accept(envelope("structural-edit-finish", 40, {
    generation: 2,
    kind: "enter",
    stable: true,
    transactionStartedAt: 12,
    lastActivityAt: 12,
    finishedAt: 40,
  })));

  records.push(...session.flush(140));
  const transactions = records.filter((record) => record.operation === "structural");
  assert.deepEqual(
    transactions.map((record) => [record.generation, record.status]),
    [[1, "superseded"], [2, "completed"]],
  );
});

test("idle stale generation becomes a standalone observation after the transaction is emitted", () => {
  const session = createDebugSummary("test-session");
  session.accept(envelope("structural-edit-finish", 50, {
    generation: 7,
    kind: "enter",
    stable: true,
    transactionStartedAt: 0,
    lastActivityAt: 0,
    finishedAt: 50,
    currentBlockId: "block-a",
  }));
  const completed = session.flush(150);
  assert.equal(completed.filter((record) => record.operation === "structural").length, 1);

  session.accept(envelope("mutation", 500, {
    structural: structuralState(7, "idle", "enter"),
    semanticClassification: "structural",
    currentBlockId: "block-z",
    removedBlockIds: ["block-z"],
  }));
  const records = session.flush(600);
  const observation = records.find((record) => record.operation === "structural-observation");
  assert.ok(observation);
  assert.equal(observation.generation, null);
  assert.equal(observation.observationId, "idle-1");
  assert.deepEqual(observation.anomalies, ["IDLE_SEMANTIC_MUTATION"]);
  assert.deepEqual(observation.removedBlockIds, ["block-z"]);
  assert.equal(session.getReport().transactions, 1);
  assert.equal(session.getReport().structuralObservations, 1);
  assert.deepEqual(session.getReport().anomalies.map((detail) => detail.code), [
    "IDLE_SEMANTIC_MUTATION",
  ]);
});

test("idle late semantic mutation attaches only when block context overlaps", () => {
  const session = createDebugSummary("test-session");
  session.accept(envelope("structural-edit-finish", 50, {
    generation: 7,
    kind: "enter",
    stable: true,
    transactionStartedAt: 0,
    lastActivityAt: 0,
    finishedAt: 50,
    currentBlockId: "block-a",
  }));
  session.accept(envelope("mutation", 100, {
    structural: structuralState(7, "idle", "enter"),
    semanticClassification: "structural",
    currentBlockId: "block-a",
    parentChanges: [{ blockId: "block-a", fromParentId: "old", toParentId: "new" }],
  }));

  const records = session.flush(150);
  const transaction = records.find((record) => record.operation === "structural");
  assert.ok(transaction);
  assert.deepEqual(transaction.anomalies, ["LATE_SEMANTIC_MUTATION"]);
  assert.equal(records.some((record) => record.operation === "structural-observation"), false);
});

test("idle same-generation semantic mutation with unrelated context is standalone", () => {
  const session = createDebugSummary("test-session");
  session.accept(envelope("structural-edit-finish", 50, {
    generation: 7,
    kind: "enter",
    stable: true,
    transactionStartedAt: 0,
    lastActivityAt: 0,
    finishedAt: 50,
    currentBlockId: "block-a",
  }));
  session.accept(envelope("mutation", 90, {
    structural: structuralState(7, "idle", "enter"),
    semanticClassification: "structural",
    currentBlockId: "block-z",
    addedBlockIds: ["block-z"],
  }));

  const records = session.flush(190);
  const transaction = records.find((record) => record.operation === "structural");
  const observation = records.find((record) => record.operation === "structural-observation");
  assert.ok(transaction);
  assert.ok(observation);
  assert.deepEqual(transaction.anomalies, []);
  assert.deepEqual(observation.anomalies, ["IDLE_SEMANTIC_MUTATION"]);
  assert.equal(observation.generation, null);
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
