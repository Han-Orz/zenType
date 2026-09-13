# Transfer Matrix

This matrix is the boundary for zenTypeNext knowledge migration. A row describes a concept, not a file to copy. Evidence links point to the current Remake, its history, or the v2.8.1 reference.

## Categories

- MUST TRANSFER: mature product invariants.
- TRANSFER SEMANTICS, REIMPLEMENT NATIVELY: the interaction is valuable, but the DOM/plugin actuator is not.
- ARCHITECTURE-LEVEL TRANSFER: a reasoning and ownership lesson, not a module design.
- RECALIBRATE: preserve the purpose, remeasure the values on a native platform.
- HOST-SPECIFIC — DO NOT TRANSFER: the underlying lesson may transfer, but this mechanism is a SiYuan/Web workaround.
- HISTORICAL / EXPERIMENTAL: preserve as cautionary knowledge, not as a Next requirement.

## Matrix

| Concept | Category | Why it exists | Maturity | zenTypeNext recommendation | Evidence |
| --- | --- | --- | --- | --- | --- |
| Writing-first priority | MUST TRANSFER | Animation must never outrank input, Selection, IME, or user agency. | Mature | Make it a product acceptance rule. | docs/DESIGN.md:41-52 |
| Continuous-document feel | MUST TRANSFER | Structured editing should not feel like manipulating unrelated boxes. | Mature product intention | Use as a user-facing north star, not a flattening algorithm. | docs/DESIGN.md:7-15; docs/CHANGELOG.md:3-30 |
| Focus/context hierarchy | MUST TRANSFER | Current writing context should be clear while relevant structure remains legible. | Regression-validated | Keep the semantic hierarchy in the native view. | commits e70b955, 8668a73, 292122c |
| Continuity over restart | MUST TRANSFER | A changing target should not expose a visual reset. | Regression-validated | Require retarget-from-presented-state scenarios. | src/motion.ts:6-45 |
| Interruptibility and user agency | MUST TRANSFER | New input, scroll, Selection, composition, and lifecycle can supersede an effect. | Regression-validated | Define cancellation and retargeting as normal behavior. | src/session.ts:596-786 |
| Structural yielding and no handoff seam | MUST TRANSFER | Structural change should read as local content flow with no system A → flash → B seam. | Desired for newest flow, mature for the principle | Evaluate semantic continuity, not block-flight resemblance. | docs/CRITICAL_MOTION_LAYOUT_CONTRACT.md:22-36 |
| Custom Cursor semantics | TRANSFER SEMANTICS, REIMPLEMENT NATIVELY | The writing location needs spatial coherence and safe recovery. | Mature / guarded | Rebuild around NativeEditor and Layout facts. | src/modules/cursor.ts:165-281 |
| Cursor breathing | TRANSFER SEMANTICS, REIMPLEMENT NATIVELY | Idle attention can remain gently visible without a blinking default caret. | Mature behavior, calibration-dependent | Recreate only if it improves writing focus; remeasure. | docs/CHANGELOG.md:170-207; src/config.ts:16-30 |
| Typewriter comfort and takeover | TRANSFER SEMANTICS, REIMPLEMENT NATIVELY | The viewport protects comfort but yields to the user and host. | Mature, some structural timing pending | Implement against native scroll ownership. | src/modules/typewriter.ts:23-88 |
| Sentence Ripple | TRANSFER SEMANTICS, REIMPLEMENT NATIVELY | Sentence-level context supports reading and writing without changing text structure. | Regression-validated | Use a native text/highlight presentation; retain segmentation semantics. | src/modules/ripple.ts:1-307; docs/DESIGN.md:169-175 |
| Block Ripple semantic hierarchy | TRANSFER SEMANTICS, REIMPLEMENT NATIVELY | Parent, sibling, child, marker, and direct content need readable context. | Regression-validated, pixel variants pending | Express semantic layers in native presentation; do not copy alpha code. | src/modules/ripple/blockPlan.ts:1-108; tests/rippleStructuralFocus.test.ts |
| Structural editing continuity | TRANSFER SEMANTICS, REIMPLEMENT NATIVELY | Enter, merge, indent, and outdent should preserve local visual continuity. | New Layout path pending feel acceptance | Build around native transaction/layout facts and Selection. | src/modules/layoutContinuity.ts:46-317 |
| WritingSession single timeline | ARCHITECTURE-LEVEL TRANSFER | Feature-local clocks created races and inconsistent interruption. | Architecture-accepted | Give one interaction coordinator clear frame/time ownership. | commit 3376380; src/session.ts:294-325 |
| StructureGate admission and generations | ARCHITECTURE-LEVEL TRANSFER | Input intent is not proof of structural completion; stale transactions must be rejected. | Architecture-accepted | Have an explicit bounded admission/generation policy. | src/structure.ts:168-335 |
| Host truth versus presentation | ARCHITECTURE-LEVEL TRANSFER | A visual continuation must not become a second document model. | Architecture-accepted | Keep Document Tree/Layout authoritative. | docs/DESIGN.md:7-25, 97-109 |
| Semantic identity versus actuator identity | ARCHITECTURE-LEVEL TRANSFER | A stable object can acquire a new drawable view, but a role may change. | Regression-validated | Model semantic object, role, and view separately where needed. | docs/DESIGN.md:133-145; commit 9c020ad |
| Read → decide → write | ARCHITECTURE-LEVEL TRANSFER | Mixing measurement, policy, and writes creates stale-frame and forced-layout races. | Architecture-accepted | Keep layout reads and presentation writes auditable. | docs/DESIGN.md:97-109 |
| Fail-closed and bounded work | ARCHITECTURE-LEVEL TRANSFER | Uncertain ownership or unbounded traversal is worse than no effect. | Architecture-accepted | Make limits, deadlines, and safe release explicit. | src/structure.ts:5-7; src/modules/layoutContinuity.ts:46-57 |
| Critical Motion law | RECALIBRATE | A shared law gives continuity, but its time constants are platform and feel dependent. | Mature implementation, not dogma | Preserve coherent retargeting; remeasure response. | src/motion.ts:6-45; docs/CRITICAL_MOTION_LAYOUT_CONTRACT.md:38-50 |
| Cursor/Ripple breathing and fade timing | RECALIBRATE | The attention rhythm is sensitive to display, input, and native caret feel. | Current calibration | Tune with user observation, keeping semantic priorities. | src/config.ts:16-36 |
| Typewriter comfort band and edge response | RECALIBRATE | Native window/layout metrics differ from a contenteditable editor. | Current calibration | Re-establish comfort boundaries from native viewport behavior. | src/modules/typewriter.ts:42-88; v2.8.1 docs/DESIGN.md |
| Structural response, gate windows, and flow bounds | RECALIBRATE | 150 ms, 48/160 ms, viewport overscan, and hard limits are engineering calibrations. | Current/provisional | Measure latency and feel; do not copy values as requirements. | src/config.ts:4-13; docs/CRITICAL_MOTION_LAYOUT_CONTRACT.md:38-56 |
| .protyle-action marker key | HOST-SPECIFIC — DO NOT TRANSFER | SiYuan markers are separate DOM chrome with a parent-derived visual key. | Regression-validated host fact | Transfer explicit chrome ownership; discard the class/key mechanism. | src/structure.ts:43-48; docs/SIYUAN_HOST_CONTRACT.md:28-35 |
| Same-key DOM replacement and rebind | HOST-SPECIFIC — DO NOT TRANSFER | SiYuan replaces elements while retaining data-node-id. | Regression-validated host fact | Transfer semantic continuity; implement native view rebinding differently. | docs/SIYUAN_HOST_CONTRACT.md:77-103, 134-141 |
| MutationObserver delivery ordering | HOST-SPECIFIC — DO NOT TRANSFER | Browser microtasks and later normalization create evidence races. | Runtime-observed/incomplete | Transfer “completion is not intent”; do not port observer timing. | docs/SIYUAN_HOST_CONTRACT.md:121-149 |
| wbr/Range Selection restoration | HOST-SPECIFIC — DO NOT TRANSFER | SiYuan restores contenteditable Selection through DOM helpers and async paths. | Runtime-observed | Transfer Selection authority; use native editor transactions. | docs/SIYUAN_HOST_CONTRACT.md:103-149 |
| Paused WAAPI opacity carrier | HOST-SPECIFIC — DO NOT TRANSFER | It is a browser actuator for a Session-owned numeric alpha state. | Current implementation | Use the native compositor/paint actuator, never its WAAPI lifecycle. | src/modules/ripple/blockPainter.ts:9-59 |
| Host transform ownership and caret-offset subtraction | HOST-SPECIFIC — DO NOT TRANSFER | DOM transforms enter Range geometry and may belong to a theme/host. | Runtime-observed | Transfer “never overwrite foreign layout”; use native coordinate conversion. | docs/SIYUAN_HOST_CONTRACT.md:35-41 |
| SiYuan editor/contenteditable lifecycle | HOST-SPECIFIC — DO NOT TRANSFER | Editor switching, blur, disconnect, and plugin teardown have host-specific ordering. | Partly verified | Transfer explicit lifecycle pairing; rediscover native lifecycle contracts. | src/session.ts:710-786; docs/SIYUAN_HOST_CONTRACT.md:163-183 |
| Host scroll takeover and transient topology | HOST-SPECIFIC — DO NOT TRANSFER | Host caret scrolling and temporary invalid DOM can supersede plugin plans. | Runtime-observed/incomplete | Transfer user/host scroll authority and fail-closed topology handling. | docs/SIYUAN_HOST_CONTRACT.md:39-43, 151-161 |
| Focused-only structural transform prototype | HISTORICAL / EXPERIMENTAL | It tried to visually carry a reparent using a late transform. | Rejected | Keep as a warning about attach timing and jump-back feel. | commits 329a0cd, e4759c4 |
| Broad structural FLIP | HISTORICAL / EXPERIMENTAL | It treated a structured edit as a large rectangle choreography. | Rejected/limited | Do not make document-scale FLIP the default continuity model. | docs/CRITICAL_MOTION_LAYOUT_CONTRACT.md:22-36 |
| Local Presentation Bridge | HISTORICAL / EXPERIMENTAL | It tried to keep old text visible through a separate surface. | Explicitly rejected | Do not create duplicate/ghost document surfaces. | commit 0354536; docs/CHANGELOG.md:115-123 |
| Persistent DOM-identity registry and inline opacity carryover | HISTORICAL / EXPERIMENTAL | It attempted to preserve CSS state across host replacement. | Rejected | Keep semantic state, but bind it to live native actuators and roles. | docs/REMAKE2_REVIEW.md:1-30; docs/DESIGN.md:149-167 |
| Old DebugKit bridge/summary/performance transport | HISTORICAL / EXPERIMENTAL | It supplied deep plugin-specific forensic transport. | Historical infrastructure | Recover useful diagnostics natively if needed; do not restore the old runtime bridge. | docs/DEBUGKIT.md; docs/DEAD_CODE_PATCH_DEBT_AUDIT.md:249-306 |

