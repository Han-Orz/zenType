export const LATE_SEMANTIC_MUTATION_WINDOW_MS = 100;

const MAX_IDS = 256;
const MAX_PARENT_CHANGES = 256;
const MAX_ANOMALIES = 256;
const STRUCTURAL_ANOMALIES = new Set([
  "IDLE_SEMANTIC_MUTATION",
  "LATE_SEMANTIC_MUTATION",
  "CHAR_BACKSPACE_STRUCTURAL_FALSE_POSITIVE",
]);

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function payloadOf(envelope) {
  return asRecord(envelope?.payload);
}

function eventTime(envelope, fallback = 0) {
  const payload = payloadOf(envelope);
  return finiteNumber(payload.monotonicMs)
    ?? finiteNumber(envelope?.monotonicMs)
    ?? fallback;
}

function structuralStateOf(payload) {
  const nested = asRecord(payload.structural);
  const legacy = asRecord(payload.structuralEdit);
  return {
    generation: finiteNumber(payload.structuralGeneration)
      ?? finiteNumber(nested.generation)
      ?? finiteNumber(legacy.generation)
      ?? 0,
    phase: typeof payload.structuralPhase === "string"
      ? payload.structuralPhase
      : typeof nested.phase === "string"
        ? nested.phase
        : typeof legacy.phase === "string" ? legacy.phase : "idle",
    kind: typeof payload.structuralKind === "string"
      ? payload.structuralKind
      : typeof nested.kind === "string"
        ? nested.kind
        : typeof legacy.kind === "string" ? legacy.kind : null,
  };
}

function uniqueBounded(values, limit = MAX_IDS) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function blockIdsForPayload(payload) {
  return uniqueBounded([
    ...arrayOfStrings(payload.addedBlockIds),
    ...arrayOfStrings(payload.removedBlockIds),
    typeof payload.currentBlockId === "string" ? payload.currentBlockId : "",
  ]);
}

function contextBlockIdsForPayload(payload) {
  const selection = asRecord(payload.selection);
  const finishEditor = asRecord(payload.finishEditor);
  return uniqueBounded([
    ...blockIdsForPayload(payload),
    typeof selection.anchorBlockId === "string" ? selection.anchorBlockId : "",
    typeof selection.focusBlockId === "string" ? selection.focusBlockId : "",
    typeof finishEditor.nodeId === "string" ? finishEditor.nodeId : "",
  ]);
}

function generationOf(payload) {
  const state = structuralStateOf(payload);
  return state.generation > 0 ? state.generation : null;
}

function operationName(payload) {
  return typeof payload.name === "string" ? payload.name : "";
}

function addParentChanges(accumulator, value) {
  if (!Array.isArray(value)) return;
  for (const change of value) {
    const candidate = asRecord(change);
    if (typeof candidate.blockId !== "string") continue;
    const normalized = {
      blockId: candidate.blockId,
      fromParentId: typeof candidate.fromParentId === "string" ? candidate.fromParentId : null,
      toParentId: typeof candidate.toParentId === "string" ? candidate.toParentId : null,
    };
    const key = JSON.stringify(normalized);
    if (accumulator.parentChangeKeys.has(key)) continue;
    accumulator.parentChangeKeys.add(key);
    if (accumulator.parentChanges.length < MAX_PARENT_CHANGES) {
      accumulator.parentChanges.push(normalized);
    }
  }
}

class StructuralAccumulator {
  constructor(generation, kind, at) {
    this.generation = generation;
    this.kind = kind;
    this.firstObservedAt = at;
    this.finishedAt = null;
    this.mutationBatches = 0;
    this.childListRecords = 0;
    this.selectionChanges = 0;
    this.structuralMutationCount = 0;
    this.representationMutationCount = 0;
    this.addedBlockIds = new Set();
    this.removedBlockIds = new Set();
    this.contextBlockIds = new Set();
    this.parentChanges = [];
    this.parentChangeKeys = new Set();
    this.stable = null;
    this.lastActivityAt = null;
    this.quietMs = null;
    this.elapsedMs = null;
    this.settleFrames = null;
    this.anomalies = [];
    this.anomalyDetails = [];
    this.status = "pending";
    this.pendingFinalizationAt = null;
    this.observationFinalizationAt = null;
    this.emitted = false;
  }
}

