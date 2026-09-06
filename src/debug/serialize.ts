import type { IProtyle } from "siyuan";
import * as structuralEdit from "../modules/structuralEdit";
import type {
  DebugAnimationSummary,
  DebugBlockDescription,
  DebugComputedStyle,
  DebugDomTreeNode,
  DebugElementDescription,
  DebugMutationRecord,
  DebugNodeReference,
  DebugRect,
  DebugScrollMetrics,
  DebugScrollState,
  DebugStructuralEditState,
  DebugWatch,
  DebugWatchSample,
} from "./types";

const MAX_TEXT_LENGTH = 2000;
const MAX_ATTR_LENGTH = 300;
const MAX_PATH_DEPTH = 24;
const MAX_BLOCK_CHAIN = 16;
const MAX_TREE_NODES = 1200;
const MAX_TREE_DEPTH = 12;
const MAX_RANGE_RECTS = 8;
const MAX_COMPOSED_PATH = 12;
const MAX_MUTATION_TEXT_NODES = 32;
const MAX_WATCH_ANCESTORS = 5;
const MAX_ACTIVE_ANIMATIONS = 8;

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

export interface DebugSerializeOptions {
  includeText?: boolean;
  maxTextLength?: number;
  onNodeSerialized?: () => void;
  onComputedStyleRead?: () => void;
}

export interface DebugSerializer {
  readonly includeText: boolean;
  setIncludeText(includeText: boolean): void;
  resetNodeIdentity(): void;
  nodeTokenFor(value: EventTarget | Node | null | undefined): string | null;
  nodeReference(
    value: EventTarget | Node | null | undefined,
    root?: Element | null,
    includeText?: boolean,
  ): DebugNodeReference;
  describeElement(
    value: EventTarget | Node | null | undefined,
    root: Element | null,
    fullText?: boolean,
  ): DebugElementDescription | null;
  selectionSnapshot(root: Element | null): Record<string, unknown> | null;
  scrollStateFor(value: Element | null, root: Element | null): DebugScrollState | null;
  protyleDescription(
    protyle: IProtyle | null,
    root: HTMLElement | null,
  ): Record<string, unknown> | null;
  serializeDomTree(
    root: HTMLElement,
    maxNodes?: number,
    maxDepth?: number,
  ): DebugDomTreeNode;
  mutationRecordSummary(record: MutationRecord, root: Element): DebugMutationRecord;
  structuralEditSnapshot(
    snapshot: structuralEdit.StructuralEditSnapshot,
    root?: Element | null,
  ): DebugStructuralEditState;
  eventTargetPayload(event: Event, root: Element | null): Record<string, unknown>;
  watchSamples(
    watches: readonly DebugWatch[],
    root: Element | null,
    reason: string,
  ): DebugWatchSample[];
}

