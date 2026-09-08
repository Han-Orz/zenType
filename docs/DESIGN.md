# v2.9.0-remake.1 baseline

## Ownership

One WritingSession owns document events, an active host binding, observers, one rAF and one idle wake timer. Cursor, Typewriter and Ripple import no other effect. Their numerical motion state survives target changes; document identities do not become animation identities.

The host adapter validates official active Protyle, DOM focus, Selection endpoints and editability. Frame data can carry a valid editor with missing caret geometry. A composition range uses its focus endpoint, never rewrites the browser Selection, and remains distinct from an ordinary selection.

Session intent is separate from geometry. Input establishes writing intent; browsing cancels automatic scrolling. Composition belongs to an editor. Editor switches discard old effect bindings. Lifecycle and DOM events invalidate observations, never certify transaction completion.

## Frame

Events mark dirty fields and enqueue one frame. Mutation callbacks inspect affected records without geometry reads; plugin presentation attributes are not observed. Text dirtiness is limited to the current editable. Structure changes invalidate the local text projection and ancestry.

A frame resolves host facts when dirty, moving the viewport, or within a bounded recovery observation window. Cursor-only interpolation and Ripple-only fades reuse the last valid geometry. Geometry and text projection precede scroll/overlay/highlight writes, except presentation cleanup which removes cloned plugin attributes before sampling.

The actual scrollTop after a write is authoritative. The frame transports measured caret geometry by that actual delta. Cursor separately transports its current and target positions by changes in the scroll container origin, outer scroll and shared nested scrollers. Only the remaining local difference is interpolated.

After motion settles there is no continuous JavaScript loop. A single delayed wake starts CSS breathing. Resize, fonts, viewport events and theme changes invalidate observations.

## Effects

### Cursor

Maintains current/target position and height, last valid sample, current native-caret owner and motion time. A new editable within the same editor transfers ownership without resetting motion. Exponential approach has no old start/end timeline and supports reversal.

Missing geometry retains the previous presentation for at most 160ms, retries, then releases ownership. This is a recovery budget, not a claimed SiYuan settling duration. Ordinary IME does not enter this fallback merely because the Selection is noncollapsed.

The overlay handles viewport clipping/edge fade; its inner ink handles breathing. Neither changes the editor layout or Selection. Out-of-view ownership does not trigger scrolling.

### Typewriter

Uses a comfort band, hysteresis anchor, target, previous frame time and last actual write. New targets start from real scrollTop. An unexpected host scroll drops the old target. Manual browsing explicitly disables following until the next edit.

Comfort adjustments wait for a short typing pause; proximity to an edge starts following early. Already clipped carets get immediate visibility correction. All writes clamp to current bounds. Composition pauses plugin scrolling while native scrolling remains available.

### Ripple

Block presentation is a map of current/target alpha and owned private style values. Focus ancestors are neutral; sibling branch roots dim without nested opacity multiplication. Retired bindings return toward 1 before releasing. Detached nodes are released immediately.

Sentence projection excludes noneditable subtrees and nested block nodes. Intl.Segmenter provides UTF-16 boundaries. Current alphas are reused only for identical mapped boundaries in the same editable, using the unchanged prefix/suffix around a local edit. There is no block-ID recovery or ordinal identity system.

CSS Highlight registrations are grouped into 65 alpha buckets with fixed rules. Relative currentColor preserves underlying text colors. Only changed bucket memberships are registered; there is no per-frame stylesheet regeneration. New bindings start neutral, while surviving bindings retain current alpha.

Work limits are explicit: 32,768 UTF-16 units, 2,048 text nodes, 256 sentences; exceeding them keeps block focus. Ancestry targets are bounded to 48 content siblings per direction per level.

## Lifecycle and failure

Blur, external focus, ordinary selection and destruction release presentation. A null focusout target merely invalidates observations because node replacement can remove focus targets. Copied plugin attributes on added nodes are cleaned without adopting old motion identities; still-owned reparented nodes retain their local values.

Unload releases listeners, observers, frame/timer, private styles, highlights and cursor. Unexpected frame exceptions restore native presentation and stop the session until valid user activity or lifecycle refresh. No document mutation API, selection repair, event cancellation, tracked ranges, FLIP or structural transaction coordinator is used.

## Evidence and limits

Host snapshot: [SiYuan 8641553a](https://github.com/siyuan-note/siyuan/tree/8641553a1f07374001902d3ce773285db1292b2d).

- [Active editor resolution](https://github.com/siyuan-note/siyuan/blob/8641553a1f07374001902d3ce773285db1292b2d/app/src/plugin/API.ts#L238) also consults Selection; DOM focus still needs validation.
- [Host caret scrolling](https://github.com/siyuan-note/siyuan/blob/8641553a1f07374001902d3ce773285db1292b2d/app/src/protyle/wysiwyg/caretScroll.ts#L55) can write scrollTop in another rAF.
- [Content replacement](https://github.com/siyuan-note/siyuan/blob/8641553a1f07374001902d3ce773285db1292b2d/app/src/protyle/util/onGet.ts#L317) can replace nodes and restore scrollTop.
- [Composition completion](https://github.com/siyuan-note/siyuan/blob/8641553a1f07374001902d3ce773285db1292b2d/app/src/protyle/wysiwyg/index.ts#L4007) includes asynchronous handling.
- [Highlight currentColor](https://drafts.csswg.org/css-pseudo-4/#highlight-text) derives from underlying highlight/text colors.

Pure motion and presentation checks are not host integration tests. Actual IME variants, empty-block geometry, bidi/wrapped boundaries, nested clipping, popup stacking, replacement timing and theme interference still require SiYuan feedback. The baseline keeps those uncertainties visible instead of building speculative compatibility machinery.
