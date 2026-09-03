import assert from "node:assert/strict";
import test from "node:test";
import { RIPPLE_CONFIG } from "../src/config";
import {
  createRippleStyleApplier,
} from "../src/modules/ripple/styleApplier";
import type {
  RippleTarget,
  RippleTargetPlan,
  RippleTargetRole,
} from "../src/modules/ripple/semanticPlanner";

const OPACITY_PROPERTY = "--zt-ripple-opacity";
const DURATION_PROPERTY = "--zt-ripple-transition-duration";
const RIPPLE_CLASS = "zentype-ripple-block";

class FakeStyle {
  private readonly values = new Map<string, { value: string; priority: string }>();
  setPropertyCount = 0;
  readonly writes: Array<{ property: string; value: string; priority: string }> = [];

  getPropertyValue(property: string): string {
    return this.values.get(property)?.value ?? "";
  }

  getPropertyPriority(property: string): string {
    return this.values.get(property)?.priority ?? "";
  }

  setProperty(property: string, value: string, priority = ""): void {
    this.setPropertyCount++;
    this.writes.push({ property, value, priority });
    if (value === "") {
      this.values.delete(property);
      return;
    }
    this.values.set(property, { value, priority });
  }
}

class FakeClassList {
  private readonly names = new Set<string>();
  addCount = 0;
  removeCount = 0;

  contains(name: string): boolean {
    return this.names.has(name);
  }

  add(name: string): void {
    this.addCount++;
    this.names.add(name);
  }

  remove(name: string): void {
    this.removeCount++;
    this.names.delete(name);
  }
}

class FakeElement {
  readonly style = new FakeStyle();
  readonly classList = new FakeClassList();
  readonly descendants = new Set<HTMLElement>();

  contains(node: Node): boolean {
    return this.descendants.has(node as unknown as HTMLElement);
  }
}

function asHTMLElement(element: FakeElement): HTMLElement {
  return element as unknown as HTMLElement;
}

function target(semanticId: string, distance: number): RippleTarget {
  return targetWithRole(semanticId, "direct-content", distance);
}

function targetWithRole(
  semanticId: string,
  role: RippleTargetRole,
  distance: number,
): RippleTarget {
  return { semanticId, role, distance };
}

function plan(...targets: RippleTarget[]): RippleTargetPlan {
  return { focusItemId: "focus", targets };
}

function binding(...entries: [string, FakeElement][]): ReadonlyMap<string, HTMLElement> {
  return new Map(entries.map(([id, element]) => [id, asHTMLElement(element)]));
}

class FakeTimers {
  private readonly originalSetTimeout = globalThis.setTimeout;
  private readonly originalClearTimeout = globalThis.clearTimeout;
  private nextId = 1;
  readonly pending = new Map<number, () => void>();
  readonly delays = new Map<number, number>();

  install(): void {
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      value: (callback: () => void, delay = 0) => {
        const id = this.nextId++;
        this.pending.set(id, callback);
        this.delays.set(id, delay);
        return id;
      },
    });
    Object.defineProperty(globalThis, "clearTimeout", {
      configurable: true,
      value: (id: number) => {
        this.pending.delete(id);
        this.delays.delete(id);
      },
    });
  }

  flushAll(): void {
    for (const [id, callback] of [...this.pending]) {
      this.pending.delete(id);
      this.delays.delete(id);
      callback();
    }
  }

  restore(): void {
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      value: this.originalSetTimeout,
    });
    Object.defineProperty(globalThis, "clearTimeout", {
      configurable: true,
      value: this.originalClearTimeout,
    });
  }
}

class FakeAnimationFrames {
  private readonly originalRequest = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  private readonly originalCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  private nextId = 1;
  readonly pending = new Map<number, FrameRequestCallback>();

  install(): void {
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        const id = this.nextId++;
        this.pending.set(id, callback);
        return id;
      },
    });
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      configurable: true,
      value: (id: number) => this.pending.delete(id),
    });
  }

  flushNext(time = 0): void {
    const entry = this.pending.entries().next().value as [number, FrameRequestCallback] | undefined;
    assert.ok(entry, "expected a pending handoff frame");
    this.pending.delete(entry[0]);
    entry[1](time);
  }

  restore(): void {
    if (this.originalRequest) Object.defineProperty(globalThis, "requestAnimationFrame", this.originalRequest);
    else delete (globalThis as unknown as Record<string, unknown>).requestAnimationFrame;
    if (this.originalCancel) Object.defineProperty(globalThis, "cancelAnimationFrame", this.originalCancel);
    else delete (globalThis as unknown as Record<string, unknown>).cancelAnimationFrame;
  }
}