interface BlockLike {
  id?: string;
  parentID?: string;
  parent2ID?: string;
  rootID?: string;
  mode?: number;
  showAll?: boolean;
  scroll?: boolean;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

/** Keep text length observable while allowing forensic sessions to retain content. */
export function redactText(
  value: string | null | undefined,
  includeText: boolean,
  maxLength = MAX_TEXT_LENGTH,
): { length: number; text?: string } | null {
  if (value == null) return null;
  const result: { length: number; text?: string } = { length: value.length };
  if (includeText) result.text = truncate(value, maxLength);
  return result;
}

/** Printable keys are masked only in timing sessions. */
export function summarizeKeyboardKey(key: string, includeText = false): string {
  if (includeText) return key;
  if (key === " ") return "Space";
  return key.length !== 1 ? key : "<printable>";
}

function asNode(value: EventTarget | Node | null | undefined): Node | null {
  if (!value || typeof value !== "object" || !("nodeType" in value)) return null;
  return value as Node;
}

function nodeTypeOf(node: Node | null): number {
  return typeof node?.nodeType === "number" ? node.nodeType : 0;
}

function asElement(value: EventTarget | Node | null | undefined): Element | null {
  const node = asNode(value);
  if (!node) return null;
  if (nodeTypeOf(node) === ELEMENT_NODE) return node as Element;
  return (node as Node & { parentElement?: Element | null }).parentElement ?? null;
}

function isTextNode(value: Node | null): value is Text {
  return nodeTypeOf(value) === TEXT_NODE;
}

function connectedOf(node: Node): boolean {
  return typeof node.isConnected === "boolean" ? node.isConnected : true;
}

function textOf(node: Node | null): string {
  if (!node) return "";
  const candidate = node as Node & { data?: string; nodeValue?: string | null };
  return candidate.nodeValue ?? candidate.data ?? node.textContent ?? "";
}

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

function rectOf(element: Element | null): DebugRect | null {
  if (!element || typeof element.getBoundingClientRect !== "function") return null;
  try {
    const rect = element.getBoundingClientRect();
    return {
      x: round(rect.x),
      y: round(rect.y),
      width: round(rect.width),
      height: round(rect.height),
      top: round(rect.top),
      right: round(rect.right),
      bottom: round(rect.bottom),
      left: round(rect.left),
    };
  } catch {
    return null;
  }
}

function scrollMetricsOf(element: Element | null): DebugScrollMetrics | null {
  if (!element) return null;
  try {
    return {
      scrollTop: round(element.scrollTop),
      scrollLeft: round(element.scrollLeft),
      scrollHeight: round(element.scrollHeight),
      scrollWidth: round(element.scrollWidth),
      clientHeight: round(element.clientHeight),
      clientWidth: round(element.clientWidth),
    };
  } catch {
    return null;
  }
}

function collectAttributes(element: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const attribute of Array.from(element.attributes ?? [])) {
    const name = attribute.name.toLowerCase();
    const isUsefulDataAttribute = name.startsWith("data-")
      && !/(content|text|html|markdown|value)/i.test(name);
    if (
      name === "id"
      || name === "class"
      || name === "style"
      || name === "contenteditable"
      || name === "spellcheck"
      || name === "updated"
      || name.startsWith("aria-")
      || isUsefulDataAttribute
    ) {
      attrs[name] = truncate(attribute.value, MAX_ATTR_LENGTH);
    }
  }
  return attrs;
}

function classesOf(element: Element): string[] {
  return Array.from(element.classList ?? []).slice(0, 32);
}

function directText(element: Element): string {
  let value = "";
  for (const child of Array.from(element.childNodes ?? [])) {
    if (isTextNode(child)) value += textOf(child);
  }
  return value;
}

function directTextLength(element: Element): number {
  return directText(element).length;
}

function subtreeTextLength(element: Element): number {
  return element.textContent?.length ?? 0;
}

function elementToken(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const nodeId = element.getAttribute("data-node-id");
  if (nodeId) return `${tag}[data-node-id="${truncate(nodeId, 80)}"]`;
  const dataType = element.getAttribute("data-type");
  if (dataType) return `${tag}[data-type="${truncate(dataType, 80)}"]`;
  const classes = classesOf(element).slice(0, 3);
  return `${tag}${classes.map((name) => `.${name}`).join("")}`;
}

function nodePath(value: EventTarget | Node | null | undefined, root?: Element | null): string {
  let element = asElement(value);
  if (!element) return "";
  const parts: string[] = [];
  let count = 0;
  while (element && count < MAX_PATH_DEPTH) {
    parts.unshift(elementToken(element));
    if (element === root) break;
    element = element.parentElement;
    count += 1;
  }
  return parts.join(" > ");
}

function styleValue(style: CSSStyleDeclaration, property: keyof CSSStyleDeclaration): string {
  const value = style[property];
  return typeof value === "string" ? value : "";
}

