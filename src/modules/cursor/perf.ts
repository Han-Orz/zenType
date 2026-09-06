/**
 * Dev-only Cursor hot-path profiling.
 *
 * Summary-only by design: counters aggregate here and are flushed as a single
 * `cursor-perf-summary` debug event (≥100 updates or ≥5s window), never as
 * per-event forensic logs. Every call site is behind its module's
 * __ZENTYPE_DEV__ flag, so production builds never touch this state.
 */

export const CURSOR_PERF_RING = 128;
export const CURSOR_PERF_FLUSH_CALLS = 100;
export const CURSOR_PERF_FLUSH_MS = 5000;

export const cursorPerf = {
  windowStartedAt: 0,
  updates: 0,
  durations: [] as number[],
  skips: {} as Record<string, number>,
  // 子项耗时（累计）
  getCursorRectMs: 0,
  boundsMs: 0,
  boundsCalls: 0,
  zIndexHits: 0,
  zIndexMisses: 0,
  forcedLayouts: 0,
  scrollRebinds: 0,
  resizeDriven: 0,
  // C1 keyboard chain
  keyboardEvents: 0,
  keyboardTwoFrame: 0,
  keyboardLatencies: [] as number[],
  keyboardEventAt: null as number | null,
  keyboardOuterRafAt: null as number | null,
  // C2 scroll duplication
  docCaptureScroll: 0,
  docCaptureWheel: 0,
  containerScroll: 0,
  queueRequests: 0,
  queueDeduped: 0,
};

export function pushPerfRing(ring: number[], value: number): void {
  ring.push(value);
  if (ring.length > CURSOR_PERF_RING) ring.shift();
}

function ringStats(ring: number[]): { median: number; p95: number; max: number; avg: number } | null {
  if (ring.length === 0) return null;
  const sorted = [...ring].sort((a, b) => a - b);
  const pick = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? sorted[0];
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    median: pick(0.5),
    p95: pick(0.95),
    max: sorted[sorted.length - 1],
    avg: sum / sorted.length,
  };
}

export function buildCursorPerfSummary(
  now: number,
  rectPerf: {
    native: number;
    fallbackAdjacent: number;
    fallbackEmpty: number;
    failOpen: number;
    fallbackCalls: number;
    fallbackTotalMs: number;
  },
): Record<string, unknown> {
  const windowMs = now - cursorPerf.windowStartedAt;
  return {
    windowMs: Math.round(windowMs),
    updates: cursorPerf.updates,
    updatesPerSec: windowMs > 0 ? Math.round((cursorPerf.updates / windowMs) * 1000 * 100) / 100 : 0,
    duration: ringStats(cursorPerf.durations),
    skips: { ...cursorPerf.skips },
    getCursorRect: {
      native: rectPerf.native,
      fallbackAdjacent: rectPerf.fallbackAdjacent,
      fallbackEmpty: rectPerf.fallbackEmpty,
      failOpen: rectPerf.failOpen,
      fallbackAvgMs: rectPerf.fallbackCalls > 0
        ? Math.round((rectPerf.fallbackTotalMs / rectPerf.fallbackCalls) * 1000) / 1000
        : 0,
    },
    bounds: {
      calls: cursorPerf.boundsCalls,
      avgMs: cursorPerf.boundsCalls > 0
        ? Math.round((cursorPerf.boundsMs / cursorPerf.boundsCalls) * 1000) / 1000
        : 0,
    },
    zIndexHits: cursorPerf.zIndexHits,
    zIndexMisses: cursorPerf.zIndexMisses,
    forcedLayouts: cursorPerf.forcedLayouts,
    scrollRebinds: cursorPerf.scrollRebinds,
    resizeDriven: cursorPerf.resizeDriven,
    keyboard: {
      events: cursorPerf.keyboardEvents,
      twoFrame: cursorPerf.keyboardTwoFrame,
      latency: ringStats(cursorPerf.keyboardLatencies),
    },
    scroll: {
      docCaptureScroll: cursorPerf.docCaptureScroll,
      docCaptureWheel: cursorPerf.docCaptureWheel,
      containerScroll: cursorPerf.containerScroll,
      queueRequests: cursorPerf.queueRequests,
      queueDeduped: cursorPerf.queueDeduped,
    },
  };
}

export function resetCursorPerf(now: number): void {
  cursorPerf.windowStartedAt = now;
  cursorPerf.updates = 0;
  cursorPerf.durations.length = 0;
  cursorPerf.skips = {};
  cursorPerf.getCursorRectMs = 0;
  cursorPerf.boundsMs = 0;
  cursorPerf.boundsCalls = 0;
  cursorPerf.zIndexHits = 0;
  cursorPerf.zIndexMisses = 0;
  cursorPerf.forcedLayouts = 0;
  cursorPerf.scrollRebinds = 0;
  cursorPerf.resizeDriven = 0;
  cursorPerf.keyboardEvents = 0;
  cursorPerf.keyboardTwoFrame = 0;
  cursorPerf.keyboardLatencies.length = 0;
  cursorPerf.keyboardEventAt = null;
  cursorPerf.keyboardOuterRafAt = null;
  cursorPerf.docCaptureScroll = 0;
  cursorPerf.docCaptureWheel = 0;
  cursorPerf.containerScroll = 0;
  cursorPerf.queueRequests = 0;
  cursorPerf.queueDeduped = 0;
}
