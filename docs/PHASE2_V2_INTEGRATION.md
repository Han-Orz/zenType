# Phase 2 v2 — Session integration

This branch intentionally keeps the real-machine-PASS Tab/Shift+Tab path unchanged. `structurePresentation.ts` remains the single-item list reparent owner. `layoutContinuity.ts` is only for Enter/Delete/Backspace document flow.

## Session wiring

Instantiate one `createLayoutContinuity(debug)` beside `createStructurePresentation(debug)`.

### Keydown admission

Keep the existing StructureGate intent generation.

- `indent` / `outdent`: keep the existing `presentation.capture(...)` exactly as the Phase 1 baseline.
- `Enter`: arm layout continuity with the current focused block, editor, `frame.viewport`, and the current Host caret point as `continuationOrigin`.
- `Backspace` / `Delete`: **do not capture** when the current frame proves an ordinary interior text delete. Reuse/export the same predicate currently used by StructureGate (`hasSafeOrdinaryTextPosition`) rather than maintaining two subtly different definitions. Only boundary/ambiguous deletes arm layout continuity.

Do not read a 24-item neighborhood on every ordinary keydown. The layout engine itself is viewport-bounded and should only run for possible structural edits.

### Mutation delivery

Do not change the Phase 1 Ripple sequence:

`ripple.rebind -> ripple.freeze -> carry -> ripple.protectFocus`

This sequence is the real-machine marker/Ripple baseline.

When `changes.kind === "structural"` and StructureGate publishes authority from the matching generation:

1. run the existing single-item `structurePresentation.attach(...)` (it is a no-op unless Tab armed it);
2. run `layoutContinuity.attach(authority.generation, now, reducedMotion.matches, changes.added, focused?.block ?? null)` (it is a no-op unless Enter/Delete/Backspace armed it).

Do not make Tab use the flow engine merely for uniformity.

### Session frame

Advance both geometry consumers from the same Session frame:

- `const reparentOffset = presentation.step(now, reducedMotion.matches)`
- `const flowMoving = layout.step(now, reducedMotion.matches)`

After `readEditorFrame(...)`, resolve the flow offset against `next.block`:

`const flowOffset = layout.offsetFor(next?.block ?? null)`

The effective caret carry is `flowOffset ?? reparentOffset` because the two modes are mutually exclusive per structural generation. Remove that effective offset from sampled Host caret geometry before StructureGate consumes it, then add it back through `presentedFrame(...)` for Cursor presentation.

Queue another Session frame while `flowMoving` is true.

### Lifecycle

`layout.abandon()` when the current structural intent resolves ordinary without structural evidence.

`layout.cancel()` on lifecycle suspension, editor switch, configuration teardown, destroy, timeout/overflow release, and any path that already cancels structural presentation entirely.

## Required tests before real-host use

1. Existing Phase 1 Tab/Shift+Tab + marker tests remain unchanged and pass.
2. Plain Enter moves following visible content and the new split continuation without a zero-motion first frame.
3. Nested Enter propagates to following siblings on outer ancestor planes.
4. Backspace/Delete interior-text fast path arms no layout capture.
5. Boundary Backspace/Delete captures and animates survivors.
6. Same-key replacement while motion is running rebases onto the new actuator with value/velocity continuity.
7. Rapid Enter/Backspace retargets from the currently presented position.
8. Reduced motion writes no transient geometry presentation.

## Non-goals

No clone, ghost deletion, placeholder, height animation, second rAF, timer scheduler, extra observer, document-wide snapshot, or marker geometry animation.
