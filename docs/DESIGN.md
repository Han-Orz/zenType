# v2.9.0-remake.2.6-delete.1

## Canonical five-layer architecture

The product boundary is deliberately small:

> Host decides truth. Structure describes change. Session grants authority. Feature decides target and personality. Motion decides trajectory. Painter commits.

### 1. Host Truth

**Owns:** the facts returned by SiYuan and the browser: `EditorFrame`, active editor, editable, Selection and Range, caret geometry, block, scroll/origin/nested scroll state, connectivity, semantic `data-node-id`, and delivered `MutationRecord`s.

**May know:** which DOM nodes are connected, which Selection endpoints belong to the active editor, and the semantic key of the block containing the current caret. `HTMLElement` identity is a handle for one Host sample, not a long-lived semantic identity. Block relations use `data-node-id` (and the existing `visualKey()` convention for visual markers); no global identity registry is built.

**Must not know:** whether a change is being animated, Cursor speed, Ripple alpha, Typewriter targets, `responseMs`, FLIP, or any other presentation policy. Host Truth reports facts; it does not choose effects.

When a collapsed Range belongs to an empty semantic block, the block's own content-host caret geometry takes precedence over adjacent placeholder-text recovery.

### 2. Structural Contract (`src/structure.ts`)

**Owns:** bounded input intent, MutationRecord classification, generation supersession, structural evidence, geometry readiness, semantic readiness, deadline/overflow release, and one per-transaction `StructuralHandoff`.

**May know:** the Host frame and bounded mutation summary supplied by Session, the monotonic execution time, and semantic block keys. The handoff is intentionally minimal: `generation`, `topologyChanged`, `fromBlockKey`, `toBlockKey`, `geometryReady`, and `semanticReady`. `fromBlockKey` is the semantic block at the last trustworthy caret when the transaction starts; `toBlockKey` is the destination block in the new authoritative frame. A different key is evidence for features to interpret, not an animation prescription.

**Must not know:** Critical Motion, `responseMs`, opacity, transform, scrollTop, WAAPI, rAF ownership, animation duration, Cursor speed, Ripple alpha, or Typewriter targets. Structure describes; it never animates. `input` intent remains a candidate; Host mutation evidence decides whether topology actually changed.

The contract answers only three questions: (1) did Host structure become ordinary, representation, structural, or overflow; (2) is the new caret geometry trustworthy; and (3) is the new topology quiet and stable enough to commit? It does not classify merge, split, indent, or outdent from the key name. A range-selection handoff cancels the pending transaction; after collapse, a fresh live Selection, active editor/editable and caret frame must be reacquired before a new structural edit can use that authority.

The two readiness levels are distinct Host facts and are never merged. `geometryReady` means continuous trustworthy caret geometry (two matching samples within 0.15px on the same block binding); `semanticReady` means geometry ready plus 48ms of structural quiet. Two publications are gated per generation (`geometryPublished`, and the semantic handoff at commit); an unavailable frame, a range selection, a caretless block or a block without a semantic key fails closed and publishes nothing. An earlier `identityReady` level existed for two rounds and has been removed: it published evidence that no runtime consumer consumed, and the replacement-role authority below now derives the same fact at mutation time.

`fromBlockKey` has strict trusted provenance: it may come only from an ordinary-admitted caret, a prior structural caret that reached `geometry-ready`, or Session's explicit fresh collapsed-Selection handoff. Waiting, unstable or missing structural samples never update it, and the post-mutation destination never backfills it. If the transaction starts without a trusted origin, `fromBlockKey` remains `null`; unknown is not the same block. `toBlockKey` describes the authoritative destination published with the geometry handoff; sampling is not authority.

### 3. Session Authority (`WritingSession`)

**Owns:** event routing, the active Host binding, the existing editor observers, one primary rAF, the bounded wake, shared frame ordering, and the authority decision that gates feature consumption. Host sampling is not visual commit: transient facts can be read while targets remain withheld.