export class DebugSummarySession {
  constructor(sessionId = "unknown", options = {}) {
    this.sessionId = sessionId;
    this.lateWindowMs = finiteNumber(options.lateWindowMs)
      ?? LATE_SEMANTIC_MUTATION_WINDOW_MS;
    this.transactions = new Map();
    this.finalized = [];
    this.allFinalized = [];
    this.lastObservedAt = null;
    this.latestCounters = {
      timingEvents: 0,
      forensicSnapshots: 0,
      mutationBatches: 0,
      serializedMutationRecords: 0,
    };
    this.pendingBackspace = null;
    this.ime = null;
    this.activeGeneration = 0;
  }

  accept(envelope) {
    if (!envelope || typeof envelope !== "object") return [];
    const at = eventTime(envelope, this.lastObservedAt ?? 0);
    this.finalizeDue(at);
    this.lastObservedAt = at;
    this.captureCounters(envelope);
    if (envelope.kind !== "event") return this.drainFinalized();

    const payload = payloadOf(envelope);
    const name = operationName(payload);
    switch (name) {
      case "structural-edit-begin":
        this.handleStructuralBegin(payload, at);
        break;
      case "structural-edit-activity":
        this.handleStructuralActivity(payload, at);
        break;
      case "structural-edit-finish":
        this.handleStructuralFinish(payload, at);
        break;
      case "mutation":
        this.handleMutation(payload, at);
        break;
      case "selectionchange":
        this.handleSelectionChange(payload, at);
        break;
      case "keydown":
        this.handleKeydown(payload, at);
        break;
      case "input":
        this.handleInput(payload, at);
        break;
      case "compositionstart":
        this.handleCompositionStart(payload, at);
        break;
      case "compositionend":
        this.handleCompositionEnd(payload, at);
        break;
      default:
        break;
    }
    return this.drainFinalized();
  }

  drainFinalized() {
    return this.finalized.splice(0, this.finalized.length);
  }

  nextFinalizationAt() {
    let next = null;
    for (const accumulator of this.transactions.values()) {
      for (const candidate of [
        accumulator.pendingFinalizationAt,
        accumulator.observationFinalizationAt,
      ]) {
        if (candidate === null) continue;
        if (next === null || candidate < next) next = candidate;
      }
    }
    if (this.pendingBackspace) {
      const candidate = this.pendingBackspace.lastAt + this.lateWindowMs;
      if (next === null || candidate < next) next = candidate;
    }
    return next;
  }

  nextFinalizationDelayMs() {
    const next = this.nextFinalizationAt();
    if (next === null) return null;
    const observed = this.lastObservedAt ?? next;
    return Math.max(0, next - observed);
  }

  finalizeDue(now) {
    const time = finiteNumber(now) ?? Infinity;
    for (const accumulator of this.transactions.values()) {
      if (accumulator.emitted) continue;
      if (
        accumulator.pendingFinalizationAt !== null
        && accumulator.pendingFinalizationAt <= time
      ) {
        this.finalizeTransaction(accumulator, accumulator.status);
      } else if (
        accumulator.finishedAt === null
        && accumulator.observationFinalizationAt !== null
        && accumulator.observationFinalizationAt <= time
      ) {
        this.finalizeTransaction(accumulator, "observed");
      }
    }
    if (
      this.pendingBackspace
      && this.pendingBackspace.lastAt + this.lateWindowMs <= time
    ) {
      this.finalizeBackspace();
    }
  }

  flush(now = Infinity) {
    this.finalizeDue(now);
    if (now === Infinity) {
      for (const accumulator of this.transactions.values()) {
        if (!accumulator.emitted && accumulator.anomalies.length > 0) {
          this.finalizeTransaction(accumulator, accumulator.finishedAt === null ? "observed" : accumulator.status);
        }
      }
      if (this.pendingBackspace) this.finalizeBackspace();
    }
    return this.drainFinalized();
  }

