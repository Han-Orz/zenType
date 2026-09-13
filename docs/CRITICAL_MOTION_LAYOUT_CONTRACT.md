# Critical Motion / Layout Continuity Contract

Baseline: `a57a86637b73ab1851aee5b59877a3277d6d5f01` (Phase 1 real-machine PASS).

## Authority

- Host owns DOM, semantic structure and final layout.
- StructureGate decides whether an edit is structural and owns structural generations.
- WritingSession is the only business frame/timeline authority.
- Critical Motion owns motion trajectories.
- Ripple owns alpha presentation; Structure Presentation owns geometry presentation.
- WAAPI may remain a paused pixel actuator. It must not own easing, duration, scheduling or semantic state.

## Phase 1 freeze

Phase 1 Block Ripple is a validated baseline. In particular, Tab/Shift+Tab Ripple and marker continuity must not regress while layout continuity is added. Do not broaden Tab from its validated focused-list-item displacement merely to make the implementation look generic.

## Local layout continuity

Local layout continuity hides Host-correct but instantaneous reflow. It is not a document-scale FLIP runtime.

For Enter/Delete/Backspace, the affected region is a **layout impact path**, not a fixed number of following blocks:

1. Start at the focused semantic block.
2. At each structural ancestor plane, capture following semantic siblings that can visibly move.
3. Continue upward while the current path can change an ancestor's extent.
4. Bound reads by the visible viewport plus overscan and by a hard safety limit.
5. Never animate markers or attribute/decorative nodes as geometry subjects.

Only surviving semantic content is matched by stable key. A same-key replacement rebinds the same running presentation state instead of restarting it.

## Split continuation

Enter is special: a newly created block may contain text that visually continued from the old block. That is a presentation continuation even though its DOM/semantic key is new. The implementation may carry the pre-edit caret origin into the newly focused structural root so the continuation moves from the old reading position into the Host's new layout.

This continuation is geometry only. It must not invent semantic identity or change Host structure.

## Hot-path rule

Ordinary text editing must not pay structural-layout capture cost. Backspace/Delete at a proven interior text position must skip layout geometry capture. Structural capture is only armed when the edit can change layout.

## Motion rule

A newly attached layout displacement starts advancing on the first Session frame after mutation delivery; do not add an artificial zero-motion frame. Repeated structural edits retarget/rebase from the currently presented position.

## Safety

- No second rAF loop, timer scheduler, observer or clock.
- Never overwrite a Host/theme transform. Fail closed per subject.
- No clone, placeholder, ghost deletion, height animation or document-scale snapshot in this phase.
- Geometry subjects and Ripple alpha owners are separate concerns. A geometry change must not require repartitioning marker alpha.

## Acceptance

Real-machine acceptance must cover: plain Enter split, plain Backspace/Delete merge, rapid repeated edits, nested-list flow, Tab/Shift+Tab with marker Ripple, IME/selection, and long-press ordinary Backspace/Delete responsiveness.
