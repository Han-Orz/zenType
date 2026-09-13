# Architecture Lessons

These are lessons extracted from zenType's evolution. They should inform zenTypeNext decisions, but they do not require Next to reproduce plugin classes, DOM observers, or a Session type.

## Authority map

The current Remake settled on this ownership chain:

| Layer | Owns | Must not own |
| --- | --- | --- |
| Host | DOM/semantic structure, active editor, Selection, caret geometry, final layout, scroll, delivered mutations | Animation policy |
| StructureGate | Structural admission, evidence classification, generations, readiness, bounded deadlines | Motion or feature targets |
| WritingSession | Event routing, one business clock, one rAF, read/decide/write ordering, lifecycle pairing | Semantic truth or per-feature scheduler |
| Feature | Cursor, Typewriter, sentence Ripple, block Ripple, structural target/personality | Host completion inference |
| Critical Motion | Common trajectory and retargeting law | Semantic classification |
| Painter / actuator | Final transform, alpha, highlight, or scroll write | New topology or document truth |

The compact formulation in docs/DESIGN.md:7-15 is:

> Host decides truth. Structure describes change. Session grants authority. Feature decides target and personality. Motion decides trajectory. Painter commits.

The important lesson is one owner per fact. It is not that these exact six names are mandatory.

## Truth versus presentation

Final structure/layout and visual continuity are different questions:

- truth asks what the document is now;
- presentation asks how the transition to that truth should be perceived.

If presentation invents a parallel structure, it can duplicate text, use stale Selection, or survive after the host has moved on. The rejected Local Presentation Bridge and broad FLIP experiments made this concrete (commit 0354536; docs/DESIGN.md:149-167).

For a native app, the analogous rule is: the Document Tree and Layout authority remain authoritative; Presentation may preserve a visual continuation only for a known semantic change and a live actuator.

## Semantic identity versus actuator identity

SiYuan can replace an HTMLElement while retaining data-node-id. The Remake therefore separates:

- semantic identity: the stable document/object key;
- presentation role: focused, ancestor, sibling, marker, direct content, and so on;
- actuator identity: the currently drawable element or surface.

A semantic key permits a rebind only when the role remains valid. This is why same-key replacement is not a blanket carry rule. The rule generalizes to native widgets, retained layout nodes, and virtualized views, but the DOM-specific key and rebind operation do not.

Evidence: src/structure.ts:43-53; src/modules/ripple/blockPainter.ts:14-40, 163-216; docs/DESIGN.md:133-145; commits 9c020ad, e70b955, 0a68a53.

## Scheduling authority

The old runtime accumulated feature-local timers, rAF loops, and transition lifecycles. The Remake consolidated business scheduling into one WritingSession frame and one performance.now timeline. This reduced races where Typewriter could consume a transient layout before Cursor settled or Ripple could commit while structural authority was withheld (docs/REMAKE2_REVIEW.md:1-30; commit 3376380).

Transfer lesson: an interaction feature should not create its own event universe. A shared scheduler makes interruption, time, lifecycle, and debugging comparable. A native implementation may use a different loop, but it should be able to answer who owns the frame, who sampled truth, and which feature was authorized.

## Read, decide, write

The current order is:

1. Read Host facts once in the Session frame.
2. Decide authority and feature targets.
3. Write presentation after decisions.

Mutation delivery is evidence collection and a narrow same-key rebind point, not a general geometry planner. This keeps transient layout out of feature decisions and avoids forced-layout feedback loops (docs/DESIGN.md:97-109; src/session.ts:294-345).

The native implication is broader than DOM: keep document mutation, layout measurement, policy, and paint responsibilities explicit enough that one subsystem cannot unknowingly observe another subsystem's half-committed state.

## Fail closed

Fail closed means releasing or withholding presentation when:

- the generation is stale;
- the subject is disconnected or ambiguous;
- geometry is missing beyond its recovery budget;
- the host owns a transform or scroll path;
- composition or Selection is active;
- traversal or mutation volume exceeds a bound;
- the document lifecycle no longer permits safe writes.

This is not an excuse for silent bugs. It is a priority rule: a correct host with no animation is better than a visually convincing but semantically wrong transition. The bounds in src/structure.ts:5-7 and src/modules/layoutContinuity.ts:46-57 are implementation limits; the general safety principle transfers.

## Bounded work is quality

Viewport/overscan, ancestry depth, node count, mutation count, deadline, and recovery budgets are not merely security fuses. They keep motion from becoming input latency or a background process that never settles. The current design uses 256 mutation records, 2048 nodes, 64 ancestry depth, a 48 ms quiet window, a 160 ms absolute deadline, and a 96-item flow hard limit; these values need recalibration on a native platform.