function customStyleValue(style: CSSStyleDeclaration, property: string): string {
  try {
    return style.getPropertyValue(property).trim();
  } catch {
    return "";
  }
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? round(value) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function activeAnimationsOf(element: Element): DebugAnimationSummary[] {
  const candidate = element as Element & {
    getAnimations?: () => readonly Animation[];
  };
  if (typeof candidate.getAnimations !== "function") return [];

  try {
    return Array.from(candidate.getAnimations())
      .slice(0, MAX_ACTIVE_ANIMATIONS)
      .map((animation) => {
        const value = animation as unknown as Record<string, unknown>;
        const constructor = value.constructor as { name?: unknown } | undefined;
        return {
          type: stringValue(value.type) ?? stringValue(constructor?.name),
          playState: stringValue(value.playState),
          currentTime: numberValue(value.currentTime),
          startTime: numberValue(value.startTime),
          playbackRate: numberValue(value.playbackRate),
          transitionProperty: stringValue(value.transitionProperty),
          animationName: stringValue(value.animationName),
        };
      });
  } catch {
    return [];
  }
}

function createIdentity(): (node: Node | null | undefined) => string | null {
  const tokens = new WeakMap<Node, string>();
  let sequence = 0;
  return (node) => {
    if (!node) return null;
    const existing = tokens.get(node);
    if (existing) return existing;
    const token = `n${++sequence}`;
    tokens.set(node, token);
    return token;
  };
}

function blockInfo(protyle: IProtyle | null): Record<string, unknown> | null {
  if (!protyle) return null;
  const block = protyle.block as BlockLike | undefined;
  if (!block) return null;
  return {
    id: block.id ?? null,
    parentID: block.parentID ?? null,
    parent2ID: block.parent2ID ?? null,
    rootID: block.rootID ?? null,
    mode: block.mode ?? null,
    showAll: block.showAll ?? null,
    scroll: block.scroll ?? null,
  };
}

function wsDataShape(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return {
      kind: "array",
      length: value.length,
      itemKeys: value.slice(0, 5).map((item) => (
        item && typeof item === "object" ? Object.keys(item).slice(0, 24) : typeof item
      )),
    };
  }
  if (!value || typeof value !== "object") return { kind: typeof value };
  const record = value as Record<string, unknown>;
  const shape: Record<string, unknown> = {
    kind: "object",
    keys: Object.keys(record).slice(0, 40),
  };
  if (Array.isArray(record.transactions)) {
    shape.transactionCount = record.transactions.length;
    shape.transactionKeys = record.transactions
      .slice(0, 5)
      .map((item) => item && typeof item === "object"
        ? Object.keys(item).slice(0, 24)
        : typeof item);
  }
  return shape;
}

function serializeWsData(data: { cmd?: unknown; code?: unknown; sid?: unknown; callback?: unknown; msg?: unknown; data?: unknown }): Record<string, unknown> {
  return {
    cmd: data.cmd ?? null,
    code: data.code ?? null,
    sid: data.sid ?? null,
    callback: data.callback ?? null,
    message: typeof data.msg === "string" ? truncate(data.msg, 300) : "",
    data: wsDataShape(data.data),
  };
}