## Counts

These are counts of the 35 matrix rows, not counts of source files or requirements:

| Category | Count |
| --- | ---: |
| MUST TRANSFER | 6 |
| TRANSFER SEMANTICS, REIMPLEMENT NATIVELY | 6 |
| ARCHITECTURE-LEVEL TRANSFER | 6 |
| RECALIBRATE | 4 |
| HOST-SPECIFIC — DO NOT TRANSFER | 8 |
| HISTORICAL / EXPERIMENTAL | 5 |

## v2.8.1 behavior disposition

| v2.8.1 behavior | Remake status | Next disposition |
| --- | --- | --- |
| Smooth cursor and caret-following | Preserved in Cursor and Session, with clearer recovery and transport ownership. | Keep semantic behavior; reimplement natively. |
| Comfort-zone Typewriter and reverse scroll | Preserved as comfort/viewport agency; actuator and scheduler consolidated. | Keep; recalibrate. |
| Sentence transition continuity | Preserved through text projection, sentence modeling, and first-frame seeding. | Keep semantic continuity; use native text presentation. |
| Nested Ripple and marker hierarchy | Preserved and strengthened through explicit owners and ancestry protection. | Keep hierarchy; discard DOM alpha workarounds. |
| Structural editing stability | Old broad paths discarded; Tab owner accepted; local Enter/Delete/Backspace flow is newer. | Keep semantic goal; treat newest flow as pending acceptance. |
| Feature-local FLIP/schedulers | Deliberately removed in the single Session Remake. | Do not restore as architecture. |
| Old DebugKit bridges and summaries | Reduced to bounded dev instrumentation; offline depth is lost. | Transfer diagnostic intent only if Next needs it. |
