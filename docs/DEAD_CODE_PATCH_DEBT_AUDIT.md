# Dead Code / Patch Debt / SiYuan Host Quirk Archaeology Audit

> Status: audit-only. No runtime source was changed, deleted, or refactored.
>
> Audit date: 2026-09-13
>
> Repository: Han-Orz/zenType

## Baseline and scope

| Field | Exact value |
| --- | --- |
| Branch | refactor/v2.9.0-remake.2.8-layout-continuity |
| HEAD | 9ef28ffafc0eab72ab46086af4652e810cb7c6e9 |
| Parent | a3877befa97a49b445493bad277d9871a53adb59 |
| Tree | 649776432a5e7650670bc1774fb67bd98d95b20b |
| HEAD subject | docs: record the remake.2.8 layout continuity milestone |
| Remote reference | origin/refactor/v2.9.0-remake.2.8-layout-continuity at the same 9ef28ff... |
| v2.8.1 reference | 6c3ac0442c6b97292151c71732ae1100c1846533 (v2.8.1) |
| Worktree at audit start | Clean; git status --short --branch showed only the branch/upstream line |

git fetch --all --prune completed before the audit. The remote had no update to investigate, so the exact HEAD above is the audit baseline.

The requested scope was read-only archaeology. The only permitted repository change was this report document. No runtime file, test implementation, build script, package metadata, motion parameter, or architecture seam was changed during the audit.

### Method and evidence standard

The audit combined:

- current import/call/reference scans over src, tests, scripts, and documentation;
- git log --all -- <path>, git log -S, git log -G, git blame, and targeted git show;
- the current design and Host contract ledgers;
- test names and assertions, including the marker/Ripple and structural handoff regressions;
- comparison with the v2.8.1 tree and its historical runtime/test/debug files;
- the required typecheck, test, build, production-strip, and diff checks.

Evidence labels follow docs/SIYUAN_HOST_CONTRACT.md:12-18:

- Source-proven: the current or SiYuan source contains the relevant path.
- Runtime-observed: a recorded real SiYuan/CDP observation, scoped to the recorded renderer/version.
- Inferred: strongly supported by source, but not a direct browser timeline.
- Not verified: static source and deterministic fixtures do not answer the question.

The classification count is by independently reviewable audit row, not by file. A file may appear in a C row and a D row because a specific guard can be both an active module responsibility and a Host regression seam. Historical code already absent from HEAD is listed separately and is not counted as current dead code.

| Class | Meaning | Count |
| --- | --- | ---: |
| A | Provably Dead | 10 |
| B | Obsolete Patch Debt | 5 |
| C | Host Quirk / Regression Guard | 16 |
| D | Active Architecture | 11 |
| E | Suspicious / Needs Real-Machine Evidence | 5 |

The practical conclusion is narrow: there are 10 small A rows, of which only two are runtime locations. No current critical runtime path met the four-part proof required for B. The complex code that looks most removable is concentrated in C and D, especially blockPainter.ts, session.ts, structure.ts, structurePresentation.ts, and layoutContinuity.ts.

## 1. Executive Summary

### Findings

1. The safe dead-code set is small and mechanical. Strict TypeScript with noUnusedLocals/noUnusedParameters reports one unused DebugKit factory, two unused locals in a geometry branch, and eight unused test callback parameters. The normal project typechecks intentionally do not enable those strict diagnostics, so this is an audit finding rather than an existing build failure.
2. No complex current runtime block is proven dead. The current call graph, tests, blame, and fix history show active consumers for parents, presented, snapshot, rebind, protectFocus, focusBranchBoundary, the paused carrier, StructureGate generations, selection handoff, replacement-role invalidation, and layout-flow state.
3. The highest-risk “dead-looking” code is recent Host knowledge. The latest 292122c fix specifically stops stale ancestor alpha at a focused NodeListItem; e70b955, 8668a73, f456068, 6ea30f1, and b8772dc form a consecutive repair chain for ancestor ownership and dim → 1 → dim flashes. Removing a layer because it is visually complicated would reopen a documented regression.
4. Patch debt is currently more documentary than runtime. The current README labels and docs/DESIGN.md title lag the .2.8-layout-continuity.1 build label. docs/TODO.md, NESTED_RIPPLE_PROJECT_BRIEF.md, and SIYUAN_DOM_EVIDENCE.md contain older present-tense assumptions and references to removed bridge/no-op files. They should be corrected or explicitly archived, not silently deleted.
5. The Remake did reduce authority count and cognitive load. v2.8.1 had 58 TypeScript source files and 13,216 TypeScript lines; the current tree has 27 TypeScript source files and 4,749 TypeScript lines. Current tests execute 132 cases through three entries, versus 196 cases through 15 v2.8.1 entries. The reduction is architectural, not just cosmetic: one Session rAF and bounded wake now coordinate feature work.
6. The remaining uncertainty is real-host timing, not an unobserved static branch. Host contract gaps remain for exact MutationObserver/Selection/rAF ordering, marker subtype conversion, immediate post-commit host scrolling, CJK/cross-block IME, and range/editor-switch ownership.

### Direct answers for cleanup

| Question | Audit answer |
| --- | --- |
| Why does this code exist? | Either strict-dead residue (A), documented Host behavior/previous regression (C), or an active authority responsibility (D). The report ties each nontrivial answer to paths, commits, and tests. |
| Could deletion restore an old bug? | Yes for C/D rows. In particular, BlockPainter ancestry/rebind/protection and StructureGate timing are backed by named regression fixes. |
| Dead code or historical knowledge? | The 10 A rows are dead by current static evidence. Most “strange” runtime code is historical Host knowledge now expressed through the new owner/gate architecture. |
| What should be cleaned first? | Wave 1: only the 10 A rows. Run the full verification and inspect the diff for each small commit. |
| What must not move before release? | BlockPainter handoff/protection, Session/StructureGate critical paths, both structural presentation owners, and any threshold or motion-law code. |

## 2. Current Architecture Map

~~~text
SiYuan Host / browser
  └─ DOM, Selection, MutationRecords, caret/layout, scroll, editor lifecycle
       ↓ facts
StructureGate (src/structure.ts)
  └─ bounded intent, mutation classification, generations, geometry/semantic readiness
       ↓ authority
WritingSession (src/session.ts)
  └─ event routing, one business rAF, one monotonic timeline, lifecycle and frame ordering
       ├─ Cursor (src/modules/cursor.ts)
       ├─ Typewriter (src/modules/typewriter.ts)
       ├─ Ripple sentence (src/modules/ripple.ts, sentenceModel, textProjection)
       ├─ Ripple block (blockPlan.ts → blockPainter.ts)
       ├─ StructurePresentation (Tab / Shift+Tab)
       └─ LayoutContinuity (Enter / Delete / Backspace)
              ↓
       Critical Motion + Painter / Highlight / scroll commit
