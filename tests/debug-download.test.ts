import assert from "node:assert/strict";
import test from "node:test";
import {
  createDebugBundleFilename,
  downloadDebugBundle,
} from "../src/debug/download";

test("Debug bundle filename contains local timestamp and fingerprint prefix", () => {
  assert.equal(
    createDebugBundleFilename("abcdef0123456789", new Date(2026, 8, 7, 4, 5, 6)),
    "zentype-debug-20260907-040506-abcdef01.json",
  );
  assert.equal(
    createDebugBundleFilename(null, new Date(2026, 0, 2, 3, 4, 5)),
    "zentype-debug-20260102-030405-unknown.json",
  );
});

test("Debug bundle download uses JSON MIME and revokes its Object URL", () => {
  let createdBlob: { parts: BlobPart[]; options: BlobPropertyBag } | null = null;
  let clicked = false;
  let removed = false;
  let revoked = "";
  let deferred: (() => void) | null = null;
  const anchor = {
    href: "",
    download: "",
    style: { display: "" },
    click: () => { clicked = true; },
    remove: () => { removed = true; },
  };
  downloadDebugBundle("{\"schema\":\"zentype-debug-bundle/v1\"}", "recording.json", {
    document: {
      createElement: () => anchor,
      body: { appendChild: () => anchor },
    } as unknown as Document,
    url: {
      createObjectURL: (value: Blob) => {
        assert.ok(value);
        return "blob:debug";
      },
      revokeObjectURL: (value: string) => { revoked = value; },
    },
    Blob: class {
      constructor(parts: BlobPart[], options: BlobPropertyBag) {
        createdBlob = { parts, options };
      }
    } as unknown as typeof Blob,
    defer: (callback) => { deferred = callback; },
  });
  assert.equal(anchor.href, "blob:debug");
  assert.equal(anchor.download, "recording.json");
  assert.equal(anchor.style.display, "none");
  assert.equal(clicked, true);
  assert.equal(removed, true);
  assert.deepEqual(createdBlob, {
    parts: ["{\"schema\":\"zentype-debug-bundle/v1\"}"],
    options: { type: "application/json;charset=utf-8" },
  });
  deferred?.();
  assert.equal(revoked, "blob:debug");
});
