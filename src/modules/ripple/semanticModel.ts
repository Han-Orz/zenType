/**
 * DOM-independent semantic representation of a nested list.
 *
 * Lists own their direct items, and an item owns its direct content and child
 * lists. The references are deliberately kept as IDs so this model can be
 * built from any adapter in a later phase.
 */

export interface SemanticList {
  id: string;
  parentItemId: string | null;
  itemIds: readonly string[];
}

export interface SemanticItem {
  id: string;
  parentListId: string;
  siblingIndex: number;
  markerId: string | null;
  directContentIds: readonly string[];
  childListIds: readonly string[];
}

export interface RippleSemanticTree {
  lists: Map<string, SemanticList>;
  items: Map<string, SemanticItem>;
}

export function createRippleSemanticTree(
  lists: Iterable<SemanticList>,
  items: Iterable<SemanticItem>,
): RippleSemanticTree {
  const listMap = new Map<string, SemanticList>();
  for (const list of lists) listMap.set(list.id, list);

  const itemMap = new Map<string, SemanticItem>();
  for (const item of items) itemMap.set(item.id, item);

  return { lists: listMap, items: itemMap };
}