**May know:** all five-layer outputs needed to route authority, including the Structural Contract decision/handoff and lifecycle state. Session routes `CursorIntent` (`"typing"`, `"navigation"`, or `"structural"`) but never selects a motion curve. Identity-ready is evidence about the Host and grants no presentation write; geometry-ready grants Cursor; Typewriter and Ripple stay held until semantic-ready.

**Must not know:** feature-specific trajectories, sentence topology, Cursor response laws, or painter implementation details. There is no second Session, scheduler, rAF, observer, FLIP manager, or timeline service.

The authority matrix is:

| Authority | Cursor | Typewriter | Ripple |
| --- | --- | --- | --- |
| ordinary admitted | yes | yes | yes |
| structural wait | hold | hold | hold |
| geometry-ready | yes | hold | hold |
| semantic-ready | yes | yes | yes |
| range selection | yield/native | cancel/hold | selection policy |
| lifecycle hard release | release | cancel | clear/release |

Selection ownership is a short bridge, not a subsystem: range entry gives presentation to native Selection and cancels the pending structure transaction; a collapse captures only a fresh `{ editable, editor, blockKey }` handoff; the first authoritative caret frame consumes and discards it. Failed or mismatched validation keeps the object `null`. No Range, Node, geometry, velocity or old generation is retained.

### 4. Feature Semantics

**Owns:** Cursor target/personality and selection behavior, Typewriter comfort-band target, and Ripple sentence/block target and ownership decisions. Cursor keeps an explicit `CursorIntent`: ordinary typing uses the fixed typing response; navigation uses the existing distance-aware response; structural relocation has its own semantic branch and initially reuses that navigation distance-aware law. `CursorIntent` is target provenance, not a long-lived application mode: a structural target keeps that branch through semantic commit until the target settles or a newer authoritative navigation/typing target replaces it. Typewriter and Ripple independently interpret structural holds.

**May know:** the Host frame and the authority/handoff granted by Session, including semantic identity, old/new geometry and topology evidence when a feature needs it. Future Local Layout Continuity belongs here as a bounded presentation feature using the existing Session frame.

**Must not know:** how StructureGate proves readiness, how Session schedules frames, or how Critical Motion integrates values. Features do not turn a key name into merge/split semantics and do not create a second runtime.

### 5. Motion + Painter

**Owns:** `motion.ts`'s pure Critical Motion integration and the existing Cursor, Ripple and Typewriter presentation writers. Painters commit transform/height/opacity/clip, WAAPI/highlight presentation, or scrollTop after Session grants authority.

**May know:** numerical state, targets and the selected feature response. Motion stays continuous across retargets; the block Ripple WAAPI owner remains the existing presentation owner.

**Must not know:** SiYuan, Selection, structural key names, merge/split/Tab, authority readiness, or semantic inference. Painters only commit presentation.

Input establishes writing intent; browsing cancels automatic scrolling. Composition belongs to an editor. Editor switches discard old effect bindings. Horizontal navigation keeps writing intent while vertical/page navigation exits it; all navigation cancels pending structural intent. Lifecycle and DOM events invalidate observations; none certifies host completion on its own.

## Semantic structure and the gate

The existing editor MutationObserver feeds bounded mutation classification. Semantic identity is a block's `data-node-id` and nearest semantic parent. Markers have visual identity `item-id:action`, but are not semantic blocks.

- Text: no semantic block/marker change. Normal character edits stay responsive.
- Representation: balanced remove/add identities under the same semantic parents, including nested descendants. A fresh element alone is not a structural edit. Marker-only replacement also invalidates bindings without starting a transaction.
- Structural: unmatched identities/parent relations, or moving the same semantic DOM element. This covers add/remove, split/merge, indent/outdent and in-place reordering.
- Overflow: the observation budget cannot establish the classification. Release presentation rather than commit a partial inference.

Removed roots use the MutationRecord target as their old parent, not their already-updated live parentElement. Descendants are inspected within changed subtrees. Batches delivered separately may temporarily look like remove then add and conservatively establish a transaction. No whole-editor semantic snapshot is built. Reordering entirely replaced same-id siblings with unchanged parent relations is not distinguished from representation churn; no repository trace establishes that case.

The gate has one optional pending record:

