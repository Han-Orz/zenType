/**
 * Production-build replacement for debugHook.ts.
 * The full collector is development-only and is never bundled into releases.
 */
export function initDebugHook() {
  return {
    toggle: () => false,
    setEnabled: (_enabled: boolean) => undefined,
    isEnabled: () => false,
    setProfile: (_profile: "timing" | "forensic") => undefined,
    getProfile: () => "timing" as const,
    captureNow: (_reason?: string, _protyle?: unknown) => undefined,
    toggleIncludeText: () => false,
    getRecentEvents: () => [],
    getState: () => ({
      enabled: false,
      profile: "timing" as const,
      includeText: false,
      sessionId: "",
      recentEventCount: 0,
      pendingEventCount: 0,
      observedRootCount: 0,
      bridgeUrl: "",
      timingEvents: 0,
      forensicSnapshots: 0,
      mutationBatches: 0,
      serializedMutationRecords: 0,
    }),
    destroy: () => undefined,
  };
}
