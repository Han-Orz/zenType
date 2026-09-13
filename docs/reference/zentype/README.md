# zenType Product & Interaction Reference Pack

This pack is the product-knowledge interface between zenType and zenTypeNext. It records what the product is trying to feel like, which user-visible behaviors are mature, which architectural lessons survived the Remake, and which mechanisms were only responses to SiYuan and the Web runtime.

It is not a source-code tour, an API reference, a runtime porting guide, or a requirement that zenTypeNext reproduce DOM, Electron, CSS, or WAAPI behavior. In particular:

> This pack is a knowledge-transfer interface, not a code-porting specification.

## Baseline and evidence

The pack was prepared on:

| Item | Baseline |
| --- | --- |
| Branch | refactor/v2.9.0-remake.2.8-layout-continuity |
| Pack start SHA | f1de8b1e7523729591d36d9a80f33f475e93b35f |
| Remake runtime/audit parent | 9ef28ffafc0eab72ab46086af4652e810cb7c6e9 |
| Mature behavior reference | v2.8.1, 6c3ac0442c6b97292151c71732ae1100c184653 |
| Recent archaeology input | docs/DEAD_CODE_PATCH_DEBT_AUDIT.md at f1de8b1 |

The evidence vocabulary is deliberate:

- Mature: long-lived product behavior or a stable product intention.
- Regression-validated: a historical failure, a fix, and a focused guard or test exist.
- Architecture-accepted: the authority boundary is intentional and tested, while final visual feel may still need real-machine acceptance.
- Desired / pending: an intended behavior implemented or specified, but not yet proven across the relevant host paths.
- Inferred: a useful synthesis from code and history that should be treated as a hypothesis until product or machine evidence confirms it.

The source evidence is concentrated in docs/DESIGN.md, docs/SIYUAN_HOST_CONTRACT.md, docs/CRITICAL_MOTION_LAYOUT_CONTRACT.md, docs/CHANGELOG.md, docs/DEAD_CODE_PATCH_DEBT_AUDIT.md, the current src/ and tests/, and the commit history named in each document.

## How zenTypeNext should use this pack

1. Read PRODUCT_VISION.md and PRODUCT_BEHAVIOR_REFERENCE.md before looking for implementation analogies.
2. Use INTERACTION_AND_MOTION_LANGUAGE.md to judge feel and failure modes, not to copy numeric parameters.
3. Use BEHAVIOR_SCENARIOS.md as product-level acceptance material. A Next implementation should be able to pass the scenarios without running zenType.
4. Use ARCHITECTURE_LESSONS.md for transferable reasoning patterns. They are lessons, not a mandate to reproduce the Session or StructureGate types.
5. Treat TRANSFER_MATRIX.md as the migration boundary. It separates semantics, architecture lessons, recalibration work, and mechanisms that must be discarded.
6. Read HOST_SPECIFIC_LESSONS.md whenever an idea mentions DOM identity, mutation timing, selection restoration, transforms, or a SiYuan class name.
7. Read OPEN_QUESTIONS_AND_NON_GOALS.md before calling a behavior mature. It records pending real-machine work and rejected approaches.

## Contents

| File | Question it answers |
| --- | --- |
| PRODUCT_VISION.md | What kind of writing product is zenType? |
| PRODUCT_BEHAVIOR_REFERENCE.md | What should a user see and feel for each feature? |
| INTERACTION_AND_MOTION_LANGUAGE.md | What is zenType's motion personality? |
| BEHAVIOR_SCENARIOS.md | What are the golden behaviors and forbidden regressions? |
| ARCHITECTURE_LESSONS.md | Which design lessons generalize beyond the plugin? |
| TRANSFER_MATRIX.md | What transfers, what must be rebuilt, and what must not move? |
| HOST_SPECIFIC_LESSONS.md | Which strange mechanisms encode SiYuan knowledge? |
| OPEN_QUESTIONS_AND_NON_GOALS.md | What is not mature, not required, or deliberately rejected? |

## Reading rule

Every claim should be interpreted through the following decomposition:

| Layer | Meaning |
| --- | --- |
| Product invariant | The user value that should survive a platform change. |
| Interaction semantic | What the user action means, independent of a particular widget tree. |
| Motion personality | How change should feel: responsive, continuous, interruptible, restrained. |
| Current implementation | How this Remake currently realizes the behavior. |
| Host workaround | A mechanism required by SiYuan, DOM, Selection, or browser timing. |

If the mechanism disappears on a native Windows-first platform but the user value remains, transfer the value and reimplement the mechanism. If the value itself only exists because a DOM quirk exists, do not turn the workaround into a Next requirement.