export function createDebugSerializer(options: DebugSerializeOptions = {}): DebugSerializer {
  let includeText = options.includeText === true;
  const maxTextLength = options.maxTextLength ?? MAX_TEXT_LENGTH;
  let nodeToken = createIdentity();
  const countNode = () => options.onNodeSerialized?.();
  const countStyle = () => options.onComputedStyleRead?.();

  function computedStyleOf(element: Element | null): DebugComputedStyle | null {
    if (!element || typeof globalThis.getComputedStyle !== "function") return null;
    try {
      countStyle();
      const style = globalThis.getComputedStyle(element);
      return {
        display: styleValue(style, "display"),
        position: styleValue(style, "position"),
        opacity: styleValue(style, "opacity"),
        visibility: styleValue(style, "visibility"),
        color: styleValue(style, "color"),
        backgroundColor: styleValue(style, "backgroundColor"),
        fill: styleValue(style, "fill"),
        stroke: styleValue(style, "stroke"),
        transform: styleValue(style, "transform"),
        filter: styleValue(style, "filter"),
        mixBlendMode: styleValue(style, "mixBlendMode"),
        willChange: styleValue(style, "willChange"),
        transition: styleValue(style, "transition"),
        transitionProperty: styleValue(style, "transitionProperty"),
        transitionDuration: styleValue(style, "transitionDuration"),
        transitionTimingFunction: styleValue(style, "transitionTimingFunction"),
        zIndex: styleValue(style, "zIndex"),
        contain: styleValue(style, "contain"),
        isolation: styleValue(style, "isolation"),
        pointerEvents: styleValue(style, "pointerEvents"),
        fontSize: styleValue(style, "fontSize"),
        lineHeight: styleValue(style, "lineHeight"),
        overflow: styleValue(style, "overflow"),
        margin: styleValue(style, "margin"),
        padding: styleValue(style, "padding"),
        rippleOpacity: customStyleValue(style, "--zt-ripple-opacity"),
        rippleTransitionDuration: customStyleValue(style, "--zt-ripple-transition-duration"),
        sentenceDimColor: customStyleValue(style, "--zt-sentence-dim-color"),
      };
    } catch {
      return null;
    }
  }

  function nodeReference(
    value: EventTarget | Node | null | undefined,
    root: Element | null = null,
    textEnabled = includeText,
  ): DebugNodeReference {
    const node = asNode(value);
    if (!node) return { nodeType: "other", path: "" };
    countNode();
    const element = asElement(node);
    const nodeTokenValue = nodeToken(node) ?? undefined;
    if (!element || nodeTypeOf(node) !== ELEMENT_NODE) {
      const valueText = textOf(node);
      const result: DebugNodeReference = {
        nodeType: isTextNode(node) ? "text" : "other",
        nodeToken: nodeTokenValue,
        isConnected: connectedOf(node),
        path: nodePath(node, root),
        textLength: valueText.length,
      };
      const redacted = redactText(valueText, textEnabled, maxTextLength);
      if (redacted?.text !== undefined) result.text = redacted.text;
      return result;
    }

    const direct = directText(element);
    const result: DebugNodeReference = {
      nodeType: "element",
      nodeToken: nodeTokenValue,
      isConnected: connectedOf(node),
      path: nodePath(element, root),
      tag: element.tagName.toLowerCase(),
      attrs: collectAttributes(element),
      directTextLength: direct.length,
      subtreeTextLength: subtreeTextLength(element),
      textLength: subtreeTextLength(element),
      childElementCount: element.children.length,
    };
    const id = element.getAttribute("id");
    const classes = classesOf(element);
    const dataNodeId = element.getAttribute("data-node-id");
    const dataType = element.getAttribute("data-type");
    if (id) result.id = truncate(id, 120);
    if (classes.length > 0) result.classes = classes;
    if (dataNodeId) result.nodeId = truncate(dataNodeId, 120);
    if (dataType) result.dataType = truncate(dataType, 120);
    if (textEnabled) {
      const directValue = redactText(direct, true, maxTextLength);
      if (directValue?.text !== undefined) result.directText = directValue.text;
    }
    return result;
  }

  function blockDescription(
    element: Element,
    root: Element | null,
    fullText = false,
  ): DebugBlockDescription | null {
    const id = element.getAttribute("data-node-id");
    if (!id) return null;
    const value: DebugBlockDescription = {
      id,
      dataType: element.getAttribute("data-type"),
      nodeToken: nodeToken(element) ?? "",
      isConnected: connectedOf(element),
      path: nodePath(element, root),
      attrs: collectAttributes(element),
      classes: classesOf(element),
      childElementCount: element.children.length,
      textLength: subtreeTextLength(element),
      rect: rectOf(element),
      computed: computedStyleOf(element),
    };
    countNode();
    if (fullText && includeText) value.text = truncate(element.textContent ?? "", maxTextLength);
    return value;
  }

  function blockChain(element: Element | null, root: Element | null): DebugBlockDescription[] {
    const result: DebugBlockDescription[] = [];
    let current = typeof element?.closest === "function"
      ? element.closest("[data-node-id]") as Element | null
      : null;
    let count = 0;
    while (current && count < MAX_BLOCK_CHAIN) {
      const description = blockDescription(current, root);
      if (description) result.push(description);
      if (current === root) break;
      current = current.parentElement?.closest("[data-node-id]") as Element | null;
      count += 1;
    }
    return result;
  }

  function describeElement(
    value: EventTarget | Node | null | undefined,
    root: Element | null,
    fullText = false,
  ): DebugElementDescription | null {
    const element = asElement(value);
    if (!element) return null;
    const reference = nodeReference(element, root, includeText);
    return {
      ...reference,
      nodeType: "element",
      nodeToken: nodeToken(element) ?? "",
      isConnected: connectedOf(element),
      rect: rectOf(element),
      scroll: scrollMetricsOf(element),
      computed: computedStyleOf(element),
      blockChain: blockChain(element, root),
      ...(fullText && includeText
        ? { text: truncate(element.textContent ?? "", maxTextLength) }
        : {}),
    };
  }

  function selectionSnapshot(root: Element | null): Record<string, unknown> | null {
    if (typeof window === "undefined" || typeof window.getSelection !== "function") return null;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    const inRoot = !!root && (
      (!!anchor && root.contains(anchor))
      || (!!focus && root.contains(focus))
    );
    let rangeRects: DebugRect[] = [];
    try {
      const range = selection.getRangeAt(0);
      rangeRects = Array.from(range.getClientRects())
        .slice(0, MAX_RANGE_RECTS)
        .map((rect) => ({
          x: round(rect.x),
          y: round(rect.y),
          width: round(rect.width),
          height: round(rect.height),
          top: round(rect.top),
          right: round(rect.right),
          bottom: round(rect.bottom),
          left: round(rect.left),
        }));
    } catch {
      rangeRects = [];
    }
    const result: Record<string, unknown> = {
      inRoot,
      isCollapsed: selection.isCollapsed,
      anchor: nodeReference(anchor, root, includeText),
      focus: nodeReference(focus, root, includeText),
      anchorPath: nodePath(anchor, root),
      focusPath: nodePath(focus, root),
      anchorToken: nodeToken(anchor),
      focusToken: nodeToken(focus),
      anchorConnected: anchor ? connectedOf(anchor) : null,
      focusConnected: focus ? connectedOf(focus) : null,
      anchorOffset: selection.anchorOffset,
      focusOffset: selection.focusOffset,
      selectedTextLength: selection.toString().length,
      rangeRects,
    };
    if (includeText) {
      const text = redactText(selection.toString(), true, maxTextLength);
      if (text?.text !== undefined) result.selectedText = text.text;
    }
    return result;
  }

  function scrollStateFor(
    value: Element | null,
    root: Element | null,
  ): DebugScrollState | null {
    const candidates: Element[] = [];
    const seen = new Set<Element>();
    let current = value;
    while (current) {
      if (!seen.has(current)) {
        seen.add(current);
        candidates.push(current);
      }
      current = current.parentElement;
    }
    if (typeof document !== "undefined") {
      for (const candidate of [document.body, document.documentElement]) {
        if (candidate && !seen.has(candidate)) {
          seen.add(candidate);
          candidates.push(candidate);
        }
      }
    }
    for (const candidate of candidates) {
      const metrics = scrollMetricsOf(candidate);
      if (!metrics) continue;
      const hasOverflow = metrics.scrollHeight > metrics.clientHeight
        || metrics.scrollWidth > metrics.clientWidth;
      if (hasOverflow || metrics.scrollTop !== 0 || metrics.scrollLeft !== 0) {
        return { container: nodeReference(candidate, root, false), metrics };
      }
    }
    return null;
  }

  function protyleDescription(
    protyle: IProtyle | null,
    root: HTMLElement | null,
  ): Record<string, unknown> | null {
    if (!protyle && !root) return null;
    return {
      id: protyle?.id ?? null,
      notebookId: protyle?.notebookId ?? null,
      path: protyle?.path ?? null,
      block: blockInfo(protyle),
      root: describeElement(root, root),
      wysiwyg: describeElement(root?.querySelector(".protyle-wysiwyg"), root),
    };
  }

  function serializeDomTree(
    root: HTMLElement,
    maxNodes = MAX_TREE_NODES,
    maxDepth = MAX_TREE_DEPTH,
  ): DebugDomTreeNode {
    let visited = 0;
    const visit = (element: Element, depth: number): DebugDomTreeNode => {
      visited += 1;
      countNode();
      const direct = directText(element);
      const node: DebugDomTreeNode = {
        tag: element.tagName.toLowerCase(),
        nodeToken: nodeToken(element) ?? "",
        isConnected: connectedOf(element),
        path: nodePath(element, root),
        attrs: collectAttributes(element),
        directTextLength: direct.length,
        subtreeTextLength: subtreeTextLength(element),
        childElementCount: element.children.length,
      };
      const id = element.getAttribute("id");
      const classes = classesOf(element);
      const dataNodeId = element.getAttribute("data-node-id");
      const dataType = element.getAttribute("data-type");
      if (id) node.id = truncate(id, 120);
      if (classes.length > 0) node.classes = classes;
      if (dataNodeId) node.nodeId = truncate(dataNodeId, 120);
      if (dataType) node.dataType = truncate(dataType, 120);
      if (includeText) {
        const directValue = redactText(direct, true, maxTextLength);
        if (directValue?.text !== undefined) node.directText = directValue.text;
      }

      const children = Array.from(element.children);
      const directTextNodes = Array.from(element.childNodes ?? [])
        .filter((child) => isTextNode(child))
        .map((child) => nodeReference(child, root, includeText));
      if (directTextNodes.length > 0) node.directTextNodes = directTextNodes;
      if (children.length === 0) return node;
      if (depth >= maxDepth || visited >= maxNodes) {
        node.truncated = true;
        node.omittedChildren = children.length;
        return node;
      }

      const serializedChildren: DebugDomTreeNode[] = [];
      for (const child of children) {
        if (visited >= maxNodes) break;
        serializedChildren.push(visit(child, depth + 1));
      }
      node.children = serializedChildren;
      if (serializedChildren.length < children.length) {
        node.truncated = true;
        node.omittedChildren = children.length - serializedChildren.length;
      }
      return node;
    };
    return visit(root, 0);
  }

  function textNodesUnder(node: Node): Node[] {
    const result: Node[] = [];
    const visit = (current: Node): void => {
      if (result.length >= MAX_MUTATION_TEXT_NODES) return;
      if (isTextNode(current)) {
        result.push(current);
        return;
      }
      for (const child of Array.from(current.childNodes ?? [])) visit(child);
    };
    visit(node);
    return result;
  }

  function mutationRecordSummary(record: MutationRecord, root: Element): DebugMutationRecord {
    const addedNodes = Array.from(record.addedNodes ?? []).slice(0, 12);
    const removedNodes = Array.from(record.removedNodes ?? []).slice(0, 12);
    const result: DebugMutationRecord = {
      type: record.type,
      target: nodeReference(record.target, root, false),
      attributeName: record.attributeName,
      oldValue: record.oldValue ? truncate(record.oldValue, MAX_ATTR_LENGTH) : null,
      addedNodes: addedNodes.map((node) => nodeReference(node, root, includeText)),
      removedNodes: removedNodes.map((node) => nodeReference(node, root, includeText)),
      addedTextNodes: addedNodes.flatMap(textNodesUnder)
        .slice(0, MAX_MUTATION_TEXT_NODES)
        .map((node) => nodeReference(node, root, true)),
      removedTextNodes: removedNodes.flatMap(textNodesUnder)
        .slice(0, MAX_MUTATION_TEXT_NODES)
        .map((node) => nodeReference(node, root, true)),
    };
    if (record.type === "characterData" || isTextNode(record.target)) {
      result.targetText = truncate(textOf(record.target), maxTextLength);
    }
    return result;
  }

  function structuralEditSnapshot(
    snapshot: structuralEdit.StructuralEditSnapshot,
    root: Element | null = null,
  ): DebugStructuralEditState {
    const editor = snapshot.editor;
    return {
      generation: snapshot.generation,
      phase: snapshot.phase,
      kind: snapshot.kind,
      editorPath: editor ? nodePath(editor, root) || null : null,
      editorToken: editor ? nodeToken(editor) : null,
      editorConnected: editor ? connectedOf(editor) : null,
      transactionStartedAt: snapshot.transactionStartedAt,
      lastActivityAt: snapshot.lastActivityAt,
      activityVersion: snapshot.activityVersion,
      quietFrames: snapshot.quietFrames,
      settleFrames: snapshot.settleFrames,
    };
  }

  function eventTargetPath(event: Event): string[] {
    if (typeof event.composedPath !== "function") return [];
    return event.composedPath()
      .slice(0, MAX_COMPOSED_PATH)
      .map((value) => nodePath(value as EventTarget | Node | null))
      .filter(Boolean);
  }

  function eventTargetPayload(event: Event, root: Element | null): Record<string, unknown> {
    return {
      target: describeElement(event.target, root),
      targetPath: nodePath(event.target, root),
      composedPath: eventTargetPath(event),
      defaultPrevented: event.defaultPrevented,
      cancelBubble: event.cancelBubble,
      eventPhase: event.eventPhase,
      timeStamp: Number.isFinite(event.timeStamp) ? round(event.timeStamp) : null,
    };
  }

  function watchSamples(
    watches: readonly DebugWatch[],
    root: Element | null,
    reason: string,
  ): DebugWatchSample[] {
    if (!root) return [];
    const result: DebugWatchSample[] = [];
    for (const watch of watches) {
      let matches: Element[] = [];
      try {
        matches = Array.from(root.querySelectorAll(watch.selector)).slice(0, 12);
        if (typeof root.matches === "function" && root.matches(watch.selector)) {
          matches = [root, ...matches].slice(0, 12);
        }
      } catch {
        matches = [];
      }
      for (const element of matches) {
        const parent = element.parentElement
          ? nodeReference(element.parentElement, root, false)
          : null;
        const ancestors: DebugNodeReference[] = [];
        let ancestor = element.parentElement;
        while (ancestor && ancestors.length < MAX_WATCH_ANCESTORS) {
          ancestors.push(nodeReference(ancestor, root, false));
          ancestor = ancestor.parentElement;
        }
        result.push({
          id: watch.id,
          label: watch.label,
          selector: watch.selector,
          reason,
          nodeToken: nodeToken(element) ?? "",
          isConnected: connectedOf(element),
          path: nodePath(element, root),
          nodeId: element.getAttribute("data-node-id"),
          classes: classesOf(element),
          parent,
          ancestors,
          rect: rectOf(element),
          computed: computedStyleOf(element),
          activeAnimations: activeAnimationsOf(element),
        });
      }
    }
    return result;
  }

  return {
    get includeText() {
      return includeText;
    },
    setIncludeText(nextIncludeText) {
      includeText = nextIncludeText;
    },
    resetNodeIdentity() {
      nodeToken = createIdentity();
    },
    nodeTokenFor: (value) => nodeToken(asNode(value)),
    nodeReference,
    describeElement,
    selectionSnapshot,
    scrollStateFor,
    protyleDescription,
    serializeDomTree,
    mutationRecordSummary,
    structuralEditSnapshot,
    eventTargetPayload,
    watchSamples,
  };
}

/** Compatibility helper for focused structural diagnostics tests. */
export function serializeStructuralEditSnapshot(
  snapshot: structuralEdit.StructuralEditSnapshot,
  root: Element | null = null,
): DebugStructuralEditState {
  return createDebugSerializer({ includeText: false }).structuralEditSnapshot(snapshot, root);
}

export function summarizeWsData(data: {
  cmd?: unknown;
  code?: unknown;
  sid?: unknown;
  callback?: unknown;
  msg?: unknown;
  data?: unknown;
}): Record<string, unknown> {
  return serializeWsData(data);
}
