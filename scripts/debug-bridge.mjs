import http from "node:http";
import path from "node:path";
import {
  appendFile,
  mkdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createDebugSummary } from "./debug-summary.mjs";

const SCHEMA = "zentype-debug/v1";
const DEFAULT_PORT = 27369;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_ROTATED_LOGS = 3;
const DEFAULT_OUTPUT_DIR = path.join(process.cwd(), ".debug");
const SESSIONS_DIR_NAME = "sessions";
const EVENTS_FILE_NAME = "events.ndjson";
const SUMMARY_FILE_NAME = "summary.ndjson";
const REPORT_FILE_NAME = "report.json";
const META_FILE_NAME = "meta.json";
const LATEST_SNAPSHOT_FILE_NAME = "latest-snapshot.json";
const LATEST_SESSION_FILE_NAME = "latest-session.json";

function jsonResponse(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Private-Network", "true");
  response.setHeader("Cache-Control", "no-store");
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(chunks.join("")));
    request.on("error", reject);
  });
}

function sanitizeSegment(value, fallback) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return normalized || fallback;
}

function relativeDirectory(outputDir, directory) {
  return path.relative(outputDir, directory).split(path.sep).join("/");
}

async function fileSize(filePath) {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

async function rotateLogs(logPath) {
  for (let index = MAX_ROTATED_LOGS; index >= 1; index -= 1) {
    const source = index === 1 ? logPath : `${logPath}.${index - 1}`;
    const target = `${logPath}.${index}`;
    try {
      await rm(target, { force: true });
      await rename(source, target);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function appendSummaryRecords(summaryPath, records) {
  if (!Array.isArray(records) || records.length === 0) return 0;
  const text = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  await appendFile(summaryPath, text, "utf8");
  return records.length;
}

function payloadOf(event) {
  return event?.payload && typeof event.payload === "object" ? event.payload : {};
}

function eventName(event) {
  const payload = payloadOf(event);
  return typeof payload.name === "string" ? payload.name : "";
}

function validProfile(value) {
  return value === "timing" || value === "forensic" ? value : "timing";
}

function buildShaFromPayload(payload) {
  return typeof payload.buildSha === "string" && payload.buildSha.trim()
    ? payload.buildSha.trim()
    : null;
}

function sessionMetaFromEvent(sessionId, event) {
  const payload = payloadOf(event);
  const eventLabel = typeof payload.label === "string" ? payload.label : "";
  const label = eventLabel.trim() || `session-${sanitizeSegment(sessionId, "unknown")}`;
  const profile = validProfile(payload.profile);
  const buildSha = buildShaFromPayload(payload);
  const startedAt = typeof payload.startedAt === "string"
    ? payload.startedAt
    : typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString();
  return {
    sessionId,
    label,
    directory: "",
    profile,
    buildSha,
    startedAt,
    stoppedAt: null,
  };
}

async function writeMeta(context) {
  await writeFile(context.metaPath, `${JSON.stringify(context.meta, null, 2)}\n`, "utf8");
}

async function writeLatestSession(outputDir, context) {
  const latest = {
    sessionId: context.meta.sessionId,
    label: context.meta.label,
    directory: context.meta.directory,
    profile: context.meta.profile,
    buildSha: context.meta.buildSha ?? null,
    startedAt: context.meta.startedAt,
    stoppedAt: context.meta.stoppedAt,
  };
  await writeFile(
    path.join(outputDir, LATEST_SESSION_FILE_NAME),
    `${JSON.stringify(latest, null, 2)}\n`,
    "utf8",
  );
}

async function createSessionContext(outputDir, sessionId, event) {
  const meta = sessionMetaFromEvent(sessionId, event);
  const directoryName = `${sanitizeSegment(meta.label, "session")}__${sanitizeSegment(sessionId, "unknown")}`;
  const directory = path.join(outputDir, SESSIONS_DIR_NAME, directoryName);
  meta.directory = relativeDirectory(outputDir, directory);
  await mkdir(directory, { recursive: true });
  const context = {
    outputDir,
    directory,
    meta,
    metaPath: path.join(directory, META_FILE_NAME),
    eventsPath: path.join(directory, EVENTS_FILE_NAME),
    summaryPath: path.join(directory, SUMMARY_FILE_NAME),
    reportPath: path.join(directory, REPORT_FILE_NAME),
    latestSnapshotPath: path.join(directory, LATEST_SNAPSHOT_FILE_NAME),
    summaryState: createDebugSummary(sessionId),
  };
  return context;
}

async function appendRawEvents(context, events) {
  const text = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  if ((await fileSize(context.eventsPath)) + Buffer.byteLength(text) > MAX_LOG_BYTES) {
    await rotateLogs(context.eventsPath);
    await writeFile(context.eventsPath, "", "utf8");
  }
  await appendFile(context.eventsPath, text, "utf8");
}

async function persistSummaryState(context, summaryRecords = context.summaryState.drainFinalized()) {
  const summaryAccepted = await appendSummaryRecords(context.summaryPath, summaryRecords);
  const report = {
    ...context.summaryState.getReport(),
    session: {
      sessionId: context.meta.sessionId,
      label: context.meta.label,
      directory: context.meta.directory,
      profile: context.meta.profile,
      buildSha: context.meta.buildSha ?? null,
      startedAt: context.meta.startedAt,
      stoppedAt: context.meta.stoppedAt,
    },
  };
  await writeFile(context.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return summaryAccepted;
}

function updateMetaFromEvent(context, event) {
  const payload = payloadOf(event);
  if (eventName(event) === "session-stop") {
    context.meta.stoppedAt = typeof payload.stoppedAt === "string"
      ? payload.stoppedAt
      : typeof event.timestamp === "string" ? event.timestamp : context.meta.stoppedAt;
  }
  if (eventName(event) === "session-start") {
    if (typeof payload.label === "string" && payload.label.trim()) context.meta.label = payload.label;
    context.meta.profile = validProfile(payload.profile);
    if (typeof payload.startedAt === "string") context.meta.startedAt = payload.startedAt;
    if (Object.prototype.hasOwnProperty.call(payload, "buildSha")) {
      context.meta.buildSha = buildShaFromPayload(payload);
    }
  }
  if (eventName(event) === "profile-changed") {
    context.meta.profile = validProfile(payload.profile);
  }
}

function ensureSessionIds(events) {
  return [...new Set(events.map((event) => (
    typeof event?.sessionId === "string" && event.sessionId.length > 0
      ? event.sessionId
      : "unknown"
  )))];
}

export async function appendEvents(outputDir, events, sessions = new Map()) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error("payload.events must be a non-empty array");
  }
  const validEvents = events.filter((event) => (
    event
    && typeof event === "object"
    && event.schema === SCHEMA
    && typeof event.kind === "string"
  ));
  if (validEvents.length === 0) throw new Error("payload contains no valid debug events");

  await mkdir(path.join(outputDir, SESSIONS_DIR_NAME), { recursive: true });
  let summaryAccepted = 0;
  const lastEvent = validEvents[validEvents.length - 1];
  const latestSessionId = typeof lastEvent.sessionId === "string"
    && lastEvent.sessionId.length > 0
    ? lastEvent.sessionId
    : "unknown";
  const groups = new Map();
  for (const event of validEvents) {
    const sessionId = typeof event.sessionId === "string" && event.sessionId.length > 0
      ? event.sessionId
      : "unknown";
    const group = groups.get(sessionId) ?? [];
    group.push(event);
    groups.set(sessionId, group);
  }

  for (const [sessionId, sessionEvents] of groups) {
    let context = sessions.get(sessionId);
    if (!context || !context.directory) {
      context = await createSessionContext(outputDir, sessionId, sessionEvents[0]);
      sessions.set(sessionId, context);
    }
    await appendRawEvents(context, sessionEvents);
    const summaryRecords = [];
    let latestSnapshot = null;
    for (const event of sessionEvents) {
      updateMetaFromEvent(context, event);
      summaryRecords.push(...context.summaryState.accept(event));
      if (event.kind === "snapshot") latestSnapshot = event;
    }
    summaryAccepted += await persistSummaryState(context, summaryRecords);
    await writeMeta(context);
    if (latestSnapshot) {
      await writeFile(context.latestSnapshotPath, `${JSON.stringify(latestSnapshot, null, 2)}\n`, "utf8");
    }
  }
  const latest = latestSessionId ? sessions.get(latestSessionId) : null;
  if (latest) await writeLatestSession(outputDir, latest);
  return {
    accepted: validEvents.length,
    sessionDir: latest?.directory ?? null,
    metaPath: latest?.metaPath ?? null,
    eventsPath: latest?.eventsPath ?? null,
    latestSnapshotPath: latest?.latestSnapshotPath ?? null,
    summaryAccepted,
    summaryPath: latest?.summaryPath ?? null,
    reportPath: latest?.reportPath ?? null,
    latestSessionPath: path.join(outputDir, LATEST_SESSION_FILE_NAME),
    latestSessionId,
    sessionIds: ensureSessionIds(validEvents),
  };
}

export function parseArgs(argv) {
  const options = {
    port: DEFAULT_PORT,
    outputDir: DEFAULT_OUTPUT_DIR,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--port" && argv[index + 1]) {
      options.port = Number(argv[++index]);
    } else if (argument.startsWith("--port=")) {
      options.port = Number(argument.slice("--port=".length));
    } else if (argument === "--dir" && argv[index + 1]) {
      options.outputDir = path.resolve(argv[++index]);
    } else if (argument.startsWith("--dir=")) {
      options.outputDir = path.resolve(argument.slice("--dir=".length));
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    }
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    if (options.port !== 0) throw new Error(`invalid port: ${options.port}`);
  }
  return options;
}

export function createDebugBridge({ port = DEFAULT_PORT, outputDir = DEFAULT_OUTPUT_DIR } = {}) {
  let writeQueue = Promise.resolve();
  let latestSessionId = null;
  const sessions = new Map();
  const summaryTimers = new Map();

  const enqueueSummaryFinalization = (sessionId) => {
    const existingTimer = summaryTimers.get(sessionId);
    if (existingTimer) clearTimeout(existingTimer);
    const context = sessions.get(sessionId);
    const summaryState = context?.summaryState;
    const dueAt = summaryState?.nextFinalizationAt();
    const delay = summaryState?.nextFinalizationDelayMs();
    if (dueAt === null || dueAt === undefined || delay === null || delay === undefined) {
      summaryTimers.delete(sessionId);
      return;
    }
    const timer = setTimeout(() => {
      summaryTimers.delete(sessionId);
      writeQueue = writeQueue
        .catch(() => undefined)
        .then(async () => {
          const current = sessions.get(sessionId);
          if (!current) return;
          const currentDueAt = current.summaryState.nextFinalizationAt();
          if (currentDueAt !== null && currentDueAt <= dueAt) {
            current.summaryState.finalizeDue(dueAt);
          }
          await persistSummaryState(current);
          enqueueSummaryFinalization(sessionId);
        });
    }, delay);
    summaryTimers.set(sessionId, timer);
  };

  const server = http.createServer((request, response) => {
    setCorsHeaders(response);
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      jsonResponse(response, 200, {
        schema: SCHEMA,
        ok: true,
        port,
        outputDir,
        summaryEnabled: true,
        sessionOriented: true,
      });
      return;
    }
    if (request.method !== "POST" || request.url !== "/events") {
      jsonResponse(response, 404, { error: "not found" });
      return;
    }

    void readRequestBody(request)
      .then((body) => {
        const payload = JSON.parse(body);
        const events = Array.isArray(payload) ? payload : payload?.events;
        writeQueue = writeQueue
          .catch(() => undefined)
          .then(async () => {
            const result = await appendEvents(outputDir, events, sessions);
            if (result.latestSessionId) latestSessionId = result.latestSessionId;
            for (const sessionId of result.sessionIds) enqueueSummaryFinalization(sessionId);
            return result;
          });
        return writeQueue;
      })
      .then((result) => jsonResponse(response, 202, result))
      .catch((error) => {
        const statusCode = error?.message?.includes("exceeds") ? 413 : 400;
        jsonResponse(response, statusCode, { error: error?.message ?? String(error) });
      });
  });

  return {
    server,
    start() {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
    },
    async stop() {
      for (const timer of summaryTimers.values()) clearTimeout(timer);
      summaryTimers.clear();
      await writeQueue.catch(() => undefined);
      for (const context of sessions.values()) {
        await persistSummaryState(context, context.summaryState.flush());
        await writeMeta(context);
      }
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function printHelp() {
  console.log("Usage: pnpm run debug:bridge [--port 27369] [--dir .debug]");
  console.log("Listens only on 127.0.0.1 and writes session-oriented raw, summary, report, and snapshot files.");
}

const isMain = process.argv[1]
  && path.basename(process.argv[1]) === "debug-bridge.mjs";

if (isMain) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[debug-bridge] ${error.message}`);
    process.exitCode = 1;
  }
  if (options?.help) {
    printHelp();
  } else if (options) {
    const bridge = createDebugBridge(options);
    bridge.start()
      .then(() => {
        console.log(`[debug-bridge] listening on http://127.0.0.1:${options.port}`);
        console.log(`[debug-bridge] output directory: ${options.outputDir}`);
      })
      .catch((error) => {
        console.error(`[debug-bridge] failed to start: ${error.message}`);
        process.exitCode = 1;
      });
    const shutdown = () => {
      bridge.stop()
        .catch((error) => console.error(`[debug-bridge] failed to stop: ${error.message}`))
        .finally(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
}

export {
  EVENTS_FILE_NAME,
  LATEST_SESSION_FILE_NAME,
  LATEST_SNAPSHOT_FILE_NAME,
  META_FILE_NAME,
  REPORT_FILE_NAME,
  SESSIONS_DIR_NAME,
  SUMMARY_FILE_NAME,
  sanitizeSegment,
};