  getReport() {
    const structuralRecords = this.allFinalized.filter((record) => record.operation === "structural");
    const completed = structuralRecords.filter((record) => record.status === "completed");
    const elapsed = completed.map((record) => record.elapsedMs).filter((value) => value !== null);
    const quiet = completed.map((record) => record.quietMs).filter((value) => value !== null);
    const anomalies = [];
    for (const record of this.allFinalized) {
      for (const detail of record.anomalyDetails ?? []) anomalies.push(detail);
    }
    const report = {
      sessionId: this.sessionId,
      transactions: structuralRecords.length,
      stable: completed.filter((record) => record.stable === true).length,
      unstable: completed.filter((record) => record.stable === false).length,
      superseded: structuralRecords.filter((record) => record.status === "superseded").length,
      ordinaryEdits: this.allFinalized.filter((record) => (
        record.operation === "character-backspace" || record.operation === "ime"
      )).length,
      timing: {
        minElapsedMs: elapsed.length > 0 ? Math.min(...elapsed) : null,
        maxElapsedMs: elapsed.length > 0 ? Math.max(...elapsed) : null,
        minQuietMs: quiet.length > 0 ? Math.min(...quiet) : null,
        maxQuietMs: quiet.length > 0 ? Math.max(...quiet) : null,
      },
      anomalies,
      counters: { ...this.latestCounters },
    };
    return report;
  }

  captureCounters(envelope) {
    const payload = payloadOf(envelope);
    const sources = [
      payload,
      asRecord(payload.debugCounters),
      asRecord(payload.debugState),
      asRecord(payload.state),
    ];
    for (const source of sources) {
      for (const key of Object.keys(this.latestCounters)) {
        const value = finiteNumber(source[key]);
        if (value !== null) this.latestCounters[key] = value;
      }
    }
  }

  maybeSupersede(generation, at) {
    if (generation <= this.activeGeneration) return;
    this.activeGeneration = generation;
    for (const accumulator of this.transactions.values()) {
      if (
        accumulator.generation < generation
        && !accumulator.emitted
        && accumulator.finishedAt === null
      ) {
        accumulator.status = "superseded";
        accumulator.pendingFinalizationAt = null;
        accumulator.observationFinalizationAt = null;
        this.finalizeTransaction(accumulator, "superseded", at);
      }
    }
  }

  ensureTransaction(generation, kind, at) {
    if (generation === null) return null;
    this.maybeSupersede(generation, at);
    const existing = this.transactions.get(generation);
    if (existing) {
      if (kind && (!existing.kind || existing.kind === "unknown")) existing.kind = kind;
      if (at < existing.firstObservedAt) existing.firstObservedAt = at;
      return existing;
    }
    const accumulator = new StructuralAccumulator(generation, kind ?? "unknown", at);
    this.transactions.set(generation, accumulator);
    return accumulator;
  }

  findLateContextAccumulator(payload, at) {
    const generation = generationOf(payload);
    const blockIds = contextBlockIdsForPayload(payload);
    for (const accumulator of this.transactions.values()) {
      if (
        accumulator.emitted
        || accumulator.finishedAt === null
        || at <= accumulator.finishedAt
        || at > accumulator.finishedAt + this.lateWindowMs
      ) continue;
      if (generation === accumulator.generation) return accumulator;
      if (blockIds.some((id) => accumulator.contextBlockIds.has(id))) return accumulator;
    }
    return null;
  }

  addAnomaly(accumulator, code, at, blockIds = []) {
    if (!STRUCTURAL_ANOMALIES.has(code)) return;
    if (!accumulator.anomalies.includes(code)) accumulator.anomalies.push(code);
    if (accumulator.anomalyDetails.length >= MAX_ANOMALIES) return;
    const ids = uniqueBounded(blockIds);
    const duplicate = accumulator.anomalyDetails.some((detail) => (
      detail.code === code && detail.at === at
    ));
    if (!duplicate) accumulator.anomalyDetails.push({ code, at, blockIds: ids });
  }

