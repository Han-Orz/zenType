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

**Runtime-observed (2026-09-10, full CDP).** 在同一宿主的真实渲染页中，段末 Enter 会新增空块并以相同 `data-node-id` 替换原 paragraph；旧 CSS Highlight Range 随旧 DOM 脱离。补丁前 replacement 在下一帧前计算为 `opacity: 1`，补丁后同一 MutationObserver delivery 内已由现有 BlockPainter 持有 `[0.6, 0.6]` WAAPI effect，计算 opacity 为 `0.6`。这只证明本次 paragraph-split 路径与运行环境，不推广为所有 Enter 路径。

**Runtime-observed (CDP-triggered lifecycle event).** 在真实渲染页触发 window blur 前，活动段落包含约 `0.6` 的 dim sentence Highlight、相邻块由 Ripple 持有 `0.4`；旧实现同步删除 Highlight 并取消 block effects。补丁路径改为把 sentence target 设为 neutral，并将 block effects 从当前值 retarget 到 `1`。这验证 renderer 内的交接，不替代操作系统窗口切换的人工观感验收。

**Runtime-observed (2026-09-11, real DebugKit session).** 在 SiYuan 3.8.3 中，拖选整段内容后执行 range deletion，Selection 会 collapse 到一个空 Text node；该 Range 没有 client rect，而所属 paragraph 仍可能包含零宽或 presentation placeholder text。该观察只约束此真实宿主路径，不推广为所有 ContentEditable 或浏览器实现。

**Runtime-observed (2026-09-12, full CDP, list Tab).** 在真实渲染页对 `- alpha / - beta / - gamma` 列表的第二个 item 按 Tab：Host 的 mutation batch 在 keydown 后约 7ms 到达，形状是 **move 而非 replacement**——新建一个 `NodeList` 挂到前一个 item 的 `<li>` 下，把聚焦 item 的 `<li>` 从外层 `NodeList` 移除并插入这个新 list；`<li>` 与内部 paragraph 的 `data-node-id` 保持不变，另外只做 `class` 归一化与 contenteditable 内空 Text node 的增删。因此 list 缩进没有同 id replacement 语义，连续性只能靠 `visualKey` 匹配与 owner 数值/WAAPI 交接。

**Runtime-observed (2026-09-12, full CDP).** 同一路径上存在两个独立的亮度闪，都由 zenType 自己的 presentation 计划产生，而非 Host 样式：

1. **Block presentation。** commit 计划给「聚焦块自己的 paragraph 与其 marker」算出 `startValue 0.2 → target 1`，原因是 `planHandoff` 把「本次计划即将释放的祖先 `<li>`」的旧 dim 值折进了这两个 target 的起始值。它们在 reparent 后才成为该 `<li>` 的后代，旧 dim 从未覆盖过它们，于是在 commit 帧先渲染为 0.2 再用 150–360ms 回到 1。修复后 commit 的 `changedCount` 由 8 降到 6，聚焦 paragraph 与 marker 不再进入 owner 计划。
2. **Sentence presentation。** Host 在 reparent 时替换了 paragraph contenteditable 内的 Text node。CSS Highlight Range 按 DOM 规范被重新锚定到元素边界（`startContainer` 变成 Element），`getClientRects()` 为 0，`::highlight` 不再绘制；而首帧 sentence presentation 之前被调用时传的是 `contentDirty = false`，所以直到语义 commit（约 60ms 后）才重新投影。实测该窗口内 dim 语句以全亮度绘制。修复后 Highlight 覆盖从 mutation 后的第一个采样帧起保持 `rects > 0`。

**Runtime-observed (2026-09-12, full CDP, transform ownership).** 同一宿主上，`.protyle-wysiwyg`、`NodeListItem` 与 item 内部 paragraph 的 computed `transform` 均为 `none`、inline `style.transform` 为空、`transition` 为 `all 0s`、`will-change` 为 `auto`。zenType 的 bounded structural slide 可以独占这些元素的 transform 并把原值原样还回；该结论只约束这些列表元素类型，不等于 Host 全局不使用 transform。

**Runtime-observed (2026-09-12, full CDP, caret under transform).** `Range.getBoundingClientRect()` 会包含祖先元素的 transform：对 item 施加 `translate(dx, 0)` 时，caret rect 与 item rect 同步位移。因此如果 Session 在此期间继续采样 host geometry，caret 读数会带上 presentation 位移；zenType 在采样后立刻减去当前 presentation offset，使 Structural Contract 与存储的 frame 始终消费未变换的 Host truth。

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

