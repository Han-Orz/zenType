/**
 * 涟漪聚焦模块 (Ripple Focus) — v2.5.0 重写 (CSS Custom Highlight API)
 *
 * 效果（DESIGN.md §4.1）：
 *   当前输入句保持原文字色；当前块其他句用 CSS Highlight color 按 0.6 alpha dim
 *   相邻顶层块按距离使用 BLOCK_LEVELS 衰减 [0.4, 0.2, 0.15, 0.1, 0.05]
 *   仅 distance=1 的相邻块额外应用视觉权重；嵌套块继承顶层块 opacity
 *
 * 设计要点：
 *   - 句级粒度：Intl.Segmenter 切句（唯一句界来源），用 CSS Custom Highlight API 标记（零 DOM 突变）
 *   - 块级粒度：JS 写入私有 custom property，由专属 class 映射到 opacity
 *   - 是否显示由 inputMode.focusActive 控制；默认加载状态由插件入口决定
 *   - 暂停：选中 / 悬浮窗 -> 清除所有 opacity 覆盖 + Highlight
 *   - 事件驱动：selectionchange/input + 当前块 DOM mutation + inputMode 订阅
 *
 * v2.5.0 变更：废弃 span 包裹（extractContents + insertNode），改用 CSS Custom Highlight API。
 *   原因：span 包裹分裂文本节点，SiYuan 的 input/transaction 处理器在突变后重新查选区时
 *   选区语义改变 → 光标飘走 + 内容丢失。Highlight API 不修改 DOM，彻底消除此冲突。
 *   trade-off：::highlight 不支持 opacity/transition，句级切换用 color + rAF 插值模拟。
 *   sentence presentation（stable dim + 逐句可中断 transition slot + 单一 rAF driver）
 *   实现在 ripple/sentenceTransition.ts；本文件只负责把语义目标交给该 engine。
 */

import { getCursorElement } from "../utils/getCursorElement";
import { shouldPauseFocusAndTypewriter } from "../utils/edgeCases";
import { RIPPLE_CONFIG } from "../config";
import {
  claimInlineStyle,
  restoreOwnedInlineStyle,
  setOwnedInlineStyle,
  type InlineStyleValue,
  type OwnedInlineStyle,
} from "../utils/inlineStyleOwnership";
import { resolveRangeTextPoint } from "../utils/rangeTextPoint";
import {
  isCurrentSelectionEditable,
  isCurrentSelectionInActiveEditor,
  isEditableEvent,
  isReadonlyEditorTarget,
} from "../utils/editorScope";
import { prefersReducedMotion } from "../utils/reducedMotion";
import * as inputMode from "./inputMode";
import * as inputModeTriggers from "./inputModeTriggers";
import * as structuralEdit from "./structuralEdit";
import { createNestedRippleEngine } from "./ripple/nestedEngine";
import {
  claimRippleOwnership,
  clearStructuralCarryovers,
  hasStructuralCarryovers,
  installStructuralCarryover,
  RIPPLE_BLOCK_CLASS,
  RIPPLE_OPACITY_PROPERTY,
  RIPPLE_TRANSITION_DURATION_PROPERTY,
} from "./ripple/structuralCarryover";
import {
  releaseAfterOpacityTransition,
  type TransitionReleaseTimer,
} from "./ripple/transitionRelease";
import {
  getSentenceSegmenter,
  resolveActiveSentenceRanges,
  splitSentences,
  type SentenceRange,
} from "./ripple/sentenceModel";
import {
  createSentenceTransitionEngine,
  parseRgbColor,
  SENTENCE_DIM_HIGHLIGHT,
  type Rgba,
  type SentenceTransitionEngine,
} from "./ripple/sentenceTransition";

const { BLOCK_LEVELS, SENTENCE_DIM_ALPHA, TRANSITION_SEC, WEIGHT_MIN } = RIPPLE_CONFIG;

/** CSS Custom Highlight API 注册名（句子呈现全部由 sentenceTransition engine 写入）。 */
const SENTENCE_OUTGOING_DIM_HIGHLIGHT = "zt-sentence-outgoing-dim";
// 跨块 handoff 时旧块句级 dim 的静态保留时长：跟随块级 opacity 过渡（TRANSITION_SEC），
// 目的是盖住 dim -> normal -> dim 亮度峰，与句子淡变时长无关。
const SENTENCE_OUTGOING_HOLD_MS = Math.round(TRANSITION_SEC * 1000);
const NESTED_RIPPLE_ENABLED = true;
const nestedRippleEngine = createNestedRippleEngine();
const sentenceTransitionEngine: SentenceTransitionEngine = createSentenceTransitionEngine();

// --- State ---

let active = false;
let initialized = false;
let pendingFrame: number | null = null;
let eventListeners: Array<[string, EventListener]> = [];
const modifiedBlocks = new Set<HTMLElement>();
const ownedBlockStyles = new WeakMap<HTMLElement, OwnedInlineStyle>();
const ownedBlocks = new Set<HTMLElement>();
const pendingBlockReleases = new Map<HTMLElement, TransitionReleaseTimer>();
interface StructuralVisualSnapshot {
  source: HTMLElement;
  opacity: string;
  wasFocused: boolean;
  hadSentenceDim: boolean;
}