  updateAccumulatorFromMutation(accumulator, payload, at, state) {
    accumulator.mutationBatches += 1;
    const childListRecords = finiteNumber(payload.childListCount);
    accumulator.childListRecords += childListRecords ?? finiteNumber(payload.recordCount) ?? 0;
    accumulator.lastActivityAt = at;
    for (const id of arrayOfStrings(payload.addedBlockIds)) {
      if (accumulator.addedBlockIds.size < MAX_IDS) accumulator.addedBlockIds.add(id);
    }
    for (const id of arrayOfStrings(payload.removedBlockIds)) {
      if (accumulator.removedBlockIds.size < MAX_IDS) accumulator.removedBlockIds.add(id);
    }
    for (const id of contextBlockIdsForPayload(payload)) {
      if (accumulator.contextBlockIds.size < MAX_IDS) accumulator.contextBlockIds.add(id);
    }
    addParentChanges(accumulator, payload.parentChanges);

    if (payload.semanticClassification === "structural") {
      accumulator.structuralMutationCount += 1;
      const blocks = blockIdsForPayload(payload);
      if (state.phase === "idle") {
        this.addAnomaly(accumulator, "IDLE_SEMANTIC_MUTATION", at, blocks);
        if (accumulator.finishedAt === null) {
          accumulator.observationFinalizationAt = at + this.lateWindowMs;
        }
      }
      if (
        accumulator.finishedAt !== null
        && at > accumulator.finishedAt
        && at <= accumulator.finishedAt + this.lateWindowMs
      ) {
        this.addAnomaly(accumulator, "LATE_SEMANTIC_MUTATION", at, blocks);
      }
      this.markBackspaceStructural(accumulator.generation, blocks);
      this.markImeStructural(accumulator.generation);
    } else if (payload.semanticClassification === "representation") {
      accumulator.representationMutationCount += 1;
      this.markBackspaceRepresentation();
      this.markImeRepresentation();
    }
  }

  handleStructuralBegin(payload, at) {
    const state = structuralStateOf(payload);
    const generation = generationOf(payload);
    const accumulator = this.ensureTransaction(generation, payload.kind ?? state.kind, at);
    if (!accumulator) return;
    accumulator.firstObservedAt = finiteNumber(payload.transactionStartedAt) ?? accumulator.firstObservedAt;
    accumulator.lastActivityAt = at;
  }

  handleStructuralActivity(payload, at) {
    const state = structuralStateOf(payload);
    const accumulator = this.ensureTransaction(generationOf(payload), state.kind, at);
    if (!accumulator) return;
    accumulator.lastActivityAt = finiteNumber(payload.lastActivityAt) ?? at;
  }

  handleStructuralFinish(payload, at) {
    const state = structuralStateOf(payload);
    const generation = finiteNumber(payload.generation) ?? generationOf(payload);
    const accumulator = this.ensureTransaction(generation, payload.kind ?? state.kind, at);
    if (!accumulator || accumulator.status === "superseded") return;
    const startedAt = finiteNumber(payload.transactionStartedAt);
    const finishedAt = finiteNumber(payload.finishedAt) ?? at;
    if (startedAt !== null) accumulator.firstObservedAt = startedAt;
    for (const id of contextBlockIdsForPayload(payload)) {
      if (accumulator.contextBlockIds.size < MAX_IDS) accumulator.contextBlockIds.add(id);
    }
    accumulator.finishedAt = finishedAt;
    accumulator.stable = typeof payload.stable === "boolean" ? payload.stable : null;
    accumulator.lastActivityAt = finiteNumber(payload.lastActivityAt) ?? accumulator.lastActivityAt ?? finishedAt;
    accumulator.quietMs = accumulator.lastActivityAt === null
      ? null
      : Math.max(0, finishedAt - accumulator.lastActivityAt);
    accumulator.elapsedMs = accumulator.firstObservedAt === null
      ? null
      : Math.max(0, finishedAt - accumulator.firstObservedAt);
    accumulator.settleFrames = finiteNumber(payload.settleFrames);
    accumulator.status = "completed";
    accumulator.observationFinalizationAt = null;
    accumulator.pendingFinalizationAt = finishedAt + this.lateWindowMs;
    this.markBackspaceStructural(generation, []);
    this.markImeStructural(generation);
  }

  handleMutation(payload, at) {
    const state = structuralStateOf(payload);
    const generation = generationOf(payload);
    const lateContext = this.findLateContextAccumulator(payload, at);
    if (
      lateContext
      && generation !== lateContext.generation
      && payload.semanticClassification === "structural"
    ) {
      this.updateAccumulatorFromMutation(lateContext, payload, at, state);
      return;
    }
    const hasStructuralContext = generation !== null && (
      state.phase !== "idle" || payload.semanticClassification === "structural"
    );
    const accumulator = hasStructuralContext
      ? this.ensureTransaction(generation, state.kind, at)
      : null;
    if (accumulator) this.updateAccumulatorFromMutation(accumulator, payload, at, state);
    else if (payload.semanticClassification === "representation") {
      this.markBackspaceRepresentation();
      this.markImeRepresentation();
    } else if (payload.semanticClassification === "structural") {
      const observation = this.ensureTransaction(generation, state.kind, at);
      if (observation) this.updateAccumulatorFromMutation(observation, payload, at, state);
    }
  }

