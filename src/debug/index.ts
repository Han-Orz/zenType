import type { EventBus } from "siyuan";
import { createDebugCollector } from "./collector";
import {
  createDebugTransport,
  DEFAULT_BRIDGE_URL,
} from "./transport";
import type {
  DebugEnvelope,
  DebugHookController,
  DebugKitCounters,
  DebugKitState,
  DebugProfile,
  DebugSessionState,
  DebugStartOptions,
} from "./types";
import type { DebugWatch } from "./types";

const MAX_RECENT_EVENTS = 500;
const MAX_LABEL_LENGTH = 160;
const MAX_MARK_PAYLOAD_KEYS = 64;
const MAX_MARK_ARRAY_ITEMS = 32;
const MAX_MARK_DEPTH = 4;

function createSessionId(): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `zt-${random}`;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function monotonicNow(): number {
  if (typeof performance === "undefined" || typeof performance.now !== "function") return 0;
  try {
    const value = performance.now();
    return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
  } catch {
    return 0;
  }
}

function safeMarkValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return typeof value === "string" ? truncate(value, 2000) : value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth >= MAX_MARK_DEPTH) return "[depth-limit]";
  if (typeof value === "object" && seen.has(value)) return "[circular]";
  if (Array.isArray(value)) {
    seen.add(value);
    const result = value
      .slice(0, MAX_MARK_ARRAY_ITEMS)
      .map((item) => safeMarkValue(item, depth + 1, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_MARK_PAYLOAD_KEYS)) {
      result[truncate(key, 120)] = safeMarkValue(item, depth + 1, seen);
    }
    seen.delete(value);
    return result;
  }
  return String(value);
}

function safeMarkPayload(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!payload) return {};
  return safeMarkValue(payload) as Record<string, unknown>;
}

function emptyCounters(): DebugKitCounters {
  return {
    eventsCaptured: 0,
    mutationBatches: 0,
    snapshotsCaptured: 0,
    domNodesSerialized: 0,
    computedStyleReads: 0,
    watchSamples: 0,
    serializedMutationRecords: 0,
  };
}

