import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = mkdtempSync(path.join(root, ".tmp-tests-"));
const outfile = path.join(outdir, "immediate-fixes.test.mjs");

try {
  await build({
    entryPoints: [path.join(root, "tests", "immediate-fixes.test.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
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

  const result = spawnSync(process.execPath, ["--test", outfile], {
    cwd: root,
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outdir, { recursive: true, force: true });
}
