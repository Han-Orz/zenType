# Open Questions and Non-Goals

This document prevents an implementation, a deterministic test, or a historical workaround from being mistaken for a universally mature product requirement.

## Maturity vocabulary

| Label | Meaning |
| --- | --- |
| Mature | Long-lived behavior or a stable product intention supported by the product history. |
| Regression-validated | A concrete failure was observed or reported, a repair was made, and focused tests or evidence protect it. |
| Architecture-accepted | The authority boundary is intentional and deterministic tests support it; final visual feel may still be pending. |
| Desired / pending | The behavior is wanted or implemented, but relevant real-machine or user-feel evidence is incomplete. |
| Inferred | A synthesis from history and implementation that is useful but not yet a confirmed product standard. |

## Canonical maturity ledger

The following 25 named knowledge claims provide the maturity counts used by the project handoff. Counts refer to this ledger, not to every sentence or scenario in the pack.

### Mature — 4

| Claim | Evidence |
| --- | --- |
| Writing-first priority is the product's reason for existing. | README.md:7-19; docs/DESIGN.md:41-52 |
| Continuous-document feel is the long-lived product direction. | docs/DESIGN.md:7-15; v2.8.1 docs/DESIGN.md |
| The Cursor should feel attached to the writing location. | src/modules/cursor.ts:239-281; docs/CHANGELOG.md:170-207 |
| Typewriter is a comfort-band behavior, not permanent centering. | src/modules/typewriter.ts:23-88; v2.8.1 docs/DESIGN.md |

### Regression-validated — 7

| Claim | Evidence |
| --- | --- |
| Ordinary character deletion bypasses structural latency. | src/structure.ts:231-238; tests/remake.test.ts |
| Sentence continuity respects segmentation and UTF-16 projection. | docs/DESIGN.md:169-175; tests/remake.test.ts |
| Nested Ripple hierarchy needs committed ancestry and residual alpha handling. | commits e70b955, 8668a73, f456068, b8772dc |
| Focused marker/content must not inherit stale ancestor dim. | commit 292122c; tests/rippleStructuralFocus.test.ts |
| Same semantic key does not preserve an invalid presentation role. | commit 9c020ad; tests/remake.test.ts |
| User/host scroll and lifecycle can take presentation ownership back. | src/modules/typewriter.ts:42-88; src/session.ts:682-786 |
| Retargeting must not expose a restart or handoff seam. | src/motion.ts:6-45; docs/TERMINAL_FLASH_INVESTIGATION.md |

### Architecture-accepted — 5

| Claim | Evidence |
| --- | --- |
| One Session owns the business frame and monotonic time. | commit 3376380; src/session.ts:294-325 |
| StructureGate separates intent, evidence, generations, geometry readiness, and semantic readiness. | src/structure.ts:168-335 |
| Host truth and presentation policy are separate authorities. | docs/DESIGN.md:7-25, 97-109 |
| A common motion law is preferable to feature-local easing/schedulers. | src/motion.ts:6-45; docs/CRITICAL_MOTION_LAYOUT_CONTRACT.md:38-50 |
| Structural reparent and local content flow deserve separate bounded owners. | src/modules/structurePresentation.ts:19-29; src/modules/layoutContinuity.ts:46-57 |

### Desired / pending — 5

| Claim | Evidence and gap |
| --- | --- |
| Layout Continuity should make Enter/merge flow feel continuous on real SiYuan. | Implemented in e5fc3ac/c7e4d7a; visual acceptance pending, docs/CHANGELOG.md:3-30 |
| Rapid repeated Enter/merge and nested flow should remain smooth and bounded. | Automated coverage exists; real host topology and feel are incomplete. |
| Long-press ordinary Backspace should remain responsive without structural overcapture. | Fast path is guarded; long-press host timing is not fully observed. |
| CJK and cross-block IME/Selection edge cases should preserve native ownership. | Policy exists; runtime evidence remains open, docs/SIYUAN_HOST_CONTRACT.md:157-161, 199-207 |
| Latest marker boundary, editor switch, and popup/split-editor combinations need final machine acceptance. | Current tests and contract are partial; browser fixture is not in tests/run.mjs. |

### Inferred — 4

| Claim | Why it is still inferred |
| --- | --- |
| Performance and elegance are two expressions of the same product quality. | Strongly suggested by the scheduler consolidation and regression history, but it is a synthesis rather than a single explicit requirement. |
| Semantic identity/actuator identity separation is a native-app design lesson. | Proven against DOM replacement; native view equivalence still needs a Next design decision. |
| Runtime semantic knowledge was transferred more completely than diagnostic knowledge. | The audit found replacement owners for old runtime requirements, but there is no complete cross-host equivalence proof. |
| The old DOM workarounds should be discarded while their underlying requirements transfer. | Correct boundary is strongly supported, but the exact Next presentation model is intentionally unspecified. |