const pendingStructuralSnapshots = new Map<string, StructuralVisualSnapshot>();

function clearStructuralVisualState(): void {
  clearStructuralCarryovers();
  pendingStructuralSnapshots.clear();
}

let unsubInputMode: (() => void) | null = null;
let unsubStructuralEditFinish: (() => void) | null = null;
let visualStateDirty = false;
let mutationObserver: MutationObserver | null = null;
let themeObserver: MutationObserver | null = null;
let observedMutationBlock: HTMLElement | null = null;
let observedMutationParent: HTMLElement | null = null;

// P0-3: 块级 opacity 缓存——同一顶层块 + 无滚动 + 无块增删时跳过整个 applyBlockOpacity。
// containerTop（rect.top）捕获祖先滚动；scrollTop 捕获 container 自身滚动。
let lastBlockOpacityBlockId: string | null = null;
let lastBlockOpacityContainer: HTMLElement | null = null;
let lastBlockOpacityContainerTop: number | null = null;
let lastBlockOpacityScrollTop: number | null = null;
let lastBlockOpacityChildCount: number | null = null;
let lastBlockOpacitySkipCurrentTopBlock = false;
let lastAppliedFocusBlockId: string | null = null;

// P1-2: 句级 dim 色 CSS 变量由 sentenceTransition engine 在主题/颜色变化时写入。
// lastSentenceThemeMode 让主题切换绕过句子 short-circuit，强制 engine 重算颜色。
let lastSentenceThemeMode: string | null = null;

// --- Block helpers ---

function getCurrentBlock(): HTMLElement | null {
  const cursor = getCursorElement();
  return (cursor?.closest("[data-node-id]") as HTMLElement) ?? null;
}

function getTopLevelBlock(currentBlock: HTMLElement, container: HTMLElement): HTMLElement {
  let topBlock = currentBlock;
  let parent: HTMLElement | null = currentBlock.parentElement;
  while (parent && parent !== container) {
    topBlock = parent;
    parent = parent.parentElement;
  }
  return topBlock;
}

function readInlineStyleValue(style: CSSStyleDeclaration, property: string): InlineStyleValue {
  return {
    value: style.getPropertyValue(property),
    priority: style.getPropertyPriority(property),
  };
}

function sameInlineStyleValue(a: InlineStyleValue, b: InlineStyleValue): boolean {
  return a.value === b.value && a.priority === b.priority;
}

function nodeIdOf(element: HTMLElement | null): string | null {
  if (!element) return null;
  const value = typeof element.getAttribute === "function"
    ? element.getAttribute("data-node-id")
    : element.dataset?.nodeId ?? null;
  return value && value.length > 0 ? value : null;
}

function isStructuralVisualBlock(element: HTMLElement): boolean {
  const id = nodeIdOf(element);
  if (!id) return false;
  if (
    element.classList?.contains("protyle-action") ||
    element.classList?.contains("protyle-attr")
  ) return false;
  const tagName = typeof element.tagName === "string" ? element.tagName.toLowerCase() : "";
  return tagName !== "svg" && tagName !== "use";
}

function structuralVisualRoots(node: Node, result: HTMLElement[] = []): HTMLElement[] {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return result;
  const element = node as HTMLElement;
  if (isStructuralVisualBlock(element)) {
    result.push(element);
    return result;
  }
  if (!element.children) return result;
  for (const child of Array.from(element.children) as HTMLElement[]) {
    structuralVisualRoots(child, result);
  }
  return result;
}

function captureStructuralVisualSnapshot(element: HTMLElement): StructuralVisualSnapshot | null {
  const id = nodeIdOf(element);
  if (!id) return null;

  const hasRippleClass = element.classList?.contains(RIPPLE_BLOCK_CLASS) === true;
  const opacity = element.style.getPropertyValue(RIPPLE_OPACITY_PROPERTY).trim();
  const wasFocused = lastAppliedFocusBlockId === id;
  const hadSentenceDim = wasFocused && lastDimBlockId === id && lastHadDimRanges;
  if (!hasRippleClass && opacity === "" && !hadSentenceDim) return null;

  return {
    source: element,
    opacity: opacity || "1",
    wasFocused,
    hadSentenceDim,
  };
}

function installSnapshotCarryover(
  element: HTMLElement,
  snapshot: StructuralVisualSnapshot,
): void {
  const opacity =
    snapshot.wasFocused &&
    snapshot.hadSentenceDim
      ? String(BLOCK_LEVELS[1])
      : snapshot.opacity;
  installStructuralCarryover(element, opacity);
}

