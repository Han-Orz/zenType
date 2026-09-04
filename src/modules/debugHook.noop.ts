/**
 * Production-build replacement for debugHook.ts.
 * Every method is inert: no fetch, DOM access, observer, or debug state.
 */
import type {
  DebugEnvelope,
  DebugHookController,
  DebugKitState,
  DebugProfile,
  DebugSessionState,
  DebugStartOptions,
} from "../debug/types";

const INACTIVE_SESSION: DebugSessionState = {
  active: false,
  sessionId: null,
  label: null,
  profile: "timing",
  buildSha: null,
  startedAt: null,
  stoppedAt: null,
};

const INACTIVE_STATE: DebugKitState = {
  ...INACTIVE_SESSION,
  session: INACTIVE_SESSION,
  transportState: "unknown",
  transportFailures: 0,
  batchesSent: 0,
  eventsSent: 0,
  bytesSent: 0,
  lastTransportError: null,
  eventsCaptured: 0,
  mutationBatches: 0,
  snapshotsCaptured: 0,
  domNodesSerialized: 0,
  computedStyleReads: 0,
  watchSamples: 0,
  serializedMutationRecords: 0,
  bridgeUrl: "",
  recentEventCount: 0,
  pendingEventCount: 0,
  observedRootCount: 0,
  watchCount: 0,
  destroyed: false,
};

export function initDebugHook(_eventBus?: unknown): DebugHookController {
  return {
    start: async (_label?: string, _options?: DebugStartOptions) => ({
      ...INACTIVE_SESSION,
    }),
    stop: async () => undefined,
    toggle: async () => false,
    mark: (_label: string, _payload?: Record<string, unknown>) => undefined,
    capture: (_reason?: string) => undefined,
    watch: (_selector: string, _label?: string) => "",
    unwatch: (_id: string) => undefined,
    clearWatches: () => undefined,
    setProfile: (_nextProfile: DebugProfile) => undefined,
    getProfile: () => "timing" as const,
    getState: () => ({
      ...INACTIVE_STATE,
    }),
    getRecentEvents: (): readonly DebugEnvelope[] => [],
    clear: () => undefined,
    reconnect: async () => false,
    destroy: () => undefined,
  };
}
