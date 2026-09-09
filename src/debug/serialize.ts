import type { EditorFrame } from "../types";
import type {
  DebugRecord,
  DebugValue,
} from "./types";

export const DEBUG_LIMITS = {
  maxTextLength: 2000,
  maxAttributeLength: 300,
  maxPathDepth: 24,
  maxTreeNodes: 1200,
  maxTreeDepth: 12,
  maxMutationRecords: 80,
  maxWatchMatches: 12,
  maxWatches: 8,
  maxComposedPath: 12,
} as const;

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

export interface DebugSerializeStats {
  onNodeSerialized?: () => void;
  onComputedStyleRead?: () => void;
}

export interface DebugWatchDefinition {
  id: string;
  selector: string;
  label: string;
}

export interface DebugSerializer {
  readonly includeText: boolean;
  setIncludeText(includeText: boolean): void;
  resetNodeIdentity(): void;
  eventPayload(event: Event, root: Element | null): DebugRecord;
  framePayload(frame: EditorFrame | null, root: Element | null): DebugRecord;
  mutationPayload(records: readonly MutationRecord[], root: Element | null): DebugRecord;
  snapshot(
    frame: EditorFrame | null,
    reason: string,
    profile: string,
    watches: readonly DebugWatchDefinition[],
  ): DebugRecord;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

function asNode(value: EventTarget | Node | null | undefined): Node | null {
  if (!value || typeof value !== "object" || !("nodeType" in value)) return null;
  return value as Node;
}

function asElement(value: EventTarget | Node | null | undefined): Element | null {
  const node = asNode(value);
  if (!node) return null;
  if (node.nodeType === ELEMENT_NODE) return node as Element;
  return (node as Node & { parentElement?: Element | null }).parentElement ?? null;
}

function nodeText(node: Node | null): string {
  if (!node) return "";
  const value = node as Node & { data?: string; nodeValue?: string | null };
  return value.nodeValue ?? value.data ?? node.textContent ?? "";
}

function safeConnected(node: Node): boolean {
  return typeof node.isConnected === "boolean" ? node.isConnected : true;
}

function safeContains(root: Element | null, node: Node | null): boolean {
  if (!root || !node || typeof root.contains !== "function") return false;
  try { return root.contains(node); } catch { return false; }
}

function safeData(value: unknown, depth = 0, seen = new WeakSet<object>()): DebugValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return typeof value === "string" ? truncate(value, DEBUG_LIMITS.maxTextLength) : value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth >= 6) return "[depth-limit]";
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (Array.isArray(value)) {
      const result = value.slice(0, 64).map(item => safeData(item, depth + 1, seen));
      seen.delete(value);
      return result;
    }
    const result: Record<string, DebugValue> = {};
    for (const [key, item] of Object.entries(value).slice(0, 64)) {
      result[truncate(key, 120)] = safeData(item, depth + 1, seen);
    }
    seen.delete(value);
    return result;
  }
  return String(value);
}

export function safeRecord(payload: Record<string, unknown> | undefined): DebugRecord {
  return (safeData(payload ?? {}) as Record<string, DebugValue>);
}

export function summarizeKeyboardKey(key: string, includeText = false): string {
  if (includeText) return truncate(key, 80);
  if (key === " ") return "Space";
  return key.length === 1 ? "<printable>" : truncate(key, 80);
}

function rectOf(element: Element | null): DebugValue {
  if (!element || typeof element.getBoundingClientRect !== "function") return null;
  try {
    const rect = element.getBoundingClientRect();
    return {
      x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height),
      top: round(rect.top), right: round(rect.right), bottom: round(rect.bottom), left: round(rect.left),
    };
  } catch { return null; }
}

function scrollOf(element: Element | null): DebugValue {
  if (!element) return null;
  try {
    const value = element as Element & {
      scrollTop?: number; scrollLeft?: number; scrollHeight?: number; scrollWidth?: number;
      clientHeight?: number; clientWidth?: number;
    };
    return {
      scrollTop: round(value.scrollTop ?? 0), scrollLeft: round(value.scrollLeft ?? 0),
      scrollHeight: round(value.scrollHeight ?? 0), scrollWidth: round(value.scrollWidth ?? 0),
      clientHeight: round(value.clientHeight ?? 0), clientWidth: round(value.clientWidth ?? 0),
    };
  } catch { return null; }
}

