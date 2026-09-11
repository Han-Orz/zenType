# v2.9.0-remake.2.4-structural.2

## Ownership and authority

One WritingSession owns document events, the active host binding, observers, one rAF and one idle wake timer. Cursor, Typewriter and Ripple import no other effect. There is no structural scheduler, subscriber runtime, second editor observer, FLIP engine or persistent visual identity registry.

The host adapter validates the official active Protyle, DOM focus, Selection endpoints and editability. Frame data can carry a valid editor with missing caret geometry. Composition uses its focus endpoint, never rewrites browser Selection, and remains distinct from an ordinary range selection.

**Host sampling is not visual commit.** Session may read transient DOM/Selection/caret facts while withholding all new effect targets. `structure.ts` is a clock-free decision policy owned by Session, not an independent runtime. Only Session decides when Cursor may approach a target, Typewriter may write scrollTop and Ripple may rebuild its owner plan.

Input establishes writing intent; browsing cancels automatic scrolling. Composition belongs to an editor. Editor switches discard old effect bindings. Horizontal navigation keeps writing intent while vertical/page navigation exits it; all navigation cancels pending structural intent. Lifecycle and DOM events invalidate observations; none certifies host completion on its own.

## Semantic structure and the gate

The existing editor MutationObserver feeds bounded mutation classification. Semantic identity is a block's `data-node-id` and nearest semantic parent. Markers have visual identity `item-id:action`, but are not semantic blocks.

- Text: no semantic block/marker change. Normal character edits stay responsive.
- Representation: balanced remove/add identities under the same semantic parents, including nested descendants. A fresh element alone is not a structural edit. Marker-only replacement also invalidates bindings without starting a transaction.
- Structural: unmatched identities/parent relations, or moving the same semantic DOM element. This covers add/remove, split/merge, indent/outdent and in-place reordering.
- Overflow: the observation budget cannot establish the classification. Release presentation rather than commit a partial inference.

Removed roots use the MutationRecord target as their old parent, not their already-updated live parentElement. Descendants are inspected within changed subtrees. Batches delivered separately may temporarily look like remove then add and conservatively establish a transaction. No whole-editor semantic snapshot is built. Reordering entirely replaced same-id siblings with unchanged parent relations is not distinguished from representation churn; no repository trace establishes that case.

The gate has one optional pending record:

1. Enter/Backspace/Delete/Tab or structural beforeinput expresses intent. It does not establish semantic evidence or authorize a target. A new explicit structural intent replaces the same-editor pending generation with a fresh bounded start/deadline; it retains the last presentation instead of releasing it.
2. Structural mutations establish the shared transaction, including operations with no key event. Input, Selection and mutation activity reset the quiet/stable run while it is pending.
3. Input is editing activity, not negative structural evidence. SiYuan schedules ordinary input normalization with `setTimeout`, and that later task can still replace or restructure DOM. A narrowly admitted Backspace/Delete with a collapsed caret strictly inside a non-boundary text node may become ordinary on the first characterData-only sample; all other text/representation candidates still require both input and classifier-confirmed evidence plus 48ms without further classified host activity. Intent without such evidence remains withheld until the existing 160ms deadline, then releases presentation without committing guessed geometry.
4. With evidence, two matching caret samples (position/height within 0.15px and the same block binding) establish `geometry-ready`; missing geometry, a non-caret selection or a caretless block breaks the stable run. Geometry-ready only authorizes Cursor to consume the sampled caret. Full semantic commit still additionally requires at least 48ms without relevant activity. These are provisional readiness heuristics, not a SiYuan completion signal.
5. The original 160ms deadline never extends indefinitely. Expiry without readiness releases all three effects and writing intent, leaving native presentation. It is logged as release, not authoritative commit. Fresh activity can resume observation. Observation overflow uses the safe release path immediately.

Session uses its existing rAF only during bounded evidence recovery. Intent-only waiting sleeps on the existing wake until classified activity, the ordinary candidate's 48ms quiet boundary, or the absolute 160ms deadline. Once structural evidence exists, Session samples on that same rAF even through missing caret geometry. A geometry-ready sample updates only Cursor; Typewriter and Ripple remain held until semantic commit. This allows Cursor to follow `null → valid A → valid A` or repeated structural targets without turning intermediate topology into a commit. Every run terminates at the original deadline; no recurring idle sampling is introduced. Reduced motion changes animation, not authority: it must still pass this gate.

Pointer down, wheel/touch browsing, keyboard navigation, range selection, editor switch, composition entry, configure, blur and destruction cancel the pending gate. Native-caret binding may follow a valid editable while the overlay target is withheld; this is ownership maintenance, not geometry commit. Cancellation resumes or releases paused painting through the ordinary Session path.

