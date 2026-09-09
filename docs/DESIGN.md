# v2.9.0-remake.1 baseline

## Ownership

One WritingSession owns document events, an active host binding, observers, one rAF and one idle wake timer. Cursor, Typewriter and Ripple import no other effect. Numerical motion state survives target changes. Ripple may hand local alpha between a binding and its same-node-id replacement, connected or not, and may seed a replaced ancestor with a retired alpha; no persistent identity registry is used.

The host adapter validates official active Protyle, DOM focus, Selection endpoints and editability. Frame data can carry a valid editor with missing caret geometry. A composition range uses its focus endpoint, never rewrites the browser Selection, and remains distinct from an ordinary selection.

Session intent is separate from geometry. Input establishes writing intent; browsing cancels automatic scrolling. Composition belongs to an editor. Editor switches discard old effect bindings. Lifecycle and DOM events invalidate observations, never certify transaction completion.

## Frame

Events mark dirty fields and enqueue one frame. Mutation callbacks inspect affected records without geometry reads; plugin presentation attributes are not observed. Text dirtiness is limited to the current editable. Structure changes invalidate the local text projection and ancestry.

A frame resolves host facts when dirty. A comfort scroll is not a host-fact change: the frame transports the measured caret and the cursor by the displacement it wrote, so resampling every animation frame is unnecessary. The container's own scroll event, matching the value the typewriter just wrote, therefore does not invalidate geometry; host-driven scrolling still does. Recovery deadlines wake through the idle timer instead of continuously resampling missing geometry. Cursor-only interpolation and Ripple-only fades reuse the last valid geometry. Within a frame every host-fact read (geometry, text colors, ink opacity) happens before any presentation write, so a frame never forces a style recalc of the invalidation it is about to make. Scroll writes and their actual-position readback precede Ripple preparation; without a scroll write, the sampled position is reused. Text colors are sampled in a batch when bindings are acquired, then cached until theme invalidation or binding release. Fade-only frames do not read text colors.

Same-element inline color/style edits are intentionally not observed: format integrations must call `WritingSession.refresh()` after applying them. This explicit entry invalidates the color cache and queues a fresh projection, as theme changes do. Without that call, cached colors remain until theme invalidation or rebinding. Observing all style writes would also observe plugin presentation writes.

Unowned copied `--zentype-text-color` values are removed from text parents during the existing bounded `projectText` traversal; owned parents are preserved. There is no whole-subtree style-substring search. Nodes outside that projection are not scanned; an unregistered highlight cannot apply the copied property there.

An invalid structural sample waits on the existing idle timer until the recovery deadline; DOM and Selection events may wake it sooner. Waiting alone does not mark geometry dirty or enqueue another frame. The timer also preserves the typing-pause deadline.

The actual scrollTop after a write is authoritative. The frame transports measured caret geometry by that actual delta. Cursor separately transports its current and target positions by changes in the scroll container origin, outer scroll and shared nested scrollers. Only the remaining local difference is interpolated.

After motion settles there is no continuous JavaScript loop. A single delayed wake starts CSS breathing. Resize, fonts, viewport events and theme changes invalidate observations.

## Effects

### Cursor

Native-caret ownership follows the valid frame's editable, including caretless and selection frames. Overlay fading does not release that ownership; its completion clears only presentation. Session passes the selection frame's editable to Cursor so drag-selection can transfer the binding even while the overlay is hidden. A missing host frame, lifecycle hide, editor switch or destruction releases ownership. This uses the existing owner reference, without a second registry or DOM scan. Fade-in and fade-out each reach 95% in approximately 120ms; release freezes the displayed ink brightness once before fading.

Editor-switch settling uses eight consecutive valid caret samples within 0.15px (position and height), or a 700ms deadline, whichever comes first. Same-editor structural edits use the same gate after a block-level mutation: two consecutive stable samples, or the existing 160ms recovery deadline. The structural gate keeps the last displayed cursor in place and does not fade it in; a host block mutation must be observed before the stable run can complete. Missing geometry resets the stable run. Cursor reuses its target rectangle and adds only a stable-sample count; Session passes its frame time and continues its existing dirty-geometry loop while settling. Release, selection takeover and hide cancel settling. Reduced motion skips the wait. Expiry without valid geometry ends settling without revealing a stale cursor.

