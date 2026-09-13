# Host-Specific Lessons

This ledger is for future agents who may otherwise mistake a SiYuan/Web workaround for product design. Each row separates the host mechanism from the lesson that survives a platform change.

## SiYuan Host Quirk Ledger

| Host-specific mechanism or behavior | Current protection | Underlying product/architecture lesson | Transfer recommendation | Evidence |
| --- | --- | --- | --- | --- |
| .protyle-action marker is separate structural chrome | visualKey uses parent data-node-id plus :action; marker/direct content get explicit ownership | Structural chrome must have a semantic owner and a focused boundary. | Transfer ownership rule; do not transfer selector/key. | src/structure.ts:43-48; tests/rippleStructuralFocus.test.ts |
| Marker DOM can be replaced or change subtype | BlockPainter rebinds only a same-key valid actuator and releases stale/focused roles | A visual part may change actuator without preserving an obsolete presentation role. | Transfer role validation; implement native chrome identity. | docs/DESIGN.md:133-145; commits 9c020ad, 292122c |
| NodeListItem reparent on Tab | StructurePresentation captures exact element before mutation and attaches during mutation delivery | A reparent is not automatically a replacement; continuity must follow the semantic subject. | Transfer exact-subject ownership; no DOM timing assumption. | docs/SIYUAN_HOST_CONTRACT.md:28-35; commits c13ad7a, e859352 |
| Shift+Tab temporary disconnected topology | Presentation fails closed if the captured item is disconnected and no replacement exists | Uncertain topology must not be filled with a guessed view. | Transfer fail-closed behavior; rediscover native transaction states. | docs/SIYUAN_HOST_CONTRACT.md:39-43; src/modules/structurePresentation.ts:98-167 |
| Same data-node-id DOM replacement | Same-key owner rebind preserves value/velocity/target when role remains valid | Semantic continuity and actuator identity are distinct. | Transfer concept; do not port data-node-id or rebind code. | docs/SIYUAN_HOST_CONTRACT.md:77-103, 134-141; src/modules/ripple/blockPainter.ts:163-216 |
| MutationObserver delivery before later normalization | StructureGate waits for quiet/stable evidence and a bounded deadline; MO callback does not plan geometry | Input intent or one mutation record is not final transaction truth. | Transfer evidence-based admission; do not port microtask timing. | docs/SIYUAN_HOST_CONTRACT.md:121-149; src/structure.ts:239-335 |
| keydown and beforeinput report one intent | Session/StructureGate match same editor and generation rather than treating key name as evidence | Multiple event surfaces can describe one action and must be deduplicated. | Transfer intent/evidence separation; use native command events. | src/structure.ts:168-195; src/session.ts:596-640 |
| Selection restoration through wbr/Range helpers | Composition, range, editor mismatch, or missing connection cancels or withholds presentation | The editor's Selection is a first-class authority, not an animation input to overwrite. | Transfer Selection supremacy; discard DOM restoration helpers. | docs/SIYUAN_HOST_CONTRACT.md:103-149, 157-161 |
| Range geometry includes ancestor transform | Session subtracts the known presentation offset before using caret geometry | Layout truth must be sampled in a coordinate space that excludes presentation's own write. | Transfer coordinate-space discipline; use native layout transforms. | docs/SIYUAN_HOST_CONTRACT.md:35-41; src/session.ts:324-345 |
| Host/user scroll takeover | Typewriter compares actual scroll readback and yields instead of writing against it | Viewport agency belongs to the user/host when they take control. | Transfer ownership rule; do not port caretScroll or scrollTop heuristics. | docs/SIYUAN_HOST_CONTRACT.md:151-155; src/modules/typewriter.ts:42-88 |
| IME completion is asynchronous | compositionstart cancels structural work; compositionend reacquires evidence rather than claiming host completion | Provisional text and final document state are different phases. | Transfer composition-safe policy; rediscover native IME transactions. | docs/SIYUAN_HOST_CONTRACT.md:157-161; tests/remake.test.ts:1863-1890 |
| Host transform/theme may already own transform | StructurePresentation and LayoutContinuity refuse to take over a foreign transform | Presentation must not overwrite an owner it cannot model. | Transfer transform ownership checks; no DOM computed-style rule. | src/modules/structurePresentation.ts:19-29; docs/SIYUAN_HOST_CONTRACT.md:35-41 |
| Ancestor opacity multiplies descendant opacity | BlockPainter folds committed ancestry, normalizes donors, and protectFocus moves covering dim off the focus path | Composite visual state is not the same as a local style value. | Transfer composite-state reasoning; do not transfer CSS opacity algorithm. | commits e70b955, 8668a73, f456068, 6ea30f1, b8772dc, 292122c |
| CSS Highlight Range follows old text nodes | Ripple re-registers highlights on the first structural frame and seeds from actual presented state | A presentation object can be invalidated by host text replacement and needs an atomic reattachment point. | Transfer presentation reattachment; use native text spans/ranges as appropriate. | docs/CHANGELOG.md:82-104; src/modules/ripple.ts:1-307 |
| Hidden document and plugin/editor lifecycle | Session cancels observers, rAF/wake, owners, and styles synchronously on disable/destroy/overflow/exception | Every acquired presentation owner needs explicit lifecycle release. | Transfer lifecycle pairing; do not port plugin unload hooks. | docs/SIYUAN_HOST_CONTRACT.md:163-183; src/session.ts:736-786 |
| Host creates temporary invalid block/list topology | Bounded node/depth/record limits and generation checks release stale work | A presentation system must tolerate transactions it cannot safely explain. | Transfer bounded fail-closed admission. | src/structure.ts:5-7, 239-335 |
| Host merge uses source insertion, destination replacement, Selection restore, and cleanup | LayoutContinuity attaches local flow only after captured evidence; no ghost text surface | Final semantic merge and visual continuity are separate phases. | Transfer the distinction; do not copy the merge timeline. | docs/SIYUAN_HOST_CONTRACT.md:77-103; docs/DESIGN.md:149-167 |

