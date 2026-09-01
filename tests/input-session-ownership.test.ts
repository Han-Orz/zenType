import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const DIRECT_SESSION_WRITE = /\binputMode\.setBoth(?:On|Off)\s*\(/g;
const ALLOWED_FILES = new Set(["inputMode.ts", "inputModeTriggers.ts"]);

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(fullPath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [fullPath] : [];
  });
}

test("input session ON/OFF writes stay behind the semantic trigger boundary", () => {
  const offenders: string[] = [];
  for (const file of productionTypeScriptFiles(path.join(process.cwd(), "src"))) {
    if (ALLOWED_FILES.has(path.basename(file))) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(DIRECT_SESSION_WRITE)) {
      const line = source.slice(0, match.index ?? 0).split(/\r?\n/).length;
      offenders.push(`${path.relative(process.cwd(), file)}:${line}`);
    }
  }

  assert.deepEqual(offenders, []);
});