1. Enter/Backspace/Delete/Tab or structural beforeinput expresses intent. The kind names the Host operation — `backspace`, `delete`, `indent`, `outdent` — and carries no animation, duration, transform or opacity. It does not establish semantic evidence or authorize a target. A new explicit structural intent replaces the same-editor pending generation with a fresh bounded start/deadline; it retains the last presentation instead of releasing it. A list indent also arms the one bounded pre-mutation geometry read the structural presentation needs.
2. Structural mutations establish the shared transaction, including operations with no key event. Input, Selection and mutation activity reset the quiet/stable run while it is pending.
3. Input is editing activity, not negative structural evidence. SiYuan schedules ordinary input normalization with `setTimeout`, and that later task can still replace or restructure DOM. A narrowly admitted Backspace/Delete with a collapsed caret requires a safe text position on the deletion side—Backspace must have text to the left, Delete text to the right—and may become ordinary on the first characterData-only sample; all other text/representation candidates still require both input and classifier-confirmed evidence plus 48ms without further classified host activity. Intent without such evidence remains withheld until the existing 160ms deadline, then releases presentation without committing guessed geometry.
4. With evidence, two matching caret samples (position/height within 0.15px and the same block binding) establish `geometry-ready`; missing geometry, a non-caret selection or a caretless block breaks the stable run. Geometry-ready authorizes Cursor only. Full Ripple neighborhood and sentence semantics still require at least 48ms without relevant activity. These are provisional readiness heuristics, not a SiYuan completion signal.
5. The original 160ms deadline never extends indefinitely. Expiry without readiness releases all three effects and writing intent, leaving native presentation. It is logged as release, not authoritative commit. Fresh activity can resume observation. Observation overflow uses the safe release path immediately.

Session uses its existing rAF only during bounded evidence recovery. Intent-only waiting sleeps on the existing wake until classified activity, the ordinary candidate's 48ms quiet boundary, or the absolute 160ms deadline. Once structural evidence exists, Session samples on that same rAF even through missing caret geometry. A geometry-ready sample updates Cursor; Typewriter, Ripple and the block neighborhood stay held until semantic commit. This allows Cursor to follow `null → valid A → valid A` or repeated structural targets without turning intermediate topology into a commit. Every run terminates at the original deadline; no recurring idle sampling is introduced. Reduced motion changes animation, not authority: it must still pass this gate.

A mutation sample performs no presentation write beyond the replacement-role rule below. No readiness level releases or promotes the destination block owner: releasing a merged destination's inherited dim owner is a visible bright snap, and promoting it is the `0.4 → 1` animation that produced the original artifact. See the Local Presentation Bridge rejection below.

Pointer down, wheel/touch browsing, keyboard navigation, range selection, editor switch, composition entry, configure, blur and destruction cancel the pending gate. Native-caret binding may follow a valid editable while the overlay target is withheld; this is ownership maintenance, not geometry commit. Cancellation resumes or releases paused painting through the ordinary Session path.

## Frame ordering and performance

Events invalidate and enqueue one frame. Mutation callbacks do not read geometry or plan new presentation targets. Their one bounded write exception is semantic replacement carry: an already committed owner is rebound to same-key replacement DOM before a throttled rAF can expose an unpainted frame. That carry is narrowed by Host semantic evidence — see the replacement-role rule below. Plugin presentation styles are not observed. Text dirtiness is scoped to the current editable; semantic/representation changes invalidate block bindings as well.

All Session duration and deadline arithmetic uses `performance.now()` as one authoritative monotonic clock. The raw rAF callback timestamp is diagnostic provenance only: a real SiYuan 3.8.3 / Electron 44.2.0 / Chrome 152 capture observed a stable offset between those sources.

On an admitted frame, Ripple's `sample()` prepares projection, colors, numeric baselines and a write-only commit closure. These reads precede scrolling/cursor/Ripple writes. Cursor commits its logical alpha and geometry only after host sampling. The scroll container's actual position after a write is authoritative; Session transports measured caret geometry by that delta. This scroll write/readback is intentional and does not trigger a second host sample. Clone-color cleanup is deferred until after reads, including fresh color acquisition.

