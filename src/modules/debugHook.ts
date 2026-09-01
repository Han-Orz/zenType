import { getActiveEditor } from "siyuan";
import type { EventBus, IProtyle, IWebSocketData } from "siyuan";
import * as structuralEdit from "./structuralEdit";
import * as typewriterScroll from "./typewriter/scroll";

const SCHEMA = "zentype-debug/v1" as const;
const GLOBAL_KEY = "__zentypeDebugHook";
const BRIDGE_URL = "http://127.0.0.1:27369";

const MAX_RECENT_EVENTS = 500;
const MAX_TREE_NODES = 1200;
const MAX_TREE_DEPTH = 12;
const MAX_MUTATION_RECORDS = 80;
const MAX_PENDING_BATCH = 24;
const MAX_OBSERVED_ROOTS = 24;
const FLUSH_DELAY_MS = 80;
const SNAPSHOT_DELAY_MS = 120;
const MAX_TEXT_LENGTH = 2000;

const OBSERVED_ATTRIBUTES = [
  "class",
  "style",
  "data-node-id",
  "data-node-index",
  "data-type",
  "data-doc-type",
  "contenteditable",
  "spellcheck",
  "aria-selected",
  "aria-expanded",
] as const;

const DOM_EVENT_NAMES = [
  "beforeinput",
  "input",
  "compositionstart",
  "compositionupdate",
  "compositionend",
  "keydown",
  "keyup",
  "paste",
  "drop",
  "click",
  "pointerdown",
  "focusin",
  "focusout",
  "selectionchange",
] as const;

type TrackedDomEventName = (typeof DOM_EVENT_NAMES)[number];

export interface DebugHookController {
  toggle(): boolean;
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  captureNow(reason?: string, protyle?: IProtyle): void;
  toggleIncludeText(): boolean;
  getRecentEvents(): readonly DebugEnvelope[];
  getState(): DebugHookState;
  destroy(): void;
}

export interface DebugHookState {
  enabled: boolean;
  includeText: boolean;
  sessionId: string;
  recentEventCount: number;
  pendingEventCount: number;
  observedRootCount: number;
  bridgeUrl: string;
}

export interface DebugEnvelope {
  schema: typeof SCHEMA;
  sessionId: string;
  sequence: number;
  timestamp: string;
  kind: "event" | "snapshot" | "status";
  reason?: string;
  payload: Record<string, unknown>;
}

export interface DebugRect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface DebugScrollMetrics {
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
}

export interface DebugStructuralEditState {
  generation: number;
  phase: structuralEdit.StructuralEditPhase;
  kind: structuralEdit.StructuralEditKind | null;
  editorPath: string | null;
  editorConnected: boolean | null;
  transactionStartedAt: number | null;
  lastActivityAt: number | null;
  activityVersion: number;
  quietFrames: number;
  settleFrames: number;
}

export interface DebugScrollState {
  container: DebugNodeReference;
  metrics: DebugScrollMetrics;
}

export interface DebugNodeReference {
  nodeType: "element" | "text" | "other";
  path: string;
  tag?: string;
  id?: string;
  classes?: string[];
  attrs?: Record<string, string>;
  nodeId?: string;
  dataType?: string;
  directTextLength?: number;
  textLength?: number;
  childElementCount?: number;
  text?: string;
  isConnected?: boolean;
}

export interface DebugDomTreeNode {
  tag: string;
  path: string;
  id?: string;
  classes?: string[];
  attrs: Record<string, string>;
  nodeId?: string;
  dataType?: string;
  directTextLength: number;
  childElementCount: number;
  children?: DebugDomTreeNode[];
  truncated?: boolean;
  omittedChildren?: number;
}

export interface DebugComputedStyle {
  display: string;
  position: string;
  opacity: string;
  visibility: string;
  color: string;
  backgroundColor: string;
  fontSize: string;
  lineHeight: string;
  transform: string;
  transition: string;
  filter: string;
  mixBlendMode: string;
  overflow: string;
  zIndex: string;
  margin: string;
  padding: string;
  pointerEvents: string;
  rippleOpacity: string;
  sentenceDimColor: string;
}

export interface DebugElementDescription extends DebugNodeReference {
  nodeType: "element";
  rect: DebugRect | null;
  scroll: DebugScrollMetrics | null;
  computed: DebugComputedStyle | null;
  blockChain: DebugBlockDescription[];
}

export interface DebugBlockDescription {
  id: string;
  dataType: string | null;
  path: string;
  attrs: Record<string, string>;
  classes: string[];
  childElementCount: number;
  textLength: number;
  rect: DebugRect | null;
  computed: DebugComputedStyle | null;
}

export interface DebugSnapshot {
  capture: {
    reason: string;
    includeText: boolean;
  };
  activeEditor: Record<string, unknown> | null;
  targetEditor: Record<string, unknown> | null;
  focus: DebugElementDescription | null;
  selection: Record<string, unknown> | null;
  currentBlock: DebugElementDescription | null;
  scroll: DebugScrollState | null;
  dom: DebugDomTreeNode | null;
  observedRoots: DebugNodeReference[];
}

