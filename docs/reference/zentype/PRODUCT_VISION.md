# Product Vision

## The thesis

zenType is a writing-surface experiment whose purpose is to make a block editor feel like a continuous document without sacrificing the editor's truth, selection, input, or performance. Its value is not “adding animation to SiYuan.” The value is reducing the mechanical feeling of manipulating block-shaped UI while keeping the user's attention on writing.

The product deliberately concentrates on a small core:

1. a cursor that stays attached to the act of writing;
2. a typewriter behavior that protects visual comfort without fighting the user;
3. a focus ripple that gives the current sentence and structural context a readable visual hierarchy.

The small feature set is intentional. More effects would not automatically make writing better. Every effect must earn its cost in attention, latency, complexity, and host interference. The historical product description and feature split are recorded in README.md and docs/CHANGELOG.md; the current authority boundary is stated in docs/DESIGN.md:7-15.

## Continuous Document

“Continuous document” does not mean flattening a document tree, hiding every boundary, or applying a document-wide FLIP animation. It means that a user can edit a structured document without perceiving every structural operation as a discrete DOM-block transaction.

The user-visible meaning is:

- the caret remains attached to the text it is editing;
- content yields and fills when a split, merge, indent, or outdent changes the local layout;
- the current writing context remains legible while surrounding context recedes;
- a host replacement, reparent, or temporary loss of geometry does not expose a bright/dim or old/new ownership handoff;
- the editor remains truthful even when continuity cannot be safely shown.

The underlying structure is still real. Host structure wins. Continuity is a presentation of a known change, not an alternative document model. This distinction is the central lesson of the Remake's StructureGate, Session, and separate structural presentation paths; see docs/DESIGN.md:7-15 and docs/CRITICAL_MOTION_LAYOUT_CONTRACT.md:14-36.

## Writing-first

Writing-first means input correctness and user agency outrank visual completion:

- typing and navigation respond immediately;
- ordinary character deletion does not pay structural-capture latency;
- Selection and IME remain native responsibilities;
- a manual scroll or selection can take back control;
- uncertain or stale geometry is withheld, faded, or released instead of guessed;
- reduced motion preserves the same semantic and authority behavior.

The correct fallback is less animation, not interference with editing. This priority is explicit in docs/DESIGN.md:41-52 and is reflected in the ordinary-delete fast path and lifecycle cancellation in src/session.ts:596-745.

## Restraint

zenType treats animation as a perceptual aid, not decoration. It should not:

- animate every DOM mutation;
- restart an effect merely because its target was recomputed;
- create duplicate text, ghost blocks, placeholders, or detached presentation surfaces;
- make the user wait for an animation before the editor accepts the next action;
- claim ownership of host transforms, scroll, Selection, or composition;
- keep an unbounded observer, timer, or identity registry alive.

When the product cannot establish a safe subject and target, it should fail closed. This is a product-quality decision because a wrong caret, stolen scroll, or flickering focused marker is more damaging than a missing transition.

## Performance as product texture

“Fast” is not only a benchmark result. In a writing tool, latency, scheduling contention, forced layout, and stale frames are directly felt as loss of softness. A quiet input path, one business frame, bounded reads, and bounded topology work make the product feel calm.

The current Remake reduced the number of runtime authorities substantially: the audit measured 27 TypeScript files and 4,749 TypeScript lines versus 58 and 13,216 in v2.8.1, with one Session-owned business rAF rather than feature-local scheduler families (docs/DEAD_CODE_PATCH_DEBT_AUDIT.md:320-347). This is evidence of reduced cognitive and scheduling load, not a claim that fewer lines automatically produce better UX.

## Elegance

In this project, code elegance and interaction warmth are related. A single owner for each fact makes it possible to preserve a visual object through interruption; separating Host truth from presentation prevents the effect layer from fighting the editor; one motion law keeps retargeting coherent. Conversely, duplicated authorities tend to appear to users as restart, flash, drift, or delay.

This is a design hypothesis synthesized from the migration and regression history, not a demand that zenTypeNext copy the current module names.

## Product invariants

The following are the ten highest-value product invariants. The evidence label distinguishes the user value from the maturity of the current implementation.

| Invariant | User meaning | Evidence |
| --- | --- | --- |
| Writing outranks animation | Input, Selection, IME, and user scroll win over visual continuity. | Mature; docs/DESIGN.md:41-52 |
| A block editor should read as a continuous document | Local structure changes should not feel like unrelated boxes being moved. | Mature product intention; docs/DESIGN.md:7-15, docs/CHANGELOG.md:3-30 |
| Host truth wins | The effect never invents document structure or final layout. | Architecture-accepted; docs/DESIGN.md:7-25 |
| The caret stays attached to writing | Text, caret, and current editor remain spatially coherent through movement or safe degradation. | Regression-validated; src/modules/cursor.ts:239-281 |
| Focus has readable hierarchy | Current content is clear; nearby context recedes by semantic distance without dimming the focus path. | Regression-validated; commits e70b955, 8668a73, f456068, 292122c |
| Ordinary text edits stay ordinary | A local character edit should not be mistaken for a structural transaction. | Regression-validated; src/structure.ts:231-238, tests/remake.test.ts |
| Structural edits yield and refill | Enter, merge, indent, and outdent preserve local continuity where evidence is safe. | Desired / pending for newer flow paths; docs/CRITICAL_MOTION_LAYOUT_CONTRACT.md:22-56 |
| Continuity beats restart | A retargeted visual subject continues from its presented state and velocity. | Regression-validated; src/motion.ts:6-45, tests/remake.test.ts |
| The user can interrupt | New input, navigation, selection, composition, scroll, blur, or lifecycle changes can cancel or retarget effects. | Regression-validated; src/session.ts:596-786 |
| Uncertainty degrades safely | No stale geometry, ghost content, or ownership fight is preferable to a confident wrong frame. | Architecture-accepted; docs/DESIGN.md:41-52, 97-109 |

## What is product knowledge versus current implementation?

Critical Motion, the 150 ms structural response, the cursor breathing cadence, the six-level alpha gradient, and the 48/160 ms StructureGate windows are current solutions or calibration. They are useful references, but none is automatically a zenTypeNext product invariant.

The transferable requirement is, for example, “structural movement must read as continuous yielding.” The current realization is a bounded local flow engine plus a shared critical trajectory. Next may choose a native layout/animation system that satisfies the same semantic test.

## v2.8.1 and the Remake

v2.8.1 is a mature behavior reference, not an architecture gold standard. It demonstrated the value of cursor comfort, typewriter scrolling, sentence transitions, nested focus hierarchy, and stable structural editing. The Remake intentionally discarded many feature-local schedulers, broad FLIP paths, inline style ownership, and old diagnostic bridges while preserving the underlying writing experience where evidence supported it.

The migration question is therefore not “how do we restore the old file?” It is “what user requirement did the old file protect, and where is that requirement expressed now?” TRANSFER_MATRIX.md records those answers.