function carryStructuralReplacementVisualState(
  records: readonly MutationRecord[],
): void {
  const removedById = new Map<string, HTMLElement[]>();
  const addedById = new Map<string, HTMLElement[]>();

  for (const record of records) {
    if (record.type !== "childList") continue;
    for (const element of Array.from(record.removedNodes).flatMap((node) => structuralVisualRoots(node))) {
      const id = nodeIdOf(element);
      if (!id) continue;
      const elements = removedById.get(id) ?? [];
      elements.push(element);
      removedById.set(id, elements);
    }
    for (const element of Array.from(record.addedNodes).flatMap((node) => structuralVisualRoots(node))) {
      const id = nodeIdOf(element);
      if (!id) continue;
      const elements = addedById.get(id) ?? [];
      elements.push(element);
      addedById.set(id, elements);
    }
  }

  const matchedAdded = new Set<HTMLElement>();
  for (const [id, removedElements] of removedById) {
    const addedElements = addedById.get(id) ?? [];
    for (const removed of removedElements) {
      const replacement = addedElements.find((candidate) => (
        candidate !== removed && !matchedAdded.has(candidate)
      ));
      const snapshot = captureStructuralVisualSnapshot(removed);
      if (replacement) {
        matchedAdded.add(replacement);
        pendingStructuralSnapshots.delete(id);
        if (snapshot) installSnapshotCarryover(replacement, snapshot);
        continue;
      }

      if (snapshot) pendingStructuralSnapshots.set(id, snapshot);
    }
  }

  for (const [id, addedElements] of addedById) {
    const snapshot = pendingStructuralSnapshots.get(id);
    if (!snapshot) continue;
    for (const added of addedElements) {
      if (matchedAdded.has(added)) continue;
      if (added === snapshot.source) {
        pendingStructuralSnapshots.delete(id);
        break;
      }
      installSnapshotCarryover(added, snapshot);
      pendingStructuralSnapshots.delete(id);
      break;
    }
  }
}

function cancelPendingBlockRelease(block: HTMLElement): void {
  const timer = pendingBlockReleases.get(block);
  if (timer === undefined) return;
  clearTimeout(timer);
  pendingBlockReleases.delete(block);
}

function releaseOwnedBlock(block: HTMLElement): void {
  cancelPendingBlockRelease(block);
  const owned = ownedBlockStyles.get(block);
  if (owned) restoreOwnedInlineStyle(block.style, owned);
  block.classList.remove(RIPPLE_BLOCK_CLASS);
  ownedBlockStyles.delete(block);
  ownedBlocks.delete(block);
}

function releaseBlockAfterTransition(block: HTMLElement): void {
  if (pendingBlockReleases.has(block)) return;
  const owned = ownedBlockStyles.get(block);
  if (!owned) return;

  const appliedOpacity = owned.applied[RIPPLE_OPACITY_PROPERTY];
  if (
    appliedOpacity?.value === "1" &&
    block.style.getPropertyValue(RIPPLE_OPACITY_PROPERTY) === appliedOpacity.value &&
    block.style.getPropertyPriority(RIPPLE_OPACITY_PROPERTY) === appliedOpacity.priority
  ) {
    releaseOwnedBlock(block);
    return;
  }

  const timer = releaseAfterOpacityTransition(
    TRANSITION_SEC,
    () => setOwnedInlineStyle(
      block.style,
      owned,
      RIPPLE_OPACITY_PROPERTY,
      "1",
    ),
    () => releaseOwnedBlock(block),
  );
  if (timer !== null) pendingBlockReleases.set(block, timer);
}

function visualWeightOf(block: HTMLElement, editorRect: DOMRect): number {
  const r = block.getBoundingClientRect();
  const visTop = Math.max(r.top, editorRect.top);
  const visBot = Math.min(r.bottom, editorRect.bottom);
  return Math.max(0, Math.min(1, Math.max(0, visBot - visTop) / (editorRect.height || 1)));
}

interface BlockOpacityCacheSnapshot {
  container: HTMLElement | null;
  blockId: string | null;
  containerTop: number | null;
  scrollTop: number | null;
  childCount: number | null;
  skipCurrentTopBlock: boolean;
}

export function isSameBlockOpacityCacheTarget(
  cache: BlockOpacityCacheSnapshot,
  container: HTMLElement,
  blockId: string | null,
  containerTop: number,
  scrollTop: number,
  childCount: number,
  skipCurrentTopBlock = false,
): boolean {
  return (
    blockId !== null &&
    cache.container === container &&
    blockId === cache.blockId &&
    containerTop === cache.containerTop &&
    scrollTop === cache.scrollTop &&
    childCount === cache.childCount &&
    skipCurrentTopBlock === cache.skipCurrentTopBlock
  );
}

// --- Caret offset helpers ---

type TextNodeEntry = { node: Text; start: number; len: number };
type TextNodeSnapshotEntry = { node: Text; len: number };

/** Single forward TreeWalker pass — collects all text nodes with cumulative offsets. */
function buildTextNodeMap(root: HTMLElement): TextNodeEntry[] {
  const map: TextNodeEntry[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let consumed = 0;
  let n: Text | null;
  while ((n = walker.nextNode() as Text | null)) {
    const len = n.nodeValue?.length ?? 0;
    map.push({ node: n, start: consumed, len });
    consumed += len;
  }
  return map;
}

function snapshotTextNodeMap(map: TextNodeEntry[]): TextNodeSnapshotEntry[] {
  return map.map(({ node, len }) => ({ node, len }));
}

function textNodeMapMatchesSnapshot(
  map: TextNodeEntry[],
  snapshot: TextNodeSnapshotEntry[] | null,
): boolean {
  if (!snapshot || map.length !== snapshot.length) return false;
  for (let i = 0; i < map.length; i++) {
    const entry = map[i];
    const cached = snapshot[i];
    if (entry.node !== cached.node || entry.len !== cached.len) return false;
  }
  return true;
}

/** Resolve the caret's global character offset within root. Returns null if caret is not within root. */
function getCaretOffset(root: HTMLElement, textNodeMap?: TextNodeEntry[]): number | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;

  const resolved = resolveRangeTextPoint(range.startContainer, range.startOffset);
  if (!resolved) return null;

  const map = textNodeMap ?? buildTextNodeMap(root);
  for (const entry of map) {
    if (entry.node === resolved.textNode) return entry.start + resolved.offset;
  }
  return null;
}