Maintains current/target position and height, last valid sample, current native-caret owner and motion time. A new editable within the same editor transfers ownership without resetting motion. Exponential approach has no old start/end timeline and supports reversal.

A collapsed range at a block boundary has no client rect. That recovery is scoped to the caret's own `[data-node-id]` block, never to the editable root: the root spans the whole document, so its text is never empty and a probe inside it can resolve to another block's line. Within that scope the caret is recovered from the adjacent glyph, then from the nearest sibling text node, and finally, for a block with no content of its own, from the block's content box and line height.

Missing geometry retains the previous presentation for a 160ms recovery budget. If the budget expires while the same editable still reports a collapsed caret with a live Range and the frozen overlay is on screen, the presentation is held in place instead of handing the caret back to the host: block boundaries, separators and unmeasurable empty lines are host-measurement gaps, not ownership changes. Selection, input, mutation, resize and theme events resume measurement, and the recovery wake is suppressed while holding. A frozen overlay that is clipped or outside the viewport releases ownership instead, because a held cursor the user cannot see is worse than the native one. A missing caret in any other state also releases ownership. This is a recovery budget, not a claimed SiYuan settling duration. Ordinary IME does not enter this fallback merely because the Selection is noncollapsed. On an editor switch the overlay stays hidden until the measured caret position holds still for a few consecutive samples, or a bounded settle deadline passes, so a themed tab-switch animation cannot be chased by an interpolating cursor.

The overlay handles viewport clipping, edge fade, a 1px visual lift and selection release/reacquisition fades. Its inner ink breathes over 4s after the idle threshold plus an additional 1.5s CSS delay, holding full opacity for most of the cycle and dipping once per cycle. Interrupting breathing samples the ink once and animates back to full opacity over 200ms; selection release freezes that brightness before fading out from the logical overlay alpha, not from the clipped edge-fade product. Settled motion discards its frame timestamp. Neither layer changes editor layout or Selection.

### Typewriter

Uses a comfort band, hysteresis anchor, target, previous frame time and last actual write. New targets start from real scrollTop with bounded distance-dependent response and fresh timing. An unexpected host scroll drops the old target and yields until a newer input. Manual browsing disables following; a plain click outside 25–75% requests one alignment to 50% without activating writing intent.

Comfort adjustments wait for a short typing pause; proximity to an edge starts following early. Already clipped carets get immediate visibility correction. All writes clamp to current bounds. Composition pauses plugin scrolling while native scrolling remains available.

### Ripple

Observed in the 2026-09-09 DebugKit recording (sequences 685–1025): Backspace merges into a replacement block carrying inline `opacity: 0.4` without the Ripple class. The frame-local same-node-id handoff now also snapshots the predecessor's original and last-written opacity. When the replacement's inline opacity matches that last write, its binding preserves the predecessor's original style for release; a different host value is preserved as-is. No persistent registry or additional DOM scan is needed.

Block presentation uses disjoint branch owners and browser-driven opacity animations. Targets are written only when changed, as a plain inline `opacity` on the owner rather than a custom property: an inline custom-property write invalidates the element's whole subtree, which a measured trace showed forcing a document-scale style recalc (~25k elements, ~140ms) on every focus-mode entry and exit. Opacity is not inherited, so a nested list still cannot multiply a parent's dim into a child's. Markers and their item's direct content use the same semantic distance; a sibling item is still represented by its branch root, so descendants are not independently retargeted. Block fades do not keep the Session rAF running. On structural handoff, current animation progress supplies local baselines before ancestor ownership is released; a same-node-id predecessor contributes its alpha whether or not it is still connected, so a host that inserts the replacement before removing the original still hands the branch over. A retired owner that now sits inside a live target folds its alpha up into that target's baseline before being released, because the target's own opacity is rewritten to its level and the inherited product would otherwise jump in one frame. A retired owner that is already fading out keeps fading instead of being released mid-fade, and an ancestor replaced by a new element with the same node id is seeded with the retired alpha and faded out, so a host re-render never swaps a dimmed branch for a bright one in a single frame. Focus ancestors remain neutral. Retired bindings fade toward 1, then release on animation completion. Coverage of a retired owner by a live target is derived from target ancestry rather than element-pair containment. Detached nodes transfer only numeric alpha to locally matched replacements. Existing inline presentation left by an older build is outside the remake's ownership and must be cleared during development when needed; the runtime does not scan or rewrite an entire editor to migrate it.

