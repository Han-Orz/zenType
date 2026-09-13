import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = mkdtempSync(path.join(root, ".tmp-tests-"));
try {
  const entries = ["remake.test.ts", "layoutContinuity.test.ts", "rippleStructuralFocus.test.ts"];
  const outputs = [];
  for (const entry of entries) {
    const outfile = path.join(outdir, entry.replace(/\.ts$/, ".mjs"));
    await build({ entryPoints: [path.join(root, "tests", entry)], bundle: true,
      platform: "node", format: "esm", outfile, sourcemap: "inline",
      plugins: [{ name: "session-frame-fixture", setup(builder) {
        builder.onLoad({ filter: /[\\/]utils[\\/]editorScope\.ts$/ }, () => ({ contents:
          "export const readEditorFrame = (...args) => globalThis.sessionFixture.read(...args);" +
          "export const editableAt = target => globalThis.sessionFixture.editableAt(target);" }));
      } }] });
    outputs.push(outfile);
  }
  const result = spawnSync(process.execPath, ["--test", ...outputs], { cwd: root, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  const resolved = path.resolve(outdir);
  if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith(".tmp-tests-")) {
    throw new Error("Refusing cleanup outside the temporary test directory");
  }
  rmSync(resolved, { recursive: true, force: true });
}