// --- Sentence semantics → presentation engine ---

// Cache for same-sentence short-circuit: selectionchange fires on cursor movement
// (arrow keys / clicks) without text changes — the semantic state is identical,
// skip rebuild. The engine below owns every CSS.highlights write for sentences.
let lastDimBlockId: string | null = null;
let lastDimText = "";
let lastActiveSentenceRanges: SentenceRange[] = [];
let lastHadDimRanges = false;
let lastDimTextNodes: TextNodeSnapshotEntry[] | null = null;
let outgoingSentenceRanges: Range[] = [];
let outgoingSentenceCleanupTimer: TransitionReleaseTimer | null = null;

function sentenceHighlightSupported(): boolean {
  return "highlights" in CSS && typeof Highlight !== "undefined";
}

function clearOutgoingSentenceHighlight(): void {
  if (outgoingSentenceCleanupTimer !== null) {
    clearTimeout(outgoingSentenceCleanupTimer);
    outgoingSentenceCleanupTimer = null;
  }
  outgoingSentenceRanges = [];
  if (sentenceHighlightSupported()) {
    CSS.highlights.delete(SENTENCE_OUTGOING_DIM_HIGHLIGHT);
  }
}

function preserveOutgoingSentenceHighlight(): void {
  if (prefersReducedMotion() || SENTENCE_OUTGOING_HOLD_MS <= 0) {
    clearOutgoingSentenceHighlight();
    return;
  }
  const stableRanges = sentenceTransitionEngine.currentStableRanges();
  if (stableRanges.length === 0) {
    return;
  }

  if (outgoingSentenceCleanupTimer !== null) {
    clearTimeout(outgoingSentenceCleanupTimer);
    outgoingSentenceCleanupTimer = null;
  }

  outgoingSentenceRanges = [
    ...outgoingSentenceRanges,
    ...stableRanges,
  ];
  CSS.highlights.set(
    SENTENCE_OUTGOING_DIM_HIGHLIGHT,
    new Highlight(...outgoingSentenceRanges),
  );
  visualStateDirty = true;
  outgoingSentenceCleanupTimer = setTimeout(() => {
    outgoingSentenceCleanupTimer = null;
    outgoingSentenceRanges = [];
    if (sentenceHighlightSupported()) {
      CSS.highlights.delete(SENTENCE_OUTGOING_DIM_HIGHLIGHT);
    }
  }, SENTENCE_OUTGOING_HOLD_MS);
}

function resetSentenceCache(): void {
  lastDimBlockId = null;
  lastDimText = "";
  lastActiveSentenceRanges = [];
  lastHadDimRanges = false;
  lastDimTextNodes = null;
  lastSentenceThemeMode = null;
}

function getThemeDimColor(): Rgba {
  const themeMode = document.documentElement.getAttribute("data-theme-mode");
  const value = themeMode === "dark" ? 255 : 0;
  return { r: value, g: value, b: value, a: SENTENCE_DIM_ALPHA };
}

function getBlockTextColor(block: HTMLElement): Rgba {
  const parsed = parseRgbColor(getComputedStyle(block).color);
  if (parsed) return parsed;
  const fallback = document.documentElement.getAttribute("data-theme-mode") === "dark" ? 255 : 0;
  return { r: fallback, g: fallback, b: fallback, a: 1 };
}

/**
 * caret 在该位置时 resolver 是否会得到与缓存一致的 active set（short-circuit 判定）。
 * 单句缓存：句内任一位置（含 EOF 端点）；双句缓存：仅公共边界点本身。
 */
function caretReproducesActiveSet(
  caretOffset: number,
  cached: SentenceRange[],
  textLength: number,
): boolean {
  if (cached.length === 1) {
    const [range] = cached;
    if (caretOffset >= range.start && caretOffset < range.end) return true;
    // EOF：最后一句的 end 精确等于 text.length。
    return caretOffset === range.end && range.end === textLength;
  }
  if (cached.length === 2) {
    return caretOffset === cached[0].end && cached[1].start === caretOffset;
  }
  return false;
}

/**
 * Route the current block's sentence semantics into the sentence transition
 * engine, which owns the whole sentence presentation (stable dim channel,
 * per-sentence transition slots, single rAF driver). Zero DOM mutation here:
 * only Range registration happens, inside the engine, on existing text nodes.
 */
