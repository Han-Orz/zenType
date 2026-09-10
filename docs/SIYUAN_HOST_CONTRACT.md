# SiYuan host contract

调研日期：2026-09-09 UTC

| Repository | Current revision | Version |
| --- | --- | --- |
| `siyuan-note/siyuan` | [`8641553a1f07374001902d3ce773285db1292b2d`](https://github.com/siyuan-note/siyuan/tree/8641553a1f07374001902d3ce773285db1292b2d) | 3.8.3 |
| `siyuan-note/plugin-sample` | [`d9ad60b556585ab66acbb494fc5aae0be62b2f86`](https://github.com/siyuan-note/plugin-sample/tree/d9ad60b556585ab66acbb494fc5aae0be62b2f86) | 0.5.1 |

本次开始时，官方 master 仍是 zenType 既有文档记录的 v3.8.3 / `8641553a…`，没有版本差异。以下结论只约束该 revision。源码里的调用顺序不等于浏览器一定在某个 rAF 前投递 MutationObserver 或 Selection 更新。

## Evidence vocabulary

- **Source-proven**：当前 SiYuan 源码直接存在该路径或操作。
- **Official API contract**：官方 Plugin class、lifecycle coordinator、plugin-sample 或类型包明确承诺。
- **Inferred**：源码强烈支持，但浏览器 task、microtask、MutationObserver 与 rAF 的相对投递仍未实测。
- **Runtime-observed**：来自真实 SiYuan 运行日志，只约束被观测的宿主组合。
- **Not verified**：当前源码与自动夹具均不能回答。

**Runtime-observed.** 用户实机 SiYuan 3.8.3 / Electron 44.2.0 / Chrome 152 中，`requestAnimationFrame` callback timestamp 与同一 callback 执行时的 `performance.now()` 存在约 134ms 的稳定偏移。zenType 不得跨这两个来源进行 elapsed/deadline arithmetic；原始 rAF timestamp 仅可作为 frame provenance/telemetry。

## Editing paths

### Tab / Shift+Tab

**Source-proven.** [`keydown.ts`](https://github.com/siyuan-note/siyuan/blob/8641553a1f07374001902d3ce773285db1292b2d/app/src/protyle/wysiwyg/keydown.ts#L2198-L2255) awaits `listIndent` / `listOutdent`. Both functions may first await `getFocusedParentOrderedList`, which obtains parent list DOM through the kernel, then reject stale disconnected nodes before mutation. Therefore these operations can cross an async boundary before local DOM editing.

[`list.ts`](https://github.com/siyuan-note/siyuan/blob/8641553a1f07374001902d3ce773285db1292b2d/app/src/protyle/wysiwyg/list.ts#L714-L944) and its [outdent path](https://github.com/siyuan-note/siyuan/blob/8641553a1f07374001902d3ce773285db1292b2d/app/src/protyle/wysiwyg/list.ts#L1085-L1581) use a mixture of DOM operations:

- existing list items and their content blocks are moved with `before` / `after`; their `data-node-id` remains stable;
- new list containers receive `Lute.NewNodeID()` when the target nesting shape does not already exist;
- emptied list/list-item containers are removed;
- `.protyle-action` is sometimes updated in place through attributes, classes, `textContent` or `innerHTML`, and some subtype conversions replace marker markup;
- a `<wbr>` tracks the caret while DOM is moved; `focusByWbr` normally restores Selection synchronously before the function returns; multi-item Range paths additionally use `restoreFocusContext` after the awaited list function;
- `transaction()` queues persistence/synchronization after the immediate DOM edits. Later transaction responses can update other copies of the same block.

There is no Tab-specific `requestAnimationFrame`, Promise continuation after the final focus call, or fixed timer in these functions. The pre-mutation fetch and later transaction response mean one user operation can still span more than one task and more than one DOM phase.

### Backspace / Delete matrix

The entry branch is [`keydown.ts`](https://github.com/siyuan-note/siyuan/blob/8641553a1f07374001902d3ce773285db1292b2d/app/src/protyle/wysiwyg/keydown.ts#L1293-L1625); block removal/merge behavior is implemented in [`remove.ts`](https://github.com/siyuan-note/siyuan/blob/8641553a1f07374001902d3ce773285db1292b2d/app/src/protyle/wysiwyg/remove.ts).

| Operation | Keydown path | DOM mutation | Semantic topology | Selection change | Async boundary |
| --- | --- | --- | --- | --- | --- |
| Character deletion inside text | Falls through to native contenteditable deletion | Usually characterData first; later `input()` normalization may replace rendered DOM | Usually unchanged, but not guaranteed until post-input work finishes | Browser first, then host focus normalization if needed | Yes: input listener schedules host `input()` with `setTimeout(0)` |
| Backspace at block start | Calls `removeBlock` | Moves/removes/merges blocks; may rerender a survivor | Parent/sibling relation can change | wbr/range focus restored by the chosen merge path | Possible: block-ref confirmation and nested list paths await |
| Empty block deletion | `removeBlock` empty-branch | Removes empty block or container; may focus a neighbor | Node removed; neighboring identity retained | Focus moves to surviving block | Possible when references or list restructuring are involved |
| List-item merge/outdent | `removeLi`, sometimes `listOutdent` | Moves child blocks/items, removes old item/list, may create a list container | Parent relation changes; new container ID possible | `focusByWbr` after local restructure | Yes on focused ordered parent lookup and some confirmation paths |
| Special inline boundary | Dedicated keydown branches | Removes an empty semantic inline node, places wbr, or only moves caret | Block topology usually unchanged | Synchronous `focusByRange` / offset update | Usually none in the local branch |
| Forward Delete at block end | Finds next block and calls `removeBlock` | Next block merges/removes; special blocks have dedicated handling | Can change | Finally restores/moves Range to survivor | Possible; the call is awaited in relevant branches |

This evidence distinguishes ordinary deletion from merge deletion by the host path and resulting mutations, not from the key name alone. zenType is therefore correct to classify observed DOM rather than add Backspace/Delete special cases.

### Enter

[`keydown.ts`](https://github.com/siyuan-note/siyuan/blob/8641553a1f07374001902d3ce773285db1292b2d/app/src/protyle/wysiwyg/keydown.ts#L1685-L1700) awaits [`enter.ts`](https://github.com/siyuan-note/siyuan/blob/8641553a1f07374001902d3ce773285db1292b2d/app/src/protyle/wysiwyg/enter.ts#L48-L841).

| Path | Identity/topology result | Selection |
| --- | --- | --- |
| Paragraph split | Original ID remains with one side; the new block gets a fresh ID | wbr is focused in the new/current result |
| Enter at paragraph start | Fresh empty block is inserted; original block identity remains | New empty block receives focus |
| Empty paragraph | Depending on parent, removes/exits container or creates/moves an ordinary block | Focus follows the surviving/moved block |
| List item | Creates a fresh list-item/block identity or delegates to list restructuring | `focusByWbr`; focused ordered-list lookup can await |
| List termination | Empty top-level/nested item delegates to outdent/break-list behavior | Focus after final topology is installed |
| Blockquote/callout | May move existing content out, remove the container, or replace converted markup | Focus is restored after the local replacement |
| Code/special block | Dedicated update/exit behavior; fence conversion can replace markup while retaining logical block identity | Dedicated wbr/range restoration |

Enter is not a single DOM contract. New IDs, stable IDs, moves, removals and same-ID representation replacement all occur on different branches.

### Post-input work and the residual authority race

**Source-proven.** [`WYSIWYG.scheduleInput`](https://github.com/siyuan-note/siyuan/blob/8641553a1f07374001902d3ce773285db1292b2d/app/src/protyle/wysiwyg/index.ts#L381-L395) uses `window.setTimeout`, normally with delay 0. The input listener invokes it after native editing. [`input.ts`](https://github.com/siyuan-note/siyuan/blob/8641553a1f07374001902d3ce773285db1292b2d/app/src/protyle/wysiwyg/input.ts#L114-L611) then normalizes inline semantics, can create blocks, and in real branches inserts rendered HTML after the current block and removes the predecessor. That replacement retains the logical `data-node-id` while changing the DOM element.

Consequently this sequence is allowed by current host source:

1. keydown establishes structural intent;
2. native input and an early characterData/representation mutation occur;
3. SiYuan's scheduled input task has not run yet;
4. that later task performs representation or semantic childList work.

**Inferred.** A browser may run zenType's first rAF between steps 2 and 4. Source cannot prove the exact MutationObserver/rAF delivery order, but it does disprove the assumption that early non-structural evidence means all host work is complete. The gate therefore waits for 48ms of quiet after the most recent classified activity before confirming ordinary, with the existing 160ms absolute deadline. The deterministic regression test puts characterData evidence before a delayed structural mutation and asserts that the first frame is withheld.

### Same-ID replacement

**Source-proven.** It occurs at least in two classes of path:

- `input.ts` renders normalized block DOM, inserts it beside the old element, then removes the old element while retaining the block ID;
- [`transaction.ts`](https://github.com/siyuan-note/siyuan/blob/8641553a1f07374001902d3ce773285db1292b2d/app/src/protyle/wysiwyg/transaction.ts#L215-L255) applies updates to matching copies/embeds with `insertAdjacentHTML` followed by `item.remove()`. The actively edited copy may be spared by the editing marker, but other same-ID copies are genuinely replaced after transaction work.

Thus marker/element object identity is not stable even when semantic block identity is stable. zenType's bounded same-key rebind is grounded in a real host path.

## Selection and Range

**Source-proven.** [`selection.ts`](https://github.com/siyuan-note/siyuan/blob/8641553a1f07374001902d3ce773285db1292b2d/app/src/protyle/util/selection.ts#L200-L232) implements `getEditorRange` from the live browser Selection and may repair focus when it is outside the requested editor. `focusByRange` synchronously replaces browser ranges; `focusBlock` constructs a valid block range. Undo focus context stores node IDs, occurrence and text offsets, while `restoreFocusContext` re-finds the live nodes. `<wbr>` and tracked-range insertion preserve a location through DOM movement/replacement.

**Inferred.** A MutationObserver batch only proves that DOM mutations were delivered. It does not prove that an async SiYuan path has executed its later `focusByWbr`, `restoreFocusContext`, or transaction continuation. Reading Selection immediately after one batch can therefore observe an intermediate Range.

**Not verified.** Whether this actually happens between specific Tab, merge, Enter or IME phases on supported Chromium builds needs a real-host timeline containing task/frame, mutations and Selection.

## caretScroll and scroll ownership

**Source-proven.** [`caretScroll.ts`](https://github.com/siyuan-note/siyuan/blob/8641553a1f07374001902d3ce773285db1292b2d/app/src/protyle/wysiwyg/caretScroll.ts#L66-L93) keeps one pending rAF per scroll container, resamples caret geometry in that rAF, then mutates `contentElement.scrollTop`. Current callers in `keydown.ts` are ArrowUp/ArrowDown paths, not Tab, Enter, Backspace or Delete. Structural functions also use synchronous focus/centering, and `input.ts` can restore table/content scroll after replacement; transaction/fold work can update views later.

Therefore there is no source-proven structural-key window in which the named `scheduleCaretScroll` must race Typewriter immediately after StructureGate commit. There is still a general later-host-scroll possibility. Typewriter already treats an unexpected scroll as host takeover and cancels its endpoint; no algorithm change or magic delay is justified. A minimal runtime test should queue a host scroll after a structural commit and assert that zenType yields rather than counter-writes.

## IME

**Source-proven.** [`index.ts`](https://github.com/siyuan-note/siyuan/blob/8641553a1f07374001902d3ce773285db1292b2d/app/src/protyle/wysiwyg/index.ts#L3963-L4055) records composition state at `compositionstart`. Cross-block `compositionend` awaits `complete`; ordinary `compositionend` invokes the async `input()` path without awaiting it. DOM normalization, transactions and Selection restoration may therefore continue after the DOM composition event returns.

zenType's `compositionstart -> cancel structure`, Typewriter suppression and normal invalidation recovery are consistent with that evidence. No source fact defines a universal composition completion frame, so this round does not add a timer or change IME behavior.

## Plugin lifecycle contract and zenType audit

**Official API contract.** SiYuan's [`Plugin` class](https://github.com/siyuan-note/siyuan/blob/8641553a1f07374001902d3ce773285db1292b2d/app/src/plugin/index.ts#L136-L162) permits `Promise<void> | void` for load/unload lifecycle hooks. The [lifecycle coordinator](https://github.com/siyuan-note/siyuan/blob/8641553a1f07374001902d3ce773285db1292b2d/app/src/plugin/lifecycle.ts#L440-L510) serializes phases and waits within one five-second teardown budget. A timed-out Promise cannot be canceled and may continue after disposal. The [official sample guidance](https://github.com/siyuan-note/plugin-sample/blob/d9ad60b556585ab66acbb494fc5aae0be62b2f86/README.md#L264-L281) requires short, idempotent hooks, plugin-owned cancellation and checks after async boundaries.

**Source-proven host cleanup.** Before `onunload`, SiYuan stops commands, uploads and tracked ranges. After it, host disposal destroys EventBus and host-owned UI/resources. `destroy-protyle` is emitted when an editor is destroyed.

zenType audit result:

| Resource/race | Current ownership and teardown | Verdict |
| --- | --- | --- |
| EventBus and addCommand/addTopBar | explicit `off` for subscriptions; host also destroys plugin resources | closed/idempotent |
| document/window/viewport/media/fonts listeners | Session-owned AbortController plus explicit feature cleanup | closed |
| MutationObserver/ResizeObserver | Session-owned; disconnected on unbind/destroy | closed |
| timers/rAF | one Session rAF and bounded wake timer; both canceled on destroy | closed |
| WAAPI | painter map cancel on clear; low-frequency exact-id stale recovery on bind | closed without scanning hot path |
| CSS Highlight/style/caret class | Ripple/Cursor/session clear plus injected style removal | closed |
| loadData after disposal | `disposed` checked after await; partial init teardown is safe | closed |
| saveData during unload/re-enable | `onunload` now awaits the serialized save chain; rejection UI is suppressed after disposal | corrected |
| duplicate enable | old instance releases resources and pending save before host completes unload | consistent with official lifecycle |

The official sample currently uses Node >=24, pnpm 11.4, TypeScript 6, Webpack and `siyuan` 1.2.7. zenType adopts the current `siyuan` types and pins its package manager, but retains the smaller esbuild/TypeScript pipeline. Its BCP 47 locale keys, manifest fields and archive layout are valid; no host fact requires copying the sample's bundler, linter or minimum app version.

## Required conclusions

1. **Tab/Shift+Tab async?** Yes, focused ordered-list lookup can await before local mutation; persistence/other-copy updates can follow later.
2. **Indent/outdent DOM model?** Mixed moves, remove/add, new containers and marker representation updates—not one replacement strategy.
3. **Node ID stable?** Moved items/blocks retain IDs; newly created containers/items get new IDs; same-ID replacement also exists.
4. **Marker rebuilt?** Sometimes mutated in place, sometimes its markup is rebuilt/replaced during subtype/render conversion.
5. **Selection restored when?** Usually synchronously at the end of the local branch through wbr/range helpers; Range paths may restore after an awaited list operation, and later async paths can restore again.
6. **Caret scroll scheduled when?** The named rAF scheduler is currently used by vertical-arrow handling, not the audited structural keys. Other synchronous/later scroll restoration exists.
7. **Ordinary vs merge Backspace?** Yes by host path and DOM/topology evidence, not safely by keydown/input alone.
8. **Structural operation after non-structural batch?** Allowed by source because native mutation precedes scheduled post-input normalization; exact frame placement is runtime-not-verified.
9. **Where does same-ID replacement occur?** Input rendering/normalization and transaction updates of matching copies/embeds, among other render paths.
10. **Async work after compositionend?** Yes: cross-block completion is awaited and normal completion launches async input work.
11. **Lifecycle aligned?** Yes after awaiting the save chain; zenType's cancellation/cleanup boundaries agree with the official serial lifecycle and timeout caveat.

## Runtime-not-verified checklist

- MutationObserver, Selection and rAF ordering for Tab/Shift+Tab and block merge.
- Marker geometry continuity across subtype conversion and same-ID replacement.
- Host-scroll takeover immediately after a structural commit.
- Compositionend ordering for at least one CJK IME and cross-block composition.
- Range selection, editor switch, disable/re-enable and popup/split editor ownership.

The current environment had no Docker executable, local SiYuan process or Chromium binary, so a browser-accessible official host could not be started without expanding the project/toolchain. These items remain deliberately unlabelled as runtime-observed.
