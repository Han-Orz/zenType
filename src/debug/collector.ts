import { getActiveEditor } from "siyuan";
import type { EventBus, IProtyle, IWebSocketData } from "siyuan";
import * as cursor from "../modules/cursor";
import * as structuralEdit from "../modules/structuralEdit";
import * as typewriterScroll from "../modules/typewriter/scroll";
import {
  createDebugSerializer,
  redactText,
  summarizeKeyboardKey,
  summarizeWsData,
} from "./serialize";
import type {
  DebugDomTreeNode,
  DebugFrameBurstOptions,
  DebugMarkerForensicOptions,
  DebugMarkerForensicTarget,
  DebugProfile,
  DebugSnapshot,
  DebugStructuralEditState,
  DebugWatch,
  DebugWatchSample,
} from "./types";
import type { DebugSerializer } from "./serialize";
import type { CursorDebugEvent } from "../modules/cursor";
import type { TypewriterScrollDebugEvent } from "../modules/typewriter/scroll";

const MAX_MUTATION_RECORDS = 80;
const DEFAULT_FRAME_BURST_FRAMES = 18;
const MAX_FRAME_BURST_FRAMES = 30;
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

const FORENSIC_DOM_EVENT_NAMES = [
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
  "wheel",
  "focusin",
  "focusout",
  "scroll",
  "selectionchange",
] as const;

const TIMING_DOM_EVENT_NAMES = [
  "keydown",
  "beforeinput",
  "input",
  "compositionstart",
  "compositionend",
  "selectionchange",
  "click",
  "pointerdown",
  "wheel",
  "scroll",
] as const;

type DomEventName = (typeof FORENSIC_DOM_EVENT_NAMES)[number]
  | (typeof TIMING_DOM_EVENT_NAMES)[number];

export interface DebugWatchDefinition {
  selector: string;
  label: string;
}

export interface DebugCollectorOptions {
  eventBus: EventBus;
  profile: DebugProfile;
  getWatches: () => readonly DebugWatch[];
  replaceWatches: (definitions: readonly DebugWatchDefinition[]) => void;
  onEvent: (payload: Record<string, unknown>, reason?: string) => void;
  onMarkerBurstStart: (payload: Record<string, unknown>) => void;
  onMarkerBurstCancelled: (payload: Record<string, unknown>) => void;
  onMutationBatch: (serializedRecordCount: number) => void;
  onWatchSamples: (count: number) => void;
  onNodeSerialized: () => void;
  onComputedStyleRead: () => void;
}

export interface DebugCollector {
  setProfile(profile: DebugProfile): void;
  setFrameBurst(options?: DebugFrameBurstOptions): void;
  setMarkerForensic(options?: DebugMarkerForensicOptions): void;
  resetNodeIdentity(): void;
  attach(): void;
  detach(): void;
  getObservedRootCount(): number;
  getLatestBurstId(): string | null;
  createSnapshot(reason: string): DebugSnapshot;
  captureContext(reason: string): Record<string, unknown>;
}

interface ProtyleLike {
  protyle?: IProtyle;
}

interface BlockLike {
  id?: string;
}

interface FrameBurstRun {
  token: number;
  burstId: string | null;
  triggerIndex: number | null;
  trigger: {
    key: string;
    shiftKey: boolean;
  };
  startedAt: number;
  frameIndex: number;
  frameCount: number;
}

function asNode(value: EventTarget | Node | null | undefined): Node | null {
  if (!value || typeof value !== "object" || !("nodeType" in value)) return null;
  return value as Node;
}

function asElement(value: EventTarget | Node | null | undefined): Element | null {
  const node = asNode(value);
  if (!node) return null;
  if (node.nodeType === 1) return node as Element;
  return (node as Node & { parentElement?: Element | null }).parentElement ?? null;
}

function connectedContains(root: Element | null, value: EventTarget | Node | null | undefined): boolean {
  const node = asNode(value);
  if (!root || !node) return false;
  try {
    return root === node || root.contains(node);
  } catch {
    return false;
  }
}

function rootOfProtyle(protyle: IProtyle | null | undefined): HTMLElement | null {
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

function scrollValue(
  value: EventTarget | null,
  property: "scrollTop" | "scrollLeft",
): number | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as unknown as Record<string, unknown>;
  const number = candidate[property];
  return typeof number === "number" && Number.isFinite(number) ? round(number) : null;
}

function monotonicNow(): number {
  if (typeof performance === "undefined" || typeof performance.now !== "function") return 0;
  try {
    return round(performance.now());
  } catch {
    return 0;
  }
}

function structuralState(): {
  generation: number;
  phase: structuralEdit.StructuralEditPhase;
  kind: structuralEdit.StructuralEditKind | null;
} {
  const snapshot = structuralEdit.getStructuralEditSnapshot();
  return {
    generation: snapshot.generation,
    phase: snapshot.phase,
    kind: snapshot.kind,
  };
}