## Pending real-machine acceptance

The current Remake explicitly leaves these questions open:

- Tab/Shift+Tab marker and ancestor handoff in all relevant list shapes;
- Enter split, Backspace merge, and Delete merge visual flow;
- rapid repeated structural edits and nested flow;
- long-press ordinary deletion and host normalization;
- CJK composition and cross-block composition;
- range selection, editor switch, popup/split editor, and disable/re-enable;
- marker subtype conversion and exact first-frame behavior;
- host scroll takeover immediately after structural commit;
- precise MutationObserver, Selection, and rAF order across transaction variants.

The existing browser marker fixture is typechecked but not run by tests/run.mjs. The absence of an automated browser lane must be visible in any future release decision; it is not evidence that the behavior is dead or complete (docs/DEAD_CODE_PATCH_DEBT_AUDIT.md:264-289).

## Potential Lost Host Knowledge

No confirmed runtime semantic loss was found in the audit. The major old mechanisms have current semantic replacements:

| v2.8.1 knowledge | Current replacement | Confidence |
| --- | --- | --- |
| Nested semantic planning | blockPlan target collection and bounded committed ancestry | High |
| Alpha/style continuity | BlockPainter CriticalState, presented/snapshot, role-checked rebind, protectFocus | High |
| Sentence transition continuity | sentenceModel, textProjection, CSS Highlight registration, first-frame seed | High |
| Comfortable scroll and reverse continuity | Typewriter virtual state, Critical Motion, host takeover | Medium-high |
| Structural continuity | StructureGate, StructurePresentation, LayoutContinuity | Medium-high; newest flow feel pending |
| Forensic debugging and offline summaries | Current bounded DebugKit and build identity | Low-medium |

The plausible lost knowledge is mainly diagnostic and investigative:

- v2.8.1 debug-summary and debug-bridge scripts are gone;
- old DebugKit had deeper collector, transport, performance, and summary vocabulary;
- old FLIP/probe terminology is not available as an equivalent offline replay tool;
- the current browser fixture is not an executed regression lane.

This does not justify restoring the old runtime. It suggests a future, platform-appropriate diagnostic tool if real-world acceptance requires it. Before Next treats any remaining unknown as a product invariant, it should obtain native-host evidence.

## Rejected and failed ideas

| Idea | Why it failed or was rejected | Lesson for Next |
| --- | --- | --- |
| Focused-only structural transform | It attached after the host had painted the new position, causing a visible jump and pullback; it also made structural edits feel slow. | Attachment timing and local subject ownership are part of UX correctness. |
| Broad/document-scale FLIP | It made a structured writing surface read like a collection of moving cards, increased work, and competed with host layout. | Prefer local content flow and bounded semantic subjects. |
| Local Presentation Bridge | Merge already placed source text into the destination; a second surface duplicated content, had zero geometry when detached, and lost host typography. | Never create a second document surface to hide a host transaction. |
| Persistent DOM identity registry | DOM and CSS lifetime can split; serialized inline styles could conflict with host ownership and stale roles. | Preserve semantic state only while a valid live actuator and role exist. |
| Separate animation systems with handoff | Independent schedulers and transition owners produced restart, stale alpha, and no-owner frames. | One timeline and explicit owner transfer are safer than visual subsystem choreography. |
| Focused replacement carrying the old role | Same key was incorrectly treated as role continuity, causing focused content to inherit or re-promote dim. | Semantic identity is necessary but not sufficient for presentation continuity. |

## Non-goals for this pack

This pack does not:

- prescribe zenTypeNext's class structure, render loop, animation library, or data schema;
- require a DOM, CSS Highlight, WAAPI, MutationObserver, or contenteditable equivalent;
- copy current response values or host timing thresholds;
- reopen the Remake architecture or perform dead-code cleanup;
- declare Layout Continuity or every IME path released merely because deterministic tests pass;
- turn every v2.8.1 behavior into a Next requirement;
- treat SiYuan-specific quirks as general editor laws.

## Questions for a future Next acceptance review

1. Can a user describe the operation as editing a continuous document rather than moving blocks?
2. Does every visible effect have a single authority and a clear release path?
3. Does retargeting preserve the current presented state?
4. Do Selection, IME, manual scroll, and native layout always win?
5. What does the product do when layout or transaction evidence is incomplete?
6. Are ordinary edits cheaper and more immediate than structural edits?
7. Are structural transitions local, bounded, and semantically explainable?
8. Which current calibration values were measured on the native display/input stack?
