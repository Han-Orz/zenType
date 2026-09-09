import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { gzipSync, inflateRawSync } from "node:zlib";

const forbidden = [
  "DebugKit",
  "__zentypeDebug",
  "zentype-debug/",
  "zentype-debug-",
  "structure-sample",
  "frame-start",
  "ownership-commit",
  "recordMutations",
  "mutationBatches",
  "createDebugBundleFilename",
  "downloadDebugBundle",
  "buildSha",
  "buildFingerprint",
  "computedStyleReads",
  "domNodesSerialized",
  "serializedMutationRecords",
  "forensic",
];
const requiredInDevelopment = ["DebugKit", "zentype-debug-", "structure-sample", "frame-start"];

function build(...args) {
  execFileSync(process.execPath, ["build.js", ...args], { stdio: "inherit" });
}

function assertMarkers(label, contents, markers, present) {
  const failures = markers.filter(marker => contents.includes(marker) !== present);
  if (failures.length) {
    throw new Error(`${label} ${present ? "is missing" : "contains"}: ${failures.join(", ")}`);
  }
}

/** Read one entry from the non-ZIP64 archive emitted by archiver. */
function readZipEntry(archive, wanted) {
  let eocd = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset--) {
    if (archive.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("package.zip has no end-of-central-directory record");
  const entries = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  for (let index = 0; index < entries; index++) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("package.zip central directory is invalid");
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name === wanted) {
      if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`${wanted} local header is invalid`);
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const bytes = archive.subarray(start, start + compressedSize);
      if (method === 0) return bytes;
      if (method === 8) return inflateRawSync(bytes);
      throw new Error(`${wanted} uses unsupported ZIP method ${method}`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${wanted} is missing from package.zip`);
}

build("--zip");
if (existsSync("dist/index.js.map")) throw new Error("production source map must not be emitted");
const production = readFileSync("dist/index.js");
const archive = readFileSync("package.zip");
const packaged = readZipEntry(archive, "index.js");
assertMarkers("dist/index.js", production.toString("utf8"), forbidden, false);
assertMarkers("package.zip:index.js", packaged.toString("utf8"), forbidden, false);
if (!production.equals(packaged)) throw new Error("package.zip:index.js differs from dist/index.js");

build("--dev");
const development = readFileSync("dev/index.js");
assertMarkers("dev/index.js", development.toString("utf8"), requiredInDevelopment, true);

console.log(JSON.stringify({
  productionBytes: production.length,
  productionGzipBytes: gzipSync(production).length,
  developmentBytes: development.length,
  developmentGzipBytes: gzipSync(development).length,
  packageZipBytes: statSync("package.zip").size,
}, null, 2));
