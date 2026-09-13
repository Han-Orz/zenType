# Interaction and Motion Language

This document describes motion personality rather than an animation-parameter contract. The current Critical Motion implementation is evidence for the language, not the only possible implementation.

## The primary verbs

zenType motion should:

- respond;
- continue;
- yield;
- re-target;
- settle;
- disappear safely.

It should not:

- restart;
- flash;
- fight;
- teleport;
- expose a handoff;
- wait forever for perfect geometry.

## Ten principles

| Principle | Meaning | Typical failure |
| --- | --- | --- |
| Responsiveness | A new input changes the visual target immediately; the user never waits for an old transition to finish. | Animation completion gates input. |
| Continuity | A visual subject preserves its current presented value when its target changes. | Cancel, reset, then start from a default. |
| Interruptibility | New input, navigation, scroll, Selection, or lifecycle events can retarget or cancel. | A timer or queue owns the user. |
| Velocity matters | A retarget begins with the current direction and velocity where that is meaningful. | Every reversal looks like a fresh ease-in. |
| One subject, one actuator | One physical displacement or alpha owner is responsible for one presentation write. | Two effects double-apply an offset. |
| No handoff seam | System A must not finish with a flash before System B becomes visible. | Old owner disappears, new owner starts at 0 or 1. |
| Structural yielding | Content makes room and fills the local gap; a block is not theatrically flown as an independent card. | Broad FLIP makes the editor feel dragged. |
| Edge hierarchy | Active text and caret may move clearly; background context should remain quiet and stable. | Every ancestor and sibling moves together. |
| Restraint | No animation is a valid result for ordinary edits, uncertainty, reduced motion, or host ownership. | Decorative motion interferes with writing. |
| Boundedness | Work, waiting, traversal, and recovery have explicit ceilings. | A stale transition survives indefinitely. |

These principles synthesize src/motion.ts:6-45, src/session.ts:294-345, docs/DESIGN.md:97-109, and the regression chain recorded in docs/CHANGELOG.md and docs/DEAD_CODE_PATCH_DEBT_AUDIT.md.

## Critical Motion philosophy

The current law is a critically damped analytic trajectory with a shared monotonic clock. ResponseMs is calibrated so that a trajectory reaches roughly 90 percent of a displacement from rest by the requested response time. Retargeting preserves the current value and velocity; reduced motion can commit directly to the target.

This solves several recurring problems:

- easing curves do not need to be coordinated across features;
- large elapsed time does not require frame-count assumptions;
- a reverse direction does not expose a restart;
- Cursor, Typewriter, Ripple, and structural displacement speak a compatible motion language.

Critical damping is not a zenTypeNext dogma. The product requirement is continuity, responsiveness, and bounded control. A native implementation may use a different physically coherent law if it passes the same scenarios.

## Continuation over restart

When the target changes:

1. sample the current presented state;
2. keep the current velocity when the subject is still semantically the same;
3. change the target;
4. commit through the existing owner.

For a replacement actuator, semantic identity may permit state rebind, but presentation role must be checked separately. A same-key replacement that becomes focused is not automatically the same dim role. This rule prevents the historical focused replacement 1 → 0.4 → 1 regression (docs/DESIGN.md:135-145; commits 9c020ad, 0a68a53, 13ef96e).

## Structural motion

Structural motion is about reading an edit as a local change in a document:

- Enter opens space at the caret and gives the following content room;
- a merge closes a local gap and lets surviving content settle;
- indent/outdent changes hierarchy while preserving subject continuity;
- the caret and content share the same structural displacement.

This is different from “the block moved from old rectangle A to new rectangle B.” The rejected focused-only transform prototype demonstrated why: it attached after the host had already painted the new position, producing a jump to the new layout and a pullback. The replacement owner attaches during mutation delivery and remains limited to the known subject (commits 329a0cd, e4759c4, c13ad7a; docs/SIYUAN_HOST_CONTRACT.md:43).

## Truth, presentation, and motion

Motion must never become a second truth system:

- Host reads provide final structure, Selection, caret, scroll, and layout facts;
- Structure admits a bounded change and its generation;
- Session orders one business frame;
- a feature chooses the semantic target;
- Motion computes a trajectory;
- a Painter commits to a known actuator.

The MutationObserver delivery window is not a general geometry-planning phase. The current exception is a bounded same-key owner rebind, needed to avoid a no-owner frame after a host replacement. Geometry belongs in the Session read phase (docs/DESIGN.md:97-109).

## Edge hierarchy

Not every object deserves the same motion:

- caret and active content need immediate spatial coherence;
- the local flow path may move enough to explain a split or merge;
- focused marker/content must not dim through an ancestor;
- nearby context should change alpha quietly;
- distant background should not become a second animated scene;
- host-owned transforms and scroll must remain untouched.

This hierarchy is why Block Ripple tracks ancestor planes and direct content separately, why LayoutContinuity is viewport/overscan bounded, and why ordinary character deletion has a fast path.

## When not to animate

Do not animate when:

- the mutation is an ordinary interior character edit;
- there is no trusted subject or generation;
- geometry is missing or stale past the recovery budget;
- the host or user owns the transform/scroll/Selection;
- composition is active;
- the document is hidden and presentation would require asynchronous work;
- the work would exceed a safety bound;
- reduced motion is enabled.

“No animation” must still leave the document correct and the next frame authoritative.

## Calibration versus semantic law

Examples of calibration:

- structuralMoveResponseMs = 150;
- Cursor typing response = 55 ms;
- comfort-band edges;
- alpha levels;
- breathing down/up timing;
- 48 ms quiet and 160 ms deadline;
- viewport overscan and hard limits.

Examples of product semantics:

- structural movement reads as continuous yielding;
- user scroll wins;
- focused content does not flash;
- a retarget continues from the current state;
- ordinary deletion remains immediate;
- uncertainty fails closed.

Calibration can and should be remeasured for a native platform. Semantic regression must not be hidden as “parameter tuning.”
