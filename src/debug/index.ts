import { buildFingerprint, buildSha } from "./buildIdentity";
import { createDebugSerializer, safeMarkValue } from "./serialize";
import type {
  DebugEnvelope,
  DebugHookController,
  DebugKitCounters,
  DebugKitState,
  DebugProfile,
  DebugRecord,
  DebugSessionState,
  DebugSource,
  DebugStartOptions,
  DebugWatch,
} from "./types";
import type { EditorFrame } from "../types";

const TIMELINE_CAPACITY = 4096;
const FORENSIC_CAPACITY = 8192;
const RECENT_CAPACITY = 500;
const MAX_LABEL_LENGTH = 160;

function nowMs(): number {
  try {
    const value = performance.now();
    return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
  } catch {
    return 0;
  }
}

function sessionId(): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `zt-${random}`;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function emptyCounters(): DebugKitCounters {
  return {
    eventsCaptured: 0,
    mutationBatches: 0,
    serializedMutationRecords: 0,
    snapshotsCaptured: 0,
    domNodesSerialized: 0,
    computedStyleReads: 0,
    watchSamples: 0,
  };
}

function pushRing<T>(ring: T[], value: T, capacity: number): boolean {
  const dropped = ring.length >= capacity;
  if (dropped) ring.shift();
  ring.push(value);
  return dropped;
}

function profileIncludesTimeline(profile: DebugProfile): boolean {
  return profile === "timeline" || profile === "full";
}