function blockForSelection(): Element | null {
  if (typeof window === "undefined" || typeof window.getSelection !== "function") return null;
  const selection = window.getSelection();
  const element = asElement(selection?.anchorNode);
  return element?.closest("[data-node-id]") as Element | null;
}

function blockId(element: Element | null): string | null {
  return element?.getAttribute("data-node-id") ?? null;
}

function caretRectSample(): { x: number; y: number; height: number } | null {
  if (typeof window === "undefined" || typeof window.getSelection !== "function") return null;
  try {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (!rect || rect.height === 0) return null;
    return { x: round(rect.x), y: round(rect.y), height: round(rect.height) };
  } catch {
    return null;
  }
}

function timingSelection(serializer: DebugSerializer): Record<string, unknown> {
  if (typeof window === "undefined" || typeof window.getSelection !== "function") {
    return { anchorBlockId: null, focusBlockId: null, collapsed: null, caret: null };
  }
  try {
    const selection = window.getSelection();
    const anchor = asElement(selection?.anchorNode);
    const focus = asElement(selection?.focusNode);
    return {
      anchorBlockId: blockId(anchor?.closest("[data-node-id]") as Element | null),
      focusBlockId: blockId(focus?.closest("[data-node-id]") as Element | null),
      anchorToken: serializer.nodeTokenFor(selection?.anchorNode),
      focusToken: serializer.nodeTokenFor(selection?.focusNode),
      collapsed: selection ? selection.isCollapsed : null,
      caret: caretRectSample(),
    };
  } catch {
    return { anchorBlockId: null, focusBlockId: null, collapsed: null, caret: null };
  }
}

function timingProtyleReference(
  protyle: IProtyle | null,
  root: Element | null,
  serializer: DebugSerializer,
): Record<string, unknown> | null {
  if (!protyle && !root) return null;
  const block = protyle?.block as BlockLike | undefined;
  return {
    id: protyle?.id ?? null,
    path: protyle?.path ?? null,
    blockId: block?.id ?? null,
    root: root
      ? {
        nodeToken: serializer.nodeTokenFor(root),
        isConnected: root.isConnected,
        path: serializer.nodeReference(root, root, false).path || null,
        nodeId: root.getAttribute("data-node-id"),
        dataType: root.getAttribute("data-type"),
      }
      : null,
  };
}

function dataTransferPayload(event: ClipboardEvent | DragEvent): Record<string, unknown> {
  const dataTransfer = "clipboardData" in event ? event.clipboardData : event.dataTransfer;
  return {
    types: dataTransfer ? Array.from(dataTransfer.types).slice(0, 32) : [],
    fileCount: dataTransfer?.files?.length ?? 0,
    dropEffect: dataTransfer?.dropEffect,
  };
}

function controlKey(event: Event): boolean {
  if (event.type !== "keydown") return false;
  const key = (event as KeyboardEvent).key;
  return ["Tab", "Enter", "Backspace", "Delete"].includes(key);
}

function markerTrigger(event: Event): boolean {
  return event.type === "keydown" && (event as KeyboardEvent).key === "Tab";
}

function nodeIdSelector(nodeId: string): string {
  const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(nodeId)
    : nodeId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `[data-node-id="${escaped}"]`;
}

function markerWatchDefinitions(target: DebugMarkerForensicTarget): DebugWatchDefinition[] {
  const suspectSelector = nodeIdSelector(target.suspectNodeId);
  const currentSelector = nodeIdSelector(target.currentNodeId);
  return [
    { selector: suspectSelector, label: "suspect-list-item" },
    { selector: `${suspectSelector} > .protyle-action`, label: "suspect-marker" },
    { selector: `${suspectSelector} > .protyle-action svg`, label: "suspect-marker-svg" },
    { selector: `${suspectSelector} > .protyle-action use`, label: "suspect-marker-use" },
    { selector: currentSelector, label: "current-list-item" },
  ];
}

function frameCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_FRAME_BURST_FRAMES;
  return Math.min(MAX_FRAME_BURST_FRAMES, Math.max(1, Math.floor(value)));
}