function applySentenceHighlight(block: HTMLElement, caretOffset: number, textNodeMap: TextNodeEntry[]): void {
  if (!sentenceHighlightSupported()) return; // CSS Custom Highlight API not supported

  if (getSentenceSegmenter() === null) {
    // Intl.Segmenter 不可用：句子聚焦整体禁用（无 regex fallback），块级 Ripple 不受影响。
    sentenceTransitionEngine.clear();
    resetSentenceCache();
    return;
  }

  const text = block.textContent ?? "";
  if (!text) {
    sentenceTransitionEngine.clear();
    resetSentenceCache();
    return;
  }

  const blockId = block.dataset?.nodeId ?? null;
  if (lastDimBlockId !== null && blockId !== lastDimBlockId) {
    // Keep the previous block's dimmed sentences visible while its block
    // opacity transitions to the new structural target. The stable ranges are
    // snapshotted before the engine rebuilds state for the new block.
    preserveOutgoingSentenceHighlight();
  }
  const textNodesUnchanged = textNodeMapMatchesSnapshot(textNodeMap, lastDimTextNodes);
  const themeMode = document.documentElement.getAttribute("data-theme-mode");

  // Short-circuit: same block, same text, caret still resolving to the cached
  // active set, same text nodes and same theme — nothing changed, skip. The
  // has() catch guards external Highlight clears; the text node snapshot
  // catches SiYuan re-renders that replace Text nodes without changing text.
  if (
    blockId !== null &&
    blockId === lastDimBlockId &&
    text === lastDimText &&
    lastActiveSentenceRanges.length > 0 &&
    textNodesUnchanged &&
    caretReproducesActiveSet(caretOffset, lastActiveSentenceRanges, text.length) &&
    themeMode === lastSentenceThemeMode &&
    (!lastHadDimRanges || CSS.highlights.has(SENTENCE_DIM_HIGHLIGHT))
  ) {
    return;
  }

  const matches = splitSentences(text);
  const activeRanges = resolveActiveSentenceRanges(matches, caretOffset, text.length);

  sentenceTransitionEngine.update({
    blockKey: blockId,
    sentenceRanges: matches,
    activeRanges,
    textChanged: text !== lastDimText,
    textNodeMap,
    textColor: getBlockTextColor(block),
    dimColor: getThemeDimColor(),
    animate: !prefersReducedMotion(),
  });

  lastDimBlockId = blockId;
  lastDimText = text;
  lastActiveSentenceRanges = activeRanges;
  lastHadDimRanges = sentenceTransitionEngine.hasStableDimRanges();
  lastDimTextNodes = snapshotTextNodeMap(textNodeMap);
  lastSentenceThemeMode = themeMode;
}

function refreshSentenceHighlightOnly(): void {
  if (!active || !inputMode.isFocusActive() || shouldPauseFocusAndTypewriter()) return;

  const currentBlock = getCurrentBlock();
  if (!currentBlock || !currentBlock.isConnected) return;

  const textNodeMap = buildTextNodeMap(currentBlock);
  const caretOffset = getCaretOffset(currentBlock, textNodeMap);
  if (caretOffset === null) return;

  applySentenceHighlight(currentBlock, caretOffset, textNodeMap);
}

// --- Block-level opacity ---

