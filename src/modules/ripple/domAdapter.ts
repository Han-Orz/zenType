import {
  createRippleSemanticTree,
  type RippleSemanticTree,
  type SemanticItem,
  type SemanticList,
} from "./semanticModel";

const NODE_LIST = "NodeList";
const NODE_LIST_ITEM = "NodeListItem";
const ACTION_CLASS = "protyle-action";
const ATTR_CLASS = "protyle-attr";

export interface RippleDomSnapshot {
  tree: RippleSemanticTree;
  focusItemId: string;
  bindings: Map<string, HTMLElement>;
}

interface AdapterState {
  lists: SemanticList[];
  items: SemanticItem[];
  bindings: Map<string, HTMLElement>;
  itemIds: Map<HTMLElement, string>;
  visitedLists: Set<HTMLElement>;
  visitedItems: Set<HTMLElement>;
  nextIds: Map<string, number>;
}

function nextSemanticId(state: AdapterState, kind: string): string {
  const next = state.nextIds.get(kind) ?? 0;
  state.nextIds.set(kind, next + 1);
  return `${kind}:${next}`;
}

function dataType(element: HTMLElement): string | null {
  return typeof element.getAttribute === "function"
    ? element.getAttribute("data-type")
    : null;
}

function hasClass(element: HTMLElement, className: string): boolean {
  return element.classList?.contains(className) === true;
}

function childrenOf(element: HTMLElement): HTMLElement[] | null {
  if (!element.children) return null;
  return Array.from(element.children) as HTMLElement[];
}

function parentOf(element: HTMLElement): HTMLElement | null {
  return (element.parentElement as HTMLElement | null | undefined) ?? null;
}

function isWithinRoot(root: HTMLElement, element: HTMLElement): boolean {
  let current: HTMLElement | null = element;
  while (current) {
    if (current === root) return true;
    current = parentOf(current);
  }
  return false;
}

function isNodeList(element: HTMLElement | null): element is HTMLElement {
  return element !== null && dataType(element) === NODE_LIST;
}

function isNodeListItem(element: HTMLElement | null): element is HTMLElement {
  return element !== null && dataType(element) === NODE_LIST_ITEM;
}

function isSvgOrUse(element: HTMLElement): boolean {
  const tagName = typeof element.tagName === "string"
    ? element.tagName.toLowerCase()
    : "";
  return tagName === "svg" || tagName === "use";
}

function findFocusItem(
  wysiwyg: HTMLElement,
  focusElement: HTMLElement,
): HTMLElement | null {
  if (!isWithinRoot(wysiwyg, focusElement)) return null;

  let current: HTMLElement | null = focusElement;
  while (current && current !== wysiwyg) {
    if (isNodeListItem(current)) return current;
    current = parentOf(current);
  }
  return null;
}

function findOutermostList(
  wysiwyg: HTMLElement,
  focusItem: HTMLElement,
): HTMLElement | null {
  let currentList = parentOf(focusItem);
  if (!isNodeList(currentList) || !isWithinRoot(wysiwyg, currentList)) return null;

  const visitedLists = new Set<HTMLElement>();
  while (true) {
    if (visitedLists.has(currentList)) return null;
    visitedLists.add(currentList);

    const parent = parentOf(currentList);
    if (!parent || parent === wysiwyg || !isNodeListItem(parent)) {
      return currentList;
    }

    const parentList = parentOf(parent);
    if (!isNodeList(parentList) || !isWithinRoot(wysiwyg, parentList)) return null;
    currentList = parentList;
  }
}

function parseItem(
  state: AdapterState,
  itemElement: HTMLElement,
  parentListId: string,
): string | null {
  if (!isNodeListItem(itemElement) || state.visitedItems.has(itemElement)) return null;

  state.visitedItems.add(itemElement);
  const itemId = nextSemanticId(state, "item");
  state.itemIds.set(itemElement, itemId);
  state.bindings.set(itemId, itemElement);

  const directContentIds: string[] = [];
  let markerId: string | null = null;
  const children = childrenOf(itemElement);
  if (!children) return null;

  for (const child of children) {
    if (hasClass(child, ACTION_CLASS)) {
      if (markerId === null) {
        markerId = nextSemanticId(state, "marker");
        state.bindings.set(markerId, child);
      }
      continue;
    }

    if (hasClass(child, ATTR_CLASS)) continue;

    if (isNodeList(child)) {
      if (parseList(state, child, itemId) === null) return null;
      continue;
    }

    if (isNodeListItem(child) || isSvgOrUse(child)) continue;

    if (child.getAttribute("data-node-id") !== null) {
      const contentId = nextSemanticId(state, "content");
      directContentIds.push(contentId);
      state.bindings.set(contentId, child);
    }
  }

  state.items.push({
    id: itemId,
    parentListId,
    markerId,
    directContentIds,
  });
  return itemId;
}

function parseList(
  state: AdapterState,
  listElement: HTMLElement,
  parentItemId: string | null,
): string | null {
  if (!isNodeList(listElement) || state.visitedLists.has(listElement)) return null;

  state.visitedLists.add(listElement);
  const listId = nextSemanticId(state, "list");
  const itemIds: string[] = [];
  state.lists.push({ id: listId, parentItemId, itemIds });

  const children = childrenOf(listElement);
  if (!children) return null;

  for (const child of children) {
    if (!isNodeListItem(child)) continue;
    const itemId = parseItem(state, child, listId);
    if (itemId === null) return null;
    itemIds.push(itemId);
  }

  return listId;
}

/**
 * Build a read-only semantic snapshot for the list subtree containing focus.
 * The supplied WYSIWYG root is the only boundary used; no global DOM lookup
 * or selection access is performed here.
 */
export function buildRippleDomSnapshot(
  wysiwyg: HTMLElement,
  focusElement: HTMLElement,
): RippleDomSnapshot | null {
  if (!wysiwyg || !focusElement) return null;

  const focusItem = findFocusItem(wysiwyg, focusElement);
  if (!focusItem) return null;

  const rootList = findOutermostList(wysiwyg, focusItem);
  if (!rootList) return null;

  const state: AdapterState = {
    lists: [],
    items: [],
    bindings: new Map<string, HTMLElement>(),
    itemIds: new Map<HTMLElement, string>(),
    visitedLists: new Set<HTMLElement>(),
    visitedItems: new Set<HTMLElement>(),
    nextIds: new Map<string, number>(),
  };

  if (parseList(state, rootList, null) === null) return null;

  const focusItemId = state.itemIds.get(focusItem);
  if (!focusItemId) return null;

  return {
    tree: createRippleSemanticTree(state.lists, state.items),
    focusItemId,
    bindings: state.bindings,
  };
}
