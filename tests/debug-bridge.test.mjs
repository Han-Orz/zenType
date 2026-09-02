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
          state: "started",
          monotonicMs: 0,
          timingEvents: 1,
          forensicSnapshots: 0,
          mutationBatches: 0,
          serializedMutationRecords: 0,
        },
      },
      event("bridge-session", 2, "structural-edit-finish", 30, {
        generation: 1,
        kind: "enter",
        stable: true,
        transactionStartedAt: 0,
        lastActivityAt: 0,
        finishedAt: 30,
      }),
    ];
    const response = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schema: "zentype-debug/v1", events }),
    });
    assert.equal(response.status, 202);
    const accepted = await response.json();
    assert.equal(accepted.accepted, 2);
    assert.equal(accepted.summaryPath.endsWith("siyuan-hook.summary.ndjson"), true);
    assert.equal(accepted.reportPath.endsWith("siyuan-hook.report.json"), true);

    await new Promise((resolve) => setTimeout(resolve, 140));
    const raw = readFileSync(path.join(outputDir, "siyuan-hook.ndjson"), "utf8");
    const summary = readFileSync(path.join(outputDir, "siyuan-hook.summary.ndjson"), "utf8");
    const report = JSON.parse(readFileSync(path.join(outputDir, "siyuan-hook.report.json"), "utf8"));
    assert.equal(raw.trim().split("\n").length, 2);
    assert.equal(summary.trim().split("\n").length, 1);
    assert.equal(JSON.parse(summary).generation, 1);
    assert.equal(report.sessionId, "bridge-session");
    assert.equal(report.transactions, 1);
    assert.equal(report.stable, 1);
  } finally {
    await bridge.stop();
    rmSync(outputDir, { recursive: true, force: true });
  }
});