## Explicit lifecycle pairing

The source may contain calls that look duplicated because several exit paths release the same owner. This is intentional when disable, destroy, timeout, overflow, blur, editor switch, and frame exception each need an explicit pairing. Removing one because another path also calls cleanup can reopen stale writes.

The lesson for Next is to make owner acquisition and every lifecycle release auditable. It does not imply retaining every current helper.

## Structural ownership should follow semantics

Tab/Shift+Tab reparent a subject. Enter/Delete/Backspace create local content flow. The Remake keeps StructurePresentation and LayoutContinuity separate rather than unifying them for visual symmetry. This avoids one “structural animation” owner trying to infer incompatible subjects (docs/PHASE2_V2_INTEGRATION.md:1-34; src/modules/structurePresentation.ts:19-29; src/modules/layoutContinuity.ts:46-57).

Native implication: choose an owner based on the semantic operation and its failure modes, not on whether the pixels look similar.

## Motion as a shared law

Critical Motion lets independent features use a coherent retargeting behavior. It is a common language, not a global personality that removes feature distinctions. Cursor can be fast, Typewriter can be quiet, Ripple can be softer, and structural flow can be bounded while all preserve current state and avoid restart.

## Regression lessons

| Failure history | Lesson |
| --- | --- |
| Ancestor dim → 1 → dim | Live ancestor alpha cannot be treated as the complete prior presentation state. |
| Focused marker inheriting ancestor dim | Structural chrome and direct content need explicit ownership boundaries. |
| Same-key focused replacement carrying old role | Semantic identity does not guarantee presentation-role continuity. |
| Sentence full-brightness plateau | Rebuilding a highlight must seed from actual presented state, not an arbitrary target. |
| Host paints new layout before a focused-only transform | The attach point is part of visual correctness, not an implementation afterthought. |
| Local Presentation Bridge duplicate/zero-box text | A visual workaround cannot create a second document surface without owning typography, selection, and lifetime. |
| Typewriter fighting host scroll | Actual user/host control must outrank a planned animation. |
| rAF timestamp versus performance.now offset | One monotonic business clock is safer than calibrating unrelated clocks. |

Evidence for the first five appears in commits e70b955, 8668a73, f456068, 6ea30f1, b8772dc, 292122c, 9c020ad, 13ef96e, 329a0cd, e4759c4, and docs/TERMINAL_FLASH_INVESTIGATION.md. Host and scroll evidence is in docs/SIYUAN_HOST_CONTRACT.md:20-149.

## v2.8.1 to Remake: what actually migrated?

| v2.8.1 mechanism | Underlying requirement | Remake expression | Status |
| --- | --- | --- | --- |
| semanticPlanner, styleApplier, structuralCarryover | Nested focus hierarchy and alpha continuity | blockPlan plus BlockPainter committed ancestry, presented values, rebind, and protection | Semantics retained; old style/registry mechanics discarded |
| sentenceTransition | Active sentence continuity and correct segmentation | sentenceModel, textProjection, CSS Highlight presentation, Session seed | Semantics retained; platform actuator replaceable |
| typewriter/flip and scroll helpers | Comfortable writing viewport and reverse continuity | Typewriter virtual state, Critical Motion, host takeover | Semantics retained; calibration and actuator rebuilt |
| structuralEdit and broad structural FLIP | Structural changes should not feel mechanical | StructureGate plus separate StructurePresentation and LayoutContinuity | Broad FLIP discarded; local flow is newer and pending feel acceptance |
| Cursor auxiliary modules | Caret follows writing and survives layout/editor transitions | Cursor state in one Session timeline plus editorScope | Product behavior retained; old scheduler boundaries discarded |
| old DebugKit summary/bridge/performance tools | Forensic visibility during natural reproductions | bounded Session-local DebugKit and build identity | Runtime diagnostics retained; offline tooling is incomplete |

This table is a knowledge migration, not a restoration plan. The audit found no confirmed runtime semantic loss, but did find lost diagnostic depth; see OPEN_QUESTIONS_AND_NON_GOALS.md.

## Relationship to zenTypeNext

zenTypeNext is a Windows-first, local-first, writing-first native Outliner / Continuous Document application. The transferable questions are:

- Is the Document Tree still the one truth?
- Does one Active Text Core have a clear owner?
- Can Presentation preserve continuity without making a second document?
- Can a new input retarget every visible effect from its current state?
- What is the safe degradation when Layout or Selection is not ready?
- Which work is bounded and which is allowed to wait?

These questions support the known Next separation of Document, View, NativeEditor, Layout, and Presentation authorities. They do not prescribe how those authorities should be implemented.