Cursor-only interpolation and Ripple-only sentence fades reuse geometry. A normal lifecycle suspension retargets Ripple to neutral and lets its existing WAAPI/Session render paths finish. Window blur keeps the Cursor presentation but shares that same Ripple release: a renderer that is still visible can animate, so the owners retarget from their current value instead of being cancelled. Only a hidden document tears the owners down synchronously, because it cannot show the release and must not keep a background loop. Disable, destruction and frame failure still clear synchronously. Self-authored scroll events matching the last actual write do not invalidate host facts. Host-driven scroll events do. After settling there is no continuous JavaScript loop; the existing delayed wake changes the cursor's bounded breathing target. Resize, fonts, viewport and theme events invalidate observations.

Explicit bounds: 256 mutation records and 2,048 visited nodes per classification, 64 ancestry levels, 48 semantic siblings per direction and at most 2,048 visited elements per block plan. Painting retains at most 2,048 owners between commits (incoming effects precede release of old ones within the synchronous commit). Replacement matching and handoff walk bounded owner/ancestor sets, not every owner/target pair. Ownership-budget overflow releases block effects instead of silently dropping part of the handoff.

Text projection is capped at 32,768 UTF-16 units, 2,048 text nodes and 256 sentences; exceeding that budget keeps block focus. No input-path whole-document query or persistent cache of all block identities is used.

## Cursor and Typewriter

Cursor owns current/target position and height, their CriticalState motion, logical alpha, native-caret binding, clipping, selection fade, breathing, missing-geometry recovery and editor-switch settling. It has no structural edit mode, structural readiness flag or structural timer. Session supplies authoritative targets; a StructureGate `geometry-ready` handoff is the earliest permitted target, while `retainOwner()` only transfers caret suppression while withholding a target. On resume, existing continuous motion approaches the final target.

Editor switching still uses eight stable samples or a 700ms ceiling; reduced motion skips this visual wait. Missing geometry retains presentation for the existing 160ms budget, then fades it. Caretless structural blocks fade immediately. Valid caretless/selected editables retain native suppression until host/lifecycle release. None of this is the shared structural gate.

Cursor transports current and target by changes in scroll origin, outer scroll and common nested scrollers before applying the same fixed-zeta=1 analytic law to x, y and height. Coordinate transport preserves a carried target; a newly granted authoritative target rebases transport instead of inheriting stale coordinate displacement. It retains the 1px visual lift, viewport edge fade, 370ms appear response and quicker 80ms disappear response. The shared `responseMs` parameter keeps the central Critical Motion calibration: from rest, a fixed target reaches approximately 90% displacement at the configured response time. The outer alpha is the sole visibility owner; breathing uses the explicit `normal → down → hold → up → normal` semantic phases on that same state. The first idle delay is 3000ms, down uses a 900ms response toward exact zero, the low hold is 0ms, up uses a 600ms response, and the recovered bright rest is 2000ms. Editor switch reveal retains the eight-stable-frame/700ms hidden geometry handoff and uses the same 370ms appear response. There is no CSS animation or inner recovery animation.

Typewriter remains an independent numerical comfort-band controller with hysteresis and host-scroll takeover. Its virtual scroll position and velocity advance independently of realized browser scrollTop through the shared critical law; the actuator readback is used only for takeover, ownership and measured displacement. The final visual tail settles only when both position and velocity are within the configured bounds, with a 0.21px virtual position epsilon. During a withheld frame Session does not call `next()` and cancels an outstanding scroll target. After commit it computes from final geometry and actual scrollTop. Composition continues to suppress plugin scrolling. The host can still scroll independently; we do not cancel SiYuan's caretScroll rAF. Manual browsing disables following; a distant ordinary click can request one centering alignment without writing intent.

## Ripple planning and presentation

`ripple.ts` owns sentence projection, boundary reuse, color ownership and highlight buckets. Sentence values and velocities use the shared critical law; ordinary text updates do not rebuild the block ownership plan.