  handleSelectionChange(payload, at) {
    const state = structuralStateOf(payload);
    if (state.phase === "idle") return;
    const accumulator = this.ensureTransaction(generationOf(payload), state.kind, at);
    if (!accumulator) return;
    accumulator.selectionChanges += 1;
    accumulator.lastActivityAt = at;
  }

  handleKeydown(payload, at) {
    if (payload.key !== "Backspace") return;
    if (this.pendingBackspace) this.finalizeBackspace();
    const state = structuralStateOf(payload);
    this.pendingBackspace = {
      keydownAt: at,
      inputAt: null,
      lastAt: at,
      inputSeen: false,
      representationMutation: false,
      structuralGenerations: new Set(),
      structuralMutationCount: 0,
      blockId: typeof payload.currentBlockId === "string" ? payload.currentBlockId : null,
      generationAtKeydown: state.generation,
    };
  }

  handleInput(payload, at) {
    if (payload.inputType !== "deleteContentBackward") return;
    const state = structuralStateOf(payload);
    if (!this.pendingBackspace) {
      this.pendingBackspace = {
        keydownAt: at,
        inputAt: at,
        lastAt: at,
        inputSeen: true,
        representationMutation: false,
        structuralGenerations: new Set(),
        structuralMutationCount: 0,
        blockId: typeof payload.currentBlockId === "string" ? payload.currentBlockId : null,
        generationAtKeydown: state.generation,
      };
    } else {
      this.pendingBackspace.inputAt = at;
      this.pendingBackspace.lastAt = at;
      this.pendingBackspace.inputSeen = true;
      if (!this.pendingBackspace.blockId && typeof payload.currentBlockId === "string") {
        this.pendingBackspace.blockId = payload.currentBlockId;
      }
    }
    if (state.generation > 0 && state.phase !== "idle") {
      this.pendingBackspace.structuralGenerations.add(state.generation);
    }
  }

  handleCompositionStart(payload, at) {
    if (this.ime) this.finalizeIme();
    this.ime = {
      startedAt: at,
      endedAt: null,
      lastAt: at,
      structuralGenerations: new Set(),
      semanticStructuralMutations: 0,
      representationMutations: 0,
      blockId: typeof payload.currentBlockId === "string" ? payload.currentBlockId : null,
    };
  }

  handleCompositionEnd(payload, at) {
    if (!this.ime) {
      this.ime = {
        startedAt: at,
        endedAt: at,
        lastAt: at,
        structuralGenerations: new Set(),
        semanticStructuralMutations: 0,
        representationMutations: 0,
        blockId: typeof payload.currentBlockId === "string" ? payload.currentBlockId : null,
      };
    }
    this.ime.endedAt = at;
    this.ime.lastAt = at;
    this.finalizeIme();
  }

  markBackspaceRepresentation() {
    if (this.pendingBackspace) {
      this.pendingBackspace.representationMutation = true;
      this.pendingBackspace.lastAt = this.lastObservedAt ?? this.pendingBackspace.lastAt;
    }
  }

  markBackspaceStructural(generation, blockIds) {
    if (!this.pendingBackspace || generation === null) return;
    this.pendingBackspace.structuralGenerations.add(generation);
    this.pendingBackspace.structuralMutationCount += 1;
    this.pendingBackspace.lastAt = this.lastObservedAt ?? this.pendingBackspace.lastAt;
    if (!this.pendingBackspace.blockId) this.pendingBackspace.blockId = blockIds[0] ?? null;
  }

  markImeRepresentation() {
    if (this.ime) {
      this.ime.representationMutations += 1;
      this.ime.lastAt = this.lastObservedAt ?? this.ime.lastAt;
    }
  }

  markImeStructural(generation) {
    if (!this.ime || generation === null) return;
    this.ime.structuralGenerations.add(generation);
    this.ime.semanticStructuralMutations += 1;
    this.ime.lastAt = this.lastObservedAt ?? this.ime.lastAt;
  }