function applyBlockOpacity(
  container: HTMLElement,
  currentBlock: HTMLElement,
  skipCurrentTopBlock = false,
): void {
  // 找 currentBlock 的顶层块（container 的直接子级）。
  // 嵌套块（列表项、列表内段落等）不单独设 opacity，继承父级——
  // 避免嵌套 opacity 叠加（父 0.5 × 子 0.5 = 0.25 不可见）。
  const topBlock = getTopLevelBlock(currentBlock, container);

  const editorRect = container.getBoundingClientRect();
  const blockId = topBlock.dataset?.nodeId ?? null;
  const containerTop = Math.round(editorRect.top);
  const scrollTop = container.scrollTop;
  const childCount = container.childElementCount;

  // P0-3: 同一顶层块 + 无滚动 + 无块增删 → distance/weight/opacity 与上一帧完全相同，跳过。
  if (
    !hasStructuralCarryovers() &&
    isSameBlockOpacityCacheTarget({
      container: lastBlockOpacityContainer,
      blockId: lastBlockOpacityBlockId,
      containerTop: lastBlockOpacityContainerTop,
      scrollTop: lastBlockOpacityScrollTop,
      childCount: lastBlockOpacityChildCount,
      skipCurrentTopBlock: lastBlockOpacitySkipCurrentTopBlock,
    }, container, blockId, containerTop, scrollTop, childCount, skipCurrentTopBlock)
  ) {
    return;
  }

  // 只遍历 container 的直接子级（顶层块），不 querySelectorAll 嵌套块。
  const siblings = Array.from(container.children) as HTMLElement[];
  const fromIndex = siblings.indexOf(topBlock);
  if (fromIndex === -1) return;

  // 缓存仅在成功应用后更新——fromIndex===-1 时不缓存，下次重试。
  lastBlockOpacityBlockId = blockId;
  lastBlockOpacityContainer = container;
  lastBlockOpacityContainerTop = containerTop;
  lastBlockOpacityScrollTop = scrollTop;
  lastBlockOpacityChildCount = childCount;
  lastBlockOpacitySkipCurrentTopBlock = skipCurrentTopBlock;

  const newBlocks = new Set<HTMLElement>();

  siblings.forEach((block, i) => {
    if (skipCurrentTopBlock && block === topBlock) return;
    if (!block.hasAttribute("data-node-id")) return; // 跳过非块元素
    const distance = Math.abs(fromIndex - i);
    const baseLevel = BLOCK_LEVELS[Math.min(distance, BLOCK_LEVELS.length - 1)];
    // P1-1: distance≥2 的远块 weight 差异不可感知，跳过 getBoundingClientRect。
    const weightFactor = distance === 0
      ? 1.0
      : distance >= 2
      ? 1.0
      : WEIGHT_MIN + visualWeightOf(block, editorRect) * (1 - WEIGHT_MIN);
    cancelPendingBlockRelease(block);
    let owned = ownedBlockStyles.get(block);
    let adoptedCarryover = false;
    if (!owned) {
      const ownership = claimRippleOwnership(block);
      owned = ownership.owned;
      adoptedCarryover = ownership.adoptedStructuralCarryover;
      ownedBlockStyles.set(block, owned);
      ownedBlocks.add(block);
    }
    const finalOpacity = String(baseLevel * weightFactor);
    let opacityApplied: boolean;
    let durationApplied: boolean;
    if (adoptedCarryover) {
      durationApplied = setOwnedInlineStyle(
        block.style,
        owned,
        RIPPLE_TRANSITION_DURATION_PROPERTY,
        `${TRANSITION_SEC}s`,
      );
      const appliedOpacity = owned.applied[RIPPLE_OPACITY_PROPERTY];
      const opacityAlreadyFinal = appliedOpacity !== undefined &&
        appliedOpacity.value === finalOpacity &&
        sameInlineStyleValue(
          readInlineStyleValue(block.style, RIPPLE_OPACITY_PROPERTY),
          appliedOpacity,
        );
      opacityApplied = durationApplied && (
        opacityAlreadyFinal || setOwnedInlineStyle(
          block.style,
          owned,
          RIPPLE_OPACITY_PROPERTY,
          finalOpacity,
        )
      );
    } else {
      opacityApplied = setOwnedInlineStyle(
        block.style,
        owned,
        RIPPLE_OPACITY_PROPERTY,
        finalOpacity,
      );
      durationApplied = opacityApplied && setOwnedInlineStyle(
        block.style,
        owned,
        RIPPLE_TRANSITION_DURATION_PROPERTY,
        `${TRANSITION_SEC}s`,
      );
    }
    if (!opacityApplied || !durationApplied) {
      // Another owner changed our private property. Drop the class as well so
      // the external value is visible and never overwrite it on a later frame.
      restoreOwnedInlineStyle(block.style, owned);
      block.classList.remove(RIPPLE_BLOCK_CLASS);
      ownedBlockStyles.delete(block);
      ownedBlocks.delete(block);
      return;
    }
    block.classList.add(RIPPLE_BLOCK_CLASS);
    newBlocks.add(block);
    visualStateDirty = true;
  });

  // 不在新列表里的旧块：真正离开 legacy ownership 时先过渡到自然
  // opacity；如果 nested engine 正在接管当前顶层块，则直接释放父层，
  // 避免 parent -> 1 -> child opacity 的 staged handoff。
  modifiedBlocks.forEach((block) => {
    if (!newBlocks.has(block)) {
      if (skipCurrentTopBlock && block === topBlock) {
        releaseOwnedBlock(block);
      } else {
        releaseBlockAfterTransition(block);
      }
    }
  });

  modifiedBlocks.clear();
  newBlocks.forEach((b) => modifiedBlocks.add(b));
}

function clearLegacyBlockOpacity(): void {
  for (const block of Array.from(ownedBlocks)) releaseBlockAfterTransition(block);
  modifiedBlocks.clear();
  lastBlockOpacityBlockId = null;
  lastBlockOpacityContainer = null;
  lastBlockOpacityContainerTop = null;
  lastBlockOpacityScrollTop = null;
  lastBlockOpacityChildCount = null;
  lastBlockOpacitySkipCurrentTopBlock = false;
}

// --- Main apply ---

function applyRippleNow(): void {
  // A pending structural transaction owns the wait for a stable semantic DOM.
  // Ordinary selection/input signals must leave the last valid visual state in
  // place until the coordinator publishes that commit.
  if (structuralEdit.isStructuralEditPending()) return;

  if (!inputMode.isFocusActive() || shouldPauseFocusAndTypewriter()) {
    clearAll();
    return;
  }

  const currentBlock = getCurrentBlock();
  if (!currentBlock) {
    disconnectMutationObserver();
    clearAll();
    return;
  }

  const container = currentBlock.closest(".protyle-wysiwyg") as HTMLElement | null;
  if (!container) {
    disconnectMutationObserver();
    clearAll();
    return;
  }

  bindMutationObserver(currentBlock, container);

  const nestedApplied = NESTED_RIPPLE_ENABLED
    ? nestedRippleEngine.apply(container, currentBlock, {
      preserveOnInvalid: false,
    })
    : false;

  applyBlockOpacity(container, currentBlock, nestedApplied);
  clearStructuralVisualState();

  const textNodeMap = buildTextNodeMap(currentBlock);
  const caretOffset = getCaretOffset(currentBlock, textNodeMap);
  if (caretOffset !== null) {
    applySentenceHighlight(currentBlock, caretOffset, textNodeMap);
  } else if (sentenceHighlightSupported()) {
    sentenceTransitionEngine.clear();
    resetSentenceCache();
  }

  lastAppliedFocusBlockId = nodeIdOf(currentBlock);

}

function applyRipple(): void {
  if (!active || structuralEdit.isStructuralEditPending()) return;
  if (pendingFrame !== null) return;
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = null;
    if (structuralEdit.isStructuralEditPending()) return;
    applyRippleNow();
  });
}

