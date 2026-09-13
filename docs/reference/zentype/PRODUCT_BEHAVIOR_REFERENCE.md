# Product Behavior Reference

This document describes what a user should experience. It is organized by behavior rather than by source file. Current implementation notes are included only to distinguish a durable semantic from a replaceable mechanism.

## Global priority

The priority order is:

1. input and document correctness;
2. Selection and IME;
3. host stability and user-owned scroll;
4. performance;
5. motion continuity;
6. secondary visual completeness.

When evidence is incomplete, the product may withhold or release presentation. It must not consume transient DOM or Selection as if it were final truth. See docs/DESIGN.md:41-52 and docs/CRITICAL_MOTION_LAYOUT_CONTRACT.md:5-12.

## Cursor

### What the user should see

The cursor feels attached to the current writing location rather than being a separate animated ornament:

- during typing it follows the newly established caret quickly;
- horizontal navigation remains part of the writing flow;
- vertical, page, or editor navigation can settle/recover without dragging an old target through an unrelated layout;
- rapid direction reversal retargets from the current position;
- selection makes the cursor yield to native Selection semantics;
- after idle, breathing is subtle and does not become a second source of attention;
- when a block moves structurally, text and caret move together;
- during temporary geometry loss it holds briefly or fades rather than appearing at a stale coordinate;
- on editor switch it commits a stable hidden geometry before revealing the new editor.

### Semantic boundary

Cursor behavior is about maintaining a trustworthy writing location. It is not permission to alter the native caret or Selection. The current implementation reads Host geometry through Session, uses Critical Motion for position/height/alpha, and has missing-geometry and editor-switch recovery budgets (src/modules/cursor.ts:165-225, 239-281; src/session.ts:324-397).

### Failure modes that are product failures

- the caret separates visibly from the text;
- an old caret target follows the user into a new editor;
- the cursor jumps to a stale position when geometry disappears;
- a structural offset is applied twice, making text and caret chase one another;
- a hidden editor is revealed before its geometry is stable.

## Typewriter

### What the user should see

Typewriter is a comfort-zone transport, not an always-centered camera:

- ordinary typing remains still while the caret is comfortably visible;
- approaching an edge causes a measured scroll response;
- repeated typing reuses the current scroll state instead of restarting;
- reverse navigation is equally comfortable;
- the user can manually scroll, wheel, touch, or select without fighting the plugin;
- host scroll takeover is detected from actual scroll readback and respected;
- IME composition does not trigger disruptive automatic scrolling;
- structural changes may cause a later scroll adjustment, but the effect must not scroll against the host's final decision.

The v2.8.1 behavior used a comfort band around the visible editor. The current Remake keeps the semantic idea while using a virtual scroll state, Critical Motion, and actual scrollTop readback (src/modules/typewriter.ts:23-88; docs/DESIGN.md:117-119). The band and response values are calibration, not a requirement to center the caret.

### Failure modes

- every keystroke recenters the document;
- user scroll is immediately overwritten;
- a structural mutation causes a second scheduler to fight host scroll;
- composition moves the viewport before the committed text exists;
- large elapsed time causes a visible teleport instead of a bounded catch-up.

## Sentence Ripple

### What the user should see

Sentence Ripple keeps the active sentence visually readable while reducing the visual competition of surrounding sentences. It should support writing and scanning, not turn the editor into a permanent highlight display.

- sentence boundaries follow the text model, including UTF-16 offsets and the configured segmentation policy;
- the active sentence transitions without a full-brightness plateau or reset;
- nearby sentences retain a coherent transition when the caret crosses a boundary;
- structural merge/split rebuilds highlights without exposing a missing-highlight frame;
- a focused replacement can seed continuity from the actual presented value without treating the target alpha as a floor;
- text remains in its host DOM; the effect does not wrap or duplicate text.

The current implementation uses sentenceModel/textProjection, CSS Custom Highlight where available, and a Session-owned presentation seed (src/modules/ripple.ts:1-307; docs/DESIGN.md:169-175). The semantic requirement transfers; CSS Highlight is a platform choice.

### Failure modes

- the active sentence flashes from dim to bright and back;
- a rebuilt highlight causes the whole paragraph to become bright;
- merge produces duplicate text or a blank frame;
- UTF-16 indexing highlights the wrong sentence;
- a new target restarts from an arbitrary baseline.

## Block Ripple

### What the user should see

Block Ripple expresses writing context as a semantic hierarchy:

