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

  getPropertyValue(property: string): string {
    return this.values.get(property)?.value ?? "";
  }

  getPropertyPriority(property: string): string {
    return this.values.get(property)?.priority ?? "";
  }

  setProperty(property: string, value: string, priority = ""): void {
    this.setPropertyCount++;
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

function withFakeTimers(run: (timers: FakeTimers) => void): void {
  const timers = new FakeTimers();
  timers.install();
  try {
    run(timers);
  } finally {
    timers.restore();
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

test("restores stale targets when a new plan drops them", () => {
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

  assert.equal(stale.style.getPropertyValue(OPACITY_PROPERTY), "0.73");
  assert.equal(stale.style.getPropertyPriority(OPACITY_PROPERTY), "important");
  assert.equal(stale.style.getPropertyValue(DURATION_PROPERTY), "1.2s");
  assert.equal(stale.style.getPropertyPriority(DURATION_PROPERTY), "important");
  assert.equal(stale.classList.contains(RIPPLE_CLASS), false);
  assert.equal(retained.style.getPropertyValue(OPACITY_PROPERTY), "1");
  assert.equal(retained.classList.contains(RIPPLE_CLASS), true);
});

test("animates a stale branch root until its new descendant targets take over", () => {
  withFakeTimers((timers) => {
    const branchRoot = new FakeElement();
    const descendant = new FakeElement();
    branchRoot.descendants.add(asHTMLElement(descendant));
    branchRoot.style.setProperty(OPACITY_PROPERTY, "0.73", "important");
    branchRoot.style.setProperty(DURATION_PROPERTY, "1.2s", "important");
    const applier = createRippleStyleApplier();

    applier.apply(
      plan(targetWithRole("branch", "branch-root", 2)),
      binding(["branch", branchRoot]),
    );
    applier.apply(
      plan(target("content", 0)),
      binding(["content", descendant]),
    );

    assert.equal(branchRoot.style.getPropertyValue(OPACITY_PROPERTY), "1");
    assert.equal(
      branchRoot.style.getPropertyValue(DURATION_PROPERTY),
      `${RIPPLE_CONFIG.TRANSITION_SEC}s`,
    );
    assert.equal(branchRoot.classList.contains(RIPPLE_CLASS), true);
    assert.equal(branchRoot.classList.removeCount, 0);
    assert.equal(timers.pending.size, 1);
    assert.equal(
      [...timers.delays.values()][0],
      RIPPLE_CONFIG.TRANSITION_SEC * 1000,
    );

    timers.flushAll();

    assert.equal(branchRoot.style.getPropertyValue(OPACITY_PROPERTY), "0.73");
    assert.equal(branchRoot.style.getPropertyPriority(OPACITY_PROPERTY), "important");
    assert.equal(branchRoot.style.getPropertyValue(DURATION_PROPERTY), "1.2s");
    assert.equal(branchRoot.style.getPropertyPriority(DURATION_PROPERTY), "important");
    assert.equal(branchRoot.classList.contains(RIPPLE_CLASS), false);
  });
});

test("releases a stale descendant immediately when its ancestor becomes a branch root", () => {
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
  assert.equal(ancestor.style.getPropertyValue(OPACITY_PROPERTY), "1");
  assert.equal(ancestor.classList.contains(RIPPLE_CLASS), true);
});

test("cancels a pending branch-root exit when the element is targeted again", () => {
  withFakeTimers((timers) => {
    const branchRoot = new FakeElement();
    const descendant = new FakeElement();
    branchRoot.descendants.add(asHTMLElement(descendant));
    const applier = createRippleStyleApplier();

    applier.apply(
      plan(targetWithRole("branch", "branch-root", 2)),
      binding(["branch", branchRoot]),
    );
    applier.apply(
      plan(target("content", 0)),
      binding(["content", descendant]),
    );
    assert.equal(timers.pending.size, 1);
    applier.apply(
      plan(target("content", 0)),
      binding(["content", descendant]),
    );
    applier.apply(
      plan(target("content", 0)),
      binding(["content", descendant]),
    );
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

test("clear cancels branch-root exit and restores styles immediately", () => {
  withFakeTimers((timers) => {
    const branchRoot = new FakeElement();
    const descendant = new FakeElement();
    branchRoot.descendants.add(asHTMLElement(descendant));
    branchRoot.style.setProperty(OPACITY_PROPERTY, "0.73", "important");
    branchRoot.style.setProperty(DURATION_PROPERTY, "1.2s", "important");
    const applier = createRippleStyleApplier();

    applier.apply(
      plan(targetWithRole("branch", "branch-root", 2)),
      binding(["branch", branchRoot]),
    );
    applier.apply(
      plan(target("content", 0)),
      binding(["content", descendant]),
    );
    assert.equal(timers.pending.size, 1);

    applier.clear();

    assert.equal(timers.pending.size, 0);
    assert.equal(branchRoot.style.getPropertyValue(OPACITY_PROPERTY), "0.73");
    assert.equal(branchRoot.style.getPropertyValue(DURATION_PROPERTY), "1.2s");
    assert.equal(branchRoot.classList.contains(RIPPLE_CLASS), false);
    timers.flushAll();
    assert.equal(branchRoot.classList.contains(RIPPLE_CLASS), false);
  });
});

test("clear restores private properties without touching ordinary styles", () => {
  const element = new FakeElement();
  element.style.setProperty(OPACITY_PROPERTY, "0.81");
  element.style.setProperty(DURATION_PROPERTY, "2s");
  element.style.setProperty("opacity", "0.42");
  element.style.setProperty("transition", "color 1s");
  const applier = createRippleStyleApplier();

  applier.apply(plan(target("content", 1)), binding(["content", element]));
  applier.clear();

  assert.equal(element.style.getPropertyValue(OPACITY_PROPERTY), "0.81");
  assert.equal(element.style.getPropertyValue(DURATION_PROPERTY), "2s");
  assert.equal(element.style.getPropertyValue("opacity"), "0.42");
  assert.equal(element.style.getPropertyValue("transition"), "color 1s");
  assert.equal(element.classList.contains(RIPPLE_CLASS), false);
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