function onStructuralEditFinish(finish: structuralEdit.StructuralEditFinish): void {
  if (!active) return;

  if (!finish.stable) {
    // The bounded coordinator window did not produce authoritative geometry.
    // Keep the last valid state through the transaction and let one ordinary
    // frame decide whether the new structure is usable.
    applyRipple();
    return;
  }

  nestedRippleEngine.invalidateStructure();
  applyRippleNow();
}

function disconnectMutationObserver(): void {
  mutationObserver?.disconnect();
  observedMutationBlock = null;
  observedMutationParent = null;
}

function bindThemeObserver(): void {
  if (themeObserver || typeof MutationObserver === "undefined") return;
  const root = document.documentElement;
  if (!root) return;
  themeObserver = new MutationObserver(() => {
    // Theme changes must refresh sentence colors even when no input or
    // selection event follows. Clearing lastSentenceThemeMode makes the next
    // apply bypass the sentence short-circuit and re-sync engine colors.
    lastSentenceThemeMode = null;
    if (active) applyRipple();
  });
  themeObserver.observe(root, {
    attributes: true,
    attributeFilter: ["data-theme-mode"],
  });
}

function disconnectThemeObserver(): void {
  themeObserver?.disconnect();
  themeObserver = null;
}

function bindMutationObserver(currentBlock: HTMLElement, container: HTMLElement): void {
  const topBlock = getTopLevelBlock(currentBlock, container);
  const parent = topBlock.parentElement;
  if (
    mutationObserver &&
    observedMutationBlock === topBlock &&
    observedMutationParent === parent
  ) {
    return;
  }

  if (!mutationObserver) mutationObserver = new MutationObserver(onDomMutation);
  mutationObserver.disconnect();
  mutationObserver.observe(topBlock, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  if (parent) {
    // Catch whole-block replacement; observing only the old block would miss
    // the parent-level remove/insert mutation.
    mutationObserver.observe(parent, { childList: true });
  }
  observedMutationBlock = topBlock;
  observedMutationParent = parent;
}

function mutationTouchesCurrentBlock(
  record: MutationRecord,
  currentBlock: HTMLElement,
  topBlock: HTMLElement,
): boolean {
  // The parent observer also sees insertion/removal of a sibling top-level
  // block. Those records do not contain the current block, but they do change
  // the semantic distance plan and must remain in scope.
  if (record.target === topBlock.parentElement) return true;
  if (topBlock.contains(record.target)) return true;
  if (currentBlock.contains(record.target)) return true;

  for (const node of [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)]) {
    if (node === currentBlock || currentBlock.contains(node)) return true;
    if (node === topBlock || topBlock.contains(node)) return true;
    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).contains(currentBlock)) return true;
    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).contains(topBlock)) return true;
  }

  return false;
}

function scheduleMutationRefresh(): void {
  if (!active) return;
  applyRipple();
}

function beginOrNoteStructuralEdit(
  kind: structuralEdit.StructuralEditKind,
  editor: HTMLElement,
): void {
  const snapshot = structuralEdit.getStructuralEditSnapshot();
  if (
    structuralEdit.isStructuralEditPending() &&
    snapshot.editor === editor
  ) {
    structuralEdit.noteStructuralActivity(editor);
    return;
  }
  structuralEdit.beginStructuralEdit(kind, editor);
}

// SiYuan inline tokenizers can re-render the current block after input/selectionchange.
function onDomMutation(records: MutationRecord[]): void {
  if (!active || !inputMode.isFocusActive() || shouldPauseFocusAndTypewriter()) return;

  const currentBlock = getCurrentBlock();
  if (!currentBlock) {
    if (structuralEdit.isStructuralEditPending()) {
      carryStructuralReplacementVisualState(records);
      structuralEdit.noteStructuralActivity();
      nestedRippleEngine.invalidateStructure();
    }
    return;
  }
  const container = currentBlock.closest(".protyle-wysiwyg") as HTMLElement | null;
  if (!container) {
    if (structuralEdit.isStructuralEditPending()) {
      carryStructuralReplacementVisualState(records);
      structuralEdit.noteStructuralActivity();
      nestedRippleEngine.invalidateStructure();
    }
    return;
  }
  const topBlock = getTopLevelBlock(currentBlock, container);
  const relevantRecords = records.filter((record) =>
    mutationTouchesCurrentBlock(record, currentBlock, topBlock),
  );
  if (relevantRecords.length === 0) return;

  const childListRecords = relevantRecords.filter((record) => record.type === "childList");
  if (childListRecords.length > 0) {
    if (structuralEdit.isStructuralEditPending()) {
      // Once a real transaction is pending, even a same-block rerender is
      // host follow-up activity and must extend its quiet window.
      carryStructuralReplacementVisualState(childListRecords);
      structuralEdit.noteStructuralActivity(container);
      nestedRippleEngine.invalidateStructure();
      const structuralSnapshot = structuralEdit.getStructuralEditSnapshot();
      if (structuralSnapshot.kind === "list-change") {
        // The host has already committed the reparent. Reconcile the nested
        // visual ownership before the next paint, while preserving the prior
        // state if this transient DOM snapshot is not yet usable.
        nestedRippleEngine.apply(container, currentBlock, {
          preserveOnInvalid: true,
        });
      }
      refreshSentenceHighlightOnly();
      return;
    }

    if (structuralEdit.hasSemanticBlockMutation(childListRecords, container)) {
      structuralEdit.beginStructuralEdit("unknown", container);
      nestedRippleEngine.invalidateStructure();
      // The coordinator's stable finish performs the next semantic rebuild.
      return;
    }

    // Representation-only rerenders still replace DOM bindings, but do not
    // establish a structural transaction or suppress the ordinary refresh.
    nestedRippleEngine.invalidateStructure();
    scheduleMutationRefresh();
    return;
  }

  const characterDataRecords = relevantRecords.filter((record) => record.type === "characterData");
  if (characterDataRecords.length > 0 && structuralEdit.isStructuralEditPending()) {
    refreshSentenceHighlightOnly();
    return;
  }

  scheduleMutationRefresh();
}

