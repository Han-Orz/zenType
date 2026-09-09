import type { EditorFrame } from "../types";

export type DebugSchema = "zentype-debug/v1" | "zentype-debug-bundle/v1";
export type DebugProfile = "timing" | "forensic" | "timeline" | "full";
export type DebugEnvelopeKind = "event" | "snapshot" | "status";
export type DebugSource = "session" | "host" | "cursor" | "typewriter" | "ripple" | "debugkit";

export type DebugValue = null | boolean | number | string | DebugValue[] | { [key: string]: DebugValue };
export type DebugRecord = Record<string, DebugValue>;

export interface DebugStartOptions {
  profile?: DebugProfile;
  includeText?: boolean;
}

export interface DebugSessionState {
  active: boolean;
  sessionId: string | null;
  label: string | null;
  profile: DebugProfile;
  buildSha: string | null;
  buildFingerprint: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
}

export interface DebugKitCounters {
  eventsCaptured: number;
  mutationBatches: number;
  serializedMutationRecords: number;
  snapshotsCaptured: number;
  domNodesSerialized: number;
  computedStyleReads: number;
  watchSamples: number;
}

export interface DebugEnvelope {
  schema: DebugSchema;
  sessionId: string;
  sequence: number;
  timestamp: string;
  kind: DebugEnvelopeKind;
  reason?: string;
  payload: DebugRecord;
}

export interface DebugKitState extends DebugSessionState, DebugKitCounters {
  session: DebugSessionState;
  timeline: { capacity: number; retainedEvents: number; droppedEvents: number };
  forensic: { capacity: number; retainedEvents: number; droppedEvents: number };
  recentEventCount: number;
  watchCount: number;
  observedEditor: boolean;
  includeText: boolean;
  destroyed: boolean;
}

export interface DebugDownloadEnvironment {
  document: Pick<Document, "createElement" | "body">;
  url: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
  Blob: typeof Blob;
  defer(callback: () => void): void;
}

/**
 * The Session owns observation and scheduling. Modules only report state that
 * was already computed during their normal presentation path.
 */
export interface DebugRecorder {
  record(source: DebugSource, name: string, data?: DebugRecord): void;
  recordEvent(event: Event, frame: EditorFrame | null): void;
  recordFrame(frame: EditorFrame | null, data?: DebugRecord): void;
  recordMutations(records: readonly MutationRecord[], frame: EditorFrame | null): void;
  setFrame(frame: EditorFrame | null): void;
}

export interface DebugWatch {
  id: string;
  selector: string;
  label: string;
}

export interface DebugHookController extends DebugRecorder {
  start(label?: string, options?: DebugStartOptions): Promise<DebugSessionState>;
  stop(): Promise<void>;
  toggle(): Promise<boolean>;
  mark(label: string, payload?: Record<string, unknown>): void;
  capture(reason?: string): void;
  watch(selector: string, label?: string): string;
  unwatch(id: string): void;
  clearWatches(): void;
  setProfile(profile: DebugProfile): void;
  getProfile(): DebugProfile;
  getState(): DebugKitState;
  getRecentEvents(): readonly DebugEnvelope[];
  exportRecording(): string;
  clear(): void;
  reconnect(): Promise<boolean>;
  destroy(): void;
}

export type DebugKitController = DebugHookController;

declare global {
  var __zentypeDebug: DebugHookController | undefined;
  var __zentypeDebugHook: DebugHookController | undefined;
}
