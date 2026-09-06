import type {
  DebugEnvelope,
  DebugTransportCounters,
  DebugTransportState,
} from "./types";

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:27369";
const HEALTH_TIMEOUT_MS = 400;
const FLUSH_DELAY_MS = 80;
const MAX_PENDING_EVENTS = 500;
const SCHEMA = "zentype-debug/v1";

type FetchResponseLike = {
  ok?: boolean;
  status?: number;
};

type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<FetchResponseLike>;

export interface DebugTransportOptions {
  bridgeUrl?: string;
  fetcher?: FetchLike;
  healthTimeoutMs?: number;
  flushDelayMs?: number;
}

export interface DebugTransport {
  reset(sessionId: string, bridgeUrl?: string): void;
  enqueue(event: DebugEnvelope): void;
  probe(): Promise<boolean>;
  flush(): Promise<void>;
  reconnect(): Promise<boolean>;
  getState(): DebugTransportCounters;
  getPendingCount(): number;
  clearPending(): void;
  destroy(): void;
}

function byteLength(value: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).byteLength;
  return value.length;
}

function responseFailed(response: FetchResponseLike): boolean {
  return response.ok === false || (
    typeof response.status === "number" && response.status >= 400
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

async function fetchWithTimeout(
  fetcher: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<FetchResponseLike> {
  const controller = typeof AbortController !== "undefined"
    ? new AbortController()
    : null;
  const requestInit = controller ? { ...init, signal: controller.signal } : init;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fetcher(url, requestInit),
      new Promise<FetchResponseLike>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller?.abort();
          reject(new Error(`request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export function createDebugTransport(options: DebugTransportOptions = {}): DebugTransport {
  let bridgeUrl = options.bridgeUrl ?? DEFAULT_BRIDGE_URL;
  const fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  const healthTimeoutMs = options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
  const flushDelayMs = options.flushDelayMs ?? FLUSH_DELAY_MS;
  let sessionId = "";
  let state: DebugTransportState = "unknown";
  let transportFailures = 0;
  let batchesSent = 0;
  let eventsSent = 0;
  let bytesSent = 0;
  let lastTransportError: string | null = null;
  let pending: DebugEnvelope[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushInFlight: Promise<void> | null = null;
  let destroyed = false;

  function setState(next: DebugTransportState): void {
    state = next;
  }

  function clearFlushTimer(): void {
    if (flushTimer === null) return;
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  function scheduleFlush(): void {
    if (destroyed || state !== "online" || pending.length === 0 || flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, flushDelayMs);
  }

  function recordFailure(error: unknown): void {
    transportFailures += 1;
    lastTransportError = errorMessage(error);
    setState("offline");
  }

  async function send(batch: readonly DebugEnvelope[]): Promise<void> {
    const body = JSON.stringify({ schema: SCHEMA, sessionId, events: batch });
    const response = await fetchWithTimeout(
      fetcher,
      `${bridgeUrl}/events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
      healthTimeoutMs,
    );
    if (responseFailed(response)) {
      throw new Error(`bridge returned HTTP ${response.status ?? "error"}`);
    }
    batchesSent += 1;
    eventsSent += batch.length;
    bytesSent += byteLength(body);
  }

  async function flush(): Promise<void> {
    clearFlushTimer();
    if (destroyed || state !== "online" || pending.length === 0) return;
    if (flushInFlight) {
      await flushInFlight;
      if (!destroyed && state === "online" && pending.length > 0) return flush();
      return;
    }

    const batch = pending.splice(0, pending.length);
    flushInFlight = send(batch)
      .catch((error) => {
        pending = [...batch, ...pending].slice(-MAX_PENDING_EVENTS);
        recordFailure(error);
      })
      .finally(() => {
        flushInFlight = null;
        if (state === "online") scheduleFlush();
      });
    return flushInFlight;
  }

  async function probe(): Promise<boolean> {
    if (destroyed) return false;
    setState("probing");
    try {
      const response = await fetchWithTimeout(
        fetcher,
        `${bridgeUrl}/health`,
        { method: "GET", headers: { Accept: "application/json" } },
        healthTimeoutMs,
      );
      if (responseFailed(response)) {
        throw new Error(`bridge health returned HTTP ${response.status ?? "error"}`);
      }
      lastTransportError = null;
      setState("online");
      scheduleFlush();
      return true;
    } catch (error) {
      recordFailure(error);
      return false;
    }
  }

  return {
    reset(nextSessionId, nextBridgeUrl) {
      clearFlushTimer();
      sessionId = nextSessionId;
      if (nextBridgeUrl) bridgeUrl = nextBridgeUrl;
      state = "unknown";
      transportFailures = 0;
      batchesSent = 0;
      eventsSent = 0;
      bytesSent = 0;
      lastTransportError = null;
      pending = [];
      destroyed = false;
    },
    enqueue(event) {
      if (destroyed) return;
      pending.push(event);
      if (pending.length > MAX_PENDING_EVENTS) pending = pending.slice(-MAX_PENDING_EVENTS);
      scheduleFlush();
    },
    probe,
    flush,
    async reconnect() {
      const online = await probe();
      if (online) await flush();
      return online;
    },
    getState() {
      return {
        transportState: state,
        transportFailures,
        batchesSent,
        eventsSent,
        bytesSent,
        lastTransportError,
      };
    },
    getPendingCount() {
      return pending.length;
    },
    clearPending() {
      pending = [];
      clearFlushTimer();
    },
    destroy() {
      destroyed = true;
      clearFlushTimer();
      pending = [];
    },
  };
}

export { DEFAULT_BRIDGE_URL, FLUSH_DELAY_MS, HEALTH_TIMEOUT_MS };
