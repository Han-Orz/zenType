import assert from "node:assert/strict";
import test from "node:test";
import { RIPPLE_CONFIG } from "../src/config";
import {
  createRippleStyleApplier,
} from "../src/modules/ripple/styleApplier";
import type {
  RippleTarget,
  RippleTargetPlan,
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
}

function asHTMLElement(element: FakeElement): HTMLElement {
  return element as unknown as HTMLElement;
}

function target(semanticId: string, distance: number): RippleTarget {
  return { semanticId, role: "direct-content", distance };
}

function plan(...targets: RippleTarget[]): RippleTargetPlan {
  return { focusItemId: "focus", targets };
}

function binding(...entries: [string, FakeElement][]): ReadonlyMap<string, HTMLElement> {
  return new Map(entries.map(([id, element]) => [id, asHTMLElement(element)]));
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
