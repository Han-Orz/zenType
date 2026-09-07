# zenType 2.9 implementation

## Ownership

- `index.ts`: plugin commands, persisted feature switches, host lifecycle events, stylesheet.
- `session.ts`: DOM input events, active writing editor, IME/pointer suspension, dirty flags, observers, one rAF handle.
- `utils/editorScope.ts`: validate the active editable body and read one frame of caret/viewport geometry. Titles, popovers, databases and embedded editors stay native.
- `modules/cursor.ts`: one custom caret, native-caret ownership class, one idle breathing timer.
- `modules/typewriter.ts`: one bounded scroll endpoint and an exponential approach. No events, timers or rAF.
- `modules/ripple.ts`: collect siblings along the focus ancestry, apply private dim styles, cache the current block's text nodes/sentences, animate one entering/leaving batch.
- `modules/ripple/sentenceModel.ts`: Intl.Segmenter and positional boundary semantics. Missing platform support disables sentence focus.

No feature imports another feature. No shared event bus, structural transactions, DOM identity model, or animation framework.

## Frame

Events mark geometry/text/structure dirty and request the same frame. Ordinary input performs no layout measurement or synchronous Ripple application.

The frame validates Selection, reads caret and viewport geometry, prepares changed Ripple targets/ranges, and calculates the next scroll position. It then removes presentation attributes copied into new host nodes, writes scroll position, places the custom caret with the same scroll delta, and applies Ripple.

Sentence-only animation advances colors without re-reading geometry. Scrolling reads current geometry. Idle has no JavaScript rAF loop.

The MutationObserver watches the current editor's childList, characterData and contenteditable changes. A separate root observer invalidates theme colors. One ResizeObserver watches the editor and scroll viewport. Plugin CSS attributes are not observed.

## Invariants

1. Never change document text, Selection or undo history.
2. Hide native caret only while a valid custom caret is visible. Invalid geometry restores native behavior.
3. IME composition pauses auto-scroll and uses native caret. Commit resumes writing.
4. Pointer activity, manual scrolling, vertical navigation, blur and editor switches stop automatic following.
5. Auto-scroll clamps to document bounds. Comfort centering may wait; viewport-edge visibility cannot.
6. Focus ancestry remains undimmed. Only direct content/markers and sibling branch roots receive dim styles.
7. Structural edits have no animation identity. Copied private attributes are discarded from added subtrees before applying current styles.
8. Unload releases events, observers, frames, timers, private attributes and Highlight registrations.
9. Reduced motion keeps functional results without movement or breathing animation.

## Motion

Configuration is in `src/config.ts`: caret 55ms while typing / 110ms for navigation, breathing after 1100ms, scrolling response 65ms, typing pause 400ms, sentence acquisition 180ms / release 280ms. Block opacity uses a 240ms CSS transition.

Large caret jumps and viewport tracking snap. Short movements ease out. Scroll retargets use current position and the newest bounded endpoint. Text/DOM edits settle sentence presentation immediately; stable-text navigation replaces the previous entering/leaving batch. Shared sentence boundaries keep both adjacent sentences active.

## Validation

The initial rewrite uses type checking and development/production builds. Existing tests are unchanged and deliberately not run or migrated. Build success is not evidence of real input latency or IME behavior. The next acceptance step is hands-on SiYuan use: Chinese IME, long paragraphs, nested lists, fast navigation, repeated structural editing, wheel interruption, split-editor switching, and unload/reload.

No DebugKit hooks or network collectors. Earlier architecture notes and changelog entries describe older versions; v2.9 follows this document and current source.
