import assert from "node:assert/strict";
import test from "node:test";
import { resolveBuildSha } from "../build.js";

test("build fingerprint accepts a full Git SHA and falls back when Git is unavailable", () => {
  const expected = "a".repeat(40);
  assert.equal(resolveBuildSha(() => `${expected}\n`), expected);
  assert.equal(resolveBuildSha(() => { throw new Error("git unavailable"); }), "unknown");
  assert.equal(resolveBuildSha(() => "not-a-commit"), "unknown");
});
