import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = mkdtempSync(path.join(root, ".tmp-tests-"));
try {
  const outfile = path.join(outdir, "remake.test.mjs");
  await build({ entryPoints: [path.join(root, "tests/remake.test.ts")], bundle: true,
    platform: "node", format: "esm", outfile, sourcemap: "inline" });
  const result = spawnSync(process.execPath, ["--test", outfile], { cwd: root, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  const resolved = path.resolve(outdir);
  if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith(".tmp-tests-")) {
    throw new Error("Refusing cleanup outside the temporary test directory");
  }
  rmSync(resolved, { recursive: true, force: true });
}
