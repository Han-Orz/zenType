# Golden Behavior Scenarios

These scenarios are product-level specifications, not automated test code. zenTypeNext should be able to use them as acceptance references without running zenType or reproducing its DOM.

## How to read the table

- Semantic result is what the edit or gesture means.
- Expected visual behavior is the user-visible contract.
- Must not happen records a regression that has already damaged the experience or a predictable violation of the authority boundary.
- Maturity describes the evidence for the scenario, not whether a current function happens to exist.
- Transfer priority says how urgently the scenario belongs in a Next acceptance suite.

The scenarios combine the current Remake, the v2.8.1 behavior reference, regression tests, and SiYuan host evidence. Real-machine acceptance remains explicitly pending for the newer Layout Continuity paths and several IME/editor variants; see OPEN_QUESTIONS_AND_NON_GOALS.md.

## Writing and cursor

| ID / Name | Context / Action | Semantic result | Expected visual behavior | Must not happen | Maturity | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| S01 Character typing | Caret is in ordinary text; type one or more characters. | Text is edited at the native caret. | Cursor follows promptly; sentence and block context retarget without restart. | Input waits for animation; caret separates from glyphs. | Mature | MUST |
| S02 Ordinary Backspace | Delete a character away from a structural boundary. | Ordinary text deletion. | Immediate local response; no structural flow capture. | 48 ms or 160 ms structural latency; a block moves. | Regression-validated | MUST |
| S03 Ordinary Delete | Delete a character forward away from a structural boundary. | Ordinary text deletion. | Same immediate path as ordinary Backspace. | Structural capture is triggered only because the key is Delete. | Regression-validated | MUST |
| S04 Horizontal movement | Move the caret left or right within a writing surface. | Navigation changes writing location. | Cursor and active sentence follow continuously. | Full reset, delayed response, or unrelated block animation. | Mature | MUST |
| S05 Vertical movement | Move up or down across lines or blocks. | Navigation changes location, possibly across layout. | Cursor settles to fresh geometry; scroll remains comfortable. | Old target is dragged through a new editor state. | Architecture-accepted | SHOULD |
| S06 Rapid direction reversal | Move, then reverse before the first motion settles. | Latest navigation intent wins. | Current position and velocity are retargeted smoothly. | Cancel to origin, then visibly ease in again. | Regression-validated | MUST |
| S07 Selection start/end | Start or extend a native range selection. | Native Selection owns the interaction. | Cursor/presentation yield; document remains stable. | Plugin moves the caret, fights selection, or paints a stale target. | Regression-validated | MUST |
| S08 Temporary geometry loss | Caret rect is temporarily unavailable during host work. | No trustworthy new geometry exists yet. | Hold briefly or fade safely; reacquire only fresh evidence. | Jump to an old coordinate or show a ghost caret. | Regression-validated | MUST |
| S09 Editor or block switch | Focus moves to another editor or document area. | Active writing context changes. | Old presentation is cleaned up; new geometry is committed hidden, then revealed coherently. | Old cursor/ripple remains in the new editor; reveal precedes stable geometry. | Architecture-accepted / pending full host matrix | MUST |
| S10 Cursor idle breathing | Stop typing and remain focused. | Attention is still in the writing location. | Subtle breathing begins after an idle period and remains subordinate. | Breathing distracts, restarts every frame, or changes Selection. | Mature behavior / current calibration | SHOULD |

## Typewriter and viewport agency

| ID / Name | Context / Action | Semantic result | Expected visual behavior | Must not happen | Maturity | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| S11 Enter comfort edge | Caret approaches the comfort boundary. | Viewport should preserve writing comfort. | Scroll moves only as needed and settles without recentering everything. | Every keystroke centers the caret. | Mature | MUST |
| S12 Repeated typing near edge | Type repeatedly while the edge remains active. | Latest caret location remains the target. | Scroll continues from its presented state; no restart staircase. | Repeated ease-in, oscillation, or growing lag. | Regression-validated | MUST |
| S13 Manual scroll takeover | User wheels, drags, touches, or otherwise scrolls. | User/host owns viewport intent. | Typewriter yields and does not immediately write back. | Scroll fights the user. | Regression-validated | MUST |
| S14 Reverse navigation scroll | Navigate back toward the opposite edge. | Viewport follows in the reverse direction. | Same comfort semantics and coherent retargeting apply. | One-way scroll behavior or jump to the previous target. | Regression-validated | SHOULD |
| S15 IME composition viewport | compositionstart through compositionend. | Composition and host completion own the edit. | Automatic scroll is suppressed during composition; fresh evidence is acquired after completion. | Scroll moves on provisional composition geometry or claims completion early. | Architecture-accepted / real CJK pending | MUST |
| S16 Structural scroll follow-up | Enter or merge changes layout near the caret. | Host commits structure; viewport may then adjust. | Any scroll response follows final host truth and remains bounded. | Typewriter and host scroll against one another. | Desired / pending | SHOULD |

## Sentence and block focus

