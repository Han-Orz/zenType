# remake.2 architecture review

Baseline: `c014b9836ea35baa1a74aa9872409f9ffd191772`.
Branch: `refactor/v2.9.0-remake.2`.

## Audit judgment

Source confirms the missing shared boundary: remake.1 Session called Typewriter before Cursor's private settle, and called Ripple even when Cursor reported settling. Consequently one frame could withhold cursor geometry yet commit scroll/opacity ownership from that same intermediate host state. This is an architectural fault, independently of whether it explains every reported flash.

Opacity has a separate root cause: normal operation serialized plugin opacity into host inline style while its original-value/ownership record existed only in JS. Copying style without class separated the two lifetimes. Fixing transaction timing alone cannot repair that design.

The v2.8.1 review retained semantic mutation classification, a bounded activity/quiet window, and alpha continuity across owner changes. It rejected the separate structural observer/rAF/subscriber runtime, FLIP motion sink, carryover registry, per-owner exit timers, forced baseline layout and temporary transition suppression. The old classifier's unbounded traversal was not copied.

The new gate and WAAPI-only presentation are implementation choices, not real-host validation results. The 48ms quiet / 160ms ceiling remains provisional. Actual DebugKit recordings are absent from the repository; the opacity observations originate in the supplied user report and baseline documentation.

## Responsibility and new concepts

| Boundary | Responsibility | State introduced or retained |
| --- | --- | --- |
| Session + `structure.ts` | Classify host activity, sample, withhold or admit all three effects | One optional pending record: editor, start/activity time, evidence, ordinary-input signal, previous caret/block and stable count |
| Cursor | Native-caret binding and continuous presentation of admitted geometry | Existing switch settle and recovery retained; no structural mode/readiness state |
| Typewriter | Numerical comfort scroll | Unchanged module; Session cancels and withholds it while pending |
| `blockPlan.ts` | Semantic targets and numeric owner repartition | Frame-local maps only; no events, animations or style writes |
| `blockPainter.ts` | WAAPI lifetime, replacement rebinding, pause/resume | One bounded owner map, one paused-presentation flag; per-owner numeric state, host baseline and saved visual key |
| `ripple.ts` | Sentence/color/highlight work and read/write staging | Commit closure replaces interleaved reads and writes |

Structural handoff is `planHandoff()` plus painter replacement matching. It executes for changed admitted plans, not ordinary text updates. While waiting, `rebind()` only carries already-owned numeric alpha to same-key replacement elements. It does not choose new neighborhood targets.

## Removed remake.1 paths

- Cursor `settleMode`, `structureReady`, `stabilize`, `markStructureReady`, `cancelStructuralSettle`.
- Session's separate `structuralUntil` selection hold and broad `holdsBlock()` classifier.
- Ripple inline opacity original/written/class ownership fields and copied-opacity inference.
- Handoff baseline inline writes, temporary transition-property overrides, forced getComputedStyle baseline flush and restoration loops.
- Added-subtree querySelectorAll cleanup and automatic legacy opacity removal.
- Color cleanup writes during projection, before fresh color reads.

Ancestor folding, brightest-donor selection and residual normalization remain because ancestor opacity multiplies descendant opacity. Merely moving those operations into a helper does not make them disappear; their isolated input/output contract is the gain. The previous mixed preparation procedure is substantially reduced, but the project gains a real coordination policy. This is a narrower reasoning boundary, not a claim that total source lines must decrease.

## Brooks review of introduced decisions

| Branch / decision | Why it exists | Evidence status |
| --- | --- | --- |
| Intent without evidence takes the ordinary path | Key names cannot distinguish character deletion from block merge | Source/event contract; user-reported ordinary deletion requirement |
| Equal block/parent identities mean representation | A new DOM element does not imply a semantic edit | v2.8.1 classifier and remake replacement logic |
| Same DOM move or unequal relations means structural | Reparent/add/remove affects ownership and geometry | Host behavior represented in existing source and marker fixture |
| Activity resets stability; missing caret resets samples | Async host work can produce wrong first geometry | User report and old readiness/recovery designs; exact threshold inferred |
| Deadline/observation overflow releases rather than commits | Elapsed time/truncated evidence cannot certify correctness | Deliberate bounded-work policy |
| User interaction/lifecycle cancels | Editor/Selection correctness outranks effect continuity | Existing ownership/lifecycle invariants |
| Same-key replacement carries old alpha | DOM replacement does not carry an animation object | Host replacement model; WAAPI object lifetime |
| Ancestor folding / donor normalization | Opacity products change when the visual owner changes | Existing list/marker fixtures; real-host validation deferred |
| Only running effects pause; paused effects resume | Playing a finished animation can rewind it | WAAPI lifecycle; finished fills must remain finished |
| Neutral completion cancels; dim completion retains fill | No DOM-serialized private opacity can survive ownership | New lifetime invariant; no inline/class side effect |
| Changed colors and clone cleanup are staged | Reading after our own style writes can force style recalculation | Existing documented performance evidence |
| Bounded painter overflow clears | Never retain partial ownership beyond the work limit | Deliberate degradation policy, not host compatibility guess |

There are no Tab-specific marker fixes, guessed legacy-value deletion branches, extra timers or effect-to-effect imports. No full FLIP or host event cancellation was introduced. The `sample()`/commit split addresses the read/write boundary rather than adding a new dirty flag to excuse an extra layout read.

## Validation scope and limits

The user subsequently requested no subagents, browser/computer-use tools or tests. The earlier scout was interrupted; this implementation and review were performed directly. No unit or browser tests are executed for this round. Existing test sources are kept compatible with removed APIs and WAAPI ownership; that is not a passing test result. The original request for six ordering characterization/replay scenarios is deferred by the no-testing instruction, not claimed complete.

Static/type/build checks can establish compilability and patch integrity only. Remaining host checks: Tab/Shift+Tab intermediate layout and marker continuity, wrong-first-geometry Backspace merge, ordinary deletion latency, representation replacement across separate tasks, interruption, IME, reduced motion, themes and long-document performance.

Checks performed in this round: `npm run typecheck`, `npm run build`, and `git diff --check`. `tsconfig.json` includes runtime source only; a successful typecheck does not validate the test fixtures. `npm test` and the marker browser fixture were deliberately not run.

In particular, withholding plugin targets does not freeze SiYuan's physical DOM layout. Same-key animation carry helps replacement continuity, but newly reparented ancestry, host text motion and live Range behavior can still change intermediate pixels. No actual trace/browser run proves freeze+commit sufficient to eliminate every reported flash. If that remains reproducible, obtain the sequence before adding local motion machinery.

Scope is limited to shared structural authority, Ripple ownership/read-write ordering, associated contract updates, build label and documentation. No unrelated feature or P2 visual polishing is included.