~~~

| Authority | Current responsibility | Archaeology result |
| --- | --- | --- |
| Host Truth | EditorFrame, active editor, Selection/Range, caret geometry, scroll, semantic keys, delivered mutations | The DOM element is a per-sample handle; data-node-id and visualKey() carry semantic continuity. See docs/DESIGN.md:7-18 and docs/SIYUAN_HOST_CONTRACT.md:134-149. |
| StructureGate | src/structure.ts:5-41,55-100,127-335 | Active authority. generation, trusted origin, input matching, bounded classification, 48ms quiet, 160ms deadline, and overflow are all consumed. |
| WritingSession | src/session.ts:20-40,294-563,566-789 | Sole business scheduler/timeline. It samples performance.now() once per frame, sequences read/authority/write, and pairs lifecycle cleanup. |
| Cursor | src/modules/cursor.ts | Active geometry/alpha/selection/switch owner. It consumes geometry-ready but does not own structural readiness or a second scheduler. |
| Typewriter | src/modules/typewriter.ts:5-103 | Active comfort-band and virtual-scroll owner. It explicitly yields to unexpected Host scroll and composition. |
| Ripple sentence | src/modules/ripple.ts, sentenceModel.ts, textProjection.ts | Active sentence projection/highlight owner. It rebuilds on Host text-node invalidation without mutating正文 DOM or Selection. |
| Ripple block | src/modules/ripple/blockPlan.ts:8-107, blockPainter.ts:14-404 | Active semantic owner/painter. The carrier is an actuator; value, velocity, target and committed ancestry are the state. |
| StructurePresentation | src/modules/structurePresentation.ts:19-224 | Active single-item displacement owner for list reparent. Capture is before mutation; attach is inside mutation delivery; step is Session-owned. |
| LayoutContinuity | src/modules/layoutContinuity.ts:43-353 | Active, newly wired local flow owner for Enter/Delete/Backspace. It is intentionally separate from Tab/Shift+Tab. |
| Critical Motion | src/motion.ts:1-50 and consumers | Active common motion law. No feature should reintroduce a private rAF, timer, FLIP scheduler, or easing law. |
| Debug/build | src/debug/*, build.js, scripts/verify-prod.mjs | Active development infrastructure with compile-time production stripping; no observer/rAF/timer of its own. |

The design document states the same ownership boundary at docs/DESIGN.md:19-68,97-109,121-145,147-161. The current architecture is therefore not an accidental collection of helpers: each large module is attached to a distinct authority or presentation seam.

## 3. Dead Code Inventory

### A — Provably Dead

These are the only current rows that satisfy the strict static bar: no read in the current in-repo graph, no registration/dynamic entry found, and no semantic behavior encoded by the unused binding itself. A future cleanup commit should still run the standard checks.

| ID | Current location | Evidence | Safe action |
| --- | --- | --- | --- |
| A1 | src/debug/index.ts:73-84, emptySession() | Strict compiler reports TS6133; current reference scan finds only the declaration. git blame attributes the whole function to c014b983 (feat: add DebugKit and stabilize remake effects), but initDebugHook() uses state() at :125-130 instead. | Delete the unused private function. No runtime state or public API changes. |
| A2 | src/session.ts:371-372, const writing and const composing inside decision === geometry | Strict compiler reports both locals as unused. They were introduced by 12bed086 (fix: decouple structural cursor geometry). The same concepts are legitimately read later at :502-508, so only these branch-local bindings are dead. | Delete these two declarations; preserve intent, acceptSelectionAuthority, Cursor rendering, and all timing. |
| A3 | tests/remake.test.ts:394, unused callback formal body | Strict test compiler reports TS6133; no body read in the callback and no test helper reflects callback arity. | Remove the formal name only. |
| A4 | tests/remake.test.ts:425, unused callback formal body | Same strict-compiler and local-body evidence. | Remove the formal name only. |
| A5 | tests/remake.test.ts:450, unused callback formal body | Same strict-compiler and local-body evidence. | Remove the formal name only. |
| A6 | tests/remake.test.ts:471, unused callback formal body | Same strict-compiler and local-body evidence. | Remove the formal name only. |
| A7 | tests/remake.test.ts:1059, unused callback formal body | Same strict-compiler and local-body evidence. | Remove the formal name only. |
| A8 | tests/remake.test.ts:1080, unused callback formal body | Same strict-compiler and local-body evidence. | Remove the formal name only. |
| A9 | tests/remake.test.ts:1117, unused callback formal body | Same strict-compiler and local-body evidence. | Remove the formal name only. |
| A10 | tests/remake.test.ts:1158, unused callback formal body | Same strict-compiler and local-body evidence. | Remove the formal name only. |

The strict checks used for this table were:

~~~text
node node_modules/typescript/bin/tsc --noEmit --noUnusedLocals --noUnusedParameters
node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit --noUnusedLocals --noUnusedParameters
~~~

The first reports A1/A2. The second reports A1/A2 plus A3–A10. The project’s normal typecheck and typecheck:tests still pass because these flags are not enabled in the release configuration.

### Historical code already removed — not current candidates

| Historical path/idea | Evidence | Audit treatment |
| --- | --- | --- |
| src/modules/ripple/structuralMove.ts focused-only prototype | Added in 329a0cd (feat: animate list structural continuity), then deleted in e4759c4 (revert: remove the focused-only list structural transform prototype). | Do not restore. Current structurePresentation.ts is the evidence-derived replacement. |
| Local Presentation Bridge / handoffFocused() / identityHandoffGeneration | 0354536 explicitly rejects the prototype. docs/DESIGN.md:149-151 records duplicate-text, zero-box, and typography reasons. | Do not restore as cleanup or compatibility code. |
| Runtime identityReady / identityPublished | The intermediate identity path was removed by the 9c020ad/0354536 line of work. Current StructuralHandoff has geometryReady and semanticReady only (src/structure.ts:11-18). | The runtime removal is complete. Remaining wording is B, not an invitation to re-add a readiness state. |
| Earlier inline-opacity/carryover registry and original repair path | Historical transition in 2156bee, d019a6d, and 5c8db10; current design explicitly rejects persistent identity registries and inline opacity repair (docs/DESIGN.md:153-167). | Treat as deleted historical mechanism; preserve the semantic requirement through BlockPainter instead. |

### D — Active Architecture

These are not cleanup targets. They are the current responsibility seams that make the Remake understandable and prevent authority duplication.

| ID | Active area | Evidence and reason to keep |
| --- | --- | --- |
| D1 | Host Truth | docs/DESIGN.md:7-18; Host owns DOM, Selection, caret/layout, scroll, semantic keys, and delivered mutations. |
| D2 | StructureGate | src/structure.ts:127-335; owns bounded structural admission, generations, readiness, quiet/deadline, and overflow. |
| D3 | WritingSession | src/session.ts:294-563; owns one business rAF, one monotonic timeline, frame ordering, and lifecycle cancellation. |
| D4 | Cursor | src/modules/cursor.ts; owns caret geometry, alpha, native-caret suppression, selection and editor-switch settling. |
| D5 | Typewriter | src/modules/typewriter.ts:5-103; owns comfort-band scrolling, virtual position, host takeover, and composition suppression. |
| D6 | Ripple sentence | src/modules/ripple.ts, sentenceModel.ts, textProjection.ts; owns bounded sentence projection and CSS Highlight continuity. |
| D7 | Ripple block | src/modules/ripple/blockPlan.ts and blockPainter.ts; owns semantic block targets, presented alpha, carrier state, and handoff. |
| D8 | StructurePresentation | src/modules/structurePresentation.ts:19-224; owns one Tab/Shift+Tab list-item displacement without a second scheduler. |
| D9 | LayoutContinuity | src/modules/layoutContinuity.ts:43-353; owns local Enter/Delete/Backspace flow continuity and is intentionally not a Tab owner. |
| D10 | Critical Motion | src/motion.ts:1-50; provides the shared analytic motion law used by all moving features. |
| D11 | Debug/build infrastructure | src/debug/*, build.js, scripts/verify-prod.mjs; development observability and production stripping are active release safeguards. |

## 4. Patch Debt Inventory

### B — Obsolete Patch Debt

For runtime code, B requires all four facts: the original problem, the repairing commit, the current authority that replaces it, and a concrete reason deletion will not restore the bug. No current critical runtime branch met all four facts as a deletion candidate. The following B rows are documentation/comment debt; they do not authorize runtime deletion.

| ID | Debt | Original problem / history | Current replacement and no-regression argument | Proposed treatment |
| --- | --- | --- | --- | --- |
| B1 | Identity-ready terminology drift | identityReady was a real intermediate experiment, then removed because it published an unconsumed fact and drove the rejected destination-release path (9c020ad, 0354536; changelog history at docs/CHANGELOG.md:108-123). | docs/DESIGN.md:29 correctly says it was removed, but :37 and src/session.ts:358-360 still use “Identity-ready/identity readiness”. Current replacement-role authority is derived at mutation time and only geometryReady/semanticReady remain. Removing the wording changes no branch. | Correct comments/document wording in Wave 2 after Wave 1 and smoke testing. |
| B2 | Release/build labels drift | README.md:1,34, README_zh-CN.md:1,36, and docs/DESIGN.md:1 still name older .2.5-structural.2 / .2.6-delete.1 rounds. src/config.ts:1 and docs/CHANGELOG.md:3-30 identify the current .2.8-layout-continuity.1 milestone. | This is a release-facing documentation mismatch, not a runtime workaround. Updating labels cannot restore a Host bug, but should be reviewed against the intended release label. | Documentation-only correction before release; do not mix with runtime cleanup. |
| B3 | docs/TODO.md present-tense v2.6.6 status | The file’s current section still describes v2.6.6 publication work and unresolved Bazaar tasks (docs/TODO.md:1-19), while the changelog has later Remake milestones and current architecture. | The listed v2.6.x historical issues have corresponding changelog/history records; no current runtime reads this file. | Split/mark historical TODOs or rewrite the current section. Preserve old bug rationale. |
| B4 | NESTED_RIPPLE_PROJECT_BRIEF.md describes a pre-Remake current implementation | It says the source is back at v2.6.6 and refers to RIPPLE_CONFIG, inline opacity/class ownership, an unimplemented debugHook.noop.ts, and an absent bridge (:3-5,84-124,285-294). | The brief contains the semantic requirements that the current blockPlan/blockPainter now implement, so deleting it would discard design history. Its stale “current” claims no longer describe the source. | Mark as historical planning input or replace the current-state section; retain the requirements and test matrix. |
| B5 | SIYUAN_DOM_EVIDENCE.md points at excluded raw logs and removed bridge | It describes .debug raw files and scripts/debug-bridge.mjs (:3-15) that are not current tracked runtime/script files. | The evidence itself is useful and scoped as non-permanent API evidence; current Host facts are consolidated in docs/SIYUAN_HOST_CONTRACT.md. Deleting the document would lose provenance, while leaving stale paths confuses new archaeology. | Update provenance/path wording or archive alongside the Host contract; do not delete raw logs or invent a replacement bridge. |

### Patch-debt conclusions

- structurePresentation.ts:137-149 is not B on present evidence. Its bounded structural-presentation-repeat-evidence branch is dev-only, has no presentation effect, and may be useful to distinguish a rebase from a missing capture. It remains E1 until a debug-use audit or real trace proves otherwise.
- src/debug/index.ts:342-344 reconnect() is not A. It always returns Promise.resolve(false) and has no in-repo caller, but it is exposed on the global __zentypeDebug controller and the DebugHookController type (src/debug/types.ts:83-105). It may be an external developer-facing compatibility surface. This is E2, not a free deletion.
- DebugKitController as an alias at src/debug/types.ts:102 and the re-export at src/modules/debugHook.ts:4-17 have no internal runtime need beyond the facade, but the public type/global surface is not bounded by repository references. Keep until external consumer intent is known.

### E — Suspicious / Needs Real-Machine Evidence

These rows are intentionally unresolved. They are not deletion recommendations; each needs evidence outside the deterministic source/test graph.

| ID | Suspicious area | Why it looks removable or uncertain | Missing evidence | Interim decision |
| --- | --- | --- | --- | --- |
| E1 | structurePresentation.ts:137-149 repeat-evidence branch | It performs only a dev-only rect read when no capture exists and has no presentation effect. | A real DebugKit trace showing whether the event distinguishes rebase/missing-capture cases, or a maintainer decision that the telemetry is no longer used. | Keep for now; do not classify A/B. |
| E2 | src/debug/index.ts:342-344 reconnect() and DebugKitController facade | reconnect() always resolves false and has no in-repo caller, but the controller is exposed globally for developer tooling. | Search/confirmation of external developer consumers and compatibility expectations. | Keep; review only with an explicit debug API decision. |
| E3 | tests/ripple-marker.browser.ts | It is a browser fixture and is typechecked but absent from tests/run.mjs, so static execution coverage is unclear. | A real browser/CDP lane or a documented manual invocation and its expected artifact. | Keep as a fixture; do not delete as dead test code. |
| E4 | LayoutContinuity/merge/IME host acceptance | Unit tests prove the contract model, but exact Host paint/order/scroll/IME behavior is still on docs/SIYUAN_HOST_CONTRACT.md:199-207. | Real SiYuan 3.8.3 timeline and painted-frame checks for Enter/Delete/Backspace, CJK IME, range selection, and editor switching. | Keep all current guards; add evidence before refactoring. |
| E5 | Removed DebugKit summary/bridge/performance surface | Current export/recorder is smaller than v2.8.1 and has no equivalent offline bridge or full FLIP sampler. | External consumer inventory and a decision whether current debug bundles need a summary/replay tool. | Treat as potential diagnostic knowledge loss, not runtime dead code. |

## 5. SiYuan Host Quirk Ledger

The table below is the required “why does this strange code exist?” ledger. A “No” in the final column means “do not remove before release”; “Not yet” means the behavior is real or plausible but the exact supported-host coverage still needs a machine timeline.

| Area | Current code | Host quirk / historical bug | Evidence commit | Regression test / evidence | Remove? |
| --- | --- | --- | --- | --- | --- |
| Marker ownership | src/structure.ts:43-48 maps ordinary blocks to data-node-id; visualKey() maps .protyle-action to parent key plus :action; blockPlan.ts:8-41 collects marker/direct-content targets. | Marker element identity is unstable. SiYuan may mutate marker attributes/text/HTML in place or replace marker markup during list/subtype work. A marker must remain a visual owner without becoming a semantic block. | d6af17e, a3877be, f057761 | docs/SIYUAN_HOST_CONTRACT.md:51-58; tests/remake.test.ts:3016-3049; tests/rippleStructuralFocus.test.ts:71-125 | No — C |
| .protyle-action specifically | Same visualKey path; blockPainter.ts:14-40 retains the key on the owner, not the DOM object. | Focused marker/content must share the item’s neutral boundary while a parent’s own marker may retain the parent’s dim. A marker replacement can otherwise flicker or inherit the wrong ancestor factor. | 292122c, b8772dc | tests/rippleStructuralFocus.test.ts:71-125; tests/remake.test.ts:3016-3049,3294-3503 | No — C |
| NodeListItem reparent | src/session.ts:154-188; blockPainter.ts:219-283; structurePresentation.ts:108-193 | Tab/Shift+Tab moves a live item between lists, can create/remove a wrapper, and can deliver an intermediate topology. This is a move/reparent path, not automatically a same-key replacement. | d6af17e, 329a0cd, c13ad7a, 292122c | Runtime-observed in docs/SIYUAN_HOST_CONTRACT.md:28-43; tests/remake.test.ts:1780-1861,2942-3049; tests/rippleStructuralFocus.test.ts:71-125 | No — C/D |
| Same-key DOM replacement | src/session.ts:163-180; blockPainter.ts:163-216,285-400; ripple.ts:193-215,295-302 | SiYuan re-renders a fresh element with the same data-node-id. The semantic key proves object continuity, not presentation-role continuity. A focused replacement must not inherit a neighbour’s dim role. | 2156bee, d019a6d, 9c020ad, 13ef96e, 46bbd25 | docs/SIYUAN_HOST_CONTRACT.md:22,77-103,134-141; tests/remake.test.ts:1552-1650,1740-1778,1892-2043,2690-2728 | No — C |
| Ancestor opacity multiplication | blockPainter.ts:79-88,219-283; blockPlan.ts:46-107 stores committed parents, computes presented(), snapshots composite alpha, and repartitions released factors. | A live post-reparent ancestor chain is not the presentation the user saw. The old plan produced 0.2 → 1 focused marker/paragraph flashes and could multiply independent dim factors (0.475 × 0.475). | e70b955, 8668a73, f456068, 6ea30f1, b8772dc, 292122c | Runtime-observed docs/SIYUAN_HOST_CONTRACT.md:30-33; docs/TERMINAL_FLASH_INVESTIGATION.md:11-21; tests/remake.test.ts:2902-3049,3294-3503 | No — C |
| MutationObserver order | src/structure.ts:251-285; session.ts:154-203 rebinds only same-key owners in the callback and defers topology planning to Session/commit. | A mutation batch proves delivery, not that a later Host task, Selection restoration, or transaction continuation has completed. SiYuan schedules post-input normalization with setTimeout(0). | b3a0c05, 73cdbe0, e509305 | docs/SIYUAN_HOST_CONTRACT.md:121-149; tests/remake.test.ts:1427-1450,2400-2456,2690-2728 | No — C |
| beforeinput + keydown duplication | src/structure.ts:168-195 matches same-editor intent and input kind into one generation; session.ts:603-615,632-640 routes both event families. | SiYuan may prevent/default or deliver both signals around one operation. Key name alone is not structural evidence; duplicate intent must not create competing generations. | 73cdbe0, a6bb099, 4c0a5b8 | tests/remake.test.ts:198-207; generation and repeated-input tests at :2344-2408 | No — C |
| Structural generation races | src/structure.ts:127-335 supersedes stale generations, carries trusted fromBlockKey, matches mutation evidence, and bounds stable geometry/quiet. | Repeated Enter/Backspace/Delete or delayed Host work can make an earlier deadline and a later topology coexist. A stale generation must not publish geometry or semantic ownership. | b3a0c05, 73cdbe0, c7e4d7a | tests/remake.test.ts:1284-1397,2344-2498; tests/layoutContinuity.test.ts:70-146 | No — C/D |
| Selection restoration | src/session.ts:84-94,710-734; captureCollapsedSelection() is used only with structural evidence and editor match; range entry cancels pending authority. | SiYuan uses wbr, focusByRange, focusByWbr, and later restoreFocusContext; a MutationObserver delivery does not certify that the final Range has landed. Multiple editors make “first editor” lookup unsafe. | 020ed64, a6bb099, 4c0a5b8 | docs/SIYUAN_HOST_CONTRACT.md:77-103,143-149; tests/remake.test.ts:3534-3564,1740-1778 | No — C |
| IME / composition | src/session.ts:617-618,662-680; src/modules/typewriter.ts:23-39; editor scope tracks composition ownership. | compositionend can launch async Host input/normalization, including cross-block completion. Plugin structural authority and comfort scroll must cancel/hold without claiming a completion frame. | 252c5a1, 73cdbe0, 2ff5594 | docs/SIYUAN_HOST_CONTRACT.md:157-161; tests/remake.test.ts:1863-1890 | Not yet — C/E |
| Host transform ownership | src/modules/structurePresentation.ts:60-105; src/modules/layoutContinuity.ts:73-109 refuse when Host/theme owns inline/computed transform. | Host transform may be none for the audited list path, but that is not a global promise. Overwriting another owner would corrupt layout or restoration. | e859352, 8bb378e, c13ad7a | docs/SIYUAN_HOST_CONTRACT.md:35-41; tests/remake.test.ts:57-132; layout suite | No — C |
| Caret under transform / scroll | src/session.ts:320-345,502-517 subtracts active presentation offset and treats actual post-write scrollTop as authoritative; Typewriter checks Host takeover. | Range.getBoundingClientRect() includes ancestor transform. SiYuan has its own caret-scroll paths and later scroll restoration. Mixing transformed geometry or counter-writing Host scroll causes trails/jumps. | e509305, 12bed08, d019a6d | docs/SIYUAN_HOST_CONTRACT.md:35-37,151-155; tests/remake.test.ts:401-471,3172-3197 | No — C |
| Editor replacement/switch | src/session.ts:461-472,750-789; cursor.switched() and paired cancellation/cleanup; src/index.ts:60-64 EventBus routing. | Multiple .protyle roots, hidden fn__none editors, destroy/re-enable, and late lifecycle promises make element identity and delayed work stale. | a2937f4, ec68223, d019a6d | docs/SIYUAN_HOST_CONTRACT.md:163-183,199-207; tests/remake.test.ts:1208-1227,2552-2764 | No — C/D; machine evidence still needed |
| Temporary invalid topology | src/session.ts:163-188,387-427; callback rebind/carry is narrowly bounded, while StructureGate withholds new targets and layout/presentation captures are abandoned on nonmatching outcomes. | During list outdent or merge, the captured subject can be detached and the replacement absent for one delivery. Planning a topology from that intermediate DOM can paint a jump or duplicate text. | e4759c4, 0354536, 9c020ad, 292122c | docs/SIYUAN_HOST_CONTRACT.md:39-43,77-103; tests/remake.test.ts:75-132,1740-1861,1999-2043 | No — C |
| List indent/outdent | structurePresentation.ts owns exactly one NodeListItem displacement; layoutContinuity.ts:46-57 explicitly excludes Tab/Shift+Tab. | Tab uses reparent/move and may create a list wrapper; Shift+Tab can replace the focused li and leave no substitute at delivery. A former multi-sibling/FLIP model was rejected. | 329a0cd, e4759c4, c13ad7a, e859352 | docs/SIYUAN_HOST_CONTRACT.md:28-60; tests/remake.test.ts:57-132,1780-1861,2942-3049; tests/layoutContinuity.test.ts:132-146 | No — C/D/E |
| Enter / Delete / Backspace merge/split | layoutContinuity.ts:182-317; session.ts:632-657; structure.ts:109-124 shares hasSafeOrdinaryTextPosition() for ordinary-delete fast path. | Host has different paragraph split, block-start merge, empty-block, list, special-block, and ordinary text paths. The key is not enough to decide topology; the flow engine must stay local and bounded. | e5fc3ac, c7e4d7a, 4daa4db, 54b95e4 | docs/SIYUAN_HOST_CONTRACT.md:62-119; tests/remake.test.ts:2146-2327,3601-3748; tests/layoutContinuity.test.ts:70-146 | No — D/E |

### Host ledger conclusions

- Marker flicker is confirmed historical knowledge, not a dead branch. The marker key and focus boundary are explicitly tested.
- Ancestor dim → 1 → dim is confirmed historical knowledge. The current protection is a same-delivery presentation re-expression, not decorative complexity.
- Same-key replacement is two separate requirements: semantic continuity for ordinary replacement and presentation-role invalidation for a focused structural replacement. Collapsing them reopens the merge regression.
- Mutation delivery is not visual commit. The only same-key owner rebind allowed in the callback is the documented bounded exception.
- The old workaround may be gone while its requirement remains. Inline opacity, the Local Presentation Bridge, and focused-only FLIP are gone; BlockPainter, StructureGate, and the single structural owner now express the surviving requirements.

## 6. Potential Lost Host Knowledge

The audit found no clear lost runtime semantic requirement in the requested old runtime mechanisms. The plausible losses are mainly diagnostic workflows and forensic detail. They should not be restored as runtime compatibility layers.

| Old mechanism at v2.8.1 | Underlying semantic requirement | Current replacement | Confidence | Potential loss / action |
| --- | --- | --- | --- | --- |
| src/modules/ripple/semanticPlanner.ts (187 lines) | Map list depth, marker/direct content, sibling distance and semantic targets. | src/modules/ripple/blockPlan.ts:8-41 collectTargets() plus current owner plan. | High | No apparent loss. Keep current plan; do not restore the old planner. |
| styleApplier.ts (425) + structuralCarryover.ts (105) | Preserve presented alpha across Host replacement/reparent without authoring persistent inline opacity or a global identity registry. | blockPainter.ts:14-42,79-88,163-216,285-400; planHandoff(); paused carrier; Session same-key rebind. | High | No apparent loss. This is the current C/D seam. |
| sentenceTransition.ts (888) | UTF-16 sentence boundaries, reusable boundary state, interruption and structural-merge sentence continuity. | sentenceModel.ts, textProjection.ts, ripple.ts:121-215; first structural frame and one-shot role seed. | Medium-high | No semantic gap found; exact Host merge ordering remains E. |
| typewriter/flip.ts (1,043) | Keep local flow content visually continuous after structural edits while respecting Host ownership and bounded layout reads. | structurePresentation.ts for Tab/Shift+Tab and layoutContinuity.ts for Enter/Delete/Backspace; both use Session’s frame. | Medium-high | Old broad FLIP surface is intentionally not restored. Real-host acceptance for the new flow engine remains pending. |
| typewriter/scroll.ts (391) | Comfort-band target, reverse retargeting, virtual position, Host-scroll takeover and composition suppression. | src/modules/typewriter.ts:23-103. | High | No apparent loss. The current implementation is smaller but retains the ownership rule. |
| src/modules/structuralEdit.ts (581) | Classify text/representation/structural changes, preserve old-parent evidence, and bound quiet/stable/deadline races. | src/structure.ts:5-335; shared Session authority. | High | No apparent loss. structure.ts is the current authority, not a historical leftover. |
| Old Cursor auxiliary modules (breathing, edgeArrow, popoverDrag, resizeBindings, scrollBindings, switchSettle) | Lifecycle, switch settling, scroll transport, breathing, clipping and auxiliary binding cleanup. | src/modules/cursor.ts; src/session.ts and src/index.ts lifecycle composition. | High | No apparent loss of required current behavior; old module boundaries are gone by design. |
| inputMode.ts (70) + inputModeTriggers.ts (68) | Distinguish typing/navigation/IME/structural provenance and cancel modes on browsing. | Session cursorTargetIntent, composition fields, StructureGate cancellation, and event routing (src/session.ts:60-75,619-680). | Medium-high | No obvious semantic gap. Keep test coverage around navigation/composition. |
| typewriter/targetResolver.ts (107) | Resolve the reliable editor/frame/caret scope without repeatedly asking each effect to parse Host truth. | readEditorFrame, EditorFrame, getCursorRect, editorScope, rangeTextPoint; Session reads once. | High | No apparent loss. This is an authority simplification. |
| Old DebugKit collector/transport/performance/summary/bridge | Record cross-event timing, DOM/geometry forensic state, performance samples, and offline analysis/replay. | src/debug/index.ts, serialize.ts, types.ts, download.ts, buildIdentity.ts; export bundle and build identity. | Medium | Diagnostic capability is reduced: no current debug-summary.mjs, debug-bridge.mjs, or standalone performance.ts. Consider a post-release analysis tool, not runtime code. |

### Specific Potential Lost Host Knowledge

1. Offline debug summary/bridge: v2.8.1 had scripts/debug-summary.mjs (913 lines) and scripts/debug-bridge.mjs (488 lines). They are absent from the current tree. Current DebugKit can export a bundle, but there is no repository-equivalent offline summary/replay/loopback bridge. This is a tooling gap, not proof that the current runtime lost a Host guard.
2. Detailed performance sampler: old src/debug/performance.ts was 102 lines. Current serializer counters (computedStyleReads, domNodesSerialized, mutation counts) are bounded observability, not a performance baseline; docs/DEBUGKIT.md:86-90 says so explicitly.
3. FLIP forensic detail: the new structural owners preserve the semantic requirements, but no current file appears to provide the old mechanism’s full geometry/probe vocabulary. This is diagnostic knowledge loss. Do not re-add FLIP behavior merely to regain telemetry.
4. Old debug schema/transport compatibility: current schemas are zentype-debug/v1 and zentype-debug-bundle/v1 (src/debug/types.ts:1-5). No old transport/schema compatibility layer was found. External consumers must be checked before deleting the facade/no-op API.

The historical 3376380/026315b migration therefore appears to have transferred runtime Host knowledge into the Remake rather than simply deleting it. The remaining “lost” items are evidence collection and analysis surfaces, and should be handled as a separate tooling decision.

## 7. Test Coverage Audit

### Current vs. v2.8.1 test shape

| Measure | Current Remake | v2.8.1 reference | Interpretation |
| --- | ---: | ---: | --- |
| Executed test entries | 3 (remake, layoutContinuity, rippleStructuralFocus) | 15 entries in tests/run.mjs | The current runner intentionally removed architecture-specific old entries. |
| Tracked test/support code files | 5 (.ts/.mjs, including runner/browser fixture) | 18 (.ts/.mjs, including runner/stub) | The old count includes tests/stubs/siyuan.ts; it is not 18 executable entries. |
| Automated tests | 132 = 127 + 4 + 1 | 196 | Reduction of 64 tests (32.7%). |
| Browser marker fixture | tests/ripple-marker.browser.ts is typechecked but not run by tests/run.mjs | No direct equivalence assumed | Real browser pixels remain an E boundary. |

### Contract and regression coverage

| Requirement | Current coverage | Audit judgment |
| --- | --- | --- |
| Marker flicker / marker ownership | tests/remake.test.ts:3016-3049; tests/rippleStructuralFocus.test.ts:71-125 | Good deterministic guard for semantic key and focused marker boundary; not full subtype/real-pixel coverage. |
| Stale ancestor dim and dim → 1 → dim | tests/remake.test.ts:1780-1816,3294-3503 | Strong regression coverage, including deep focus path, direct content, nested owners and one-time removal. |
| Focused marker boundary | tests/rippleStructuralFocus.test.ts:71-125; blockPainter.ts:89-102 | Directly locks the latest 292122c behavior. |
| Nested Ripple ownership | tests/remake.test.ts:2902-3049,3347-3503 | Covers presented alpha, marker/direct content, residual and nested covering owner behavior. |
| Same-key replacement | tests/remake.test.ts:1552-1650,1740-1778,1892-2043,2690-2728 | Covers ordinary carry, focused role invalidation, sentence floor and mutation-before-rAF rebind. |
| Tab / Shift+Tab | tests/remake.test.ts:57-132,1780-1861,2942-3049; tests/layoutContinuity.test.ts:132-146 | Deterministic ownership/transform guards are strong; exact Host ordering and all marker subtype variants remain E. |
| Enter split continuation | tests/layoutContinuity.test.ts:70-117; tests/remake.test.ts:3601-3649 | Current Session wiring has characterization coverage; real Host visual acceptance is explicitly pending in docs/CHANGELOG.md:28-30. |
| Ordinary Backspace/Delete fast path | src/structure.ts:109-124; tests/remake.test.ts:2146-2327,3655-3695 | Good boundary/ordinary/repeated-generation coverage; the fast path is shared rather than duplicated in LayoutContinuity. |
| Structural generation matching | tests/remake.test.ts:1284-1397,2344-2498; tests/layoutContinuity.test.ts:70-146 | Strong deterministic coverage for trusted origin, supersession, geometry and deadline/quiet behavior. |
| Selection/range/lifecycle | tests/remake.test.ts:2552-2764,3534-3564,3719-3748 | Current owner pairing is covered; full editor/split/popup real-host ownership remains E. |
| DebugKit | One integration path at tests/remake.test.ts:940-970 | DebugKit internals, download, serializer limits, build fingerprint, and production stripping are not directly covered by the unit runner; scripts/CI cover artifact behavior. |

### Test gaps that matter to cleanup

- tests/ripple-marker.browser.ts is a browser-oriented fixture but is not a test-runner entry. Do not call it dead; decide whether to wire it into a real-browser lane or document it as a manual fixture.
- No current test directly exercises src/debug/download.ts, the full serializer schema, buildIdentity.ts, or scripts/verify-prod.mjs; these are protected by typecheck, artifact inspection, and CI rather than unit assertions.
- No deterministic fixture can establish actual browser paint timing or SiYuan’s task/microtask/rAF order. The Host contract keeps those items at Not verified.
- The old test reduction is expected after 3376380/026315b, but it means a cleanup review must ask whether a removed old regression was semantically re-expressed, not merely whether its old file disappeared.

## 8. Debug / Build / Script Audit

### DebugKit

| Surface | Current evidence | Verdict |
| --- | --- | --- |
| Recorder ownership | src/debug/index.ts:86-92; src/debug/types.ts:65-75 | DebugKit consumes Session events/frames/mutations; it owns no observer, rAF, timer, or independent timeline. Keep. |
| Capacity bounds | src/debug/index.ts:17-20; src/debug/serialize.ts:7-17 | Timeline 4096, forensic 8192, recent 500; DOM 1200 nodes/12 depth; mutation 80; watches 8. These are safety bounds, not dead limits. |
| Development activation | src/index.ts:27-35; src/modules/debugPlugin.ts:8-11 | __ZENTYPE_DEV__ gates installation. Production does not install the DebugKit controller. Keep. |
| Build identity | src/debug/buildIdentity.ts; DebugKit session state and export | Developer evidence for matching a recording to a build. Keep; no current unit test directly covers it. |
| Download/export | src/debug/download.ts; debugPlugin.ts | Developer workflow, not runtime feature semantics. Keep until an external-use review says otherwise. |
| No-op reconnect | src/debug/index.ts:342-344; src/debug/types.ts:98 | Looks dead because it always returns false, but is exposed on the public debug controller and preserves an old-shaped API. E2, not A. |
| Public type facade | src/modules/debugHook.ts:1-17; DebugKitController alias | Internal callers are few, but global developer consumers are not searchable in-repo. Keep pending compatibility decision. |

The old v2.8.1 DebugKit was approximately 3,246 lines across collector (1,185), serialize (851), index (552), transport (242), performance (102), and types (314), plus 913 lines of summary and 488 lines of bridge script. The current implementation is approximately 399 lines of recorder, 429 lines of serializer, and 108 lines of types, with no transport/summary/bridge/performance module. This is a deliberate session-local reduction, not an accidental dead-code deletion.

### Build and production stripping

| Check | Current implementation | Verdict |
| --- | --- | --- |
| Production build | build.js:79-105 drops ZENTYPE_DEBUG, minifies, omits production source maps, and uses an explicit archive whitelist. | Active release boundary. |
| Production verifier | scripts/verify-prod.mjs:5-24,70-89 rebuilds prod/dev, checks forbidden/required markers, compares dist/index.js and ZIP contents. | Active safety fuse; not dead because it is not imported by runtime. |
| Dev build | pnpm run build:dev is invoked by the verifier and preserves source maps/DebugKit. | Developer infrastructure. |
| Dev link | scripts/make_dev_link.js:1-216 resolves workspace paths, validates targets, and uses symlink/junction fallback without overwriting an existing install. | Active development infrastructure. |
| CI | .github/workflows/ci.yml:10-30 runs typecheck, tests, production build/verify, dev build, and git diff --check on Node 24/pnpm 11.19.0. | Active external guard. |

No current script was proven dead. The absent debug-summary.mjs and debug-bridge.mjs are historical tooling, not current script candidates.

## 9. v2.8.1 → Remake Complexity Comparison

### Size and test counts

| Measure | v2.8.1 (6c3ac044) | Current HEAD | Change |
| --- | ---: | ---: | ---: |
| TypeScript source files | 58 | 27 | −31 (53.4%) |
| TypeScript source lines | 13,216 | 4,749 | −8,467 (64.0%) |
| SCSS source lines | 210 | 95 | −115 |
| Executed test entries | 15 | 3 | −12 |
| Automated tests | 196 | 132 | −64 |

The current tracked src tree has 28 source files total: 27 TypeScript plus 95 lines of SCSS. The v2.8.1 source tree had 59 source files total: 58 TypeScript plus 210 lines of SCSS.

### Authority and scheduling comparison

| Dimension | v2.8.1 shape | Current Remake shape | Cognitive-load result |
| --- | --- | --- | --- |
| Business frame/rAF | Many feature-local rAF paths; old flip, scroll, sentence transition, and debug/performance paths had separate timing concerns. | One WritingSession business rAF; feature modules receive performance.now() and shared frame ordering. | Major reduction. A bug can be followed through one timeline. |
| Mutation observation | Old Ripple/structural paths were more distributed. | Session owns the editor MutationObserver and ResizeObserver/theme invalidations; StructureGate classifies; DebugKit observes through Session. | Major reduction in ownership ambiguity. |
| Timers | Old scripts and feature paths contained more delayed cleanup/debounce surfaces. | Current source has one bounded Session wake concept and no setInterval; lifecycle cancels the wake/rAF. | Smaller cancellation surface. |
| Structural authority | Old structuralEdit.ts and Typewriter FLIP coordinated broad flow work. | StructureGate owns generation/readiness; StructurePresentation owns Tab/Shift+Tab; LayoutContinuity owns Enter/Delete/Backspace. | Fewer shared responsibilities, while keeping two intentionally distinct geometry owners. |
| Ripple ownership | Old semantic planner, style applier, nested engine and carryover registry were separate. | BlockPlan is read-only planning; BlockPainter owns semantic values/parents/carriers; Session decides when commit is allowed. | Fewer places to understand alpha continuity. |
| Host replacement identity | Old carryover/inline-style paths mixed DOM/style identity. | visualKey + bounded same-key rebind; focused role is separately derived from live collapsed Selection and structural evidence. | Stronger semantic boundary; no identity registry. |
| Debug infrastructure | Collector + transport + performance + summary + bridge. | Session-local bounded recorder + serializer + export/build identity. | Lower runtime coupling; weaker offline analysis tooling. |
| Structural motion | Old broad Typewriter FLIP surface. | One structural displacement owner for list reparent and one local flow owner for Enter/Delete/Backspace; neither has a scheduler. | Lower authority count, but new flow acceptance is still E. |

Syntactic current-vs-old counts reinforce the ownership conclusion but do not prove browser equivalence: current source has one requestAnimationFrame call site, two cancelAnimationFrame references, two new MutationObserver sites, one new ResizeObserver, three setTimeout references, and no setInterval. The old source had 37/23/6/2/16/0 corresponding textual occurrences. The meaningful invariant is the one Session rAF owner, not the raw occurrence count.

### Old mechanism → requirement → current replacement

The complete migration table is in §6. The short answer is:

~~~text
old semantic planner / style applier
  → semantic target identity + presented alpha continuity
  → blockPlan + BlockPainter owner/parent/snapshot/rebind

old sentenceTransition
  → UTF-16 sentence projection + interruptible value continuity
  → sentenceModel + textProjection + Ripple Session rendering

old Typewriter FLIP / structuralEdit
  → local flow continuity + Host structural admission
  → LayoutContinuity + StructurePresentation + StructureGate

old Cursor auxiliaries / targetResolver / inputMode
  → scoped Host frame + intent/lifecycle/switch semantics
  → editorScope/readEditorFrame + Cursor + Session

old DebugKit transport/performance/summary/bridge
  → forensic evidence and offline analysis
  → session-local DebugKit recorder/export/build identity
  (diagnostic capability is the only plausible lost knowledge)
~~~

## 10. Safe Removal Wave 1

Wave 1 is deliberately limited to A — Provably Dead. It should be split into small commits or one clearly isolated hygiene commit, with no feature-semantic edits.

1. Delete emptySession() from src/debug/index.ts:73-84.
2. Delete the unused writing local at src/session.ts:371.
3. Delete the unused composing local at src/session.ts:372.
4. Remove the unused body formal at tests/remake.test.ts:394,425,450,471.
5. Remove the unused body formal at tests/remake.test.ts:1059,1080,1117,1158.
6. Run the full verification after each commit or after the isolated batch; inspect git diff --check and confirm no runtime file beyond the two A2 lines changed.

These are the top five safest removal batches. No BlockPainter, StructureGate, StructurePresentation, LayoutContinuity, DebugKit public type, or build verifier code belongs in this wave.

## 11. Safe Removal Wave 2

Wave 2 is for B — Obsolete Patch Debt, only after Wave 1 and real-machine smoke testing. It is primarily documentation/API-surface review:

1. Correct identity-ready wording in docs/DESIGN.md:29,37 and src/session.ts:358-360 so “removed evidence” is not described as a current authority.
2. Align README/design release labels with the intended src/config.ts:1 build label and the current changelog.
3. Reframe docs/TODO.md as historical or replace only its stale present-tense section.
4. Mark NESTED_RIPPLE_PROJECT_BRIEF.md as historical planning input and update missing path references without deleting its semantic requirements.
5. Update/archive SIYUAN_DOM_EVIDENCE.md path/provenance references; retain the evidence ledger.
6. Decide, with developer-consumer evidence, whether reconnect() and the DebugKitController alias remain a compatibility surface. Do not remove them as an internal unused symbol solely from the current import graph.

Wave 2 must not include changing a readiness threshold, moving a mutation callback write, combining structural owners, or simplifying BlockPainter ancestry.

## 12. Do Not Touch Before Release

The following are explicit no-touch areas for this release:

- src/modules/ripple/blockPainter.ts:79-88,89-102,111-122,163-216,219-283,285-400:
  - parents, presented, snapshot;
  - protectFocus() and focusBranchBoundary();
  - focused replacement-role invalidation;
  - paused WAAPI carrier and exact-id stale recovery;
  - connected-only handoff and bounded owner limits.
- src/modules/ripple/blockPlan.ts:46-107 ancestor/descendant alpha repartition.
- src/session.ts:154-203,294-563,596-747:
  - mutation-time same-key rebind ordering;
  - one performance.now() sample per Session frame;
  - geometry-ready versus semantic-ready gating;
  - lifecycle cancel/abandon pairing;
  - selection/editor/composition cancellation.
- src/structure.ts:55-100,109-124,127-335:
  - old-parent MutationRecord classification;
  - ordinary-delete fast path;
  - generation matching, 48ms quiet, 160ms deadline, stability and overflow.
- src/modules/structurePresentation.ts and src/modules/layoutContinuity.ts:
  - attach inside mutation delivery;
  - Host transform fail-closed;
  - same-key/subject/generation validation;
  - separate Tab/Shift+Tab versus Enter/Delete/Backspace ownership;
  - hard safety bounds.
- Any recently fixed marker/Ripple handoff from e70b955, 8668a73, f456068, 6ea30f1, b8772dc, 292122c, 9c020ad, 13ef96e, or 46bbd25.
- Motion parameters in src/config.ts, especially 48ms/160ms structural policy, until a separate evidence-driven change is requested.
- The rejected Local Presentation Bridge and focused-only structural transform. Their deletion is already the architecture decision.

## 13. Post-release Refactor Candidates

These are worthwhile only after release evidence, not pre-release cleanup:

1. BlockPainter explanation/observability refactor, not semantic rewrite. The module is complex, but the repair chain is recent and the tests are dense. A future change could improve internal naming or split pure alpha math from lifecycle code if it preserves the same owner/parent/carrier invariants and replays the real traces.
2. Offline DebugKit analysis tooling. Recreate a small summary/inspection CLI for current zentype-debug-bundle/v1 exports instead of restoring the old bridge/transport architecture. First define privacy, schema, and replay requirements.
3. Browser/real-Host acceptance lane. Wire the marker browser fixture or a CDP harness for Tab/Shift+Tab, Enter/merge, Host scroll takeover, IME and editor switching. This is the cheapest way to retire E uncertainty.
4. Documentation consolidation. After the release label is settled, make DESIGN.md, README files, Host Contract, CHANGELOG, TODO, and historical briefs distinguish current architecture from archived planning. Preserve historical bug narratives.
5. Debug facade compatibility decision. Determine whether reconnect() and DebugKitController are consumed outside this repository. If not, remove them in a deliberately documented API cleanup; if yes, implement or document their contract rather than guessing.
6. Test matrix reconciliation. Compare the old 196-test behavior list with current contract rows and add only missing semantic regressions. Do not port architecture-specific tests mechanically.

## Audit handoff

| Required report item | Result |
| --- | --- |
| Change summary | Added this audit report only. |
| Responsibility | Runtime responsibility remains exactly with Host → StructureGate → WritingSession → feature → Critical Motion/Painter. |
| New concepts | None in runtime; the A/B/C/D/E labels are report classification only. |
| Removed code | None. Historical code listed as already removed was not touched. |
| New branches / fallbacks | None. |
| Invariants | One Session business rAF/timeline; Host truth before presentation; mutation callback only same-key owner rebind; geometry-ready only Cursor; semantic-ready for Typewriter/Ripple; no inline opacity or second scheduler; lifecycle cleanup pairing; bounded work/deadlines. |
| Tests | Required checks were run; results are recorded below. No regression test was added because no runtime behavior changed. |
| Scope | No unrelated source, test, build, configuration, or documentation file was modified. |

### Verification record

| Command | Result |
| --- | --- |
| pnpm run typecheck | PASS |
| pnpm run typecheck:tests | PASS |
| pnpm test | PASS — 132/132 |
| pnpm run build | PASS — dist/index.js 56.8 KB; package.zip created |
| pnpm run verify:prod | PASS — production 58,112 bytes / gzip 20,782; development 172,845 bytes / gzip 41,516; ZIP 107,299 bytes |
| git diff --check | Required after this document is added and before commit |
| strict noUnused audit commands | Expected FAIL with exactly A1/A2 and A3–A10; these failures are the evidence for Wave 1, not release-check failures |

Production verification confirmed that DebugKit markers/controller strings are stripped from production output while the development build retains them. Build output is ignored/generated and is not part of the report commit.

## Final audit decision

**Dead Code Audit complete — no runtime changes performed.**

The next safe action is Wave 1 only. Do not use this report as permission to simplify BlockPainter, alter StructureGate timing, merge the two structural presentation owners, or restore any historical prototype.