function attrsOf(element: Element): Record<string, DebugValue> {
  const result: Record<string, DebugValue> = {};
  for (const attribute of Array.from(element.attributes ?? [])) {
    const name = attribute.name.toLowerCase();
    const usefulData = name.startsWith("data-") && !/(content|text|html|markdown|value)/i.test(name);
    if (name === "id" || name === "class" || name === "style" || name === "contenteditable"
      || name.startsWith("aria-") || usefulData) {
      result[name] = truncate(attribute.value, DEBUG_LIMITS.maxAttributeLength);
    }
  }
  return result;
}

function classesOf(element: Element): string[] {
  return Array.from(element.classList ?? []).slice(0, 32);
}

function directText(element: Element): string {
  let result = "";
  for (const child of Array.from(element.childNodes ?? [])) {
    if (child.nodeType === TEXT_NODE) result += nodeText(child);
  }
  return result;
}

function tokenOf(element: Element): string {
  const tag = element.tagName?.toLowerCase() ?? "element";
  const nodeId = element.getAttribute?.("data-node-id");
  if (nodeId) return `${tag}[data-node-id="${truncate(nodeId, 80)}"]`;
  const dataType = element.getAttribute?.("data-type");
  if (dataType) return `${tag}[data-type="${truncate(dataType, 80)}"]`;
  return `${tag}${classesOf(element).slice(0, 3).map(name => `.${name}`).join("")}`;
}

function createNodeIdentity() {
  const tokens = new WeakMap<object, string>();
  let serial = 0;
  return (value: Node | null): string | null => {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return null;
    const object = value as unknown as object;
    const existing = tokens.get(object);
    if (existing) return existing;
    const token = `n${++serial}`;
    tokens.set(object, token);
    return token;
  };
}