function withFakeTimers(run: (timers: FakeTimers) => void): void {
  const timers = new FakeTimers();
  timers.install();
  try {
    run(timers);
  } finally {
    timers.restore();
  }
}

function withFakeAnimationFrames(run: (frames: FakeAnimationFrames) => void): void {
  const frames = new FakeAnimationFrames();
  frames.install();
  try {
    run(frames);
  } finally {
    frames.restore();
  }
}

test("maps semantic distance to configured opacity and clamps only at apply time", () => {
  const distanceZero = new FakeElement();
  const distanceOne = new FakeElement();
  const distanceFar = new FakeElement();
  const applier = createRippleStyleApplier();

  applier.apply(
    plan(
      target("zero", 0),
      target("one", 1),
      target("far", RIPPLE_CONFIG.BLOCK_LEVELS.length + 3),
    ),
    binding(
      ["zero", distanceZero],
      ["one", distanceOne],
      ["far", distanceFar],
    ),
  );

  assert.equal(distanceZero.style.getPropertyValue(OPACITY_PROPERTY), "1");
  assert.equal(
    distanceOne.style.getPropertyValue(OPACITY_PROPERTY),
    String(RIPPLE_CONFIG.BLOCK_LEVELS[1]),
  );
  assert.equal(
    distanceFar.style.getPropertyValue(OPACITY_PROPERTY),
    String(RIPPLE_CONFIG.BLOCK_LEVELS[RIPPLE_CONFIG.BLOCK_LEVELS.length - 1]),
  );
  for (const element of [distanceZero, distanceOne, distanceFar]) {
    assert.equal(
      element.style.getPropertyValue(DURATION_PROPERTY),
      `${RIPPLE_CONFIG.TRANSITION_SEC}s`,
    );
    assert.equal(element.classList.contains(RIPPLE_CLASS), true);
  }
});

test("transitions a stale target to natural opacity before restoring it", () => {
  withFakeTimers((timers) => {
    const stale = new FakeElement();
    stale.style.setProperty(OPACITY_PROPERTY, "0.73", "important");
    stale.style.setProperty(DURATION_PROPERTY, "1.2s", "important");
    const retained = new FakeElement();
    const applier = createRippleStyleApplier();

    applier.apply(
      plan(target("stale", 1), target("retained", 2)),
      binding(["stale", stale], ["retained", retained]),
    );
    applier.apply(
      plan(target("retained", 0)),
      binding(["retained", retained]),
    );

    assert.equal(stale.style.getPropertyValue(OPACITY_PROPERTY), "1");
    assert.equal(stale.style.getPropertyPriority(OPACITY_PROPERTY), "");
    assert.equal(stale.style.getPropertyValue(DURATION_PROPERTY), `${RIPPLE_CONFIG.TRANSITION_SEC}s`);
    assert.equal(stale.classList.contains(RIPPLE_CLASS), true);
    assert.equal(timers.pending.size, 1);
    assert.equal(retained.style.getPropertyValue(OPACITY_PROPERTY), "1");
    assert.equal(retained.classList.contains(RIPPLE_CLASS), true);

    timers.flushAll();

    assert.equal(stale.style.getPropertyValue(OPACITY_PROPERTY), "0.73");
    assert.equal(stale.style.getPropertyPriority(OPACITY_PROPERTY), "important");
    assert.equal(stale.style.getPropertyValue(DURATION_PROPERTY), "1.2s");
    assert.equal(stale.style.getPropertyPriority(DURATION_PROPERTY), "important");
    assert.equal(stale.classList.contains(RIPPLE_CLASS), false);
  });
});

test("retargets an existing element without staging natural opacity", () => {
  const element = new FakeElement();
  const applier = createRippleStyleApplier();

  applier.apply(plan(target("content", 2)), binding(["content", element]));
  element.style.writes.length = 0;
  applier.apply(plan(target("content", 1)), binding(["content", element]));

  assert.deepEqual(
    element.style.writes
      .filter((write) => write.property === OPACITY_PROPERTY)
      .map((write) => write.value),
    [String(RIPPLE_CONFIG.BLOCK_LEVELS[1])],
  );
  assert.equal(element.style.getPropertyValue(OPACITY_PROPERTY), String(RIPPLE_CONFIG.BLOCK_LEVELS[1]));
});