`ripple/blockPlan.ts` contains two read-only boundaries: `collectTargets()` describes the disjoint neighborhood and semantic marker distance; `planHandoff()` maps prior numeric painting onto a changed owner plan. Ancestor-to-child transfer folds alpha down; child-to-ancestor transfer takes the brightest donor and normalizes remaining child residuals. The fold applies only to a target that inherits the released role. A target the plan neutralizes instead starts at its own previous presentation: folding a released ancestor's dim into it would double-count an opacity the DOM already applies, or — after a reparent such as a list indent — animate away a dim frame the user never saw. Opacity composites multiplicatively across ancestors: the partition, not CSS inheritance, prevents unintended double dimming. This numerical complexity remains necessary when a marker's owner changes.

`modules/structurePresentation.ts` is the single presentation owner of a structural displacement: one Host element slides from the position the user last saw to the geometry the Host has already committed. `capture()` runs once before the Host mutation and reads one rect for the focused list item; `attach()` runs **inside the mutation delivery**, not at `geometry-ready`, because a frame that paints the Host's new layout before the transform exists is exactly the jump this exists to avoid. The Host moves the item node itself, so the captured element is the primary subject and the live Selection is only a fallback — SiYuan restores the Selection through a `<wbr>` that outdent resolves after that delivery. Continuity is proved by `visualKey`, never by DOM identity, and a Host or theme that owns its own inline transform is never overwritten. A capture whose own generation ends without acting is abandoned, while a displacement already running keeps converging. `step()` advances on the shared Session frame with `MOTION.structuralMoveResponseMs` — a displacement is its own personality dimension, not the block alpha timescale — and one frame may advance at most a quarter of the response so a stalled renderer cannot teleport the subject. Reduced motion and sub-pixel displacements never attach. It is not a FLIP pass: no document snapshot, no placeholder, no clone, no second structural tree.

The caret is attached to the glyphs, so Session presents that same offset on the caret while storing the Host's untransformed `frame.caret`; the Structural Contract therefore still reads stable geometry. Cursor consumes the offset through `carried`, which places the position instead of approaching it: one physical displacement has exactly one motion owner, and a second critical motion toward the same offset would only make the cursor trail the glyphs. Cursor keeps its own Critical Motion for every other intent, including structural caret moves that no displacement owns.

Sentence ranges are a projection of the live text nodes, so a Host rewrite that keeps the contenteditable element still invalidates them: a range whose text node is removed is re-anchored to an element boundary and paints nothing. The sentences-only first frame receives the frame's `contentDirty` evidence for exactly that reason.

`ripple/blockPainter.ts` owns animations and bindings. Replacement matching uses the previous owner's saved semantic key, including disconnected predecessors and same-id ancestors. There is no separate carryover registry. On bounded mutation delivery it can rebind an existing owner to a same-key added element and hold its alpha; if detached sentence highlights were the only dim owner, Ripple hands their current visible floor to that same semantic block. It does not run the neighborhood planner against intermediate DOM. Full target planning/handoff runs only at an admitted commit or normal focus/binding change; no readiness level writes an owner.

#### Replacement-role rule

`same visualKey` proves semantic object continuity, not presentation-role continuity. SiYuan's paragraph merge removes the focused source and re-renders the destination as a **fresh element with the same `data-node-id`**, so the surviving key previously described a dim neighbour while the new element is the focused block. Carrying that key's committed dim value would present a stale role until the semantic commit.

Session therefore derives one optional semantic fact at mutation time and passes only that across the boundary; it never passes an opacity or a "skip" instruction:

- The Host restores the collapsed Selection into the final destination **synchronously inside the merge** (`focusByWbr` is the last statement of `removeBlock`), before the MutationObserver microtask runs. Session therefore resolves `captureCollapsedSelection()` and uses its `blockKey` **only when** the classifier already reported `structural` **and** the captured `editor` is the observed editor. A range selection, a missing connection, an unparsed block or an editor mismatch all fail closed to `null`, which means "unknown" and leaves the ordinary carry in place.
- `blockPainter.rebind()` skips the replacement for that key, so the focused replacement is presented the way every focused block is: with **no block opacity owner at all**. It authors no `1` owner, no release of a freshly carried owner, and no promotion.
- A detached predecessor is no longer current presentation truth. Its stale owner is dropped with that key so the semantic commit cannot fold the old `0.4` back onto the live replacement — which would otherwise produce a `1 → 0.4 → 1` regression strictly worse than the original artifact.

