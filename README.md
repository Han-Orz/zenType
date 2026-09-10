# zenType v2.9.0-remake.2.2.1

Smooth cursor, typewriter scrolling and ripple focus for SiYuan. remake.2.2.1 keeps one WritingSession/rAF/observer system and one monotonic business clock, validates its structural authority boundary against SiYuan v3.8.3 source and runtime evidence, and removes development diagnostics from production artifacts at compile time.

## Behavior

The blue cursor continues from its displayed position, including during IME composition and ordinary editable changes. Scroll displacement transports the cursor without restarting its local motion. Clipping fades and idle breathing have separate opacity layers.

A missing caret rectangle keeps the current presentation for a bounded 160ms recovery window and is then recovered from the caret's own block rather than from the whole editable. Once the budget is spent, a collapsed caret with a live Range in the same editable keeps the presentation instead of returning native behavior; any other state releases it. IME uses the selection focus endpoint and pauses plugin comfort scrolling.

Typewriter motion starts from actual scroll positions, supports reverse retargeting, and yields to browsing and unexpected host scrolling. Ripple retains current brightness across navigation and unambiguous local text edits. New DOM bindings do not inherit historical animation identities.

Potential structural edits withhold new Cursor, Typewriter and Ripple targets until host evidence is either confirmed ordinary or quiet, stable structural geometry is observed. Input alone never disproves structural intent. Because SiYuan performs post-input normalization in a later task, ordinary text deletion is admitted after 48ms without further classified activity; every path is bounded by 160ms.

The topbar button or Ctrl+Alt+Z toggles typewriter and ripple together. The smooth cursor remains independently enabled. Reduced motion disables movement and breathing.

## Build and install

```sh
npm run typecheck
npm run typecheck:tests
npm test
npm run build:dev
npm run build
npm run verify:prod
```

Development output: `dev/`. Production output: `dist/`. Installable archive: `package.zip`.

Disable zenType, back up the existing installation outside the plugins directory, extract the archive into your SiYuan workspace's `data/plugins/zenType/`, then enable it. Do not run two copies. The topbar tooltip identifies `v2.9.0-remake.2.2.1`; the numeric plugin manifest version is `2.9.0`.

Existing development links can use `dev/`. To create one, use `node scripts/make_dev_link.js --workspace <workspace-path>`; it refuses to overwrite an existing installation.

## Boundaries

Host research baseline: SiYuan v3.8.3. Titles, databases and query embeds stay native. Split and popup document editors require matching official active editor, focus and Selection ownership.

There is no structural FLIP or second transaction scheduler. The shared gate is a bounded policy inside WritingSession. A same-node-id replacement hands over numeric brightness only (local baselines and ancestor seeding); there is no identity registry and no cross-block identity tracking. Sentence focus requires CSS Highlights, relative colors and Intl.Segmenter. It falls back to block focus above 32,768 UTF-16 units, 2,048 text nodes or 256 sentences per editable. Block focus visits up to 48 content siblings on each side at each ancestor level.

Automated checks cover motion interruption, scroll boundaries, local sentence boundaries, shared structural ordering, bounded recovery, WAAPI ownership and cursor presentation. They do not establish real IME, theme or host DOM replacement behavior. Old architecture-specific tests are available in v2.8.1 history.

See [the design document](docs/DESIGN.md), [SiYuan host contract](docs/SIYUAN_HOST_CONTRACT.md), and [Chinese installation notes](README_zh-CN.md). Motion parameters are in `src/config.ts`.