Sentence projection excludes noneditable subtrees and nested block nodes. Intl.Segmenter alone provides UTF-16 boundaries, without punctuation post-processing. Local edits reuse mapped boundaries; deletion can preserve a surviving start anchor. A detached editable's same-block replacement may reuse this mapping. A caret that resolves into an excluded subtree (a boundary next to an inline non-editable element, or a nested block) anchors to the nearest preceding projected text node rather than dropping the sentence state, which would flicker the highlights and force a color re-sample every frame. No ordinal identity system is used.

CSS Highlight registrations are grouped into 65 alpha buckets with fixed rules. A private custom property on each text parent supplies its actual text color, including inline colors, without depending on highlight currentColor resolution. Only changed bucket memberships are registered; there is no per-frame stylesheet regeneration. New bindings start neutral, while surviving bindings retain current alpha.

Two reusable bucket buffers alternate between current membership and scratch space, so comparison never clears its own previous data. Highlight objects are still replaced only when membership changes. Motion parameters, including generated breathing CSS variables, live in `config.ts`; active motion allows up to 100ms elapsed time while settled motion resets its timestamp.

Work limits are explicit: 32,768 UTF-16 units, 2,048 text nodes, 256 sentences; exceeding them keeps block focus. Ancestry targets are bounded to 48 content siblings per direction per level.

## Lifecycle and failure

Blur, external focus and destruction immediately release presentation. Ordinary selection fades the cursor and Ripple out; disabling Ripple also fades it out. A null focusout target invalidates observations, with bounded recovery while focus remains in the editor or on body. Copied plugin attributes on added nodes are cleaned; still-owned reparented nodes retain their local values.

Unload releases listeners, observers, frame/timer, private styles, highlights and cursor. Unexpected frame exceptions restore native presentation and stop the session until valid user activity or lifecycle refresh. No document mutation API, selection repair, event cancellation, tracked ranges, FLIP or structural transaction coordinator is used.

### Diagnostics

Development builds start a full DebugKit session by default. It reuses Session's existing event path, MutationObserver records and EditorFrame; it owns no observer, rAF or timer of its own. Cursor, Typewriter and Ripple report scalar state already computed during their normal presentation paths. Full snapshots are bounded and may include text, Selection, DOM paths, geometry and computed style, so exported recordings are sensitive and are not performance baselines. Production builds replace the hook with a noop module.

## Evidence and limits

Host snapshot: [SiYuan 8641553a](https://github.com/siyuan-note/siyuan/tree/8641553a1f07374001902d3ce773285db1292b2d).

- [Active editor resolution](https://github.com/siyuan-note/siyuan/blob/8641553a1f07374001902d3ce773285db1292b2d/app/src/plugin/API.ts#L238) also consults Selection; DOM focus still needs validation.
- [Host caret scrolling](https://github.com/siyuan-note/siyuan/blob/8641553a1f07374001902d3ce773285db1292b2d/app/src/protyle/wysiwyg/caretScroll.ts#L55) can write scrollTop in another rAF.
- [Content replacement](https://github.com/siyuan-note/siyuan/blob/8641553a1f07374001902d3ce773285db1292b2d/app/src/protyle/util/onGet.ts#L317) can replace nodes and restore scrollTop.
- [Composition completion](https://github.com/siyuan-note/siyuan/blob/8641553a1f07374001902d3ce773285db1292b2d/app/src/protyle/wysiwyg/index.ts#L4007) includes asynchronous handling.
- [Highlight currentColor](https://drafts.csswg.org/css-pseudo-4/#highlight-text) derives from underlying highlight/text colors.

Pure motion and presentation checks are not host integration tests. Actual IME variants, empty-block geometry, bidi/wrapped boundaries, nested clipping, popup stacking, replacement timing and theme interference still require SiYuan feedback. The baseline keeps those uncertainties visible instead of building speculative compatibility machinery.