Ordinary `representation` replacements, `structural` replacements that are not the focused block, and same-key sentence-floor carry are unchanged. The rule is expressed entirely in Host semantic terms; no key name, key event or block operation is special-cased.

Running block fades pause during the gate. Finished fills are left finished, so resuming does not rewind them. Sentence motion also stops advancing because Session does not render it. Native DOM layout is not frozen: host-driven text movement, live Range changes and compositing during reparenting remain integration risks. Withholding effect targets alone does not prove all intermediate host pixels stable; no full FLIP was restored.

### Local Presentation Bridge (rejected prototype)

A bounded prototype for the block-start Backspace merge artifact was evaluated and rejected *as a mechanism*; the artifact itself is addressed by the replacement-role rule above. The host merge path (`remove.ts`) `extractContents()`es the source editable and `insertNode()`s it into the destination, then re-renders the destination through `SpinBlockDOM(... outerHTML)` and removes both original elements. Two consequences are decisive: the source text is rendered at the destination's position, so any second presentation surface showing the source at its old position is a duplicate-text ghost; and the visible dim phase belongs to the *destination's* inherited dim owner, so a source-side surface could not remove it anyway. Measured host facts: a detached element or detached clone has a zero box, and a clone mounted outside `.protyle-wysiwyg` loses host typography unless the holder carries that class (`line-height 26px → normal`, `font-size 16px → 14px`). See `SIYUAN_HOST_CONTRACT.md`.

### Opacity lifecycle invariant

Block painting never writes `element.style.opacity`, `commitStyles()`, a dim class, an opacity custom property or a transition override. Both transitions and settled levels live exclusively in owned WAAPI KeyframeEffects with `fill: "both"`. Each owner has at most one retained effect. Retargeting installs the incoming effect before cancelling its predecessor; neutral completion cancels and removes the owner, while dim completion retains its finished fill. Normal blur/lifecycle suspension retargets effects to neutral; disable, editor switch, timeout, exception handling and destruction cancel them. Retired detached effects are removed at commit/clear.

On first editor bind, editor identity changes and lifecycle clear/re-entry, the painter performs one editor-scoped `getAnimations({ subtree: true })` recovery pass. It cancels only animations whose exact id is `zentype-ripple` and which are absent from the current painter map. This closes abnormal unload/hot-reload ownership loss without scanning every frame, guessing opacity values or touching host animations and inline styles.

Acquisition samples host baseline opacity once. Animated values multiply it by Ripple alpha; underlying host inline/CSS values are never overwritten. Release reveals current host style, including changes by another integration. Host opacity changes during ownership are revealed on release/reacquisition rather than polled.