  finalizeBackspace() {
    const operation = this.pendingBackspace;
    if (!operation) return;
    this.pendingBackspace = null;
    if (!operation.inputSeen) return;
    const anomalies = [];
    const structural = operation.structuralGenerations.size > 0;
    if (structural) anomalies.push("CHAR_BACKSPACE_STRUCTURAL_FALSE_POSITIVE");
    const anomalyDetails = structural
      ? [{
        code: "CHAR_BACKSPACE_STRUCTURAL_FALSE_POSITIVE",
        at: operation.inputAt ?? operation.lastAt,
        blockIds: operation.blockId ? [operation.blockId] : [],
      }]
      : [];
    this.queueFinalized({
      sessionId: this.sessionId,
      operation: "character-backspace",
      structural,
      expectedStructural: false,
      semanticMutation: operation.representationMutation ? "representation" : "none",
      keydownAt: operation.keydownAt,
      inputAt: operation.inputAt,
      blockId: operation.blockId,
      structuralGenerations: [...operation.structuralGenerations],
      anomalies,
      anomalyDetails,
      forensicRecommended: anomalies.length > 0,
    });
  }

  finalizeIme() {
    const operation = this.ime;
    if (!operation) return;
    this.ime = null;
    this.queueFinalized({
      sessionId: this.sessionId,
      operation: "ime",
      structural: operation.structuralGenerations.size > 0,
      startedAt: operation.startedAt,
      endedAt: operation.endedAt ?? operation.lastAt,
      structuralTransactions: operation.structuralGenerations.size,
      semanticStructuralMutations: operation.semanticStructuralMutations,
      representationMutations: operation.representationMutations,
      blockId: operation.blockId,
      anomalies: [],
      anomalyDetails: [],
      forensicRecommended: false,
    });
  }

  finalizeTransaction(accumulator, status = accumulator.status, at = null) {
    if (accumulator.emitted) return;
    accumulator.emitted = true;
    accumulator.pendingFinalizationAt = null;
    accumulator.observationFinalizationAt = null;
    accumulator.status = status;
    const finishedAt = accumulator.finishedAt ?? at;
    const record = {
      sessionId: this.sessionId,
      operation: "structural",
      generation: accumulator.generation,
      kind: accumulator.kind ?? "unknown",
      status,
      firstObservedAt: accumulator.firstObservedAt,
      finishedAt,
      mutationBatches: accumulator.mutationBatches,
      childListRecords: accumulator.childListRecords,
      selectionChanges: accumulator.selectionChanges,
      structuralMutationCount: accumulator.structuralMutationCount,
      representationMutationCount: accumulator.representationMutationCount,
      addedBlockIds: [...accumulator.addedBlockIds],
      removedBlockIds: [...accumulator.removedBlockIds],
      parentChanges: accumulator.parentChanges,
      stable: accumulator.stable,
      lastActivityAt: accumulator.lastActivityAt,
      quietMs: accumulator.quietMs,
      elapsedMs: accumulator.elapsedMs,
      settleFrames: accumulator.settleFrames,
      anomalies: [...accumulator.anomalies],
      anomalyDetails: accumulator.anomalyDetails.map((detail) => ({
        code: detail.code,
        at: detail.at,
        blockIds: [...detail.blockIds],
      })),
      forensicRecommended: accumulator.anomalies.length > 0,
    };
    this.queueFinalized(record);
  }

  queueFinalized(record) {
    this.finalized.push(record);
    this.allFinalized.push(record);
  }
}

export function createDebugSummary(sessionId = "unknown", options = {}) {
  return new DebugSummarySession(sessionId, options);
}

export function summarizeEnvelopes(envelopes, options = {}) {
  const sessionId = options.sessionId
    ?? envelopes?.find?.((envelope) => typeof envelope?.sessionId === "string")?.sessionId
    ?? "unknown";
  const session = new DebugSummarySession(sessionId, options);
  const records = [];
  for (const envelope of envelopes ?? []) records.push(...session.accept(envelope));
  records.push(...session.flush());
  return { records, report: session.getReport(), session };
}

export const createSummarySession = createDebugSummary;
export const createDebugSummarySession = createDebugSummary;
export const summarizeDebugEnvelopes = summarizeEnvelopes;