## Frame ordering and performance

Events invalidate and enqueue one frame. Mutation callbacks do not read geometry or plan new presentation targets. Their one bounded write exception is semantic replacement carry: an already committed owner is rebound to same-key replacement DOM before a throttled rAF can expose an unpainted frame. Plugin presentation styles are not observed. Text dirtiness is scoped to the current editable; semantic/representation changes invalidate block bindings as well.

All Session duration and deadline arithmetic uses `performance.now()` as one authoritative monotonic clock. The raw rAF callback timestamp is diagnostic provenance only: a real SiYuan 3.8.3 / Electron 44.2.0 / Chrome 152 capture observed a stable offset between those sources.

On an admitted frame, Ripple's `sample()` prepares projection, colors, numeric baselines and a write-only commit closure. These reads precede scrolling/cursor/Ripple writes. Cursor commits its logical alpha and geometry only after host sampling. The scroll container's actual position after a write is authoritative; Session transports measured caret geometry by that delta. This scroll write/readback is intentional and does not trigger a second host sample. Clone-color cleanup is deferred until after reads, including fresh color acquisition.

Cursor-only interpolation and Ripple-only sentence fades reuse geometry. A normal lifecycle suspension retargets Ripple to neutral and lets its existing WAAPI/Session render paths finish; window blur uses a narrower blocked path that cancels writing/gate work, clears Ripple and preserves the last Cursor presentation until focus triggers a fresh host sample. Disable, destruction and frame failure still clear synchronously. Self-authored scroll events matching the last actual write do not invalidate host facts. Host-driven scroll events do. After settling there is no continuous JavaScript loop; the existing delayed wake changes the cursor's bounded breathing target. Resize, fonts, viewport and theme events invalidate observations.

Explicit bounds: 256 mutation records and 2,048 visited nodes per classification, 64 ancestry levels, 48 semantic siblings per direction and at most 2,048 visited elements per block plan. Painting retains at most 2,048 owners between commits (incoming effects precede release of old ones within the synchronous commit). Replacement matching and handoff walk bounded owner/ancestor sets, not every owner/target pair. Ownership-budget overflow releases block effects instead of silently dropping part of the handoff.

Text projection is capped at 32,768 UTF-16 units, 2,048 text nodes and 256 sentences; exceeding that budget keeps block focus. No input-path whole-document query or persistent cache of all block identities is used.

## Cursor and Typewriter

Cursor owns current/target position and height, their CriticalState motion, logical alpha, native-caret binding, clipping, selection fade, breathing, missing-geometry recovery and editor-switch settling. It has no structural edit mode, structural readiness flag or structural timer. Session supplies authoritative targets; a StructureGate `geometry-ready` handoff is the earliest permitted target, while `retainOwner()` only transfers caret suppression while withholding a target. On resume, existing continuous motion approaches the final target.

Editor switching still uses eight stable samples or a 700ms ceiling; reduced motion skips this visual wait. Missing geometry retains presentation for the existing 160ms budget, then fades it. Caretless structural blocks fade immediately. Valid caretless/selected editables retain native suppression until host/lifecycle release. None of this is the shared structural gate.

Cursor transports current and target by changes in scroll origin, outer scroll and common nested scrollers before applying the same fixed-zeta=1 analytic law to x, y and height. It retains the 1px visual lift, viewport edge fade, 370ms appear response and quicker 80ms disappear response. The shared `responseMs` parameter keeps the central Critical Motion calibration: from rest, a fixed target reaches approximately 90% displacement at the configured response time. The outer alpha is the sole visibility owner; breathing uses the explicit `normal → down → hold → up → normal` semantic phases on that same state. The first idle delay is 3000ms, down uses a 900ms response toward exact zero, the low hold is 0ms, up uses a 600ms response, and the recovered bright rest is 2000ms. Editor switch reveal retains the eight-stable-frame/700ms hidden geometry handoff and uses the same 370ms appear response. There is no CSS animation or inner recovery animation.

Typewriter remains an independent numerical comfort-band controller with hysteresis and host-scroll takeover. Its virtual scroll position and velocity advance independently of realized browser scrollTop through the shared critical law; the actuator readback is used only for takeover, ownership and measured displacement. The final visual tail settles only when both position and velocity are within the configured bounds, with a 0.21px virtual position epsilon. During a withheld frame Session does not call `next()` and cancels an outstanding scroll target. After commit it computes from final geometry and actual scrollTop. Composition continues to suppress plugin scrolling. The host can still scroll independently; we do not cancel SiYuan's caretScroll rAF. Manual browsing disables following; a distant ordinary click can request one centering alignment without writing intent.

