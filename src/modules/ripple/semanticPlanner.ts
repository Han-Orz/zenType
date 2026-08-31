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
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasUniqueStrings(values: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const value of values) {
    if (!isNonEmptyString(value) || seen.has(value)) return false;
    seen.add(value);
  }
  return true;
}

/**
 * Keep invalid input a predictable no-op. This is intentionally a small
 * structural check, not a general validation framework.
 */
function isValidSemanticTree(tree: RippleSemanticTree): boolean {
  if (
    !tree ||
    !(tree.lists instanceof Map) ||
    !(tree.items instanceof Map)
  ) {
    return false;
  }

  const referencedItemIds = new Set<string>();
  for (const [mapKey, list] of tree.lists) {
    if (!list || typeof list !== "object") return false;
    if (
      mapKey !== list.id ||
      !isNonEmptyString(list.id) ||
      (list.parentItemId !== null && !isNonEmptyString(list.parentItemId)) ||
      !Array.isArray(list.itemIds)
    ) {
      return false;
    }

    const itemIdsInList = new Set<string>();
    for (let index = 0; index < list.itemIds.length; index++) {
      const itemId = list.itemIds[index];
      const item = tree.items.get(itemId);
      if (
        !isNonEmptyString(itemId) ||
        itemIdsInList.has(itemId) ||
        !item ||
        item.id !== itemId ||
        item.parentListId !== list.id ||
        item.siblingIndex !== index ||
        referencedItemIds.has(itemId)
      ) {
        return false;
      }
      itemIdsInList.add(itemId);
      referencedItemIds.add(itemId);
    }
  }

  if (referencedItemIds.size !== tree.items.size) return false;

  const visualTargetIds = new Set<string>();
  for (const [mapKey, item] of tree.items) {
    if (!item || typeof item !== "object") return false;
    if (
      mapKey !== item.id ||
      !isNonEmptyString(item.id) ||
      !isNonEmptyString(item.parentListId) ||
      !Number.isInteger(item.siblingIndex) ||
      item.siblingIndex < 0 ||
      (item.markerId !== null && !isNonEmptyString(item.markerId)) ||
      !Array.isArray(item.directContentIds) ||
      !Array.isArray(item.childListIds) ||
      !hasUniqueStrings(item.directContentIds) ||
      !hasUniqueStrings(item.childListIds)
    ) {
      return false;
    }

    if (item.markerId !== null) {
      if (visualTargetIds.has(item.markerId)) return false;
      visualTargetIds.add(item.markerId);
    }
    for (const contentId of item.directContentIds) {
      if (visualTargetIds.has(contentId)) return false;
      visualTargetIds.add(contentId);
    }

    const parentList = tree.lists.get(item.parentListId);
    if (!parentList || parentList.itemIds[item.siblingIndex] !== item.id) return false;

    for (const childListId of item.childListIds) {
      const childList = tree.lists.get(childListId);
      if (!childList || childList.parentItemId !== item.id) return false;
    }
  }

  for (const list of tree.lists.values()) {
    if (list.parentItemId === null) continue;
    const parentItem = tree.items.get(list.parentItemId);
    if (!parentItem || !parentItem.childListIds.includes(list.id)) return false;
  }

  // Every parent link must eventually reach a root list rather than cycle.
  for (const item of tree.items.values()) {
    const visited = new Set<string>();
    let current: SemanticItem | undefined = item;
    while (current) {
      if (visited.has(current.id)) return false;
      visited.add(current.id);

      const parentList = tree.lists.get(current.parentListId);
      if (!parentList) return false;
      if (parentList.parentItemId === null) break;
      current = tree.items.get(parentList.parentItemId);
      if (!current) return false;
    }
  }

  return true;
}

function getFocusPath(
  tree: RippleSemanticTree,
  focusItemId: string,
): FocusPathEntry[] | null {
  const path: FocusPathEntry[] = [];
  const visited = new Set<string>();
  let item = tree.items.get(focusItemId);

  while (item) {
    if (visited.has(item.id)) return null;
    visited.add(item.id);

    const parentList = tree.lists.get(item.parentListId);
    if (!parentList) return null;
    path.push({ item, parentList });

    if (parentList.parentItemId === null) return path;
    item = tree.items.get(parentList.parentItemId);
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
  if (!isValidSemanticTree(tree) || !isNonEmptyString(focusItemId)) return null;

  const focusPath = getFocusPath(tree, focusItemId);
  if (!focusPath) return null;

  const targets: RippleTarget[] = [];

  // Emit the active path first so every path wrapper remains target-free while
  // its own visual units receive the path distance.
  focusPath.forEach(({ item }, distance) => {
    addItemTargets(targets, item, distance);
  });

  // A sibling is represented once, at its item ID. We intentionally do not
  // follow its childListIds, which suppresses all descendants of that branch.
  focusPath.forEach(({ item: activeItem, parentList }, pathDistance) => {
    for (const siblingId of parentList.itemIds) {
      if (siblingId === activeItem.id) continue;
      const sibling = tree.items.get(siblingId);
      if (!sibling) return;

      targets.push({
        semanticId: sibling.id,
        role: "branch-root",
        distance: pathDistance + Math.abs(sibling.siblingIndex - activeItem.siblingIndex),
      });
    }
  });

  return { focusItemId, targets };
}