export function createDebugCollector(options: DebugCollectorOptions): DebugCollector {
  let profile = options.profile;
  let attached = false;
  let currentProtyle: IProtyle | null = null;
  let currentRoot: HTMLElement | null = null;
  let observedRoot: HTMLElement | null = null;
  let observer: MutationObserver | null = null;
  let serializer = createDebugSerializer({
    includeText: profile === "forensic",
    onNodeSerialized: options.onNodeSerialized,
    onComputedStyleRead: options.onComputedStyleRead,
  });
  const eventBusOffs: Array<() => void> = [];
  const domEventListeners: Array<{ type: DomEventName; handler: EventListener }> = [];
  const lastScrollTopByTarget = new WeakMap<EventTarget, number>();
  let unsubStructuralFinish: (() => void) | null = null;
  let frameBurstEnabled = false;
  let frameBurstFrameCount = DEFAULT_FRAME_BURST_FRAMES;
  let frameBurstToken = 0;
  let frameBurstRequest: number | null = null;
  let frameBurstRun: FrameBurstRun | null = null;
  let markerForensic: DebugMarkerForensicOptions | null = null;
  let markerBurstSequence = 0;
  let latestBurstId: string | null = null;

  function sampleWatches(reason: string, root = currentRoot): ReturnType<DebugSerializer["watchSamples"]> {
    const samples = serializer.watchSamples(options.getWatches(), root, reason);
    if (samples.length > 0) options.onWatchSamples(samples.length);
    return samples;
  }

  function onTypewriterScrollDebug(event: TypewriterScrollDebugEvent): void {
    if (!attached) return;
    const { target, ...details } = event;
    const snapshot = structuralEdit.getStructuralEditSnapshot();
    const container = target
      ? {
        nodeToken: serializer.nodeTokenFor(target),
        tag: target.tagName.toLowerCase(),
        id: target.getAttribute("id"),
        nodeId: target.getAttribute("data-node-id"),
        dataType: target.getAttribute("data-type"),
        classes: Array.from(target.classList).slice(0, 12),
        isConnected: target.isConnected,
      }
      : null;
    const scrolling = typewriterScroll.isScrolling();
    options.onEvent({
      source: "typewriter-scroll",
      ...details,
      ...(container ? {
        scrollContainer: container,
        scrollContainerToken: container.nodeToken,
      } : {
        scrollContainer: null,
        scrollContainerToken: null,
      }),
      structural: {
        generation: snapshot.generation,
        phase: snapshot.phase,
        kind: snapshot.kind,
      },
      typewriterScrollActive: scrolling,
      typewriterScroll: { active: scrolling },
    }, event.name);
  }

  function onCursorDebug(event: CursorDebugEvent): void {
    if (!attached) return;
    const {
      name,
      cursorElement,
      caretElement,
      scrollContainer,
      ...details
    } = event;
    const snapshot = structuralEdit.getStructuralEditSnapshot();
    const scroll = scrollContainer
      ? serializer.scrollStateFor(scrollContainer, currentRoot)
      : null;
    options.onEvent({
      source: "cursor",
      ...details,
      cursor: cursorElement
        ? serializer.describeElement(cursorElement, currentRoot, false)
        : null,
      caret: caretElement
        ? serializer.describeElement(caretElement, currentRoot, false)
        : null,
      scrollContainer: scrollContainer
        ? serializer.nodeReference(scrollContainer, currentRoot, false)
        : null,
      scroll,
      scrollTop: scroll?.metrics.scrollTop ?? null,
      structural: {
        generation: snapshot.generation,
        phase: snapshot.phase,
        kind: snapshot.kind,
      },
      typewriterScrollActive: typewriterScroll.isScrolling(),
      typewriterScroll: { active: typewriterScroll.isScrolling() },
    }, name);
  }

  function currentContext(
    root: HTMLElement | null,
    reason: string,
    includeWatches = false,
  ): Record<string, unknown> {
    const snapshot = structuralEdit.getStructuralEditSnapshot();
    const structural = serializer.structuralEditSnapshot(snapshot, root);
    const block = blockForSelection();
    const selection = profile === "timing"
      ? timingSelection(serializer)
      : serializer.selectionSnapshot(root);
    const currentBlock = profile === "forensic" && block
      ? serializer.describeElement(block, root, true)
      : null;
    const selectionNode = typeof window !== "undefined" ? window.getSelection()?.anchorNode : null;
    const scrollTarget = asElement(selectionNode) ?? block ?? root;
    const scroll = serializer.scrollStateFor(scrollTarget, root);
    const scrolling = typewriterScroll.isScrolling();
    const watches = includeWatches ? sampleWatches(reason, root) : [];
    return {
      structural: {
        generation: snapshot.generation,
        phase: snapshot.phase,
        kind: snapshot.kind,
      },
      structuralEdit: structural,
      selection,
      currentBlock,
      currentBlockId: blockId(block),
      currentBlockToken: block ? serializer.nodeTokenFor(block) : null,
      scroll,
      typewriterScrollActive: scrolling,
      typewriterScroll: { active: scrolling },
      watchSamples: watches,
    };
  }

  function timingEventPayload(event: Event, root: HTMLElement): Record<string, unknown> {
    const snapshot = structuralEdit.getStructuralEditSnapshot();
    const target = asElement(event.target);
    const selection = timingSelection(serializer);
    const block = target?.closest("[data-node-id]") as Element | null;
    const scrolling = typewriterScroll.isScrolling();
    const payload: Record<string, unknown> = {
      source: "dom",
      name: event.type,
      target: serializer.nodeReference(event.target, root, false),
      targetPath: serializer.nodeReference(event.target, root, false).path,
      structural: {
        generation: snapshot.generation,
        phase: snapshot.phase,
        kind: snapshot.kind,
      },
      structuralEdit: serializer.structuralEditSnapshot(snapshot, root),
      selection,
      currentBlockId: blockId(block) ?? (selection.anchorBlockId as string | null),
      currentBlockToken: block ? serializer.nodeTokenFor(block) : null,
      // document-level events (selectionchange) have no element target, so the
      // selection anchor's scroll state is what matters; fall back to the root.
      scroll: serializer.scrollStateFor(target ?? root, root),
      selectionScroll: target ? null : serializer.scrollStateFor(
        asElement((typeof window !== "undefined" ? window.getSelection()?.anchorNode : null) as Node | null)
        ?? root,
        root,
      ),
      typewriterScrollActive: scrolling,
      typewriterScroll: { active: scrolling },
    };
    if (event.type === "beforeinput" || event.type === "input") {
      const input = event as InputEvent;
      const text = redactText(input.data, false);
      payload.inputType = input.inputType ?? "";
      payload.isComposing = input.isComposing ?? false;
      payload.dataLength = text?.length ?? 0;
    } else if (event.type === "keydown") {
      const keyboard = event as KeyboardEvent;
      payload.key = summarizeKeyboardKey(keyboard.key, false);
      payload.code = keyboard.code;
      payload.isComposing = keyboard.isComposing;
      payload.repeat = keyboard.repeat;
    } else if (event.type === "compositionstart" || event.type === "compositionend") {
      payload.isComposing = event.type === "compositionstart";
    } else if (event.type === "click" || event.type === "pointerdown") {
      payload.button = (event as MouseEvent).button;
    }
    if (controlKey(event)) payload.watchSamples = sampleWatches("keydown", root);
    return payload;
  }

  function forensicEventPayload(event: Event, root: HTMLElement): Record<string, unknown> {
    const snapshot = structuralEdit.getStructuralEditSnapshot();
    const payload: Record<string, unknown> = {
      source: "dom",
      name: event.type,
      ...serializer.eventTargetPayload(event, root),
      structural: {
        generation: snapshot.generation,
        phase: snapshot.phase,
        kind: snapshot.kind,
      },
      structuralEdit: serializer.structuralEditSnapshot(snapshot, root),
      ...currentContext(root, event.type),
    };
    if (event.type === "beforeinput" || event.type === "input") {
      const input = event as InputEvent;
      const text = redactText(input.data, true);
      Object.assign(payload, {
        inputType: input.inputType ?? "",
        isComposing: input.isComposing ?? false,
        dataLength: text?.length ?? 0,
        data: text?.text,
      });
    } else if (event.type.startsWith("composition")) {
      const composition = event as CompositionEvent;
      const text = redactText(composition.data, true);
      Object.assign(payload, {
        dataLength: text?.length ?? 0,
        data: text?.text,
      });
    } else if (event.type === "keydown" || event.type === "keyup") {
      const keyboard = event as KeyboardEvent;
      Object.assign(payload, {
        key: summarizeKeyboardKey(keyboard.key, true),
        code: keyboard.code,
        repeat: keyboard.repeat,
        isComposing: keyboard.isComposing,
        ctrlKey: keyboard.ctrlKey,
        altKey: keyboard.altKey,
        shiftKey: keyboard.shiftKey,
        metaKey: keyboard.metaKey,
      });
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
      payload.relatedTarget = serializer.nodeReference(
        (event as FocusEvent).relatedTarget,
        root,
        false,
      );
    }
    if (event.type === "selectionchange") payload.selection = serializer.selectionSnapshot(root);
    if (controlKey(event)) payload.watchSamples = sampleWatches("keydown", root);
    return payload;
  }

  function mutationPayload(root: HTMLElement, records: MutationRecord[]): Record<string, unknown> {
    const snapshot = structuralEdit.getStructuralEditSnapshot();
    const childListCount = records.reduce(
      (count, record) => count + (record.type === "childList" ? 1 : 0),
      0,
    );
    const details = childListCount > 0
      ? structuralEdit.summarizeSemanticMutations(records, snapshot.editor ?? root)
      : {
        classification: "representation" as const,
        addedBlockIds: [],
        removedBlockIds: [],
        parentChanges: [],
      };
    const semanticClassification = childListCount === 0 ? "none" : details.classification;
    const anomaly = semanticClassification === "structural" && snapshot.phase === "idle"
      ? "IDLE_SEMANTIC_MUTATION"
      : null;
    const base: Record<string, unknown> = {
      source: "mutation-observer",
      name: "mutation",
      root: serializer.nodeReference(root, root, false),
      structural: {
        generation: snapshot.generation,
        phase: snapshot.phase,
        kind: snapshot.kind,
      },
      structuralEdit: serializer.structuralEditSnapshot(snapshot, root),
      typewriterScrollActive: typewriterScroll.isScrolling(),
      typewriterScroll: { active: typewriterScroll.isScrolling() },
      recordCount: records.length,
      childListCount,
      structuralGeneration: snapshot.generation,
      structuralPhase: snapshot.phase,
      structuralKind: snapshot.kind,
      semanticClassification,
      addedBlockIds: details.addedBlockIds,
      removedBlockIds: details.removedBlockIds,
      parentChanges: details.parentChanges,
      anomaly,
      anomalies: anomaly ? [anomaly] : [],
      ...currentContext(root, "mutation", true),
    };
    if (profile === "timing") return base;
    const limitedRecords = records.slice(0, MAX_MUTATION_RECORDS);
    options.onMutationBatch(Math.min(records.length, MAX_MUTATION_RECORDS));
    base.records = limitedRecords.map((record) => serializer.mutationRecordSummary(record, root));
    base.omittedRecords = Math.max(0, records.length - MAX_MUTATION_RECORDS);
    return base;
  }

  function onMutations(records: MutationRecord[]): void {
    if (!attached || records.length === 0 || !currentRoot || !observedRoot) return;
    const root = currentRoot;
    if (!root.isConnected || !observedRoot.isConnected) {
      refreshRoot();
      return;
    }
    if (profile === "timing") options.onMutationBatch(0);
    options.onEvent(mutationPayload(root, records), "mutation");
  }

  function disconnectObserver(): void {
    observer?.disconnect();
    observer = null;
    observedRoot = null;
  }

  function cancelFrameBurst(reason = "cancelled", notify = false): void {
    const cancelled = frameBurstRun;
    frameBurstToken += 1;
    if (frameBurstRequest !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(frameBurstRequest);
    }
    frameBurstRequest = null;
    frameBurstRun = null;
    if (notify && cancelled?.burstId) {
      options.onMarkerBurstCancelled({
        source: "debugkit",
        name: "marker-burst-cancelled",
        burstId: cancelled.burstId,
        triggerIndex: cancelled.triggerIndex,
        trigger: cancelled.trigger,
        capturedFrameCount: cancelled.frameIndex,
        requestedFrameCount: cancelled.frameCount,
        reason,
      });
    }
  }

  function scheduleFrameBurstFrame(run: FrameBurstRun): void {
    if (typeof requestAnimationFrame !== "function") {
      frameBurstRun = null;
      return;
    }

    frameBurstRequest = requestAnimationFrame((timestamp) => {
      frameBurstRequest = null;
      if (
        frameBurstRun !== run
        || run.token !== frameBurstToken
        || !attached
        || profile !== "forensic"
        || !frameBurstEnabled
        || !currentRoot
        || !currentRoot.isConnected
        || options.getWatches().length === 0
      ) {
        if (frameBurstRun === run) frameBurstRun = null;
        return;
      }

      const snapshot = structuralEdit.getStructuralEditSnapshot();
      const frameTimestamp = Number.isFinite(timestamp) ? timestamp : monotonicNow();
      options.onEvent({
        source: "debugkit",
        name: "watch-frame",
        ...(run.burstId ? {
          burstId: run.burstId,
          triggerIndex: run.triggerIndex,
        } : {}),
        trigger: run.trigger,
        frameIndex: run.frameIndex,
        elapsedMs: round(Math.max(0, frameTimestamp - run.startedAt)),
        structural: {
          generation: snapshot.generation,
          phase: snapshot.phase,
          kind: snapshot.kind,
        },
        typewriterScrollActive: typewriterScroll.isScrolling(),
        watchSamples: sampleWatches("watch-frame", currentRoot),
      }, "watch-frame");

      run.frameIndex += 1;
      if (run.frameIndex >= run.frameCount) {
        frameBurstRun = null;
        return;
      }
      scheduleFrameBurstFrame(run);
    });
  }

  function startMarkerFrameBurst(event: Event): void {
    if (
      profile !== "forensic"
      || !frameBurstEnabled
      || !markerForensic?.enabled
      || typeof requestAnimationFrame !== "function"
    ) return;

    options.replaceWatches([]);
    cancelFrameBurst("replaced-by-new-tab", true);

    let target: DebugMarkerForensicTarget | null = null;
    try {
      target = markerForensic.resolveTarget(event);
    } catch {
      target = null;
    }
    if (!target) return;

    const burstId = `b${++markerBurstSequence}`;
    latestBurstId = burstId;
    const triggerIndex = markerBurstSequence;
    options.replaceWatches(markerWatchDefinitions(target));
    options.onMarkerBurstStart({
      source: "debugkit",
      name: "marker-burst-start",
      burstId,
      triggerIndex,
      key: (event as KeyboardEvent).key,
      shiftKey: (event as KeyboardEvent).shiftKey,
      currentNodeId: target.currentNodeId,
      suspectNodeId: target.suspectNodeId,
      currentNodeToken: serializer.nodeTokenFor(target.currentElement),
      suspectNodeToken: serializer.nodeTokenFor(target.suspectElement),
    });

    const keyboard = event as KeyboardEvent;
    const run: FrameBurstRun = {
      token: frameBurstToken,
      burstId,
      triggerIndex,
      trigger: {
        key: keyboard.key,
        shiftKey: keyboard.shiftKey,
      },
      startedAt: monotonicNow(),
      frameIndex: 0,
      frameCount: frameBurstFrameCount,
    };
    frameBurstRun = run;
    scheduleFrameBurstFrame(run);
  }

  function startFrameBurst(event: Event): void {
    cancelFrameBurst();
    if (
      profile !== "forensic"
      || !frameBurstEnabled
      || options.getWatches().length === 0
      || typeof requestAnimationFrame !== "function"
    ) return;

    const keyboard = event as KeyboardEvent;
    const run: FrameBurstRun = {
      token: frameBurstToken,
      burstId: null,
      triggerIndex: null,
      trigger: {
        key: keyboard.key,
        shiftKey: keyboard.shiftKey,
      },
      startedAt: monotonicNow(),
      frameIndex: 0,
      frameCount: frameBurstFrameCount,
    };
    frameBurstRun = run;
    scheduleFrameBurstFrame(run);
  }

  function observationTarget(root: HTMLElement | null): HTMLElement | null {
    if (!root) return null;
    return (root.querySelector(".protyle-wysiwyg") as HTMLElement | null) ?? root;
  }

  function attachObserver(): void {
    disconnectObserver();
    if (!currentRoot || typeof MutationObserver === "undefined") return;
    const target = observationTarget(currentRoot);
    if (!target) return;
    observedRoot = target;
    observer = new MutationObserver((records) => onMutations(records));
    observer.observe(target, profile === "timing"
      ? { subtree: true, childList: true }
      : {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeOldValue: true,
        attributeFilter: [...OBSERVED_ATTRIBUTES],
      });
  }

  function refreshRoot(candidate?: IProtyle | null): void {
    if (!attached || typeof document === "undefined") return;
    const active = activeProtyle();
    const desired = candidate ?? active ?? currentProtyle ?? null;
    const fallback = desired ? null : document.querySelector<HTMLElement>(".protyle");
    const nextRoot = rootOfProtyle(desired) ?? fallback;
    if (nextRoot === currentRoot) {
      currentProtyle = desired;
      if (observationTarget(nextRoot) !== observedRoot) attachObserver();
      return;
    }
    currentProtyle = desired;
    currentRoot = nextRoot;
    attachObserver();
  }

  function rootForEvent(event: Event): HTMLElement | null {
    if (!currentRoot) return null;
    if (event.type === "selectionchange") {
      if (typeof window === "undefined" || typeof window.getSelection !== "function") return null;
      const selection = window.getSelection();
      return selection && (
        connectedContains(currentRoot, selection.anchorNode)
        || connectedContains(currentRoot, selection.focusNode)
      ) ? currentRoot : null;
    }
    return connectedContains(currentRoot, event.target) ? currentRoot : null;
  }

  function handleDomEvent(event: Event): void {
    if (!attached) return;
    // Scroll forensics intentionally bypass the protyle-root filter: an
    // external scroll owner may move an ancestor or sibling container, and the
    // per-target delta is what identifies motion that Typewriter did not write.
    if (event.type === "scroll") {
      const target = event.target;
      const root = currentRoot;
      const reference = serializer.nodeReference(target, root, false);
      const scrollTop = scrollValue(target, "scrollTop");
      const previousScrollTop = target === null ? undefined : lastScrollTopByTarget.get(target);
      if (target !== null && scrollTop !== null) {
        lastScrollTopByTarget.set(target, scrollTop);
      }
      const snapshot = structuralEdit.getStructuralEditSnapshot();
      const scrolling = typewriterScroll.isScrolling();
      options.onEvent({
        source: "dom",
        name: "scroll",
        target: reference,
        targetPath: reference.path,
        inRoot: connectedContains(root, target),
        scrollTop,
        scrollLeft: scrollValue(target, "scrollLeft"),
        deltaScrollTop: scrollTop !== null && previousScrollTop !== undefined
          ? round(scrollTop - previousScrollTop)
          : null,
        firstSample: previousScrollTop === undefined,
        caret: caretRectSample(),
        typewriterScrollActive: scrolling,
        typewriterScroll: { active: scrolling },
        structural: {
          generation: snapshot.generation,
          phase: snapshot.phase,
          kind: snapshot.kind,
        },
      }, "scroll");
      return;
    }
    const root = rootForEvent(event);
    if (!root) return;
    if (markerForensic?.enabled && markerTrigger(event)) startMarkerFrameBurst(event);
    const payload = profile === "timing"
      ? timingEventPayload(event, root)
      : forensicEventPayload(event, root);
    options.onEvent(payload, event.type);
    if (!markerForensic?.enabled && controlKey(event)) startFrameBurst(event);
  }

  function onLoaded(
    event: CustomEvent<{ protyle: IProtyle; position?: "afterend" | "beforebegin" }>,
    name: "loaded-protyle-static" | "loaded-protyle-dynamic",
  ): void {
    const active = activeProtyle();
    if (active && active !== event.detail.protyle) return;
    refreshRoot(event.detail.protyle);
    const root = rootOfProtyle(event.detail.protyle);
    options.onEvent({
      source: "eventbus",
      name,
      ...(name === "loaded-protyle-dynamic" ? { position: event.detail.position } : {}),
      protyle: profile === "timing"
        ? timingProtyleReference(event.detail.protyle, root, serializer)
        : serializer.protyleDescription(event.detail.protyle, root),
    }, name);
  }

  function onSwitch(event: CustomEvent<{ protyle: IProtyle }>): void {
    refreshRoot(event.detail.protyle);
    const root = rootOfProtyle(event.detail.protyle);
    options.onEvent({
      source: "eventbus",
      name: "switch-protyle",
      protyle: profile === "timing"
        ? timingProtyleReference(event.detail.protyle, root, serializer)
        : serializer.protyleDescription(event.detail.protyle, root),
    }, "switch-protyle");
  }

  function onClickEditorContent(
    event: CustomEvent<{ protyle: IProtyle; event: MouseEvent }>,
  ): void {
    const root = rootOfProtyle(event.detail.protyle);
    if (currentRoot && root && root !== currentRoot) return;
    if (!currentRoot) refreshRoot(event.detail.protyle);
    const eventRoot = root ?? currentRoot;
    if (!eventRoot) return;
    options.onEvent({
      source: "eventbus",
      name: "click-editorcontent",
      protyle: profile === "timing"
        ? timingProtyleReference(event.detail.protyle, root, serializer)
        : serializer.protyleDescription(event.detail.protyle, root),
      domEvent: profile === "timing"
        ? timingEventPayload(event.detail.event, eventRoot)
        : forensicEventPayload(event.detail.event, eventRoot),
    }, "click-editorcontent");
  }

  function onWsMain(event: CustomEvent<IWebSocketData>): void {
    options.onEvent({
      source: "eventbus",
      name: "ws-main",
      websocket: summarizeWsData(event.detail),
    }, "ws-main");
  }

  function onStructuralEditFinish(finish: structuralEdit.StructuralEditFinish): void {
    if (!attached) return;
    const finishRoot = currentRoot
      ?? (typeof finish.editor.closest === "function"
        ? finish.editor.closest(".protyle") as HTMLElement | null
        : null)
      ?? finish.editor;
    const snapshot = structuralEdit.getStructuralEditSnapshot();
    const block = blockForSelection();
    const selection = profile === "timing"
      ? timingSelection(serializer)
      : serializer.selectionSnapshot(finishRoot);
    const scrolling = typewriterScroll.isScrolling();
    const payload: Record<string, unknown> = {
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
      structural: profile === "timing"
        ? { generation: finish.generation, phase: "idle", kind: null }
        : {
          generation: snapshot.generation,
          phase: snapshot.phase,
          kind: snapshot.kind,
        },
      structuralStateAfterFinish: serializer.structuralEditSnapshot(snapshot, finishRoot),
      finishEditor: serializer.nodeReference(finish.editor, finishRoot, false),
      selection,
      currentBlockId: blockId(block),
        currentBlockToken: block ? serializer.nodeTokenFor(block) : null,
      currentBlock: profile === "forensic" && block
        ? serializer.describeElement(block, finishRoot, true)
        : null,
      scroll: serializer.scrollStateFor(block ?? finish.editor, finishRoot),
      typewriterScrollActive: scrolling,
      typewriterScroll: { active: scrolling },
      watchSamples: sampleWatches("structural-edit-finish", finishRoot),
    };
    options.onEvent(payload, "structural-edit-finish");
  }

  function attachEventBus(): void {
    const onLoadedStatic = (event: CustomEvent<{ protyle: IProtyle }>) => {
      onLoaded(event, "loaded-protyle-static");
    };
    const onLoadedDynamic = (event: CustomEvent<{ protyle: IProtyle; position: "afterend" | "beforebegin" }>) => {
      onLoaded(event, "loaded-protyle-dynamic");
    };
    options.eventBus.on("loaded-protyle-static", onLoadedStatic);
    options.eventBus.on("loaded-protyle-dynamic", onLoadedDynamic);
    options.eventBus.on("switch-protyle", onSwitch);
    options.eventBus.on("click-editorcontent", onClickEditorContent);
    options.eventBus.on("ws-main", onWsMain);
    eventBusOffs.push(
      () => options.eventBus.off("loaded-protyle-static", onLoadedStatic),
      () => options.eventBus.off("loaded-protyle-dynamic", onLoadedDynamic),
      () => options.eventBus.off("switch-protyle", onSwitch),
      () => options.eventBus.off("click-editorcontent", onClickEditorContent),
      () => options.eventBus.off("ws-main", onWsMain),
    );
  }

  function attachDomEvents(): void {
    if (typeof document === "undefined") return;
    const names = profile === "timing" ? TIMING_DOM_EVENT_NAMES : FORENSIC_DOM_EVENT_NAMES;
    const handler: EventListener = handleDomEvent;
    for (const type of names) {
      document.addEventListener(type, handler, { capture: true, passive: true });
      domEventListeners.push({ type, handler });
    }
  }

  function detach(): void {
    cursor.setDebugSink(null);
    typewriterScroll.setDebugSink(null);
    cancelFrameBurst();
    if (typeof document !== "undefined") {
      for (const listener of domEventListeners) {
        document.removeEventListener(listener.type, listener.handler, true);
      }
    }
    domEventListeners.length = 0;
    for (const off of eventBusOffs.splice(0)) {
      try {
        off();
      } catch {
        // A host EventBus may already have been torn down during plugin unload.
      }
    }
    unsubStructuralFinish?.();
    unsubStructuralFinish = null;
    disconnectObserver();
    currentProtyle = null;
    currentRoot = null;
    attached = false;
  }

  function createSnapshot(reason: string): DebugSnapshot {
    refreshRoot();
    const active = activeProtyle();
    const protyle = active ?? currentProtyle;
    const root = rootOfProtyle(protyle) ?? currentRoot;
    const snapshot = structuralEdit.getStructuralEditSnapshot();
    const selectionNode = typeof window !== "undefined" ? window.getSelection()?.anchorNode : null;
    const block = blockForSelection();
    const selection = profile === "timing"
      ? timingSelection(serializer)
      : serializer.selectionSnapshot(root);
    const watches = sampleWatches(reason, root);
    const scrolling = typewriterScroll.isScrolling();
    if (profile === "timing") {
      return {
        capture: { reason, profile, includeText: false },
        activeEditor: timingProtyleReference(protyle, root, serializer),
        targetEditor: null,
        focus: null,
        selection,
        currentBlock: null,
        scroll: serializer.scrollStateFor(asElement(selectionNode) ?? block ?? root, root),
        structural: serializer.structuralEditSnapshot(snapshot, root),
        typewriterScroll: { active: scrolling },
        dom: null,
        observedRoots: root ? [serializer.nodeReference(root, root, false)] : [],
        watches,
      };
    }
    const treeRoot = (root?.querySelector(".protyle-wysiwyg") as HTMLElement | null) ?? root;
    const currentBlock = block ? serializer.describeElement(block, root, true) : null;
    const activeDescription = serializer.protyleDescription(active, root);
    const dom: DebugDomTreeNode | null = treeRoot
      ? serializer.serializeDomTree(treeRoot)
      : null;
    return {
      capture: { reason, profile, includeText: true },
      activeEditor: activeDescription,
      targetEditor: null,
      focus: typeof document !== "undefined"
        ? serializer.describeElement(document.activeElement, root)
        : null,
      selection,
      currentBlock,
      scroll: serializer.scrollStateFor(asElement(selectionNode) ?? block ?? treeRoot, root),
      structural: serializer.structuralEditSnapshot(snapshot, root),
      typewriterScroll: { active: scrolling },
      dom,
      observedRoots: root ? [serializer.nodeReference(root, root, false)] : [],
      watches,
    };
  }

  return {
    setProfile(nextProfile) {
      if (profile === nextProfile) return;
      profile = nextProfile;
      serializer.setIncludeText(profile === "forensic");
      if (!attached) return;
      const previous = attached;
      detach();
      if (previous) {
        attached = true;
        attachEventBus();
        attachDomEvents();
        refreshRoot();
        unsubStructuralFinish = structuralEdit.subscribeStructuralEditFinish(onStructuralEditFinish);
      }
    },
    setFrameBurst(nextOptions) {
      frameBurstEnabled = nextOptions?.enabled === true;
      frameBurstFrameCount = frameCount(nextOptions?.frames);
      if (!frameBurstEnabled) cancelFrameBurst();
    },
    setMarkerForensic(nextOptions) {
      const wasMarkerForensic = markerForensic?.enabled === true;
      cancelFrameBurst();
      markerForensic = nextOptions?.enabled === true ? nextOptions : null;
      markerBurstSequence = 0;
      latestBurstId = null;
      if (wasMarkerForensic || markerForensic) options.replaceWatches([]);
    },
    resetNodeIdentity() {
      serializer.resetNodeIdentity();
    },
    attach() {
      if (attached) return;
      attached = true;
      cursor.setDebugSink(onCursorDebug);
      typewriterScroll.setDebugSink(onTypewriterScrollDebug);
      attachEventBus();
      attachDomEvents();
      refreshRoot();
      unsubStructuralFinish = structuralEdit.subscribeStructuralEditFinish(onStructuralEditFinish);
    },
    detach,
    getObservedRootCount() {
      return observer && observedRoot ? 1 : 0;
    },
    getLatestBurstId() {
      return latestBurstId;
    },
    createSnapshot,
    captureContext(reason) {
      refreshRoot();
      return currentContext(currentRoot, reason, true);
    },
  };
}
