# Structural Ripple presentation handoff

Status: Awaiting real-machine visual acceptance.

## Evidence and scope

- User-observed: v2.8.1 `6c3ac0442c6b97292151c71732ae1100c1846533` presents Tab / Shift+Tab continuously; v2.9 Tab has a terminal dim/pause/flash, which disappears with Ripple disabled.
- The supplied investigation records eight completed gate/motion/hold cycles in `zentype-debug-20260912-225421-4ad54a45.json`, SiYuan 3.8.3. Tab creates a new NodeList wrapper and reparents the item. No timeout, overflow, frame error or transform takeover was reported. These are prior investigation results, not a new runtime verification.
- Terminal zero-frame hold and deferred block handoff did not resolve the visual artifact. Deferral placed the 360ms block transition after structural displacement finished.

## Source-confirmed defect

`planHandoff()` multiplied an existing marker's sampled opacity by its live ancestors' old opacity. After indent, those ancestors describe the new DOM, not the marker's previous presentation. For example, two independent owners at 0.475 became a handoff baseline of 0.225625, followed by a fade back to the semantic target. The committed ancestry was missing from Paint.

A second discontinuity was in replacement carry: a frozen replacement overwrote its semantic target with its sampled value. The admitted commit then installed another transition even when the semantic target had not changed.

## Repair

BlockPainter samples composite alpha from the previous committed Paint ancestry. Existing semantic owners retain that baseline; newly exposed targets inherit the nearest old donor. Residual child factors are normalized against the incoming parent baseline. Replacement carry pauses the effect while retaining its target and presentation ancestry. All incoming effects are installed before outgoing owners are cancelled.

This ports the old version's baseline-before-retarget semantics, not its inline opacity, forced layout, carryover registry or deferred rAF runtime. WritingSession remains the only frame authority. The gate, motion law, marker mapping, target neighborhood and Host/theme ownership rules are unchanged.

Removed experimental worktree paths: terminal zero-frame hold, structural-Ripple deferred handoff, expanded local structural transform field and their experimental tests/build label. Structural displacement uses the original exact-subject owner.

Regression tests cover in-flight Tab/new-wrapper/Shift+Tab handoff, nested residual composite alpha, and paused same-key replacement without a second effect at semantic commit. Automated tests do not establish browser pixels; the user's real-machine Tab / Shift+Tab visual acceptance remains pending.
