import assert from "node:assert/strict";
import test from "node:test";
import { resolveBuildSha, resolveBuildFingerprint } from "../build.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("build fingerprint accepts a full Git SHA and falls back when Git is unavailable", () => {
  const expected = "a".repeat(40);
  assert.equal(resolveBuildSha(() => `${expected}\n`), expected);
  assert.equal(resolveBuildSha(() => { throw new Error("git unavailable"); }), "unknown");
  assert.equal(resolveBuildSha(() => "not-a-commit"), "unknown");
});

test("source fingerprint detects uncommitted content and build mode, not timestamps", () => {
  const root = mkdtempSync(path.join(tmpdir(), "zentype-fingerprint-"));
  try {
    mkdirSync(path.join(root, "src"));
    for (const file of ["build.js", "package.json", "pnpm-lock.yaml", "tsconfig.json", "plugin.json", "src/index.ts"]) writeFileSync(path.join(root, file), file);
    const original = resolveBuildFingerprint(root, true);
    assert.match(original, /^[0-9a-f]{64}$/);
    assert.equal(resolveBuildFingerprint(root, true), original);
    assert.notEqual(resolveBuildFingerprint(root, false), original);
    writeFileSync(path.join(root, "src/index.ts"), "changed without commit");
    assert.notEqual(resolveBuildFingerprint(root, true), original);
    writeFileSync(path.join(root, "src/index.ts"), "src/index.ts");
    assert.equal(resolveBuildFingerprint(root, true), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
