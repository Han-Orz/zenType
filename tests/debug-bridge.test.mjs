import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { createDebugBridge } from "../scripts/debug-bridge.mjs";

function event(sessionId, sequence, name, monotonicMs, payload = {}) {
  return {
    schema: "zentype-debug/v1",
    sessionId,
    sequence,
    timestamp: new Date(0).toISOString(),
    kind: "event",
    payload: { name, monotonicMs, ...payload },
  };
}

test("Bridge keeps raw evidence and writes summary/report outputs", async () => {
  const outputDir = mkdtempSync(path.join(process.cwd(), ".tmp-debug-bridge-"));
  const bridge = createDebugBridge({ port: 0, outputDir });
  try {
    await bridge.start();
    const address = bridge.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const expectedBuildSha = "b".repeat(40);

    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).summaryEnabled, true);

    const events = [
      {
        schema: "zentype-debug/v1",
        sessionId: "bridge-session",
        sequence: 1,
        timestamp: new Date(0).toISOString(),
        kind: "status",
        payload: {
          name: "session-start",
          label: "bridge test",
          profile: "forensic",
          buildSha: expectedBuildSha,
          startedAt: new Date(0).toISOString(),
          monotonicMs: 0,
          timingEvents: 1,
          forensicSnapshots: 0,
          mutationBatches: 0,
          serializedMutationRecords: 0,
        },
      },
      {
        ...event("bridge-session", 2, "profile-changed", 10, { profile: "timing" }),
        kind: "status",
      },
      event("other-session", 1, "mark", 20, { label: "other" }),
      event("bridge-session", 3, "structural-edit-finish", 30, {
        generation: 1,
        kind: "enter",
        stable: true,
        transactionStartedAt: 0,
        lastActivityAt: 0,
        finishedAt: 30,
      }),
      {
        schema: "zentype-debug/v1",
        sessionId: "bridge-session",
        sequence: 4,
        timestamp: new Date(0).toISOString(),
        kind: "status",
        payload: {
          name: "session-stop",
          stoppedAt: new Date(0).toISOString(),
        },
      },
    ];
    const response = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schema: "zentype-debug/v1", events }),
    });
    assert.equal(response.status, 202);
    const accepted = await response.json();
    assert.equal(accepted.accepted, 5);
    assert.equal(accepted.summaryPath.endsWith("summary.ndjson"), true);
    assert.equal(accepted.reportPath.endsWith("report.json"), true);

    await new Promise((resolve) => setTimeout(resolve, 140));
    const raw = readFileSync(path.join(outputDir, "sessions", "bridge-test__bridge-session", "events.ndjson"), "utf8");
    const otherRaw = readFileSync(path.join(outputDir, "sessions", "other__other-session", "events.ndjson"), "utf8");
    const summary = readFileSync(path.join(outputDir, "sessions", "bridge-test__bridge-session", "summary.ndjson"), "utf8");
    const report = JSON.parse(readFileSync(path.join(outputDir, "sessions", "bridge-test__bridge-session", "report.json"), "utf8"));
    const meta = JSON.parse(readFileSync(path.join(outputDir, "sessions", "bridge-test__bridge-session", "meta.json"), "utf8"));
    const latest = JSON.parse(readFileSync(path.join(outputDir, "latest-session.json"), "utf8"));
    const rawEvents = raw.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rawEvents.length, 4);
    assert.equal(rawEvents[0].payload.name, "session-start");
    assert.equal(rawEvents.at(-1).payload.name, "session-stop");
    assert.equal(otherRaw.trim().split("\n").length, 1);
    assert.equal(summary.trim().split("\n").length, 1);
    assert.equal(JSON.parse(summary).generation, 1);
    assert.equal(report.sessionId, "bridge-session");
    assert.equal(report.session.buildSha, expectedBuildSha);
    assert.equal(report.transactions, 1);
    assert.equal(report.stable, 1);
    assert.equal(meta.label, "bridge test");
    assert.equal(meta.profile, "timing");
    assert.equal(meta.buildSha, expectedBuildSha);
    assert.equal(meta.stoppedAt, new Date(0).toISOString());
    assert.equal(latest.sessionId, "bridge-session");
    assert.equal(latest.profile, "timing");
    assert.equal(latest.buildSha, expectedBuildSha);
    assert.equal(latest.directory, "sessions/bridge-test__bridge-session");
  } finally {
    await bridge.stop();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("Bridge persists standalone structural observations separately from transactions", async () => {
  const outputDir = mkdtempSync(path.join(process.cwd(), ".tmp-debug-bridge-observation-"));
  const bridge = createDebugBridge({ port: 0, outputDir });
  try {
    await bridge.start();
    const address = bridge.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const events = [
      event("observation-session", 1, "structural-edit-finish", 0, {
        generation: 7,
        kind: "enter",
        stable: true,
        transactionStartedAt: 0,
        lastActivityAt: 0,
        finishedAt: 0,
        currentBlockId: "block-a",
      }),
      event("observation-session", 2, "mutation", 200, {
        structural: { generation: 7, phase: "idle", kind: "enter" },
        semanticClassification: "structural",
        currentBlockId: "block-z",
        addedBlockIds: ["block-z"],
      }),
      {
        schema: "zentype-debug/v1",
        sessionId: "observation-session",
        sequence: 3,
        timestamp: new Date(0).toISOString(),
        kind: "status",
        payload: {
          name: "session-stop",
          stoppedAt: new Date(0).toISOString(),
        },
      },
    ];
    const response = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schema: "zentype-debug/v1", events }),
    });
    assert.equal(response.status, 202);

    await new Promise((resolve) => setTimeout(resolve, 140));
    const summary = readFileSync(path.join(outputDir, "sessions", "session-observation-session__observation-session", "summary.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const report = JSON.parse(readFileSync(path.join(outputDir, "sessions", "session-observation-session__observation-session", "report.json"), "utf8"));
    const meta = JSON.parse(readFileSync(path.join(outputDir, "sessions", "session-observation-session__observation-session", "meta.json"), "utf8"));
    const latest = JSON.parse(readFileSync(path.join(outputDir, "latest-session.json"), "utf8"));
    assert.equal(summary.length, 2);
    assert.equal(summary[0].operation, "structural");
    assert.equal(summary[1].operation, "structural-observation");
    assert.equal(summary[1].generation, null);
    assert.deepEqual(summary[1].anomalies, ["IDLE_SEMANTIC_MUTATION"]);
    assert.equal(report.transactions, 1);
    assert.equal(report.structuralObservations, 1);
    assert.equal(meta.buildSha, null);
    assert.equal(latest.buildSha, null);
  } finally {
    await bridge.stop();
    rmSync(outputDir, { recursive: true, force: true });
  }
});