interface TrackedRoot {
  protyle: IProtyle | null;
  observer: MutationObserver;
}

interface ProtyleLike {
  protyle?: IProtyle;
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

interface DebugGlobalApi {
  capture: (reason?: string) => void;
  clear: () => void;
  destroy: () => void;
  getRecentEvents: () => readonly DebugEnvelope[];
  getState: () => DebugHookState;
  setEnabled: (enabled: boolean) => void;
  setIncludeText: (enabled: boolean) => void;
  toggle: () => boolean;
  toggleIncludeText: () => boolean;
}

function createSessionId(): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `zt-${random}`;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength)}…`;
}

/** Keep text length observable while avoiding accidental document-content capture. */
export function redactText(
  value: string | null | undefined,
  includeText: boolean,
): { length: number; text?: string } | null {
  if (value == null) return null;
  const result: { length: number; text?: string } = { length: value.length };
  if (includeText) result.text = truncate(value, MAX_TEXT_LENGTH);
  return result;
}

/** Printable key values are content, while control keys are useful diagnostics. */
export function summarizeKeyboardKey(key: string): string {
  if (key === " ") return "Space";
  return key.length === 1 ? "<printable>" : key;
}

function asNode(value: EventTarget | Node | null | undefined): Node | null {
  if (!value || typeof value !== "object" || !("nodeType" in value)) return null;
  return value as Node;
}

function asElement(value: EventTarget | Node | null | undefined): Element | null {
  const node = asNode(value);
  if (!node) return null;
  if (node.nodeType === Node.ELEMENT_NODE) return node as Element;
  return node.parentElement;
}

function protyleRoot(protyle: IProtyle | null | undefined): HTMLElement | null {
  const element = protyle?.element as HTMLElement | undefined;
  if (!element || typeof element.closest !== "function") return null;
  return (element.closest(".protyle") as HTMLElement | null) ?? element;
}

function activeProtyle(): IProtyle | null {
  try {
    const editor = getActiveEditor() as unknown as ProtyleLike | null | undefined;
    return editor?.protyle ?? null;
  } catch {
    return null;
  }
}

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

function monotonicNow(): number {
  if (typeof performance === "undefined" || typeof performance.now !== "function") return 0;
  try {
    return round(performance.now());
  } catch {
    return 0;
  }
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
  for (const attribute of Array.from(element.attributes)) {
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
      attrs[name] = truncate(attribute.value, 300);
    }
  }
  return attrs;
}

function classesOf(element: Element): string[] {
  return Array.from(element.classList ?? []).slice(0, 32);
}

function directTextLength(element: Element): number {
  let length = 0;
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) length += child.textContent?.length ?? 0;
  }
  return length;
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
  while (element && count < 24) {
    parts.unshift(elementToken(element));
    if (element === root) break;
    element = element.parentElement;
    count += 1;
  }
  return parts.join(" > ");
}

/** Convert the coordinator's DOM-bearing snapshot into debug-safe JSON data. */
export function serializeStructuralEditSnapshot(
  snapshot: structuralEdit.StructuralEditSnapshot,
  root: Element | null = null,
): DebugStructuralEditState {
  const editor = snapshot.editor;
  return {
    generation: snapshot.generation,
    phase: snapshot.phase,
    kind: snapshot.kind,
    editorPath: editor ? nodePath(editor, root) || null : null,
    editorConnected: editor
      ? typeof editor.isConnected === "boolean" ? editor.isConnected : null
      : null,
    transactionStartedAt: snapshot.transactionStartedAt,
    lastActivityAt: snapshot.lastActivityAt,
    activityVersion: snapshot.activityVersion,
    quietFrames: snapshot.quietFrames,
    settleFrames: snapshot.settleFrames,
  };
}

function computedStyleOf(element: Element | null): DebugComputedStyle | null {
  if (!element || typeof getComputedStyle !== "function") return null;
  try {
    const style = getComputedStyle(element);
    return {
      display: style.display,
      position: style.position,
      opacity: style.opacity,
      visibility: style.visibility,
      color: style.color,
      backgroundColor: style.backgroundColor,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      transform: style.transform,
      transition: style.transition,
      filter: style.filter,
      mixBlendMode: style.mixBlendMode,
      overflow: style.overflow,
      zIndex: style.zIndex,
      margin: style.margin,
      padding: style.padding,
      pointerEvents: style.pointerEvents,
      rippleOpacity: style.getPropertyValue("--zt-ripple-opacity").trim(),
      sentenceDimColor: style.getPropertyValue("--zt-sentence-dim-color").trim(),
    };
  } catch {
    return null;
  }
}

function nodeReference(
  value: EventTarget | Node | null | undefined,
  root?: Element | null,
  includeText = false,
): DebugNodeReference {
  const node = asNode(value);
  const element = asElement(node);
  if (!node) {
    return { nodeType: "other", path: "" };
  }
  if (!element || node.nodeType !== Node.ELEMENT_NODE) {
    const textValue = node.textContent ?? "";
    const result: DebugNodeReference = {
      nodeType: node.nodeType === Node.TEXT_NODE ? "text" : "other",
      path: nodePath(node, root),
      textLength: textValue.length,
      isConnected: node.isConnected,
    };
    const redacted = redactText(textValue, includeText);
    if (redacted?.text !== undefined) result.text = redacted.text;
    return result;
  }

  const attrs = collectAttributes(element);
  const result: DebugNodeReference = {
    nodeType: "element",
    path: nodePath(element, root),
    tag: element.tagName.toLowerCase(),
    attrs,
    directTextLength: directTextLength(element),
    childElementCount: element.children.length,
    isConnected: element.isConnected,
  };
  const id = element.getAttribute("id");
  const classes = classesOf(element);
  const dataNodeId = element.getAttribute("data-node-id");
  const dataType = element.getAttribute("data-type");
  if (id) result.id = truncate(id, 120);
  if (classes.length > 0) result.classes = classes;
  if (dataNodeId) result.nodeId = truncate(dataNodeId, 120);
  if (dataType) result.dataType = truncate(dataType, 120);
  if (includeText) {
    const redacted = redactText(element.textContent, true);
    if (redacted?.text !== undefined) result.text = redacted.text;
    result.textLength = redacted?.length ?? 0;
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
      return {
        container: nodeReference(candidate, root, false),
        metrics,
      };
    }
  }
  return null;
}

function blockDescription(element: Element, root: Element | null): DebugBlockDescription | null {
  const id = element.getAttribute("data-node-id");
  if (!id) return null;
  return {
    id,
    dataType: element.getAttribute("data-type"),
    path: nodePath(element, root),
    attrs: collectAttributes(element),
    classes: classesOf(element),
    childElementCount: element.children.length,
    textLength: element.textContent?.length ?? 0,
    rect: rectOf(element),
    computed: computedStyleOf(element),
  };
}

function blockChain(element: Element | null, root: Element | null): DebugBlockDescription[] {
  const result: DebugBlockDescription[] = [];
  let current = element?.closest("[data-node-id]") as Element | null;
  let count = 0;
  while (current && count < 16) {
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
  includeText: boolean,
): DebugElementDescription | null {
  const element = asElement(value);
  if (!element) return null;
  const reference = nodeReference(element, root, includeText);
  return {
    ...reference,
    nodeType: "element",
    rect: rectOf(element),
    scroll: scrollMetricsOf(element),
    computed: computedStyleOf(element),
    blockChain: blockChain(element, root),
  };
}

export function serializeDomTree(
  root: HTMLElement,
  maxNodes = MAX_TREE_NODES,
  maxDepth = MAX_TREE_DEPTH,
): DebugDomTreeNode {
  let visited = 0;

  const visit = (element: Element, depth: number): DebugDomTreeNode => {
    visited += 1;
    const attrs = collectAttributes(element);
    const node: DebugDomTreeNode = {
      tag: element.tagName.toLowerCase(),
      path: nodePath(element, root),
      attrs,
      directTextLength: directTextLength(element),
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

    const children = Array.from(element.children);
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

function selectionSnapshot(root: Element | null, includeText: boolean): Record<string, unknown> | null {
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
      .slice(0, 8)
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
    anchorPath: nodePath(anchor, root),
    focusPath: nodePath(focus, root),
    anchorOffset: selection.anchorOffset,
    focusOffset: selection.focusOffset,
    selectedTextLength: selection.toString().length,
    rangeRects,
  };
  if (includeText) {
    const text = redactText(selection.toString(), true);
    if (text?.text !== undefined) result.selectedText = text.text;
  }
  return result;
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

function protyleDescription(
  protyle: IProtyle | null,
  root: HTMLElement | null,
  includeText: boolean,
): Record<string, unknown> | null {
  if (!protyle && !root) return null;
  return {
    id: protyle?.id ?? null,
    notebookId: protyle?.notebookId ?? null,
    path: protyle?.path ?? null,
    block: blockInfo(protyle),
    root: describeElement(root, root, includeText),
    wysiwyg: describeElement(
      root?.querySelector(".protyle-wysiwyg"),
      root,
      includeText,
    ),
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
      .map((item) => item && typeof item === "object" ? Object.keys(item).slice(0, 24) : typeof item);
  }
  return shape;
}

function summarizeWsData(data: IWebSocketData): Record<string, unknown> {
  return {
    cmd: data.cmd,
    code: data.code,
    sid: data.sid,
    callback: data.callback ?? null,
    message: data.msg ? truncate(data.msg, 300) : "",
    data: wsDataShape(data.data),
  };
}

function eventTargetPath(event: Event): string[] {
  if (typeof event.composedPath !== "function") return [];
  return event.composedPath()
    .slice(0, 12)
    .map((value) => nodePath(value as EventTarget | Node | null))
    .filter(Boolean);
}

function eventTargetPayload(
  event: Event,
  root: Element | null,
  includeText: boolean,
): Record<string, unknown> {
  return {
    target: describeElement(event.target, root, includeText),
    targetPath: nodePath(event.target, root),
    composedPath: eventTargetPath(event),
    defaultPrevented: event.defaultPrevented,
    cancelBubble: event.cancelBubble,
    eventPhase: event.eventPhase,
    timeStamp: Number.isFinite(event.timeStamp) ? round(event.timeStamp) : null,
  };
}

function inputEventPayload(event: InputEvent, includeText: boolean): Record<string, unknown> {
  const text = redactText(event.data, includeText);
  return {
    inputType: event.inputType,
    isComposing: event.isComposing,
    dataLength: text?.length ?? 0,
    data: text?.text,
  };
}

function compositionEventPayload(event: CompositionEvent, includeText: boolean): Record<string, unknown> {
  const text = redactText(event.data, includeText);
  return {
    dataLength: text?.length ?? 0,
    data: text?.text,
  };
}

function keyboardEventPayload(event: KeyboardEvent): Record<string, unknown> {
  return {
    key: summarizeKeyboardKey(event.key),
    code: event.code,
    repeat: event.repeat,
    isComposing: event.isComposing,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
  };
}

function dataTransferPayload(event: ClipboardEvent | DragEvent): Record<string, unknown> {
  const dataTransfer = "clipboardData" in event ? event.clipboardData : event.dataTransfer;
  return {
    types: dataTransfer ? Array.from(dataTransfer.types).slice(0, 32) : [],
    fileCount: dataTransfer?.files?.length ?? 0,
    dropEffect: "dropEffect" in (dataTransfer ?? {}) ? dataTransfer?.dropEffect : undefined,
  };
}

function mutationNodeSummary(
  node: Node,
  root: Element,
  includeText: boolean,
): DebugNodeReference {
  return nodeReference(node, root, includeText);
}

function mutationRecordSummary(
  record: MutationRecord,
  root: Element,
  includeText: boolean,
): Record<string, unknown> {
  return {
    type: record.type,
    target: nodeReference(record.target, root, false),
    attributeName: record.attributeName,
    oldValue: record.oldValue ? truncate(record.oldValue, 300) : null,
    addedNodes: Array.from(record.addedNodes)
      .slice(0, 12)
      .map((node) => mutationNodeSummary(node, root, includeText)),
    removedNodes: Array.from(record.removedNodes)
      .slice(0, 12)
      .map((node) => mutationNodeSummary(node, root, includeText)),
  };
}

function safeRootContains(root: Element, value: EventTarget | Node | null | undefined): boolean {
  const node = asNode(value);
  return !!node && (root === node || root.contains(node));
}

export function initDebugHook(eventBus: EventBus): DebugHookController {
  const sessionId = createSessionId();
  const recentEvents: DebugEnvelope[] = [];
  const pendingEvents: DebugEnvelope[] = [];
  const trackedRoots = new Map<HTMLElement, TrackedRoot>();
  const eventBusOffs: Array<() => void> = [];
  const domEventListeners: Array<{ type: TrackedDomEventName; handler: EventListener }> = [];
  let sequence = 0;
  let enabled = true;
  let includeText = false;
  let destroyed = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  let snapshotGeneration = 0;
  let pendingSnapshotReason = "scheduled";
  let pendingSnapshotProtyle: IProtyle | null = null;
  let lastProtyle: IProtyle | null = null;
  let unsubStructuralFinish: (() => void) | null = null;

  const globalObject = globalThis as unknown as Record<string, unknown>;

  function state(): DebugHookState {
    return {
      enabled,
      includeText,
      sessionId,
      recentEventCount: recentEvents.length,
      pendingEventCount: pendingEvents.length,
      observedRootCount: trackedRoots.size,
      bridgeUrl: BRIDGE_URL,
    };
  }

  function flushPending(): void {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingEvents.length === 0) return;
    const batch = pendingEvents.splice(0, pendingEvents.length);
    const fetcher = globalThis.fetch;
    if (typeof fetcher !== "function") return;
    const body = JSON.stringify({ schema: SCHEMA, sessionId, events: batch });
    void fetcher(`${BRIDGE_URL}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }).catch(() => undefined);
  }

  function scheduleFlush(): void {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushPending();
    }, FLUSH_DELAY_MS);
  }

  function publish(
    kind: DebugEnvelope["kind"],
    payload: Record<string, unknown>,
    reason?: string,
  ): DebugEnvelope | null {
    if (destroyed) return null;
    const envelope: DebugEnvelope = {
      schema: SCHEMA,
      sessionId,
      sequence: ++sequence,
      timestamp: new Date().toISOString(),
      kind,
      ...(reason ? { reason } : {}),
      payload: {
        ...payload,
        monotonicMs: monotonicNow(),
      },
    };
    recentEvents.push(envelope);
    if (recentEvents.length > MAX_RECENT_EVENTS) recentEvents.shift();
    pendingEvents.push(envelope);
    if (pendingEvents.length >= MAX_PENDING_BATCH) flushPending();
    else scheduleFlush();
    return envelope;
  }

  function currentRoot(fallback?: Element | null): HTMLElement | null {
    const active = protyleRoot(activeProtyle());
    if (active) return active;
    if (fallback instanceof HTMLElement) return fallback;
    const firstTracked = trackedRoots.keys().next().value as HTMLElement | undefined;
    return firstTracked ?? null;
  }

  function protyleForRoot(root: HTMLElement | null): IProtyle | null {
    return root ? trackedRoots.get(root)?.protyle ?? null : null;
  }

  function pruneRoots(): void {
    for (const [root, tracked] of trackedRoots) {
      if (root.isConnected) continue;
      tracked.observer.disconnect();
      trackedRoots.delete(root);
    }
  }

  function onMutations(root: HTMLElement, records: MutationRecord[]): void {
    if (!enabled || destroyed || records.length === 0) return;
    publish("event", {
      source: "mutation-observer",
      name: "mutation",
      root: nodeReference(root, root, false),
      structuralEdit: serializeStructuralEditSnapshot(
        structuralEdit.getStructuralEditSnapshot(),
        root,
      ),
      typewriterScroll: { active: typewriterScroll.isScrolling() },
      recordCount: records.length,
      records: records
        .slice(0, MAX_MUTATION_RECORDS)
        .map((record) => mutationRecordSummary(record, root, includeText)),
      omittedRecords: Math.max(0, records.length - MAX_MUTATION_RECORDS),
    }, "mutation");
    scheduleSnapshot("after-mutation", protyleForRoot(root));
  }

  function trackRoot(root: HTMLElement, protyle: IProtyle | null): void {
    if (typeof MutationObserver === "undefined") return;
    pruneRoots();
    const existing = trackedRoots.get(root);
    if (existing) {
      if (protyle) existing.protyle = protyle;
      return;
    }
    if (trackedRoots.size >= MAX_OBSERVED_ROOTS) {
      const oldest = trackedRoots.entries().next().value as [HTMLElement, TrackedRoot] | undefined;
      if (oldest) {
        oldest[1].observer.disconnect();
        trackedRoots.delete(oldest[0]);
      }
    }
    const observer = new MutationObserver((records) => onMutations(root, records));
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: [...OBSERVED_ATTRIBUTES],
    });
    trackedRoots.set(root, { protyle, observer });
  }

  function trackProtyle(protyle: IProtyle | null | undefined): HTMLElement | null {
    const root = protyleRoot(protyle);
    if (!root) return null;
    trackRoot(root, protyle ?? null);
    if (protyle) lastProtyle = protyle;
    return root;
  }

  function refreshRoots(): void {
    if (typeof document === "undefined") return;
    for (const root of Array.from(document.querySelectorAll<HTMLElement>(".protyle"))) {
      trackRoot(root, trackedRoots.get(root)?.protyle ?? null);
    }
    const active = activeProtyle();
    if (active) trackProtyle(active);
  }

  function selectionBelongsToTrackedRoot(): boolean {
    if (typeof window === "undefined" || typeof window.getSelection !== "function") return false;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;
    for (const root of trackedRoots.keys()) {
      if (safeRootContains(root, selection.anchorNode) || safeRootContains(root, selection.focusNode)) {
        return true;
      }
    }
    return false;
  }

  function rootForEvent(event: Event): HTMLElement | null {
    const target = asElement(event.target);
    const closest = target?.closest(".protyle") as HTMLElement | null;
    if (closest) {
      trackRoot(closest, trackedRoots.get(closest)?.protyle ?? null);
      return closest;
    }
    return currentRoot();
  }

  function relevantEvent(event: Event): boolean {
    if (event.type === "selectionchange") return selectionBelongsToTrackedRoot();
    const target = asNode(event.target);
    if (!target) return false;
    for (const root of trackedRoots.keys()) {
      if (safeRootContains(root, target)) return true;
    }
    return !!asElement(target)?.closest(".protyle");
  }

  function domEventPayload(event: Event, root: HTMLElement | null): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      source: "dom",
      name: event.type,
      ...eventTargetPayload(event, root, includeText),
      structuralEdit: serializeStructuralEditSnapshot(
        structuralEdit.getStructuralEditSnapshot(),
        root,
      ),
      typewriterScroll: { active: typewriterScroll.isScrolling() },
    };
    if (event.type === "beforeinput" || event.type === "input") {
      Object.assign(payload, inputEventPayload(event as InputEvent, includeText));
    } else if (event.type.startsWith("composition")) {
      Object.assign(payload, compositionEventPayload(event as CompositionEvent, includeText));
    } else if (event.type === "keydown" || event.type === "keyup") {
      Object.assign(payload, keyboardEventPayload(event as KeyboardEvent));
    } else if (event.type === "paste" || event.type === "drop") {
      Object.assign(payload, dataTransferPayload(event as ClipboardEvent | DragEvent));
    } else if (event.type === "click" || event.type === "pointerdown") {
      const mouse = event as MouseEvent;
      Object.assign(payload, {
        button: mouse.button,
        clientX: round(mouse.clientX),
        clientY: round(mouse.clientY),
      });
    } else if (event.type === "focusout") {
      const focusEvent = event as FocusEvent;
      payload.relatedTarget = nodeReference(focusEvent.relatedTarget, root, false);
    }
    if (event.type === "selectionchange") {
      payload.selection = selectionSnapshot(root, includeText);
    }
    return payload;
  }

  function shouldScheduleAfterDomEvent(event: Event): boolean {
    return event.type === "beforeinput"
      || event.type === "input"
      || event.type.startsWith("composition")
      || event.type === "paste"
      || event.type === "drop"
      || event.type === "click"
      || (
        (event.type === "keydown" || event.type === "keyup")
        && ["Enter", "Backspace", "Delete"].includes((event as KeyboardEvent).key)
      );
  }

  function handleDomEvent(event: Event): void {
    if (!enabled || destroyed || !relevantEvent(event)) return;
    const root = rootForEvent(event);
    publish("event", domEventPayload(event, root), event.type);
    if (shouldScheduleAfterDomEvent(event)) {
      scheduleSnapshot(`after-${event.type}`, protyleForRoot(root));
    }
  }

  function createSnapshot(reason: string, requestedProtyle?: IProtyle | null): DebugSnapshot {
    const active = activeProtyle();
    const target = requestedProtyle ?? active ?? lastProtyle;
    const activeRoot = protyleRoot(active);
    const targetRoot = protyleRoot(target) ?? activeRoot;
    if (active) trackProtyle(active);
    if (target) trackProtyle(target);
    const treeRoot = targetRoot?.querySelector(".protyle-wysiwyg") as HTMLElement | null
      ?? targetRoot;
    const selectionRoot = activeRoot ?? targetRoot;
    const selection = selectionSnapshot(selectionRoot, includeText);
    const selectionNode = typeof window !== "undefined" ? window.getSelection()?.anchorNode : null;
    const currentBlockElement = asElement(selectionNode)?.closest("[data-node-id]") ?? null;
    const currentBlock = describeElement(
      currentBlockElement,
      selectionRoot,
      includeText,
    );
    const activeDescription = protyleDescription(active, activeRoot, includeText);
    const targetDescription = target && target !== active
      ? protyleDescription(target, targetRoot, includeText)
      : null;
    return {
      capture: { reason, includeText },
      activeEditor: activeDescription,
      targetEditor: targetDescription,
      focus: typeof document !== "undefined"
        ? describeElement(document.activeElement, selectionRoot, includeText)
        : null,
      selection,
      currentBlock,
      scroll: scrollStateFor(
        asElement(selectionNode) ?? currentBlockElement ?? treeRoot,
        targetRoot,
      ),
      dom: treeRoot ? serializeDomTree(treeRoot) : null,
      observedRoots: Array.from(trackedRoots.keys())
        .map((root) => nodeReference(root, root, false)),
    };
  }

  function onStructuralEditFinish(finish: structuralEdit.StructuralEditFinish): void {
    if (!enabled || destroyed) return;

    const active = activeProtyle();
    const activeRoot = protyleRoot(active);
    const root = activeRoot
      ?? currentRoot()
      ?? (
        typeof finish.editor.closest === "function"
          ? (finish.editor.closest(".protyle") as HTMLElement | null) ?? finish.editor
          : finish.editor
      );
    const selection = selectionSnapshot(root, includeText);
    const selectionNode = typeof window !== "undefined" ? window.getSelection()?.anchorNode : null;
    const currentBlockElement = asElement(selectionNode)?.closest("[data-node-id]") ?? null;

    publish("event", {
      source: "structural-edit",
      name: "structural-edit-finish",
      generation: finish.generation,
      kind: finish.kind,
      stable: finish.stable,
      transactionStartedAt: finish.transactionStartedAt,
      lastActivityAt: finish.lastActivityAt,
      finishedAt: finish.finishedAt,
      quietFrames: finish.quietFrames,
      settleFrames: finish.settleFrames,
      structuralStateAfterFinish: serializeStructuralEditSnapshot(
        structuralEdit.getStructuralEditSnapshot(),
        root,
      ),
      finishEditor: nodeReference(finish.editor, root, false),
      selection,
      currentBlock: describeElement(currentBlockElement, root, includeText),
      activeEditor: protyleDescription(active, activeRoot, includeText),
      scroll: scrollStateFor(
        asElement(selectionNode) ?? currentBlockElement ?? finish.editor,
        root,
      ),
      typewriterScroll: { active: typewriterScroll.isScrolling() },
    }, "structural-edit-finish");
  }

  function captureNow(reason = "manual", protyle?: IProtyle): void {
    if (!enabled || destroyed) return;
    publish("snapshot", { ...createSnapshot(reason, protyle) }, reason);
  }

  function afterPaint(callback: () => void): void {
    if (typeof requestAnimationFrame !== "function") {
      setTimeout(callback, 0);
      return;
    }
    requestAnimationFrame(() => {
      if (destroyed) return;
      requestAnimationFrame(() => {
        if (!destroyed) callback();
      });
    });
  }

  function scheduleSnapshot(reason: string, protyle: IProtyle | null): void {
    if (!enabled || destroyed) return;
    pendingSnapshotReason = reason;
    pendingSnapshotProtyle = protyle ?? pendingSnapshotProtyle;
    const generation = ++snapshotGeneration;
    if (snapshotTimer !== null) clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      afterPaint(() => {
        if (generation !== snapshotGeneration || !enabled || destroyed) return;
        const snapshotProtyle = pendingSnapshotProtyle;
        pendingSnapshotProtyle = null;
        captureNow(pendingSnapshotReason, snapshotProtyle ?? undefined);
      });
    }, SNAPSHOT_DELAY_MS);
  }

  function onLoadedStatic(event: CustomEvent<{ protyle: IProtyle }>): void {
    trackProtyle(event.detail.protyle);
    publish("event", {
      source: "eventbus",
      name: "loaded-protyle-static",
      protyle: protyleDescription(event.detail.protyle, protyleRoot(event.detail.protyle), false),
    }, "loaded-protyle-static");
    scheduleSnapshot("after-loaded-protyle-static", event.detail.protyle);
  }

  function onLoadedDynamic(
    event: CustomEvent<{ protyle: IProtyle; position: "afterend" | "beforebegin" }>,
  ): void {
    trackProtyle(event.detail.protyle);
    publish("event", {
      source: "eventbus",
      name: "loaded-protyle-dynamic",
      position: event.detail.position,
      protyle: protyleDescription(event.detail.protyle, protyleRoot(event.detail.protyle), false),
    }, "loaded-protyle-dynamic");
    scheduleSnapshot("after-loaded-protyle-dynamic", event.detail.protyle);
  }

  function onSwitch(event: CustomEvent<{ protyle: IProtyle }>): void {
    lastProtyle = event.detail.protyle;
    trackProtyle(event.detail.protyle);
    publish("event", {
      source: "eventbus",
      name: "switch-protyle",
      protyle: protyleDescription(event.detail.protyle, protyleRoot(event.detail.protyle), false),
    }, "switch-protyle");
    scheduleSnapshot("after-switch-protyle", event.detail.protyle);
  }

  function onSwitchMode(event: CustomEvent<{ protyle: IProtyle }>): void {
    trackProtyle(event.detail.protyle);
    publish("event", {
      source: "eventbus",
      name: "switch-protyle-mode",
      protyle: protyleDescription(event.detail.protyle, protyleRoot(event.detail.protyle), false),
    }, "switch-protyle-mode");
    scheduleSnapshot("after-switch-protyle-mode", event.detail.protyle);
  }

  function onDestroyProtyle(event: CustomEvent<{ protyle: IProtyle }>): void {
    const root = protyleRoot(event.detail.protyle);
    if (root) {
      const tracked = trackedRoots.get(root);
      tracked?.observer.disconnect();
      trackedRoots.delete(root);
    }
    publish("event", {
      source: "eventbus",
      name: "destroy-protyle",
      protyle: protyleDescription(event.detail.protyle, root, false),
    }, "destroy-protyle");
  }

  function onWsMain(event: CustomEvent<IWebSocketData>): void {
    publish("event", {
      source: "eventbus",
      name: "ws-main",
      websocket: summarizeWsData(event.detail),
    }, "ws-main");
  }

  function onClickEditorContent(
    event: CustomEvent<{ protyle: IProtyle; event: MouseEvent }>,
  ): void {
    trackProtyle(event.detail.protyle);
    publish("event", {
      source: "eventbus",
      name: "click-editorcontent",
      protyle: protyleDescription(event.detail.protyle, protyleRoot(event.detail.protyle), false),
      domEvent: domEventPayload(event.detail.event, protyleRoot(event.detail.protyle)),
    }, "click-editorcontent");
  }

  function onPaste(event: CustomEvent<{
    protyle: IProtyle;
    textHTML: string;
    textPlain: string;
    siyuanHTML: string;
    localFiles: { path: string; size: number }[];
    files: FileList | DataTransferItemList;
  }>): void {
    trackProtyle(event.detail.protyle);
    publish("event", {
      source: "eventbus",
      name: "paste",
      protyle: protyleDescription(event.detail.protyle, protyleRoot(event.detail.protyle), false),
      textHTMLLength: event.detail.textHTML.length,
      textPlainLength: event.detail.textPlain.length,
      siyuanHTMLLength: event.detail.siyuanHTML.length,
      localFileCount: event.detail.localFiles.length,
      fileCount: event.detail.files.length,
    }, "paste");
  }

  function onOpenNonEditableBlock(event: CustomEvent<{
    protyle: IProtyle;
    blockElement: HTMLElement;
    renderElement: HTMLElement;
  }>): void {
    trackProtyle(event.detail.protyle);
    const root = protyleRoot(event.detail.protyle);
    publish("event", {
      source: "eventbus",
      name: "open-noneditableblock",
      protyle: protyleDescription(event.detail.protyle, root, false),
      blockElement: describeElement(event.detail.blockElement, root, includeText),
      renderElement: describeElement(event.detail.renderElement, root, includeText),
    }, "open-noneditableblock");
    scheduleSnapshot("after-open-noneditableblock", event.detail.protyle);
  }

  function attachEventBus(): void {
    eventBus.on("loaded-protyle-static", onLoadedStatic);
    eventBusOffs.push(() => eventBus.off("loaded-protyle-static", onLoadedStatic));
    eventBus.on("loaded-protyle-dynamic", onLoadedDynamic);
    eventBusOffs.push(() => eventBus.off("loaded-protyle-dynamic", onLoadedDynamic));
    eventBus.on("switch-protyle", onSwitch);
    eventBusOffs.push(() => eventBus.off("switch-protyle", onSwitch));
    eventBus.on("switch-protyle-mode", onSwitchMode);
    eventBusOffs.push(() => eventBus.off("switch-protyle-mode", onSwitchMode));
    eventBus.on("destroy-protyle", onDestroyProtyle);
    eventBusOffs.push(() => eventBus.off("destroy-protyle", onDestroyProtyle));
    eventBus.on("ws-main", onWsMain);
    eventBusOffs.push(() => eventBus.off("ws-main", onWsMain));
    eventBus.on("click-editorcontent", onClickEditorContent);
    eventBusOffs.push(() => eventBus.off("click-editorcontent", onClickEditorContent));
    eventBus.on("paste", onPaste);
    eventBusOffs.push(() => eventBus.off("paste", onPaste));
    eventBus.on("open-noneditableblock", onOpenNonEditableBlock);
    eventBusOffs.push(() => eventBus.off("open-noneditableblock", onOpenNonEditableBlock));
  }

  function attachDomEvents(): void {
    if (typeof document === "undefined") return;
    for (const type of DOM_EVENT_NAMES) {
      const handler: EventListener = handleDomEvent;
      document.addEventListener(type, handler, { capture: true, passive: true });
      domEventListeners.push({ type, handler });
    }
  }

  function detach(): void {
    if (typeof document !== "undefined") {
      for (const listener of domEventListeners) {
        document.removeEventListener(listener.type, listener.handler, true);
      }
    }
    domEventListeners.length = 0;
    for (const off of eventBusOffs.splice(0)) {
      try {
        off();
      } catch (error) {
        console.error("[zenType] debug hook eventBus cleanup failed:", error);
      }
    }
    for (const tracked of trackedRoots.values()) tracked.observer.disconnect();
    trackedRoots.clear();
    if (snapshotTimer !== null) {
      clearTimeout(snapshotTimer);
      snapshotTimer = null;
    }
    snapshotGeneration += 1;
    pendingSnapshotProtyle = null;
  }

  function setEnabled(next: boolean): void {
    if (destroyed || enabled === next) return;
    if (!next) {
      enabled = false;
      detach();
      publish("status", { state: "disabled", ...state() }, "disabled");
      flushPending();
      return;
    }
    enabled = true;
    refreshRoots();
    attachDomEvents();
    attachEventBus();
    publish("status", { state: "enabled", ...state() }, "enabled");
    captureNow("enabled");
  }

  const controller: DebugHookController = {
    toggle(): boolean {
      setEnabled(!enabled);
      return enabled;
    },
    setEnabled,
    isEnabled(): boolean {
      return enabled;
    },
    captureNow,
    toggleIncludeText(): boolean {
      includeText = !includeText;
      publish("status", { state: "include-text-changed", ...state() }, "include-text-changed");
      captureNow("include-text-changed");
      return includeText;
    },
    getRecentEvents(): readonly DebugEnvelope[] {
      return recentEvents.slice();
    },
    getState: state,
    destroy(): void {
      if (destroyed) return;
      publish("status", { state: "destroying", ...state() }, "destroying");
      detach();
      unsubStructuralFinish?.();
      unsubStructuralFinish = null;
      destroyed = true;
      flushPending();
      if (globalObject[GLOBAL_KEY] === globalApi) delete globalObject[GLOBAL_KEY];
    },
  };

  const globalApi: DebugGlobalApi = {
    capture: (reason) => controller.captureNow(reason),
    clear: () => {
      recentEvents.length = 0;
      pendingEvents.length = 0;
    },
    destroy: () => controller.destroy(),
    getRecentEvents: () => controller.getRecentEvents(),
    getState: () => controller.getState(),
    setEnabled: (next) => controller.setEnabled(next),
    setIncludeText: (next) => {
      includeText = next;
      publish("status", { state: "include-text-changed", ...state() }, "include-text-changed");
    },
    toggle: () => controller.toggle(),
    toggleIncludeText: () => controller.toggleIncludeText(),
  };

  const previousApi = globalObject[GLOBAL_KEY] as DebugGlobalApi | undefined;
  if (previousApi && typeof previousApi.destroy === "function") previousApi.destroy();
  globalObject[GLOBAL_KEY] = globalApi;

  refreshRoots();
  attachDomEvents();
  attachEventBus();
  unsubStructuralFinish = structuralEdit.subscribeStructuralEditFinish(onStructuralEditFinish);
  publish("status", { state: "started", ...state() }, "started");
  captureNow("hook-start");

  return controller;
}