export function createDebugSerializer(
  initialIncludeText = true,
  stats: DebugSerializeStats = {},
): DebugSerializer {
  let includeText = initialIncludeText;
  let nodeToken = createNodeIdentity();

  function pathOf(value: EventTarget | Node | null | undefined, root: Element | null): string {
    let element = asElement(value);
    const parts: string[] = [];
    let depth = 0;
    while (element && depth < DEBUG_LIMITS.maxPathDepth) {
      parts.unshift(tokenOf(element));
      if (element === root) break;
      element = element.parentElement;
      depth++;
    }
    return parts.join(" > ");
  }

  function computedOf(element: Element | null): DebugValue {
    if (!element || typeof getComputedStyle !== "function") return null;
    try {
      const style = getComputedStyle(element);
      stats.onComputedStyleRead?.();
      const value = (property: keyof CSSStyleDeclaration): string => {
        const candidate = style[property];
        return typeof candidate === "string" ? candidate : "";
      };
      return {
        display: value("display"), position: value("position"), opacity: value("opacity"),
        visibility: value("visibility"), color: value("color"), backgroundColor: value("backgroundColor"),
        transform: value("transform"), transition: value("transition"), animationName: value("animationName"),
        animationPlayState: value("animationPlayState"), zIndex: value("zIndex"),
        overflow: value("overflow"), lineHeight: value("lineHeight"), fontSize: value("fontSize"),
        pointerEvents: value("pointerEvents"), willChange: value("willChange"),
        rippleOpacity: style.getPropertyValue("--zentype-ripple-opacity").trim(),
        cursorActive: element.classList.contains("zentype-custom-caret-active"),
        rippleClass: element.classList.contains("zentype-ripple-block"),
      };
    } catch { return null; }
  }

  function nodeReference(value: EventTarget | Node | null | undefined, root: Element | null): DebugValue {
    const node = asNode(value);
    if (!node) return { nodeType: "other", path: "" };
    stats.onNodeSerialized?.();
    const element = asElement(node);
    const token = nodeToken(node);
    if (!element || node.nodeType !== ELEMENT_NODE) {
      const text = nodeText(node);
      return {
        nodeType: node.nodeType === TEXT_NODE ? "text" : "other",
        nodeToken: token, isConnected: safeConnected(node), path: pathOf(node, root),
        textLength: text.length, ...(includeText ? { text: truncate(text, DEBUG_LIMITS.maxTextLength) } : {}),
      };
    }
    const text = element.textContent ?? "";
    return {
      nodeType: "element", nodeToken: token, isConnected: safeConnected(node), path: pathOf(element, root),
      tag: element.tagName.toLowerCase(), id: element.getAttribute("id"),
      classes: classesOf(element), attrs: attrsOf(element), nodeId: element.getAttribute("data-node-id"),
      dataType: element.getAttribute("data-type"), directTextLength: directText(element).length,
      textLength: text.length, childElementCount: element.children.length,
      ...(includeText ? { text: truncate(text, DEBUG_LIMITS.maxTextLength) } : {}),
    };
  }

  function domTree(root: HTMLElement): DebugValue {
    let visited = 0;
    const visit = (element: Element, depth: number): DebugValue => {
      visited++;
      stats.onNodeSerialized?.();
      const text = directText(element);
      const children = Array.from(element.children ?? []);
      const node: Record<string, DebugValue> = {
        tag: element.tagName.toLowerCase(), nodeToken: nodeToken(element), isConnected: safeConnected(element),
        path: pathOf(element, root), attrs: attrsOf(element), classes: classesOf(element),
        nodeId: element.getAttribute("data-node-id"), dataType: element.getAttribute("data-type"),
        directTextLength: text.length, subtreeTextLength: (element.textContent ?? "").length,
        childElementCount: children.length,
        ...(includeText ? { directText: truncate(text, DEBUG_LIMITS.maxTextLength) } : {}),
      };
      if (depth >= DEBUG_LIMITS.maxTreeDepth || visited >= DEBUG_LIMITS.maxTreeNodes) {
        node.truncated = true;
        node.omittedChildren = children.length;
        return node;
      }
      const serialized: DebugValue[] = [];
      for (const child of children) {
        if (visited >= DEBUG_LIMITS.maxTreeNodes) break;
        serialized.push(visit(child, depth + 1));
      }
      if (serialized.length) node.children = serialized;
      if (serialized.length < children.length) {
        node.truncated = true;
        node.omittedChildren = children.length - serialized.length;
      }
      return node;
    };
    return visit(root, 0);
  }

  function selectionPayload(root: Element | null): DebugValue {
    if (typeof window === "undefined" || typeof window.getSelection !== "function") return null;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    let rects: DebugValue[] = [];
    try {
      rects = Array.from(selection.getRangeAt(0).getClientRects()).slice(0, 8).map(rect => ({
        x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height),
        top: round(rect.top), right: round(rect.right), bottom: round(rect.bottom), left: round(rect.left),
      }));
    } catch { rects = []; }
    return {
      isCollapsed: selection.isCollapsed,
      inRoot: safeContains(root, anchor) || safeContains(root, focus),
      anchor: nodeReference(anchor, root), focus: nodeReference(focus, root),
      anchorPath: pathOf(anchor, root), focusPath: pathOf(focus, root),
      anchorOffset: selection.anchorOffset, focusOffset: selection.focusOffset,
      selectedTextLength: selection.toString().length, ...(includeText ? { selectedText: truncate(selection.toString(), DEBUG_LIMITS.maxTextLength) } : {}),
      rangeRects: rects,
    };
  }

  function eventPayload(event: Event, root: Element | null): DebugRecord {
    const keyboard = event as KeyboardEvent;
    const input = event as InputEvent;
    const pointer = event as PointerEvent;
    const payload: DebugRecord = {
      type: event.type, timeStamp: Number.isFinite(event.timeStamp) ? round(event.timeStamp) : null,
      defaultPrevented: event.defaultPrevented, cancelBubble: event.cancelBubble,
      target: nodeReference(event.target, root), targetPath: pathOf(event.target, root),
      composedPath: typeof event.composedPath === "function"
        ? event.composedPath().slice(0, DEBUG_LIMITS.maxComposedPath).map(value => pathOf(value as EventTarget, root))
        : [],
      selection: selectionPayload(root),
    };
    if (typeof keyboard.key === "string") payload.key = summarizeKeyboardKey(keyboard.key, includeText);
    if (typeof keyboard.code === "string") payload.code = keyboard.code;
    if (typeof keyboard.repeat === "boolean") payload.repeat = keyboard.repeat;
    if (typeof keyboard.isComposing === "boolean") payload.isComposing = keyboard.isComposing;
    if (typeof keyboard.shiftKey === "boolean") {
      payload.shiftKey = keyboard.shiftKey; payload.ctrlKey = keyboard.ctrlKey;
      payload.altKey = keyboard.altKey; payload.metaKey = keyboard.metaKey;
    }
    if (typeof input.inputType === "string") payload.inputType = input.inputType;
    if (input.data !== undefined) payload.dataLength = input.data?.length ?? 0;
    if (includeText && input.data) payload.data = truncate(input.data, DEBUG_LIMITS.maxTextLength);
    if (typeof pointer.buttons === "number") payload.buttons = pointer.buttons;
    if (typeof pointer.clientX === "number") { payload.clientX = round(pointer.clientX); payload.clientY = round(pointer.clientY); }
    const related = (event as FocusEvent).relatedTarget;
    if (related) payload.relatedTarget = nodeReference(related, root);
    return payload;
  }

  function framePayload(frame: EditorFrame | null, root: Element | null): DebugRecord {
    if (!frame) return { present: false, selection: "missing" };
    return {
      present: true, selection: frame.selection, caret: frame.caret ? { ...frame.caret } : null,
      caretless: frame.caretless === true, reducedMotion: frame.reducedMotion,
      editor: nodeReference(frame.editor, root), editable: nodeReference(frame.editable, root),
      block: nodeReference(frame.block, root), scroll: nodeReference(frame.scroll, root),
      scrollTop: round(frame.scrollTop), scrollLeft: round(frame.scrollLeft), maxScroll: round(frame.maxScroll),
      origin: { x: round(frame.origin.x), y: round(frame.origin.y) }, viewport: { ...frame.viewport },
      scrollViewport: { ...frame.scrollViewport }, zIndex: frame.zIndex,
      nestedScroll: frame.nestedScroll.map(item => ({
        element: nodeReference(item.element, root), left: round(item.left), top: round(item.top),
      })),
    };
  }

  function mutationPayload(records: readonly MutationRecord[], root: Element | null): DebugRecord {
    const selected = records.slice(0, DEBUG_LIMITS.maxMutationRecords).map(record => ({
      type: record.type, target: nodeReference(record.target, root), attributeName: record.attributeName,
      oldValue: record.oldValue ? truncate(record.oldValue, DEBUG_LIMITS.maxAttributeLength) : null,
      addedNodes: Array.from(record.addedNodes ?? []).slice(0, 16).map(node => nodeReference(node, root)),
      removedNodes: Array.from(record.removedNodes ?? []).slice(0, 16).map(node => nodeReference(node, root)),
    }));
    return { count: records.length, truncated: records.length > selected.length, records: selected };
  }

  function watchPayload(
    watches: readonly DebugWatchDefinition[],
    root: Element | null,
    reason: string,
  ): DebugValue {
    if (!root) return [];
    const samples: DebugValue[] = [];
    for (const watch of watches.slice(0, DEBUG_LIMITS.maxWatches)) {
      let matches: Element[] = [];
      try {
        matches = Array.from(root.querySelectorAll(watch.selector)).slice(0, DEBUG_LIMITS.maxWatchMatches);
        if (root.matches?.(watch.selector)) matches = [root, ...matches].slice(0, DEBUG_LIMITS.maxWatchMatches);
      } catch { matches = []; }
      for (const element of matches) {
        samples.push({
          id: watch.id, label: watch.label, selector: watch.selector, reason,
          nodeToken: nodeToken(element), path: pathOf(element, root), isConnected: safeConnected(element),
          nodeId: element.getAttribute("data-node-id"), classes: classesOf(element), rect: rectOf(element),
          computed: computedOf(element), parent: nodeReference(element.parentElement, root),
        });
      }
    }
    return samples;
  }

  return {
    get includeText() { return includeText; },
    setIncludeText(next) { includeText = next; },
    resetNodeIdentity() { nodeToken = createNodeIdentity(); },
    eventPayload,
    framePayload,
    mutationPayload,
    snapshot(frame, reason, profile, watches) {
      const root = asElement(frame?.root) ?? asElement(frame?.editor);
      const editor = asElement(frame?.editor) as HTMLElement | null;
      return {
        capture: { reason, profile, includeText },
        activeElement: nodeReference(typeof document === "undefined" ? null : document.activeElement, root),
        selection: selectionPayload(root),
        frame: framePayload(frame, root),
        root: nodeReference(root, root),
        editor: editor ? {
          description: nodeReference(editor, root), rect: rectOf(editor), scroll: scrollOf(editor),
          computed: computedOf(editor), tree: domTree(editor),
        } : null,
        watches: watchPayload(watches, root, reason),
      };
    },
  };
}

export function safeMarkValue(value: unknown): DebugValue {
  return safeData(value);
}
