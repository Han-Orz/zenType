export type PerformancePreset = "all" | "cursor" | "sentence" | "scroll";
export type PerformanceSource = "input" | "cursor" | "sentence" | "scroll" | "debugkit";
export type PerformanceData = Record<string, string | number | boolean | null>;

export interface PerformanceEvent {
  sequence: number;
  monotonicMs: number;
  inputContextId: number;
  source: PerformanceSource;
  name: string;
  data: PerformanceData;
}

export const PERFORMANCE_CAPACITY = 4096;
let sink: ((source: PerformanceSource, name: string, data: PerformanceData) => void) | null = null;
let inputContextId = 0;

export function performanceRecordingActive(): boolean {
  return sink !== null;
}

export function currentInputContextId(): number {
  return inputContextId;
}

/** Call sites pass existing scalar state only; never DOM nodes or lazy readers. */
export function recordPerformance(source: PerformanceSource, name: string, data: PerformanceData = {}): void {
  sink?.(source, name, data);
}

export function createPerformanceRecorder() {
  let events = new Array<PerformanceEvent>(PERFORMANCE_CAPACITY);
  let count = 0;
  let sequence = 0;
  let dropped = 0;
  let preset: PerformancePreset = "all";
  let attached = false;
  let root: Element | null = null;
  const eventNames = ["keydown", "beforeinput", "input", "pointerdown", "click", "wheel", "compositionstart", "compositionend"];
  const navigationKeys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Enter", "Backspace", "Delete", "Tab", "Escape"]);

  function record(source: PerformanceSource, name: string, data: PerformanceData): void {
    if (!attached || (source !== "input" && source !== "debugkit" && preset !== "all" && source !== preset)) return;
    const event: PerformanceEvent = {
      sequence: ++sequence,
      monotonicMs: performance.now(),
      inputContextId,
      source,
      name,
      data: { ...data },
    };
    events[(sequence - 1) % PERFORMANCE_CAPACITY] = event;
    if (count < PERFORMANCE_CAPACITY) count++;
    else dropped++;
  }

  const onInput: EventListener = (event) => {
    if (!root || !event.target || !root.contains(event.target as Node)) return;
    inputContextId++;
    const keyboard = event as KeyboardEvent;
    record("input", event.type, {
      key: typeof keyboard.key === "string"
        ? (navigationKeys.has(keyboard.key) ? keyboard.key : "[masked]") : null,
      repeat: keyboard.repeat === true,
      shiftKey: keyboard.shiftKey === true,
      ctrlKey: keyboard.ctrlKey === true,
      altKey: keyboard.altKey === true,
      metaKey: keyboard.metaKey === true,
      isComposing: keyboard.isComposing === true,
    });
  };

  function stop(): void {
    if (!attached) return;
    attached = false;
    if (sink === record) sink = null;
    eventNames.forEach((name) => window.removeEventListener(name, onInput, true));
    root = null;
  }

  return {
    start(nextPreset: PerformancePreset, editorRoot: Element | null) {
      stop();
      events = new Array<PerformanceEvent>(PERFORMANCE_CAPACITY);
      count = sequence = dropped = inputContextId = 0;
      preset = nextPreset;
      root = editorRoot;
      attached = true;
      sink = record;
      eventNames.forEach((name) => window.addEventListener(name, onInput, { capture: true, passive: true }));
    },
    stop,
    record,
    getState: () => ({ preset, capacity: PERFORMANCE_CAPACITY, retainedEvents: count, droppedEvents: dropped }),
    getEvents(): PerformanceEvent[] {
      return Array.from({ length: count }, (_, index) => {
        const event = events[(sequence - count + index) % PERFORMANCE_CAPACITY];
        return { ...event, data: { ...event.data } };
      });
    },
  };
}
