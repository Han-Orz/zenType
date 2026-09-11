import { RIPPLE_LEVELS } from "../../config";
import { STRUCTURE_LIMITS } from "../../structure";

function isTarget(element: Element): element is HTMLElement {
  return element instanceof HTMLElement && (!!element.dataset.nodeId || element.classList.contains("protyle-action"));
}

/** Read-only semantic neighborhood. Markers share their item's direct content distance. */
export function collectTargets(block: HTMLElement, editor: HTMLElement): Map<HTMLElement, number> {
  const targets = new Map<HTMLElement, number>();
  let branch = block;
  let depth = 0;
  let visited = 0;
  for (let level = 0; branch !== editor && branch.parentElement && level < STRUCTURE_LIMITS.depth; level++) {
    let markerLevel = depth;
    if (branch.dataset.type === "NodeList") {
      const siblings: HTMLElement[] = [];
      for (const child of branch.parentElement.children) {
        if (++visited > STRUCTURE_LIMITS.nodes) break;
        if (isTarget(child)) siblings.push(child);
      }
      const content = siblings.find(node => node !== branch && !node.classList.contains("protyle-action") && node.dataset.type !== "NodeList");
      markerLevel = depth + Math.max(1, Math.abs(siblings.indexOf(branch) - (content ? siblings.indexOf(content) : -1)));
    }
    for (const direction of ["previousElementSibling", "nextElementSibling"] as const) {
      let sibling = branch[direction];
      for (let distance = 1; sibling && distance <= 48; sibling = sibling[direction]) {
        if (++visited > STRUCTURE_LIMITS.nodes) break;
        if (!isTarget(sibling)) continue;
        const distanceFromFocus = sibling.classList.contains("protyle-action") ? markerLevel : depth + distance;
        targets.set(sibling, RIPPLE_LEVELS[Math.min(distanceFromFocus, RIPPLE_LEVELS.length - 1)]);
        distance++;
      }
    }
    if (visited > STRUCTURE_LIMITS.nodes) break;
    if (branch.parentElement.dataset.type === "NodeListItem") depth++;
    branch = branch.parentElement;
  }
  targets.set(block, 1);
  return targets;
}

export interface BlockStep { value: number; target: number }

/**
 * Repartition the existing alpha product into new disjoint owners, without writes.
 * Ancestor -> children folds down; children -> ancestor takes the brightest child
 * and leaves normalized residuals underneath. Each walk is bounded, never pairs
 * every old owner with every target. Called only when the owner plan changes.
 */
export function planHandoff(old: ReadonlyMap<HTMLElement, number>, targets: ReadonlyMap<HTMLElement, number>, editor: HTMLElement) {
  const steps = new Map<HTMLElement, BlockStep>();
  const ancestors = new Set<HTMLElement>();
  const nearest = new Map<HTMLElement, HTMLElement>();
  const donors = new Map<HTMLElement, { element: HTMLElement; value: number }>();
  function walk(element: HTMLElement, visit: (parent: HTMLElement) => boolean | void) {
    let parent = element.parentElement;
    for (let depth = 0; parent && parent !== editor && depth < STRUCTURE_LIMITS.depth; depth++, parent = parent.parentElement) {
      if (visit(parent) === false) break;
    }
  }
  for (const [element, target] of targets) {
    let value = old.get(element) ?? 1;
    // Folding a released ancestor's value into a target that the plan neutralizes
    // animates away a dim frame no earlier frame showed. That ancestor is either
    // already dimming the element through its own opacity, or — after a reparent
    // such as a list indent — it dimmed a different subtree and this element has
    // simply moved underneath it. Only a target that inherits the released role
    // carries the ancestor's factor, and that target is never neutral.
    const inherits = target !== 1;
    walk(element, parent => {
      ancestors.add(parent);
      if (inherits) value *= old.get(parent) ?? 1;
    });
    steps.set(element, { value, target });
  }
  for (const [element, value] of old) {
    if (targets.has(element) || !element.isConnected) continue;
    walk(element, parent => {
      if (!targets.has(parent)) return;
      nearest.set(element, parent);
      if (!old.has(parent) && value > (donors.get(parent)?.value ?? 0)) donors.set(parent, { element, value });
      return false;
    });
  }
  for (const [element, donor] of donors) steps.get(element)!.value *= donor.value;
  for (const [element, value] of old) {
    if (targets.has(element) || !element.isConnected || ancestors.has(element)) continue;
    const parent = nearest.get(element);
    const donor = parent && donors.get(parent);
    if (donor && donor.element === element) continue;
    steps.set(element, { value: donor ? value / donor.value : value, target: 1 });
  }
  return steps;
}