function profileIncludesForensic(profile: DebugProfile): boolean {
  return profile === "forensic" || profile === "full";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function emptySession(profile: DebugProfile): DebugSessionState {
  return {
    active: false,
    sessionId: null,
    label: null,
    profile,
    buildSha,
    buildFingerprint,
    startedAt: null,
    stoppedAt: null,
  };
}

/**
 * Full DebugKit for the remake architecture.
 *
 * It deliberately has no observer, rAF or timer of its own. Session feeds it
 * events, frames and MutationObserver records from the paths it already owns.
 */
export function initDebugHook(): DebugHookController {
  const globalObject = globalThis as unknown as Record<string, unknown>;
  const previous = globalObject.__zentypeDebug ?? globalObject.__zentypeDebugHook;
  if (previous && typeof previous === "object") {
    const destroy = (previous as { destroy?: unknown }).destroy;
    if (typeof destroy === "function") {
      try { (destroy as () => void)(); } catch { /* stale dev reload must not block startup */ }
    }
  }

  let profile: DebugProfile = "full";
  let includeText = true;
  let active = false;
  let destroyed = false;
  let currentSessionId: string | null = null;
  let label: string | null = null;
  let startedAt: string | null = null;
  let stoppedAt: string | null = null;
  let sequence = 0;
  let droppedTimeline = 0;
  let droppedForensic = 0;
  let latestFrame: EditorFrame | null = null;
  let watchSequence = 0;
  let watches: DebugWatch[] = [];
  let counters = emptyCounters();
  let timeline: DebugEnvelope[] = [];
  let forensic: DebugEnvelope[] = [];
  let recent: DebugEnvelope[] = [];
  const serializer = createDebugSerializer(includeText, {
    onNodeSerialized: () => { counters.domNodesSerialized += 1; },
    onComputedStyleRead: () => { counters.computedStyleReads += 1; },
  });

  function state(): DebugSessionState {
    return {
      active, sessionId: currentSessionId, label, profile, buildSha, buildFingerprint,
      startedAt, stoppedAt,
    };
  }

  function recordEnvelope(
    kind: DebugEnvelope["kind"],
    payload: DebugRecord,
    reason?: string,
  ): DebugEnvelope | null {
    if (destroyed || !active || !currentSessionId) return null;
    const envelope: DebugEnvelope = {
      schema: "zentype-debug/v1",
      sessionId: currentSessionId,
      sequence: ++sequence,
      timestamp: new Date().toISOString(),
      kind,
      ...(reason ? { reason } : {}),
      payload: {
        ...payload,
        monotonicMs: nowMs(),
      },
    };
    if (kind === "event") counters.eventsCaptured += 1;
    pushRing(recent, envelope, RECENT_CAPACITY);
    if (kind === "event" && profileIncludesTimeline(profile) && pushRing(timeline, envelope, TIMELINE_CAPACITY)) {
      droppedTimeline += 1;
    }
    if (profileIncludesForensic(profile) && pushRing(forensic, envelope, FORENSIC_CAPACITY)) {
      droppedForensic += 1;
    }
    return envelope;
  }

  function resetRecording(): void {
    counters = emptyCounters();
    timeline = [];
    forensic = [];
    recent = [];
    sequence = 0;
    droppedTimeline = 0;
    droppedForensic = 0;
    latestFrame = null;
    serializer.resetNodeIdentity();
  }

  function startInternal(nextLabel = "debug-session", options: DebugStartOptions = {}): DebugSessionState {
    if (destroyed) throw new Error("DebugKit has been destroyed");
    if (active) stopInternal();
    profile = options.profile ?? profile;
    includeText = options.includeText ?? (profile === "full" || profile === "forensic");
    serializer.setIncludeText(includeText);
    currentSessionId = sessionId();
    label = truncate(nextLabel.trim() || "debug-session", MAX_LABEL_LENGTH);
    startedAt = new Date().toISOString();
    stoppedAt = null;
    active = true;
    resetRecording();
    recordEnvelope("status", {
      source: "debugkit", name: "session-start", label, profile,
      buildSha, buildFingerprint, startedAt, includeText,
    }, "session-start");
    if (profileIncludesForensic(profile)) captureInternal("session-start");
    return state();
  }

  function stopInternal(): void {
    if (!active || destroyed) return;
    if (profileIncludesForensic(profile)) captureInternal("session-stop");
    stoppedAt = new Date().toISOString();
    recordEnvelope("status", {
      source: "debugkit", name: "session-stop", label, profile, startedAt, stoppedAt,
    }, "session-stop");
    active = false;
  }

  function captureInternal(reason: string): void {
    if (!active || destroyed || !currentSessionId) return;
    if (!profileIncludesForensic(profile)) {
      safeRecord("debugkit", "capture-skipped", { reason });
      return;
    }
    try {
      const payload = serializer.snapshot(latestFrame, reason, profile, watches);
      const samples = payload.watches;
      if (Array.isArray(samples)) counters.watchSamples += samples.length;
      counters.snapshotsCaptured += 1;
      recordEnvelope("snapshot", payload, reason);
    } catch (error) {
      recordEnvelope("event", {
        source: "debugkit", name: "capture-error", message: errorMessage(error),
      }, "capture-error");
    }
  }

  function safeRecord(source: DebugSource, name: string, data: DebugRecord = {}): void {
    if (!active || destroyed) return;
    try {
      recordEnvelope("event", {
        source, name, ...data,
      });
    } catch (error) {
      try {
        recordEnvelope("event", {
          source: "debugkit", name: "record-error", originalSource: source,
          originalName: name, message: errorMessage(error),
        }, "record-error");
      } catch { /* diagnostics must never escape into the editor */ }
    }
  }

  const controller: DebugHookController = {
    start(labelName, options) {
      return Promise.resolve(startInternal(labelName, options));
    },
    stop() {
      stopInternal();
      return Promise.resolve();
    },
    toggle() {
      if (active) {
        stopInternal();
        return Promise.resolve(false);
      }
      startInternal("debug-session", { profile: "full" });
      return Promise.resolve(true);
    },
    mark(markLabel, payload) {
      safeRecord("debugkit", "mark", {
        label: truncate(markLabel.trim() || "mark", MAX_LABEL_LENGTH),
        payload: safeMarkValue(payload),
      });
    },
    capture(reason = "manual") {
      captureInternal(reason);
    },
    watch(selector, watchLabel) {
      const normalized = selector.trim();
      if (!normalized) throw new Error("DebugKit watch selector must not be empty");
      if (watches.length >= 8) throw new Error("DebugKit supports at most 8 watches");
      const watch: DebugWatch = {
        id: `w${++watchSequence}`,
        selector: normalized,
        label: truncate(watchLabel?.trim() || normalized, MAX_LABEL_LENGTH),
      };
      watches = [...watches, watch];
      return watch.id;
    },
    unwatch(id) {
      watches = watches.filter(watch => watch.id !== id);
    },
    clearWatches() {
      watches = [];
    },
    setProfile(nextProfile) {
      if (destroyed || profile === nextProfile) return;
      profile = nextProfile;
      includeText = nextProfile === "full" || nextProfile === "forensic";
      serializer.setIncludeText(includeText);
      safeRecord("debugkit", "profile-changed", { profile: nextProfile });
    },
    getProfile() {
      return profile;
    },
    getState(): DebugKitState {
      return {
        ...state(),
        session: state(),
        ...counters,
        timeline: { capacity: TIMELINE_CAPACITY, retainedEvents: timeline.length, droppedEvents: droppedTimeline },
        forensic: { capacity: FORENSIC_CAPACITY, retainedEvents: forensic.length, droppedEvents: droppedForensic },
        recentEventCount: recent.length,
        watchCount: watches.length,
        observedEditor: latestFrame?.editor.isConnected ?? false,
        includeText,
        destroyed,
      };
    },
    getRecentEvents() {
      return (profile === "full" || profile === "forensic" ? forensic : recent).slice();
    },
    exportRecording() {
      if (active) throw new Error("Stop the DebugKit session before exporting");
      const recorded = state();
      return JSON.stringify({
        schema: "zentype-debug-bundle/v1",
        session: recorded,
        host: {
          userAgent: typeof navigator === "undefined" ? null : navigator.userAgent,
          platform: typeof navigator === "undefined" ? null : navigator.platform,
          href: typeof location === "undefined" ? null : location.href,
        },
        timeline: {
          capacity: TIMELINE_CAPACITY,
          events: timeline,
        },
        forensic: {
          capacity: FORENSIC_CAPACITY,
          events: forensic.length ? forensic : recent,
          counters: { ...counters },
        },
        loss: {
          timeline: { capacity: TIMELINE_CAPACITY, retainedEvents: timeline.length, droppedEvents: droppedTimeline },
          forensic: { capacity: FORENSIC_CAPACITY, retainedEvents: forensic.length, droppedEvents: droppedForensic },
          recent: { capacity: RECENT_CAPACITY, retainedEvents: recent.length, droppedEvents: 0 },
        },
      });
    },
    clear() {
      timeline = [];
      forensic = [];
      recent = [];
      droppedTimeline = 0;
      droppedForensic = 0;
    },
    reconnect() {
      return Promise.resolve(false);
    },
    record: safeRecord,
    recordEvent(event, frame) {
      if (!active || destroyed) return;
      try {
        const root = frame?.root ?? frame?.editor ?? null;
        recordEnvelope("event", {
          source: "host", name: `event:${event.type}`, event: serializer.eventPayload(event, root),
        });
      } catch (error) {
        safeRecord("debugkit", "event-serialize-error", { message: errorMessage(error) });
      }
    },
    recordFrame(frame, data = {}) {
      latestFrame = frame;
      if (!active || destroyed) return;
      try {
        recordEnvelope("event", {
          source: "session", name: "frame", frame: serializer.framePayload(frame, frame?.root ?? frame?.editor ?? null), ...data,
        });
      } catch (error) {
        safeRecord("debugkit", "frame-serialize-error", { message: errorMessage(error) });
      }
    },
    recordMutations(records, frame) {
      latestFrame = frame;
      if (!active || destroyed || records.length === 0) return;
      counters.mutationBatches += 1;
      counters.serializedMutationRecords += Math.min(records.length, 80);
      try {
        recordEnvelope("event", {
          source: "host", name: "mutation-batch",
          mutations: serializer.mutationPayload(records, frame?.root ?? frame?.editor ?? null),
        }, "mutation");
      } catch (error) {
        safeRecord("debugkit", "mutation-serialize-error", { message: errorMessage(error) });
      }
    },
    setFrame(frame) {
      latestFrame = frame;
    },
    destroy() {
      if (destroyed) return;
      if (active) stopInternal();
      active = false;
      destroyed = true;
      if (globalObject.__zentypeDebug === controller) delete globalObject.__zentypeDebug;
      if (globalObject.__zentypeDebugHook === controller) delete globalObject.__zentypeDebugHook;
    },
  };

  globalObject.__zentypeDebug = controller;
  globalObject.__zentypeDebugHook = controller;
  return controller;
}