### Block-start Backspace merge (local presentation continuity)

**Source-proven.** The paragraph merge branch of [`remove.ts`](https://github.com/siyuan-note/siyuan/blob/8641553a1f07374001902d3ce773285db1292b2d/app/src/protyle/wysiwyg/remove.ts#L1712-L1782) resolves `previousLastElement = getLastBlock(previousElement)` (the destination) and `removeElement` (the source), extends the live editor Range to the source editable's last child, then performs, in order:

1. `const leftNodes = range.extractContents()` — the source content leaves the DOM;
2. `range.selectNodeContents(previousLastEditElement); range.collapse(false); range.insertNode(leftNodes)` — that content is inserted at the **end of the destination's** contenteditable;
3. `previousLastElement.insertAdjacentHTML("afterend", protyle.lute.SpinBlockDOM(previousLastElement.outerHTML))`, reassignment to the new sibling, and `previousLastElement.previousElementSibling.remove()` — the destination is destroyed and replaced by a fresh element that keeps the same `data-node-id`;
4. `removeElement.remove()` — the source container is removed;
5. `protyle.contentElement.scrollTop = scroll` and a follow-up `update` operation with `previousLastElement.outerHTML`.

Two consequences bound any local-continuity feature:

- after the merge the source text is rendered at the **destination's** position, so a second presentation surface drawn at the source's old position renders the same text twice;
- the destination is a **new element** carrying the old semantic key, which is exactly why same-key replacement carry (not element identity) is the correct continuity primitive.

**Source-proven (same branch).** The merge block performs its DOM work and its Selection restoration in one synchronous span: `range.insertNode(<wbr>)`, `range.extractContents()`, `range.insertNode(leftNodes)`, the `SpinBlockDOM` re-render, `previousLastElement.previousElementSibling.remove()`, `removeElement.remove()`, the `scrollTop` correction, `transaction(...)`, and finally `focusByWbr(protyle.wysiwyg.element, range)` as the **last statement** of `removeBlock` (line 1822). No `await` intervenes on the ordinary paragraph path (`confirmRefRemoval` precedes the span; only the `NodeSuperBlock` branch awaits afterwards). Therefore at the MutationObserver microtask that follows the task, the live collapsed Selection has already been moved into the surviving destination.

**Runtime-observed (2026-09-11, read-only CDP probe, live page).** The renderer hosts **more than one `.protyle-wysiwyg`**; the then-current Selection resolved to a block whose `closest('.protyle-wysiwyg')` was *not* the first editor in the document. Any feature that derives a focused semantic key from the live Selection at mutation time must therefore match the editor it observed and fail closed otherwise. This probe was read-only and did not edit the document.

**Runtime-observed (2026-09-11, read-only CDP probe).** SiYuan 3.8.3 / Electron 44.2.0 / Chrome 152.0.7977.76, live document, no editing performed:

- `.protyle-wysiwyg` itself carries `contenteditable="true"`, and the focused block's own inner contenteditable is a child of it, so a presentation surface placed inside the editor subtree is both a Host-observable mutation and editable Host content;
- a detached element and a `cloneNode(true)` of a live block both report `{x:0,y:0,w:0,h:0}` from `getBoundingClientRect()`, and `getComputedStyle()` on a fully detached node returns empty strings;
- a clone mounted under `.protyle-content` (above the editor, outside any editor-rooted MutationObserver) loses host typography: `line-height 26px → normal`, `font-size 16px → 14px`, `margin 2px 0px → 0px`;
- giving that holder the host `protyle-wysiwyg` class restores the block typography (`line-height 26px`, `font-size 16px`, `margin 2px 0px`, `padding 4px`), at the cost of depending on a host-internal class name.

Scope: this constrains the audited revision and renderer only. The merge MutationObserver/rAF/Selection ordering itself was **not** triggered and remains on the Runtime-not-verified checklist.

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

The source-only audit initially lacked a local host. On 2026-09-10 the user launched the packaged SiYuan renderer with loopback remote debugging and full CDP became available; only the paragraph-split and lifecycle observations explicitly recorded above are promoted to Runtime-observed. The remaining checklist items keep their prior evidence level.
