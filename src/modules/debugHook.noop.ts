import type {
  DebugEnvelope,
  DebugHookController,
  DebugKitState,
  DebugProfile,
  DebugRecord,
  DebugSource,
  DebugSessionState,
  DebugStartOptions,
} from "../debug/types";
import type { EditorFrame } from "../types";

const SESSION: DebugSessionState = {
  active: false, sessionId: null, label: null, profile: "full",
  buildSha: null, buildFingerprint: null, startedAt: null, stoppedAt: null,
};

const STATE: DebugKitState = {
  ...SESSION,
  session: SESSION,
  eventsCaptured: 0, mutationBatches: 0, serializedMutationRecords: 0,
  snapshotsCaptured: 0, domNodesSerialized: 0, computedStyleReads: 0, watchSamples: 0,
  timeline: { capacity: 0, retainedEvents: 0, droppedEvents: 0 },
  forensic: { capacity: 0, retainedEvents: 0, droppedEvents: 0 },
  recentEventCount: 0, watchCount: 0, observedEditor: false, includeText: false, destroyed: false,
};

export function createDebugBundleFilename(): string {
  return "zentype-debug-unknown.json";
}

export function downloadDebugBundle(): void {
  // Production builds intentionally expose no export side effect.
}

export function initDebugHook(): DebugHookController {
  return {
    start: async (_label?: string, _options?: DebugStartOptions) => ({ ...SESSION }),
    stop: async () => undefined,
    toggle: async () => false,
    mark: (_label: string, _payload?: Record<string, unknown>) => undefined,
    capture: (_reason?: string) => undefined,
    watch: (_selector: string, _label?: string) => "",
    unwatch: (_id: string) => undefined,
    clearWatches: () => undefined,
    setProfile: (_profile: DebugProfile) => undefined,
    getProfile: () => "full",
    getState: () => ({ ...STATE, session: { ...SESSION } }),
    getRecentEvents: (): readonly DebugEnvelope[] => [],
    exportRecording: () => "{}",
    clear: () => undefined,
    reconnect: async () => false,
    record: (_source: DebugSource, _name: string, _data?: DebugRecord) => undefined,
    recordEvent: (_event: Event, _frame: EditorFrame | null) => undefined,
    recordFrame: (_frame: EditorFrame | null, _data?: DebugRecord) => undefined,
    recordMutations: (_records: readonly MutationRecord[], _frame: EditorFrame | null) => undefined,
    setFrame: (_frame: EditorFrame | null) => undefined,
    destroy: () => undefined,
  };
}