## Ripple planning and presentation

`ripple.ts` owns sentence projection, boundary reuse, color ownership and highlight buckets. Sentence values and velocities use the shared critical law; ordinary text updates do not rebuild the block ownership plan.

`ripple/blockPlan.ts` contains two read-only boundaries: `collectTargets()` describes the disjoint neighborhood and semantic marker distance; `planHandoff()` maps prior numeric painting onto a changed owner plan. Ancestor-to-child transfer folds alpha down; child-to-ancestor transfer takes the brightest donor and normalizes remaining child residuals. Opacity composites multiplicatively across ancestors: the partition, not CSS inheritance, prevents unintended double dimming. This numerical complexity remains necessary when a marker's owner changes.

`ripple/blockPainter.ts` owns animations and bindings. Replacement matching uses the previous owner's saved semantic key, including disconnected predecessors and same-id ancestors. There is no separate carryover registry. On bounded mutation delivery it can rebind an existing owner to a same-key added element and hold its alpha; if detached sentence highlights were the only dim owner, Ripple hands their current visible floor to that same semantic block. It does not run the neighborhood planner against intermediate DOM. New target planning/handoff runs only at an admitted commit or normal focus/binding change.

Running block fades pause during the gate. Finished fills are left finished, so resuming does not rewind them. Sentence motion also stops advancing because Session does not render it, including during a Cursor-only geometry-ready handoff. Native DOM layout is not frozen: host-driven text movement, live Range changes and compositing during reparenting remain integration risks. Withholding effect targets alone does not prove all intermediate host pixels stable; no full FLIP was restored.

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

Highlights use 65 fixed alpha buckets and a private text-parent color property; only changed memberships replace Highlight registrations. Two buffers alternate scratch/current ranges. Text colors are batched on acquisition and cached until theme invalidation, explicit `WritingSession.refresh()` or release. Same-element inline format edits are not observed automatically. Copied color properties are collected during bounded projection and removed in the write phase; owned values are preserved.

## Diagnostics and evidence

DebugKit remains full-profile in development. Production esbuild drops every `ZENTYPE_DEBUG` labeled instrumentation statement and tree-shakes the dev-only installer and implementation, so payload construction and controller wiring do not enter either `dist/index.js` or `package.zip`. It adds no observer/rAF/timer. Structural records are scalar: intent, evidence, activity, sample/decision, geometry-ready, stable, timeout, commit, cancel and release. Intent samples distinguish `inputObserved`, `nonStructuralObserved`, `awaiting-structural-evidence`, `awaiting-post-input-quiet`, `non-structural-quiet` and `intent-deadline-expired`; structural samples report `geometryReady`, `semanticReady`, `awaiting-stable-geometry`, `awaiting-semantic-quiet` or `quiet-and-stable`. Ripple reports hold, replacement carry, owner commit, stale recovery and budget release. Full diagnostics still have overhead and are not a performance baseline.

Observed in source: remake.1 called Typewriter and Ripple while Cursor's structural settle withheld only the cursor. Inline opacity could survive a DOM copy without its in-memory owner/class. This supports the shared-boundary and ownership redesign; it does not by itself prove the cause of every visual artifact.

The direct host audit uses SiYuan v3.8.3 at [`8641553a`](https://github.com/siyuan-note/siyuan/tree/8641553a1f07374001902d3ce773285db1292b2d) and official plugin-sample at [`d9ad60b5`](https://github.com/siyuan-note/plugin-sample/tree/d9ad60b556585ab66acbb494fc5aae0be62b2f86), both current on 2026-09-09. It proves that Tab/list operations and several removal paths can cross awaits, ordinary input normalization runs in a later task, same-id replacement is real, and composition completion can continue asynchronously. Browser MutationObserver/Selection/rAF delivery order remains a runtime fact, not a source guarantee. See `SIYUAN_HOST_CONTRACT.md`.

Deterministic Session tests now cover text evidence preceding delayed structural evidence, clock-skewed quiet/deadline budgets, missing-caret structural recovery, lifecycle release, mutation-time replacement carry, range/pointer/wheel interruption, and staged editor-switch reveal. Painter tests cover sentence-floor carry and exact-id stale WAAPI recovery without host animation or inline-opacity mutation. Full CDP against the user's SiYuan 3.8.3 runtime verifies the paragraph-split replacement and blur handoff described in the host contract. Merge geometry, IME, clipping and theme combinations still require broader real-host acceptance; automated fixtures do not turn the heuristic thresholds into an official host completion contract.