## Host facts versus product requirements

The durable lessons are the arrows below:

- .protyle-action ownership → explicit structural-chrome ownership; the class name and parent-key string do not transfer.
- Same-key replacement → semantic continuity requires a role check; data-node-id rebind does not transfer.
- MutationObserver delay → completion needs evidence and a bound; browser microtask order does not transfer.
- Selection restoration → the editor owns selection; wbr and Range helpers do not transfer.
- Ancestor opacity multiplication → composite presentation state must be reasoned about; CSS alpha folding does not transfer.
- Host scroll takeover → user/host viewport agency wins; SiYuan scroll APIs do not transfer.
- WAAPI carrier → a compositor actuator may be useful; paused KeyframeEffect and its lifecycle do not transfer.
- Temporary invalid topology → fail closed under uncertainty; DOM disconnection patterns do not transfer.

## Old workaround removed, requirement retained

The Remake deliberately removed inline opacity ownership, persistent identity registries, deferred presentation bridges, and broad FLIP. Their semantic requirements were not simply forgotten:

| Removed mechanism | Requirement retained by |
| --- | --- |
| Inline opacity/style cleanup | BlockPainter's numeric CriticalState and paused actuator |
| Carryover/identity registry | Same-key, role-checked owner rebind |
| Local Presentation Bridge | Host-owned final text plus first-frame sentence presentation |
| Broad FLIP | Exact-subject StructurePresentation and bounded LayoutContinuity |
| Feature-local timers/rAF | WritingSession single time axis and lifecycle |

This is why “the old code did something important” is not enough to restore it. The next question is whether the requirement has a current semantic owner.

## Evidence limits

Some host facts are runtime-observed only for the audited SiYuan path/version. The precise MutationObserver/Selection/rAF order for every merge, marker subtype conversion, post-commit host scroll takeover, CJK IME, popup editor, and split-editor path remains unverified (docs/SIYUAN_HOST_CONTRACT.md:199-207). These are open evidence questions, not portable design requirements.
