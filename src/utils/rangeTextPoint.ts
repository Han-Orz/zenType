/**
 * Resolve a DOM Range boundary to a concrete text node without mutating the
 * document. Element-container ranges use child indexes rather than character
 * offsets, so the resolver preserves the boundary by preferring the first
 * text node at/after the boundary and falling back to the last text node
 * before it.
 */

export interface RangeTextPoint {
  textNode: Text;
  offset: number;
}
const TEXT_NODE = 3;

function isTextNode(node: Node): node is Text {
  return node.nodeType === TEXT_NODE;
}

function childNodesOf(node: Node): Node[] {
  return Array.from(node.childNodes);
}

function findFirstText(node: Node, skipEmpty: boolean): Text | null {
  if (isTextNode(node)) {
    if (!skipEmpty || node.data.length > 0) return node;
    return null;
  }

  for (const child of childNodesOf(node)) {
    const text = findFirstText(child, skipEmpty);
    if (text) return text;
  }
  return null;
}

function findLastText(node: Node, skipEmpty: boolean): Text | null {
  if (isTextNode(node)) {
    if (!skipEmpty || node.data.length > 0) return node;
    return null;
  }

  const children = childNodesOf(node);
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const text = findLastText(children[index], skipEmpty);
    if (text) return text;
  }
  return null;
}

function findTextAfterBoundary(children: Node[], offset: number, skipEmpty: boolean): Text | null {
  for (let index = offset; index < children.length; index += 1) {
    const text = findFirstText(children[index], skipEmpty);
    if (text) return text;
  }
  return null;
}

function findTextBeforeBoundary(children: Node[], offset: number, skipEmpty: boolean): Text | null {
  for (let index = Math.min(offset, children.length) - 1; index >= 0; index -= 1) {
    const text = findLastText(children[index], skipEmpty);
    if (text) return text;
  }
  return null;
}

/**
 * Resolve an element/document-fragment range point. Empty text nodes are
 * skipped when a real text node exists, but are retained as a final fallback
 * for genuinely empty content placeholders.
 */
export function resolveRangeTextPoint(container: Node, offset: number): RangeTextPoint | null {
  if (isTextNode(container)) {
    const length = container.data.length;
    return {
      textNode: container,
      offset: Math.max(0, Math.min(length, offset)),
    };
  }

  const children = childNodesOf(container);
  if (children.length === 0) return null;

  const boundary = Math.max(0, Math.min(children.length, offset));
  const forward = findTextAfterBoundary(children, boundary, true);
  if (forward) return { textNode: forward, offset: 0 };

  const backward = findTextBeforeBoundary(children, boundary, true);
  if (backward) return { textNode: backward, offset: backward.data.length };

  // All available text nodes are empty. Preserve the same boundary preference
  // so an empty placeholder does not unexpectedly jump to the opposite side.
  const emptyForward = findTextAfterBoundary(children, boundary, false);
  if (emptyForward) return { textNode: emptyForward, offset: 0 };

  const emptyBackward = findTextBeforeBoundary(children, boundary, false);
  if (emptyBackward) return { textNode: emptyBackward, offset: emptyBackward.data.length };

  return null;
}