Cloning/serializing DOM attributes cannot copy these runtime animation objects. Thus no serialized zenType block opacity can outlive its JS ownership. No persistent CSS dim rule activates a copied class. A host that explicitly serializes computed animated style rather than attributes would be a different contract and is not verified here. See the [Web Animations fill model](https://www.w3.org/TR/web-animations-1/#fill-behavior); retained fills are bounded and explicitly cancelled.

### Legacy opacity

The remake.1 documentation/user report describes same-id replacements carrying inline opacity without a Ripple class. The actual recording is not in this repository. Repairing one copied value with a predecessor's JS `original` field cannot solve the general owner/DOM lifecycle split, so that runtime repair path is removed.

remake.2 stops authoring that inline side effect. It does not infer ownership from `0.05/0.1/0.15/0.2/0.4`: valid host styling can have those values. No automatic style-substring scan or migration runs. For an already polluted document, use a DebugKit capture to identify the exact block/path/style, confirm provenance against clean content or a backup, and remove only the confirmed legacy property in a separate explicit repair. Uncertain styles remain untouched. Reconstructing clean host content may clear transient DOM-only residue; persisted content needs its own reviewed repair.

### Sentences

Projection excludes noneditable subtrees and nested blocks. Intl.Segmenter supplies UTF-16 boundaries without punctuation repair. Local changes reuse mapped boundaries; deletion may preserve a surviving start anchor. A detached same-block editable replacement can reuse mapping. Excluded caret text anchors to the nearest preceding projected node.

A sentence rebuild has three provenance branches, and they are not interchangeable. A boundary that maps onto a previous sentence keeps that sentence's `value` and `velocity`. A fresh boundary takes the active/non-active role it is about to hold: `1` for the active sentence. A fresh **non-active** boundary only takes `SENTENCE_ALPHA` when the replacement-role rule above reported an actual invalidated block role for this semantic block — that is, when this focused block was already on screen as a dim neighbour. Without that authority the fresh sentence still enters from full brightness, so ordinary navigation, click, editor switch and ordinary content rebuild keep their existing entrance. The seed is one-shot: whichever rebuild runs next consumes it, and `clear()` drops it. This changes initial `value`/`velocity` provenance only; the Critical Motion law, `SENTENCE_ALPHA`, bucket count, highlight registration and active-sentence resolution are unchanged, and the block layer never compensates sentence alpha.

Highlights use 65 fixed alpha buckets and a private text-parent color property; only changed memberships replace Highlight registrations. Two buffers alternate scratch/current ranges. Text colors are batched on acquisition and cached until theme invalidation, explicit `WritingSession.refresh()` or release. Same-element inline format edits are not observed automatically. Copied color properties are collected during bounded projection and removed in the write phase; owned values are preserved.

## Diagnostics and evidence

DebugKit remains full-profile in development. Production esbuild drops every `ZENTYPE_DEBUG` labeled instrumentation statement and tree-shakes the dev-only installer and implementation, so payload construction and controller wiring do not enter either `dist/index.js` or `package.zip`. It adds no observer/rAF/timer. Structural records are scalar: intent, evidence, activity, sample/decision, geometry-ready, stable, timeout, commit, cancel and release. Intent samples distinguish `inputObserved`, `nonStructuralObserved`, `awaiting-structural-evidence`, `awaiting-post-input-quiet`, `non-structural-quiet` and `intent-deadline-expired`; structural samples report `geometryReady`, `semanticReady`, `awaiting-stable-geometry`, `awaiting-semantic-quiet` or `quiet-and-stable`. Ripple reports hold, replacement-role invalidation, replacement carry, owner commit, stale recovery and budget release. Full diagnostics still have overhead and are not a performance baseline.

Observed in source: remake.1 called Typewriter and Ripple while Cursor's structural settle withheld only the cursor. Inline opacity could survive a DOM copy without its in-memory owner/class. This supports the shared-boundary and ownership redesign; it does not by itself prove the cause of every visual artifact.

The direct host audit uses SiYuan v3.8.3 at [`8641553a`](https://github.com/siyuan-note/siyuan/tree/8641553a1f07374001902d3ce773285db1292b2d) and official plugin-sample at [`d9ad60b5`](https://github.com/siyuan-note/plugin-sample/tree/d9ad60b556585ab66acbb494fc5aae0be62b2f86), both current on 2026-09-09. It proves that Tab/list operations and several removal paths can cross awaits, ordinary input normalization runs in a later task, same-id replacement is real, and composition completion can continue asynchronously. Browser MutationObserver/Selection/rAF delivery order remains a runtime fact, not a source guarantee. See `SIYUAN_HOST_CONTRACT.md`.

Deterministic Session tests now cover text evidence preceding delayed structural evidence, clock-skewed quiet/deadline budgets, missing-caret structural recovery, lifecycle release, mutation-time replacement carry, range/pointer/wheel interruption, and staged editor-switch reveal. Painter tests cover sentence-floor carry and exact-id stale WAAPI recovery without host animation or inline-opacity mutation. Full CDP against the user's SiYuan 3.8.3 runtime verifies the paragraph-split replacement and blur handoff described in the host contract. Merge geometry, IME, clipping and theme combinations still require broader real-host acceptance; automated fixtures do not turn the heuristic thresholds into an official host completion contract.
