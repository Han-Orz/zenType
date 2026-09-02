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
const SUMMARY_FILE_NAME = "siyuan-hook.summary.ndjson";
const REPORT_FILE_NAME = "siyuan-hook.report.json";

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

async function persistSummaryState(
  outputDir,
  summaryState,
  writeReport = true,
  summaryRecords = summaryState.drainFinalized(),
) {
  await mkdir(outputDir, { recursive: true });
  const summaryPath = path.join(outputDir, SUMMARY_FILE_NAME);
  const reportPath = path.join(outputDir, REPORT_FILE_NAME);
  const summaryAccepted = await appendSummaryRecords(summaryPath, summaryRecords);
  if (writeReport) {
    await writeFile(reportPath, `${JSON.stringify(summaryState.getReport(), null, 2)}\n`, "utf8");
  }
  return { summaryAccepted, summaryPath, reportPath };
}

export async function appendEvents(outputDir, events, summarySessions = new Map()) {
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

  await mkdir(outputDir, { recursive: true });
  const logPath = path.join(outputDir, "siyuan-hook.ndjson");
  const latestPath = path.join(outputDir, "siyuan-hook.latest.json");
  const text = `${validEvents.map((event) => JSON.stringify(event)).join("\n")}\n`;
  if ((await fileSize(logPath)) + Buffer.byteLength(text) > MAX_LOG_BYTES) {
    await rotateLogs(logPath);
    await writeFile(logPath, "", "utf8");
  }
  await appendFile(logPath, text, "utf8");

  const latestSnapshot = [...validEvents]
    .reverse()
    .find((event) => event.kind === "snapshot");
  if (latestSnapshot) {
    await writeFile(latestPath, `${JSON.stringify(latestSnapshot, null, 2)}\n`, "utf8");
  }
  let latestSessionId = null;
  let summaryAccepted = 0;
  for (const event of validEvents) {
    const sessionId = typeof event.sessionId === "string" && event.sessionId.length > 0
      ? event.sessionId
      : "unknown";
    let summaryState = summarySessions.get(sessionId);
    if (!summaryState) {
      summaryState = createDebugSummary(sessionId);
      summarySessions.set(sessionId, summaryState);
    }
    const finalized = summaryState.accept(event);
    const persisted = await persistSummaryState(
      outputDir,
      summaryState,
      false,
      finalized,
    );
    summaryAccepted += persisted.summaryAccepted;
    latestSessionId = sessionId;
  }
  const latestSummaryState = latestSessionId ? summarySessions.get(latestSessionId) : null;
  const summaryPath = path.join(outputDir, SUMMARY_FILE_NAME);
  const reportPath = path.join(outputDir, REPORT_FILE_NAME);
  if (latestSummaryState) {
    await writeFile(reportPath, `${JSON.stringify(latestSummaryState.getReport(), null, 2)}\n`, "utf8");
  }
  return {
    accepted: validEvents.length,
    logPath,
    latestPath,
    summaryAccepted,
    summaryPath,
    reportPath,
    latestSessionId,
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
    throw new Error(`invalid port: ${options.port}`);
  }
  return options;
}

export function createDebugBridge({ port = DEFAULT_PORT, outputDir = DEFAULT_OUTPUT_DIR } = {}) {
  let writeQueue = Promise.resolve();
  let latestSessionId = null;
  const summarySessions = new Map();
  const summaryTimers = new Map();

  const enqueueSummaryFinalization = (sessionId) => {
    const existingTimer = summaryTimers.get(sessionId);
    if (existingTimer) clearTimeout(existingTimer);
    const summaryState = summarySessions.get(sessionId);
    const dueAt = summaryState?.nextFinalizationAt();
    const delay = summaryState?.nextFinalizationDelayMs();
    if (dueAt === null || delay === null) {
      summaryTimers.delete(sessionId);
      return;
    }
    const timer = setTimeout(() => {
      summaryTimers.delete(sessionId);
      writeQueue = writeQueue
        .catch(() => undefined)
        .then(async () => {
          const current = summarySessions.get(sessionId);
          if (!current) return;
          const currentDueAt = current.nextFinalizationAt();
          if (currentDueAt !== null && currentDueAt <= dueAt) {
            current.finalizeDue(dueAt);
          }
          await persistSummaryState(
            outputDir,
            current,
            sessionId === latestSessionId,
          );
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
            const result = await appendEvents(outputDir, events, summarySessions);
            if (result.latestSessionId) latestSessionId = result.latestSessionId;
            for (const event of events ?? []) {
              const sessionId = typeof event?.sessionId === "string" && event.sessionId.length > 0
                ? event.sessionId
                : "unknown";
              enqueueSummaryFinalization(sessionId);
            }
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
    stop() {
      return new Promise((resolve, reject) => {
        for (const timer of summaryTimers.values()) clearTimeout(timer);
        summaryTimers.clear();
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function printHelp() {
  console.log("Usage: pnpm run debug:bridge [--port 27369] [--dir .debug]");
  console.log("Listens only on 127.0.0.1 and writes raw, summary, report, and latest snapshot files.");
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
