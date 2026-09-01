import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = mkdtempSync(path.join(root, ".tmp-tests-"));
const testEntries = [
  "immediate-fixes.test.ts",
  "characterization.test.ts",
  "ripple-semantic.test.ts",
  "ripple-dom-adapter.test.ts",
  "ripple-style-applier.test.ts",
  "ripple-nested-engine.test.ts",
];
const outfiles = testEntries.map((entry) => path.join(outdir, entry.replace(/\.ts$/, ".mjs")));

try {
  for (let index = 0; index < testEntries.length; index++) {
    await build({
      entryPoints: [path.join(root, "tests", testEntries[index])],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: outfiles[index],
      sourcemap: "inline",
      loader: { ".ts": "ts" },
      plugins: [{
        name: "siyuan-shim",
        setup(build) {
          build.onResolve({ filter: /^siyuan$/ }, () => ({
            path: path.join(root, "tests", "stubs", "siyuan.ts"),
          }));
        },
      }],
    });
  }

  const result = spawnSync(process.execPath, ["--test", ...outfiles], {
    cwd: root,
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outdir, { recursive: true, force: true });
}
