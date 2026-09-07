import assert from "node:assert/strict";
import test from "node:test";
import { setActiveEditor } from "siyuan";
import type { EventBus } from "siyuan";
import { initDebugHook } from "../src/debug";
import { createPerformanceRecorder, PERFORMANCE_CAPACITY, performanceRecordingActive, recordPerformance } from "../src/debug/performance";
import { reportDebugEvent } from "../src/modules/typewriter/scroll";

function install() {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const listeners = new Map<string, Set<EventListener>>();
  const forbidden = () => { throw new Error("performance capture must not read DOM geometry, styles, text or use transport"); };
  const target = { getBoundingClientRect: forbidden, get textContent() { return forbidden(); } };
  const root = { contains: (value: unknown) => value === target };
  const globals = {
    document: { querySelector: forbidden, addEventListener: forbidden, removeEventListener: forbidden },
    window: {
      addEventListener: (name: string, listener: EventListener) => {
        const set = listeners.get(name) ?? new Set();
        set.add(listener);
        listeners.set(name, set);
      },
      removeEventListener: (name: string, listener: EventListener) => listeners.get(name)?.delete(listener),
      getSelection: forbidden,
    },
    getComputedStyle: forbidden,
    MutationObserver: forbidden,
    fetch: forbidden,
  };
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  setActiveEditor({ protyle: { element: root } });
  return {
    root: root as unknown as Element,
    target,
    dispatch(name: string, values: Record<string, unknown> = {}) {
      for (const listener of listeners.get(name) ?? []) listener({ type: name, target, ...values } as unknown as Event);
    },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    restore() {
      setActiveEditor(null);
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as unknown as Record<string, unknown>)[key];
      }
    },
  };
}

test("timeline mode records scalar events without layout, text, transport or observers", async () => {
  const runtime = install();
  const controller = initDebugHook({ on() { throw new Error("legacy collector attached"); }, off() {} } as unknown as EventBus);
  try {
    await controller.start("navigation", { profile: "timeline", preset: "all" });
    assert.equal(performanceRecordingActive(), true);
    runtime.dispatch("keydown", { key: "private text", data: "private text" });
    recordPerformance("cursor", "cursor-commit", { x: 10, y: 20 });
    reportDebugEvent({ name: "typewriter-scroll-cancel", motionId: "tw1", reason: "test", target: runtime.target as unknown as HTMLElement });
    controller.mark("observed");
    controller.capture();
    assert.throws(() => controller.exportRecording(), /Stop the session/);
    assert.throws(() => controller.setProfile("forensic"), /Stop the session/);
    assert.equal(await controller.reconnect(), false);
    assert.equal(controller.getState().computedStyleReads, 0);
    await controller.stop();
    const exported = controller.exportRecording();
    assert.equal(exported.includes("private text"), false);
    const result = JSON.parse(exported);
    assert.equal(result.schema, "zentype-debug-bundle/v1");
    assert.equal(result.session.buildFingerprint, "unknown");
    assert.ok(result.session.stoppedAt);
    const commit = result.timeline.events.find((event: { name: string }) => event.name === "cursor-commit");
    assert.equal(commit.inputContextId, 1);
    const cancelled = result.timeline.events.find((event: { name: string }) => event.name === "typewriter-scroll-cancel");
    assert.equal(cancelled.data.motionId, "tw1");
    assert.equal("target" in cancelled.data, false);
    assert.equal(runtime.listenerCount(), 0);
    assert.equal(performanceRecordingActive(), false);
    recordPerformance("cursor", "after-stop", {});
    assert.equal(controller.exportRecording(), exported);
    controller.setProfile("timing");
    assert.equal(JSON.parse(controller.exportRecording()).schema, "zentype-debug-bundle/v1");
  } finally {
    controller.destroy();
    runtime.restore();
  }
});

test("timeline ring is bounded, ordered, reports loss and filters presets", () => {
  const runtime = install();
  const recorder = createPerformanceRecorder();
  try {
    recorder.start("cursor", runtime.root);
    runtime.dispatch("keydown", { target: {}, key: "ArrowLeft" });
    recordPerformance("sentence", "filtered", {});
    assert.equal(recorder.getEvents().length, 0);
    for (let index = 0; index < PERFORMANCE_CAPACITY + 7; index++) recordPerformance("cursor", "cursor-commit", { index });
    const events = recorder.getEvents();
    assert.equal(events.length, PERFORMANCE_CAPACITY);
    assert.equal(events[0].data.index, 7);
    assert.equal(events.at(-1)?.data.index, PERFORMANCE_CAPACITY + 6);
    assert.equal(recorder.getState().droppedEvents, 7);
    events[0].data.index = -1;
    assert.equal(recorder.getEvents()[0].data.index, 7);
    recorder.start("scroll", runtime.root);
    assert.equal(recorder.getState().retainedEvents, 0);
    recordPerformance("cursor", "filtered", {});
    recordPerformance("scroll", "start", { motionId: "tw2" });
    assert.equal(recorder.getEvents().length, 1);
  } finally {
    recorder.stop();
    runtime.restore();
  }
});

test("destroying a timeline session detaches and preserves its local recording", async () => {
  const runtime = install();
  const controller = initDebugHook({ on() {}, off() {} } as unknown as EventBus);
  try {
    await controller.start("destroy", { profile: "timeline", preset: "sentence" });
    recordPerformance("sentence", "sentence-update", { slots: 2 });
    controller.destroy();
    assert.equal(runtime.listenerCount(), 0);
    assert.equal(performanceRecordingActive(), false);
    const recording = JSON.parse(controller.exportRecording());
    assert.equal(recording.timeline.events.at(-1).data.reason, "destroy");
    assert.equal(recording.session.active, false);
  } finally {
    controller.destroy();
    runtime.restore();
  }
});
