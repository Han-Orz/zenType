import type {
  StructuralEditKind,
  StructuralEditPhase,
} from "../modules/structuralEdit";

export type DebugSchema = "zentype-debug/v1";
export type DebugProfile = "timing" | "forensic";
export type DebugTransportState = "unknown" | "probing" | "online" | "offline";
export type DebugEnvelopeKind = "event" | "snapshot" | "status";

export interface DebugFrameBurstOptions {
  enabled: boolean;
  frames?: number;
}

export interface DebugStartOptions {
  profile?: DebugProfile;
  frameBurst?: DebugFrameBurstOptions;
  markerForensic?: DebugMarkerForensicOptions;
  /** Development-only override used by local bridge smoke tests. */
  bridgeUrl?: string;
}

export interface DebugMarkerForensicTarget {
  currentElement: Element;
  currentNodeId: string;
  suspectElement: Element;
  suspectNodeId: string;
}

export interface DebugMarkerForensicOptions {
  enabled: boolean;
  resolveTarget: (event: Event) => DebugMarkerForensicTarget | null;
}

export interface DebugSessionState {
  active: boolean;
  sessionId: string | null;
  label: string | null;
  profile: DebugProfile;
  buildSha: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
}

export interface DebugTransportCounters {
  transportState: DebugTransportState;
  transportFailures: number;
  batchesSent: number;
  eventsSent: number;
  bytesSent: number;
  lastTransportError: string | null;
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

export interface DebugKitState extends DebugSessionState, DebugTransportCounters, DebugKitCounters {
  session: DebugSessionState;
  bridgeUrl: string;
  recentEventCount: number;
  pendingEventCount: number;
  observedRootCount: number;
  watchCount: number;
  latestBurstId: string | null;
  destroyed: boolean;
}

export interface DebugEnvelope {
  schema: DebugSchema;
  sessionId: string;
  sequence: number;
  timestamp: string;
  kind: DebugEnvelopeKind;
  reason?: string;
  payload: Record<string, unknown>;
}

export interface DebugRect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface DebugScrollMetrics {
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
}

export interface DebugNodeReference {
  nodeType: "element" | "text" | "other";
  nodeToken?: string;
  isConnected?: boolean;
  path: string;
  tag?: string;
  id?: string;
  classes?: string[];
  attrs?: Record<string, string>;
  nodeId?: string;
  dataType?: string;
  directTextLength?: number;
  directText?: string;
  subtreeTextLength?: number;
  textLength?: number;
  text?: string;
  childElementCount?: number;
}

export interface DebugDomTreeNode {
  tag: string;
  nodeToken: string;
  isConnected: boolean;
  path: string;
  id?: string;
  classes?: string[];
  attrs: Record<string, string>;
  nodeId?: string;
  dataType?: string;
  directTextLength: number;
  directText?: string;
  directTextNodes?: DebugNodeReference[];
  subtreeTextLength: number;
  childElementCount: number;
  children?: DebugDomTreeNode[];
  truncated?: boolean;
  omittedChildren?: number;
}

export interface DebugComputedStyle {
  display: string;
  position: string;
  opacity: string;
  visibility: string;
  color: string;
  backgroundColor: string;
  fill: string;
  stroke: string;
  transform: string;
  filter: string;
  mixBlendMode: string;
  willChange: string;
  transition: string;
  transitionProperty: string;
  transitionDuration: string;
  transitionTimingFunction: string;
  zIndex: string;
  contain: string;
  isolation: string;
  pointerEvents: string;
  fontSize: string;
  lineHeight: string;
  overflow: string;
  margin: string;
  padding: string;
  rippleOpacity: string;
  rippleTransitionDuration: string;
  sentenceDimColor: string;
}

export interface DebugBlockDescription {
  id: string;
  dataType: string | null;
  nodeToken: string;
  isConnected: boolean;
  path: string;
  attrs: Record<string, string>;
  classes: string[];
  childElementCount: number;
  textLength: number;
  text?: string;
  rect: DebugRect | null;
  computed: DebugComputedStyle | null;
}

export interface DebugElementDescription extends DebugNodeReference {
  nodeType: "element";
  nodeToken: string;
  isConnected: boolean;
  rect: DebugRect | null;
  scroll: DebugScrollMetrics | null;
  computed: DebugComputedStyle | null;
  blockChain: DebugBlockDescription[];
}

export interface DebugStructuralEditState {
  generation: number;
  phase: StructuralEditPhase;
  kind: StructuralEditKind | null;
  editorPath: string | null;
  editorToken?: string | null;
  editorConnected: boolean | null;
  transactionStartedAt: number | null;
  lastActivityAt: number | null;
  activityVersion: number;
  quietFrames: number;
  settleFrames: number;
}

export interface DebugScrollState {
  container: DebugNodeReference;
  metrics: DebugScrollMetrics;
}

export interface DebugWatch {
  id: string;
  selector: string;
  label: string;
}

export interface DebugAnimationSummary {
  type: string | null;
  playState: string | null;
  currentTime: number | null;
  startTime: number | null;
  playbackRate: number | null;
  transitionProperty: string | null;
  animationName: string | null;
}

export interface DebugWatchSample {
  id: string;
  label: string;
  selector: string;
  reason: string;
  nodeToken: string;
  isConnected: boolean;
  path: string;
  nodeId: string | null;
  classes: string[];
  parent: DebugNodeReference | null;
  ancestors: DebugNodeReference[];
  rect: DebugRect | null;
  computed: DebugComputedStyle | null;
  activeAnimations: DebugAnimationSummary[];
}

export interface DebugMutationRecord {
  type: string;
  target: DebugNodeReference;
  attributeName: string | null;
  oldValue: string | null;
  targetText?: string;
  addedNodes: DebugNodeReference[];
  removedNodes: DebugNodeReference[];
  addedTextNodes: DebugNodeReference[];
  removedTextNodes: DebugNodeReference[];
}

export interface DebugSnapshot {
  capture: {
    reason: string;
    profile: DebugProfile;
    includeText: boolean;
  };
  activeEditor: Record<string, unknown> | null;
  targetEditor: Record<string, unknown> | null;
  focus: DebugElementDescription | null;
  selection: Record<string, unknown> | null;
  currentBlock: DebugElementDescription | null;
  scroll: DebugScrollState | null;
  structural: DebugStructuralEditState;
  typewriterScroll: { active: boolean };
  dom: DebugDomTreeNode | null;
  observedRoots: DebugNodeReference[];
  watches: DebugWatchSample[];
}

export interface DebugHookController {
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
  clear(): void;
  reconnect(): Promise<boolean>;
  destroy(): void;
}

/** Stable name for new code; DebugHookController remains the facade contract. */
export type DebugKitController = DebugHookController;

declare global {
  var __zentypeDebug: DebugHookController | undefined;
  var __zentypeDebugHook: DebugHookController | undefined;
}