- the focused block/direct content is clear;
- siblings recede according to distance;
- parent context remains present but quieter;
- nested list levels do not flatten into one opacity plane;
- a marker and its direct content participate as visual parts of the correct semantic owner;
- a focused marker does not inherit stale dimming from an ancestor;
- moving focus transfers the visual hierarchy continuously;
- DOM replacement or list reparent does not produce a bright/dim/bright seam;
- when ownership is ambiguous, the effect releases rather than paints stale content.

Its purpose is not “opacity animation.” It is to reveal the current writing context without making the document's hierarchy disappear. The current BlockPainter keeps committed presentation ancestry, presented composite alpha, semantic keys, role invalidation, and a bounded owner set; blockPlan collects the semantic topology (src/modules/ripple/blockPlan.ts:1-108; src/modules/ripple/blockPainter.ts:1-404).

### Why the ancestor logic matters

Opacity is multiplicative in the host tree. A child can be assigned the intended local alpha and still become too dim because a covering ancestor carries an old alpha. The history from e70b955, 8668a73, f456068, 6ea30f1, b8772dc, and 292122c records successive fixes for this class of bug.

The current protection is not decorative complexity:

- parents record committed presentation ancestry, not merely current live ancestry;
- presented and snapshot values preserve the actual handoff state;
- protectFocus re-expresses covering dim on safe off-path siblings;
- focusBranchBoundary stops stale ancestor dim at the focused list item;
- same-key replacement preserves state only when the presentation role is still valid.

These are high-risk host- and regression-informed seams. They are not safe cleanup targets.

## Structural editing

Host final structure and visual continuity are separate problems. The host decides whether a list item was moved, replaced, split, or merged. The presentation layer may show a bounded local transition only after it has evidence about the change.

### Tab

Tab indents the focused list item. It is a structural reparent, not a document-wide move animation. The user should see the affected content and its marker remain coherent while the surrounding tree stays stable. Current StructurePresentation captures the exact subject before mutation and attaches the displacement inside mutation delivery; it must fail closed if the host owns the transform or the subject is no longer valid (src/modules/structurePresentation.ts:19-29, 107-208).

### Shift+Tab

Shift+Tab outdents the focused item. The host may temporarily disconnect the old item before a replacement is observable. The product must never invent a replacement or expose stale ownership. A safe release is preferable to a delayed or wrong animation.

### Enter

Enter means the continuous document yields at the caret and opens a new writing location. Surviving content may move locally; the new block may visually continue from the pre-edit caret origin. The semantic result is a split, not a request to move an old block wholesale.

### Backspace and Delete

At a structural boundary, Backspace or Delete can merge or remove structure. The user should see nearby surviving content make room or fill the gap, while Selection follows the host's final result. Inside ordinary text, the edit remains ordinary and should bypass structural capture.

LayoutContinuity is a separate bounded local-flow owner for Enter, Delete, and Backspace. It is intentionally not unified with Tab/Shift+Tab presentation, because reparent displacement and local content flow have different subjects and evidence (src/modules/layoutContinuity.ts:46-57, 182-317; docs/PHASE2_V2_INTEGRATION.md:1-34).

### Failure modes

- ordinary character deletion pays a structural deadline;
- a focused-only transform lets the host paint the new layout for one frame and then pulls it back;
- a merge duplicates source text through a ghost surface;
- structural motion is applied twice to the same content;
- marker geometry is treated as document content;
- a transform owned by the host is overwritten;
- rapid structural input queues stale generations.

## Selection, IME, and lifecycle

Native editing remains authoritative:

- range selection cancels structural presentation and returns ownership to the editor;
- compositionstart cancels structural authority and automatic scroll; compositionend reacquires fresh evidence rather than claiming completion;
- blur/focusout in a visible editor retargets presentation toward neutral when safe;
- disable, destroy, timeout, overflow, hidden-document teardown, and frame exceptions release synchronously;
- editor switching pairs cleanup across Cursor, Typewriter, Ripple, and structural owners;
- a missing or disconnected editor causes fail-closed behavior.

These are mature policies with incomplete real-machine coverage for some IME, popup/split-editor, and cross-block cases (src/session.ts:596-786; docs/SIYUAN_HOST_CONTRACT.md:157-183, 199-207).

## What is deliberately not promised

zenType does not promise that every host mutation animates, that the caret is always centered, that a structural effect survives every uncertain topology, or that current response values remain correct on a new platform. The promise is a writing-first, calm, continuous presentation when truth and ownership are sufficiently known.