function clearAll(): void {
  disconnectMutationObserver();
  clearStructuralVisualState();
  nestedRippleEngine.clear();
  clearLegacyBlockOpacity();
  const sentenceStateActive = sentenceTransitionEngine.hasActiveVisualState();
  sentenceTransitionEngine.clear();
  if (
    !sentenceStateActive &&
    !visualStateDirty &&
    ownedBlocks.size === 0 &&
    outgoingSentenceRanges.length === 0 &&
    outgoingSentenceCleanupTimer === null
  ) return;

  clearOutgoingSentenceHighlight();
  resetSentenceCache();
  lastAppliedFocusBlockId = null;
  visualStateDirty = false;
}

// --- Lifecycle ---

function onSelectionChange(): void {
  if (!isCurrentSelectionEditable()) {
    if (isCurrentSelectionInActiveEditor()) inputModeTriggers.onReadonly();
    return;
  }
  applyRipple();
}

function onInput(event: Event): void {
  if (!isEditableEvent(event)) {
    if (isReadonlyEditorTarget(event.target)) inputModeTriggers.onReadonly();
    return;
  }

  if (!inputMode.isFocusActive() || shouldPauseFocusAndTypewriter()) {
    clearAll();
    return;
  }

  const inputType = (event as InputEvent).inputType;
  const currentBlock = getCurrentBlock();
  const editor = currentBlock?.closest(".protyle-wysiwyg") as HTMLElement | null;
  const structuralKind = typeof inputType === "string"
    ? structuralEdit.structuralKindFromInputType(inputType)
    : null;
  if (structuralKind !== null) {
    if (editor) beginOrNoteStructuralEdit(structuralKind, editor);
    else if (structuralEdit.isStructuralEditPending()) structuralEdit.noteStructuralActivity();
    nestedRippleEngine.invalidateStructure();
    return;
  }

  // Backspace/Delete are ambiguous: a character deletion does not establish a
  // structural transaction by itself, while Typewriter may already have
  // classified a block merge from keydown capture.
  if (inputType === "deleteContentBackward" || inputType === "deleteContentForward") {
    if (structuralEdit.isStructuralEditPending()) {
      if (editor) structuralEdit.noteStructuralActivity(editor);
      else structuralEdit.noteStructuralActivity();
    }
    applyRipple();
    return;
  }

  // Do not let an ordinary follow-up event force a rebuild while a structural
  // edit is waiting for its stable DOM frame.
  if (structuralEdit.isStructuralEditPending()) {
    applyRipple();
    return;
  }

  if (pendingFrame !== null) {
    cancelAnimationFrame(pendingFrame);
    pendingFrame = null;
  }
  applyRippleNow();
  applyRipple();
}

export function initRipple(): void {
  if (initialized) return;
  initialized = true;
  active = true;
  pendingFrame = null;

  const handler: EventListener = onSelectionChange;
  document.addEventListener("selectionchange", handler);
  const inputHandler: EventListener = onInput;
  document.addEventListener("input", inputHandler);
  eventListeners = [
    ["selectionchange", handler],
    ["input", inputHandler],
  ];

  unsubStructuralEditFinish = structuralEdit.subscribeStructuralEditFinish(onStructuralEditFinish);

  bindThemeObserver();

  // P1-1: 订阅 inputMode。wheel/touchmove/blur/click 等退出事件不触发 selectionchange，
  // 旧版仅靠 selectionchange → clearAll 会让 ripple opacity 在滚动/失焦后残留。
  unsubInputMode = inputMode.subscribe((state) => {
    if (!state.focusActive && active) clearAll();
    else if (state.focusActive && active) applyRipple();
  });

  applyRipple();
}

export function destroyRipple(): void {
  initialized = false;
  active = false;
  eventListeners.forEach(([event, handler]) => {
    document.removeEventListener(event, handler);
  });
  eventListeners = [];

  if (unsubInputMode) {
    unsubInputMode();
    unsubInputMode = null;
  }
  if (unsubStructuralEditFinish) {
    unsubStructuralEditFinish();
    unsubStructuralEditFinish = null;
  }

  disconnectThemeObserver();

  if (mutationObserver) {
    mutationObserver.disconnect();
    mutationObserver = null;
  }
  observedMutationBlock = null;
  observedMutationParent = null;

  if (pendingFrame !== null) {
    cancelAnimationFrame(pendingFrame);
    pendingFrame = null;
  }

  clearAll();
}