export function initDebugHook(eventBus: EventBus): DebugHookController {
  const globalObject = globalThis as unknown as Record<string, unknown>;
  const previousApi = globalObject.__zentypeDebug ?? globalObject.__zentypeDebugHook as unknown;
  if (previousApi && typeof previousApi === "object") {
    const destroy = (previousApi as { destroy?: unknown }).destroy;
    if (typeof destroy === "function") {
      try {
        (destroy as () => void)();
      } catch {
        // A stale dev reload must not prevent the new API from being installed.
      }
    }
  }

  const recentEvents: DebugEnvelope[] = [];
  const watches = new Map<string, DebugWatch>();
  const counters = emptyCounters();
  const transport = createDebugTransport();
  let watchSequence = 0;
  let profile: DebugProfile = "timing";
  let bridgeUrl = DEFAULT_BRIDGE_URL;
  let active = false;
  let sessionId: string | null = null;
  let label: string | null = null;
  let startedAt: string | null = null;
  let stoppedAt: string | null = null;
  let sequence = 0;
  let destroyed = false;
  let lifecycleQueue: Promise<unknown> = Promise.resolve();

  const collector = createDebugCollector({
    eventBus,
    profile,
    getWatches: () => [...watches.values()],
    onEvent: (payload, reason) => publish("event", payload, reason),
    onMutationBatch: (serializedRecordCount) => {
      counters.mutationBatches += 1;
      counters.serializedMutationRecords += serializedRecordCount;
    },
    onWatchSamples: (count) => {
      counters.watchSamples += count;
    },
    onNodeSerialized: () => {
      counters.domNodesSerialized += 1;
    },
    onComputedStyleRead: () => {
      counters.computedStyleReads += 1;
    },
  });

  function sessionState(): DebugSessionState {
    return {
      active,
      sessionId,
      label,
      profile,
      startedAt,
      stoppedAt,
    };
  }

  function debugCounters(): Record<string, unknown> {
    return {
      ...counters,
      // Keep the names consumed by the existing summary engine.
      timingEvents: profile === "timing" ? counters.eventsCaptured : 0,
      forensicSnapshots: counters.snapshotsCaptured,
      mutationBatches: counters.mutationBatches,
      serializedMutationRecords: counters.serializedMutationRecords,
    };
  }

  function publish(
    kind: DebugEnvelope["kind"],
    payload: Record<string, unknown>,
    reason?: string,
  ): DebugEnvelope | null {
    if (destroyed || !active || !sessionId) return null;
    if (kind === "event") counters.eventsCaptured += 1;
    const envelope: DebugEnvelope = {
      schema: "zentype-debug/v1",
      sessionId,
      sequence: ++sequence,
      timestamp: new Date().toISOString(),
      kind,
      ...(reason ? { reason } : {}),
      payload: {
        ...payload,
        monotonicMs: monotonicNow(),
        debugCounters: debugCounters(),
      },
    };
    recentEvents.push(envelope);
    if (recentEvents.length > MAX_RECENT_EVENTS) recentEvents.shift();
    transport.enqueue(envelope);
    return envelope;
  }

  function resetSessionCounters(): void {
    Object.assign(counters, emptyCounters());
  }

  function enqueueLifecycle<T>(task: () => Promise<T>): Promise<T> {
    const run = lifecycleQueue.then(task, task);
    lifecycleQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function startInternal(
    nextLabel = "debug-session",
    options: DebugStartOptions = {},
  ): Promise<DebugSessionState> {
    if (destroyed) throw new Error("DebugKit has been destroyed");
    if (active) await stopInternal();

    profile = options.profile ?? profile;
    bridgeUrl = options.bridgeUrl ?? bridgeUrl;
    sessionId = createSessionId();
    label = truncate(nextLabel.trim() || "debug-session", MAX_LABEL_LENGTH);
    startedAt = new Date().toISOString();
    stoppedAt = null;
    active = true;
    sequence = 0;
    recentEvents.length = 0;
    resetSessionCounters();
    transport.reset(sessionId, bridgeUrl);
    collector.setProfile(profile);
    collector.resetNodeIdentity();

    // Keep the session-start envelope first. The collector must not be able
    // to publish anything before this marker establishes the new sequence.
    publish("status", {
      source: "debugkit",
      name: "session-start",
      label,
      profile,
      startedAt,
      transportState: transport.getState().transportState,
    }, "session-start");

    collector.attach();

    // This is the only automatic bridge request made at session start.
    await transport.probe();
    if (profile === "forensic") captureInternal("session-start");
    return sessionState();
  }

  async function stopInternal(): Promise<void> {
    if (!active || destroyed) return;
    if (profile === "forensic") captureInternal("session-stop");
    stoppedAt = new Date().toISOString();
    publish("status", {
      source: "debugkit",
      name: "session-stop",
      label,
      profile,
      startedAt,
      stoppedAt,
    }, "session-stop");
    collector.detach();
    active = false;
    await transport.flush();
  }

  function captureInternal(reason = "manual"): void {
    if (!active || destroyed || !sessionId) return;
    const snapshot = collector.createSnapshot(reason);
    counters.snapshotsCaptured += 1;
    publish("snapshot", snapshot as unknown as Record<string, unknown>, reason);
  }

  const controller: DebugHookController = {
    start(labelName, options) {
      return enqueueLifecycle(() => startInternal(labelName, options));
    },
    stop() {
      return enqueueLifecycle(stopInternal);
    },
    toggle() {
      return enqueueLifecycle(async () => {
        if (active) {
          await stopInternal();
          return false;
        }
        await startInternal("debug-session", { profile: "forensic" });
        return true;
      });
    },
    mark(markLabel, payload) {
      if (!active || destroyed) return;
      const safeLabel = truncate(markLabel.trim() || "mark", MAX_LABEL_LENGTH);
      publish("event", {
        ...safeMarkPayload(payload),
        source: "debugkit",
        name: "mark",
        label: safeLabel,
        ...collector.captureContext("mark"),
      }, "mark");
    },
    capture(reason = "manual") {
      captureInternal(reason);
    },
    watch(selector, watchLabel) {
      const normalizedSelector = selector.trim();
      if (!normalizedSelector) throw new Error("DebugKit watch selector must not be empty");
      if (watches.size >= 8) throw new Error("DebugKit supports at most 8 watches");
      const id = `w${++watchSequence}`;
      watches.set(id, {
        id,
        selector: normalizedSelector,
        label: truncate(watchLabel?.trim() || normalizedSelector, MAX_LABEL_LENGTH),
      });
      return id;
    },
    unwatch(id) {
      watches.delete(id);
    },
    clearWatches() {
      watches.clear();
    },
    setProfile(nextProfile) {
      if (profile === nextProfile || destroyed) return;
      profile = nextProfile;
      collector.setProfile(nextProfile);
      if (active) {
        publish("status", {
          source: "debugkit",
          name: "profile-changed",
          profile: nextProfile,
        }, "profile-changed");
      }
    },
    getProfile() {
      return profile;
    },
    getState() {
      const transportState = transport.getState();
      return {
        ...sessionState(),
        session: sessionState(),
        ...transportState,
        ...counters,
        bridgeUrl,
        recentEventCount: recentEvents.length,
        pendingEventCount: transport.getPendingCount(),
        observedRootCount: active ? collector.getObservedRootCount() : 0,
        watchCount: watches.size,
        destroyed,
      };
    },
    getRecentEvents() {
      return recentEvents.slice();
    },
    clear() {
      recentEvents.length = 0;
      transport.clearPending();
    },
    reconnect() {
      if (destroyed) return Promise.resolve(false);
      return enqueueLifecycle(async () => transport.reconnect());
    },
    destroy() {
      if (destroyed) return;
      if (active) {
        if (profile === "forensic") captureInternal("destroy");
        stoppedAt = new Date().toISOString();
        publish("status", {
          source: "debugkit",
          name: "session-stop",
          label,
          profile,
          startedAt,
          stoppedAt,
        }, "session-stop");
        collector.detach();
        active = false;
        void transport.flush().finally(() => transport.destroy());
      } else {
        collector.detach();
        transport.destroy();
      }
      destroyed = true;
      if (globalObject.__zentypeDebug === globalApi) delete globalObject.__zentypeDebug;
      if (globalObject.__zentypeDebugHook === globalApi) delete globalObject.__zentypeDebugHook;
    },
  };

  const globalApi = controller as unknown as Record<string, unknown>;
  globalObject.__zentypeDebug = globalApi;
  globalObject.__zentypeDebugHook = globalApi;
  return controller;
}

export type {
  DebugEnvelope,
  DebugHookController,
  DebugKitState,
  DebugProfile,
  DebugSessionState,
  DebugStartOptions,
} from "./types";
