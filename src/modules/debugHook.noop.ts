/**
 * Production-build replacement for debugHook.ts.
 * The full collector is development-only and is never bundled into releases.
 */
export function initDebugHook() {
  return {
    toggle: () => false,
    setEnabled: (_enabled: boolean) => undefined,
    isEnabled: () => false,
    captureNow: (_reason?: string, _protyle?: unknown) => undefined,
    toggleIncludeText: () => false,
    getRecentEvents: () => [],
    getState: () => ({
      enabled: false,
      includeText: false,
      sessionId: "",
      recentEventCount: 0,
      pendingEventCount: 0,
      observedRootCount: 0,
      bridgeUrl: "",
    }),
    destroy: () => undefined,
  };
}