test("hands ancestor ownership to a descendant at the old visual baseline", () => {
  withFakeAnimationFrames((frames) => {
    const branchRoot = new FakeElement();
    const descendant = new FakeElement();
    branchRoot.descendants.add(asHTMLElement(descendant));
    branchRoot.style.setProperty(OPACITY_PROPERTY, "0.73", "important");
    branchRoot.style.setProperty(DURATION_PROPERTY, "1.2s", "important");
    const applier = createRippleStyleApplier();

    applier.apply(
      plan(targetWithRole("branch", "branch-root", 1)),
      binding(["branch", branchRoot]),
    );
    descendant.style.writes.length = 0;
    applier.apply(
      plan(target("content", 1)),
      binding(["content", descendant]),
    );

    assert.equal(branchRoot.style.getPropertyValue(OPACITY_PROPERTY), "0.73");
    assert.equal(branchRoot.style.getPropertyPriority(OPACITY_PROPERTY), "important");
    assert.equal(branchRoot.style.getPropertyValue(DURATION_PROPERTY), "1.2s");
    assert.equal(branchRoot.classList.contains(RIPPLE_CLASS), false);
    assert.equal(descendant.style.getPropertyValue(OPACITY_PROPERTY), "0.4");
    assert.equal(
      descendant.style.getPropertyValue(DURATION_PROPERTY),
      `${RIPPLE_CONFIG.TRANSITION_SEC}s`,
    );
    assert.equal(descendant.classList.contains(RIPPLE_CLASS), true);
    assert.deepEqual(
      descendant.style.writes
        .filter((write) => write.property === OPACITY_PROPERTY)
        .map((write) => write.value),
      ["0.4"],
    );
    assert.equal(descendant.style.getPropertyValue(OPACITY_PROPERTY), "0.4");
    assert.equal(
      descendant.style.getPropertyValue(DURATION_PROPERTY),
      `${RIPPLE_CONFIG.TRANSITION_SEC}s`,
    );
    assert.equal(frames.pending.size, 0);
  });
});

test("retargets a transferred descendant from the old baseline without natural opacity", () => {
  withFakeAnimationFrames((frames) => {
    const branchRoot = new FakeElement();
    const descendant = new FakeElement();
    branchRoot.descendants.add(asHTMLElement(descendant));
    const applier = createRippleStyleApplier();

    applier.apply(
      plan(targetWithRole("branch", "branch-root", 1)),
      binding(["branch", branchRoot]),
    );
    descendant.style.writes.length = 0;
    applier.apply(
      plan(target("content", 2)),
      binding(["content", descendant]),
    );

    assert.equal(descendant.style.getPropertyValue(OPACITY_PROPERTY), "0.4");
    assert.equal(descendant.style.getPropertyValue(DURATION_PROPERTY), "0s");
    assert.deepEqual(
      descendant.style.writes
        .filter((write) => write.property === OPACITY_PROPERTY)
        .map((write) => write.value),
      ["0.4"],
    );

    frames.flushNext();
    assert.equal(descendant.style.getPropertyValue(OPACITY_PROPERTY), "0.2");
    assert.equal(
      descendant.style.getPropertyValue(DURATION_PROPERTY),
      `${RIPPLE_CONFIG.TRANSITION_SEC}s`,
    );
    assert.deepEqual(
      descendant.style.writes
        .filter((write) => write.property === OPACITY_PROPERTY)
        .map((write) => write.value),
      ["0.4", "0.2"],
    );
  });
});

test("hands descendant ownership to an ancestor without a double-dim paint", () => {
  withFakeAnimationFrames((frames) => {
    const ancestor = new FakeElement();
    const descendant = new FakeElement();
    ancestor.descendants.add(asHTMLElement(descendant));
    descendant.style.setProperty(OPACITY_PROPERTY, "0.73", "important");
    const applier = createRippleStyleApplier();

    applier.apply(
      plan(target("content", 1)),
      binding(["content", descendant]),
    );
    applier.apply(
      plan(targetWithRole("branch", "branch-root", 0)),
      binding(["branch", ancestor]),
    );

    assert.equal(descendant.style.getPropertyValue(OPACITY_PROPERTY), "0.73");
    assert.equal(descendant.style.getPropertyPriority(OPACITY_PROPERTY), "important");
    assert.equal(descendant.classList.contains(RIPPLE_CLASS), false);
    assert.equal(ancestor.style.getPropertyValue(OPACITY_PROPERTY), "0.4");
    assert.equal(ancestor.style.getPropertyValue(DURATION_PROPERTY), "0s");
    assert.equal(ancestor.classList.contains(RIPPLE_CLASS), true);

    frames.flushNext();
    assert.equal(ancestor.style.getPropertyValue(OPACITY_PROPERTY), "1");
    assert.equal(
      ancestor.style.getPropertyValue(DURATION_PROPERTY),
      `${RIPPLE_CONFIG.TRANSITION_SEC}s`,
    );
  });
});

