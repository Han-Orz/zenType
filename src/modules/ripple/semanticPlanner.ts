import type {
  RippleSemanticTree,
  SemanticItem,
  SemanticList,
} from "./semanticModel";

export type RippleTargetRole = "marker" | "direct-content" | "branch-root";

export interface RippleTarget {
  semanticId: string;
  role: RippleTargetRole;
  distance: number;
}

export interface RippleTargetPlan {
  focusItemId: string;
  targets: RippleTarget[];
}

interface FocusPathEntry {
  item: SemanticItem;
  parentList: SemanticList;
  activeIndex: number;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSemanticList(value: unknown): value is SemanticList {
  if (!value || typeof value !== "object") return false;
  const list = value as SemanticList;
  if (
    !isNonEmptyString(list.id) ||
    (list.parentItemId !== null && !isNonEmptyString(list.parentItemId)) ||
    !Array.isArray(list.itemIds)
  ) {
    return false;
  }
  for (const itemId of list.itemIds) {
    if (!isNonEmptyString(itemId)) return false;
  }
  return true;
}

function isSemanticItem(value: unknown): value is SemanticItem {
  if (!value || typeof value !== "object") return false;
  const item = value as SemanticItem;
  if (
    !isNonEmptyString(item.id) ||
    !isNonEmptyString(item.parentListId) ||
    (item.markerId !== null && !isNonEmptyString(item.markerId)) ||
    !Array.isArray(item.directContentIds)
  ) {
    return false;
  }
  for (const contentId of item.directContentIds) {
    if (!isNonEmptyString(contentId)) return false;
  }
  return true;
}

function isItemReference(value: unknown, expectedId: string): value is SemanticItem {
  return Boolean(
    value &&
    typeof value === "object" &&
    isNonEmptyString((value as SemanticItem).id) &&
    (value as SemanticItem).id === expectedId,
  );
}

function getFocusPath(
  tree: RippleSemanticTree,
  focusItemId: string,
): FocusPathEntry[] | null {
  if (
    !tree ||
    !(tree.lists instanceof Map) ||
    !(tree.items instanceof Map)
  ) {
    return null;
  }

  const path: FocusPathEntry[] = [];
  const visitedItemIds = new Set<string>();
  const visitedListIds = new Set<string>();
  let item = tree.items.get(focusItemId);
  let expectedItemId = focusItemId;

  while (item) {
    if (
      !isSemanticItem(item) ||
      item.id !== expectedItemId ||
      visitedItemIds.has(item.id)
    ) {
      return null;
    }

    const parentList = tree.lists.get(item.parentListId);
    if (
      !isSemanticList(parentList) ||
      parentList.id !== item.parentListId ||
      visitedListIds.has(parentList.id)
    ) {
      return null;
    }

    const activeIndex = parentList.itemIds.indexOf(item.id);
    if (activeIndex === -1) return null;

    visitedItemIds.add(item.id);
    visitedListIds.add(parentList.id);
    path.push({ item, parentList, activeIndex });

    if (parentList.parentItemId === null) return path;
    const parentItem = tree.items.get(parentList.parentItemId);
    if (!isItemReference(parentItem, parentList.parentItemId)) return null;
    item = parentItem;
    expectedItemId = parentList.parentItemId;
  }

  return null;
}

function addItemTargets(
  targets: RippleTarget[],
  item: SemanticItem,
  distance: number,
): void {
  if (item.markerId !== null) {
    targets.push({ semanticId: item.markerId, role: "marker", distance });
  }
  for (const semanticId of item.directContentIds) {
    targets.push({ semanticId, role: "direct-content", distance });
  }
}

/**
 * Plan semantic ripple targets from ordinary list data.
 *
 * A focus path item contributes only its marker and direct content. Siblings
 * of each path item contribute only the sibling item itself as a branch root;
 * child lists of those branch roots are never traversed.
 */
export function planRippleTargets(
  tree: RippleSemanticTree,
  focusItemId: string,
): RippleTargetPlan | null {
  if (!isNonEmptyString(focusItemId)) return null;

  const focusPath = getFocusPath(tree, focusItemId);
  if (!focusPath) return null;

  const targets: RippleTarget[] = [];

  // Emit the active path first so every path wrapper remains target-free while
  // its own visual units receive the path distance.
  focusPath.forEach(({ item }, distance) => {
    addItemTargets(targets, item, distance);
  });

  // A sibling is represented once, at its item ID. We intentionally stop at
  // that branch root, which suppresses all descendants of that branch.
  for (let pathDistance = 0; pathDistance < focusPath.length; pathDistance++) {
    const { item: activeItem, parentList, activeIndex } = focusPath[pathDistance];
    const visitedSiblingIds = new Set<string>();
    for (let siblingIndex = 0; siblingIndex < parentList.itemIds.length; siblingIndex++) {
      const siblingId = parentList.itemIds[siblingIndex];
      if (visitedSiblingIds.has(siblingId)) return null;
      visitedSiblingIds.add(siblingId);
      if (siblingIndex === activeIndex) continue;
      if (siblingId === activeItem.id) return null;

      const sibling = tree.items.get(siblingId);
      if (!isItemReference(sibling, siblingId)) return null;
      const distance = pathDistance + Math.abs(siblingIndex - activeIndex);
      if (!Number.isInteger(distance) || distance < 0) return null;
      targets.push({
        semanticId: sibling.id,
        role: "branch-root",
        distance,
      });
    }
  }

  return { focusItemId, targets };
}