| ID / Name | Context / Action | Semantic result | Expected visual behavior | Must not happen | Maturity | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| S17 Sibling focus | Move focus from one sibling block to another. | Writing context changes to the sibling. | Active sentence/block becomes clear; old context recedes continuously. | Bright → dim → bright seam. | Regression-validated | MUST |
| S18 Nested list focus | Focus a child at one or more nested levels. | Tree context remains meaningful. | Child is clear, relevant parent context remains legible, distant branches recede. | Whole tree becomes one opacity plane. | Regression-validated | MUST |
| S19 Parent/sibling depth | Move among parent, sibling, and descendant branches. | Visual distance communicates context, not ownership confusion. | Alpha hierarchy changes without flattening or stale ancestor multiplication. | Focused content is dimmed by an old parent. | Regression-validated | MUST |
| S20 Marker ownership | Focus or move across a list marker and its content. | Marker is structural chrome attached to the semantic item. | Marker and direct content have the correct owner and continuity. | Marker is treated as an independent document block. | Regression-validated | MUST |
| S21 Focused marker boundary | Focused item contains a marker; ancestor has dim state. | Focus path must be visually clear. | Focused marker/content remain neutral while safe off-path branches carry dim. | Marker flash or dim → 1 → dim. | Regression-validated | MUST |
| S22 Same semantic replacement | Host replaces an element with the same semantic key. | Semantic object may continue, actuator identity changes. | Value, velocity, and target continue on the new actuator when role is valid. | Old DOM disappears, new DOM fades from default; duplicate owner. | Regression-validated | MUST |
| S23 Focused replacement role change | Same key replacement becomes the focused role. | Semantic identity does not preserve an obsolete presentation role. | Old dim owner is invalidated; focus is not dimmed by carried role. | 1 → 0.4 → 1 or stale focused alpha. | Regression-validated | MUST |
| S24 Sentence boundary crossing | Move caret across a sentence boundary. | Active sentence changes. | Highlight transition follows UTF-16/text-model boundaries without a full-brightness plateau. | Wrong segment, missing highlight, or full-text flash. | Regression-validated | SHOULD |
| S25 Structural sentence rebuild | Merge/split rebuilds text nodes or highlights. | New text model is authoritative after the host change. | First committed frame registers the current highlight; continuity is seeded only from real presented state. | Blank highlight frame or duplicated text surface. | Regression-validated | MUST |

## Structural editing

| ID / Name | Context / Action | Semantic result | Expected visual behavior | Must not happen | Maturity | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| S26 Tab indent | Focus a list item; press Tab. | Item is reparented into a deeper list. | A bounded exact-subject displacement and Ripple handoff preserve marker/content continuity. | Whole-editor FLIP; marker flashes; host transform is overwritten. | Regression-validated / real paths bounded | MUST |
| S27 Shift+Tab outdent | Focus a nested item; press Shift+Tab. | Item is reparented upward. | Same continuity goal; if subject is temporarily disconnected, release safely. | Invented replacement, stale owner, delayed wrong animation. | Regression-validated / path acceptance pending | MUST |
| S28 Enter split | Caret splits a block. | Continuous writing surface creates a new block at the split. | Local surviving content yields; new block may continue from the pre-edit caret origin. | New block pops in independently; broad block flight. | Architecture-accepted / feel pending | MUST |
| S29 Backspace boundary merge | Caret is at a merge boundary; press Backspace. | Host merges with the preceding structure. | Surviving local content fills the gap and Selection follows host result. | Ghost source text, duplicate content, stale caret. | Architecture-accepted / feel pending | MUST |
| S30 Delete boundary merge | Caret is at a merge boundary; press Delete. | Host merges with following structure. | Same local flow and Selection continuity in the opposite direction. | Direction-specific jump, duplicate text, or structural timeout. | Architecture-accepted / feel pending | MUST |
| S31 Repeated structural edits | Press Enter, Tab, or merge keys again before motion settles. | Latest structural generation supersedes stale work. | Motion rebases from the presented state within bounded work. | Queue of obsolete animations, double offset, stale topology. | Regression-validated for gate; flow feel pending | MUST |
| S32 Nested structural edit | Perform split/merge/indent in a nested list with several visible ancestors. | Host hierarchy changes locally. | Only the known impact path moves; ancestor planes and focus remain coherent. | Unbounded traversal, ancestor flash, unrelated branches move. | Desired / pending | MUST |
| S33 Empty block boundary | Edit an empty block or boundary case. | Host applies its normal structure semantics. | Presentation may release if topology is ambiguous; Selection remains correct. | Guessing geometry, placeholder/clone surface, stuck owner. | Desired / pending | SHOULD |

## Lifecycle and safety

| ID / Name | Context / Action | Semantic result | Expected visual behavior | Must not happen | Maturity | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| S34 Blur/focusout | Leave a visible editor or suspend a menu. | Editor no longer owns active writing attention. | Ripple retargets toward neutral when safe; native state remains intact. | Abrupt destructive flash or effects continue over another surface. | Regression-validated | MUST |
| S35 Disable/enable | Toggle zenType off and on. | Plugin presentation is withdrawn; host remains usable. | Owners, observers, rAF work, and styles are released; re-enable starts fresh. | Old owner reappears, leaked observer, or stale geometry. | Architecture-accepted | MUST |
| S36 Hidden/destroy teardown | Hide the document, destroy the session, or hit timeout/overflow. | Presentation cannot safely continue. | Synchronous fail-closed cleanup. | Asynchronous stale write after destruction. | Regression-validated | MUST |

## Acceptance notes

The highest-value missing acceptance lane is real SiYuan/CDP or equivalent native-host observation for S16, S27-S33, S35, and the IME/editor variants of S09 and S15. The current browser fixture tests marker alpha but is typechecked rather than included in tests/run.mjs (docs/DEAD_CODE_PATCH_DEBT_AUDIT.md:264-289). This is a coverage gap, not permission to weaken the scenarios.