test("cancels a pending true exit when the element is targeted again", () => {
  withFakeTimers((timers) => {
    const branchRoot = new FakeElement();
    const applier = createRippleStyleApplier();

    applier.apply(
      plan(targetWithRole("branch", "branch-root", 2)),
      binding(["branch", branchRoot]),
    );
    applier.apply(plan(), binding());
    assert.equal(timers.pending.size, 1);

    applier.apply(
      plan(targetWithRole("branch", "branch-root", 1)),
      binding(["branch", branchRoot]),
    );

    assert.equal(timers.pending.size, 0);
    assert.equal(branchRoot.style.getPropertyValue(OPACITY_PROPERTY), "0.4");
    assert.equal(branchRoot.classList.contains(RIPPLE_CLASS), true);
    timers.flushAll();
    assert.equal(branchRoot.style.getPropertyValue(OPACITY_PROPERTY), "0.4");
    assert.equal(branchRoot.classList.contains(RIPPLE_CLASS), true);
  });
});

test("clear transitions active targets before restoring styles", () => {
  withFakeTimers((timers) => {
    const branchRoot = new FakeElement();
    branchRoot.style.setProperty(OPACITY_PROPERTY, "0.73", "important");
    branchRoot.style.setProperty(DURATION_PROPERTY, "1.2s", "important");
    const applier = createRippleStyleApplier();

    applier.apply(
      plan(targetWithRole("branch", "branch-root", 2)),
      binding(["branch", branchRoot]),
    );

    applier.clear();

    assert.equal(timers.pending.size, 1);
    assert.equal(branchRoot.style.getPropertyValue(OPACITY_PROPERTY), "1");
    assert.equal(branchRoot.style.getPropertyValue(DURATION_PROPERTY), `${RIPPLE_CONFIG.TRANSITION_SEC}s`);
    assert.equal(branchRoot.classList.contains(RIPPLE_CLASS), true);
    timers.flushAll();
    assert.equal(branchRoot.style.getPropertyValue(OPACITY_PROPERTY), "0.73");
    assert.equal(branchRoot.style.getPropertyValue(DURATION_PROPERTY), "1.2s");
    assert.equal(branchRoot.classList.contains(RIPPLE_CLASS), false);
  });
});

test("clear restores private properties without touching ordinary styles", () => {
  withFakeTimers((timers) => {
    const element = new FakeElement();
    element.style.setProperty(OPACITY_PROPERTY, "0.81");
    element.style.setProperty(DURATION_PROPERTY, "2s");
    element.style.setProperty("opacity", "0.42");
    element.style.setProperty("transition", "color 1s");
    const applier = createRippleStyleApplier();

    applier.apply(plan(target("content", 1)), binding(["content", element]));
    applier.clear();
    timers.flushAll();

    assert.equal(element.style.getPropertyValue(OPACITY_PROPERTY), "0.81");
    assert.equal(element.style.getPropertyValue(DURATION_PROPERTY), "2s");
    assert.equal(element.style.getPropertyValue("opacity"), "0.42");
    assert.equal(element.style.getPropertyValue("transition"), "color 1s");
    assert.equal(element.classList.contains(RIPPLE_CLASS), false);
  });
});

test("reapplying an identical plan performs no inline style or class writes", () => {
  const element = new FakeElement();
  const applier = createRippleStyleApplier();
  const input = plan(target("content", 1));
  const bindings = binding(["content", element]);

  applier.apply(input, bindings);
  element.style.setPropertyCount = 0;
  element.classList.addCount = 0;
  element.classList.removeCount = 0;

  applier.apply(input, bindings);

  assert.equal(element.style.setPropertyCount, 0);
  assert.equal(element.classList.addCount, 0);
  assert.equal(element.classList.removeCount, 0);
});

test("external private-property changes are not overwritten on reapply", () => {
  const element = new FakeElement();
  const applier = createRippleStyleApplier();
  const input = plan(target("content", 1));
  const bindings = binding(["content", element]);

  applier.apply(input, bindings);
  element.style.setProperty(OPACITY_PROPERTY, "0.87");
  element.style.setPropertyCount = 0;

  applier.apply(input, bindings);

  assert.equal(element.style.getPropertyValue(OPACITY_PROPERTY), "0.87");
  assert.equal(element.classList.contains(RIPPLE_CLASS), false);
});
