/**
 * Development-only compatibility facade. DebugKit implementation lives in
 * src/debug so production builds can replace this module with the noop.
 */
export { initDebugHook } from "../debug";
export {
  redactText,
  serializeStructuralEditSnapshot,
  summarizeKeyboardKey,
  summarizeWsData,
} from "../debug/serialize";
export type {
  DebugBlockDescription,
  DebugComputedStyle,
  DebugDomTreeNode,
  DebugElementDescription,
  DebugEnvelope,
  DebugHookController,
  DebugKitController,
  DebugKitCounters,
  DebugKitState,
  DebugMutationRecord,
  DebugNodeReference,
  DebugProfile,
  DebugRect,
  DebugScrollMetrics,
  DebugScrollState,
  DebugSessionState,
  DebugSchema,
  DebugSnapshot,
  DebugStartOptions,
  DebugStructuralEditState,
  DebugTransportCounters,
  DebugTransportState,
  DebugWatch,
  DebugWatchSample,
} from "../debug/types";
