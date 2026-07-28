# zenType v2

Smooth cursor + typewriter mode + ripple focus for distraction-free writing in SiYuan Note.

![zenType preview](preview.png)

> **⚠️ Upgrading from v2.x (siyuan-zen)?**
>
> The plugin has been renamed from `siyuan-zen` to `zenType` (v2.6.1) to resolve bazaar marketplace sync issues. SiYuan treats these as **two different plugins**, so existing users must:
>
> 1. **Uninstall the old `siyuan-zen` plugin first** (Settings → Plugins → siyuan-zen → Uninstall)
> 2. **Then install `zenType`** using the new zip from [Releases](../../releases)
>
> Skipping step 1 will leave both plugins installed side-by-side. Your data and settings are not transferred (you'll need to re-toggle features you want).
>
> v1.0.6 (`ZenType`) → v2.0.0-2.6.0 (`siyuan-zen`) → v2.6.1+ (`zenType`). See [CHANGELOG](../docs/CHANGELOG.md) for details.

## Features

- **Smooth Cursor** — Custom blue cursor replaces the system caret with smooth transition animation
- **Typewriter Mode** — Your caret stays at 38% screen height (golden ratio)
- **Ripple Focus** — The current sentence stays bright while surrounding blocks/sentences gradually dim (CSS Custom Highlight API, zero DOM mutation, no data loss)

## Installation

1. Download the latest release zip from the Releases page
2. In SiYuan Note, open Settings → Plugins → Load plugin from disk
3. Select the downloaded zip

## Usage

All three modules are enabled by default. Typewriter initialization immediately enables the shared typewriter/ripple state. To toggle:

- **Top bar icon** (galaxy): Toggle typewriter mode + ripple focus on/off. The colorful planets animate when both are enabled; the smooth cursor stays active.
- **Command palette** (Ctrl+Shift+P): Search "zenType" to see individual toggles

## Edge Cases

### Embedded Blocks

Videos, iframes, and PDF embeds are treated as 1 ripple unit (they fade normally). Typewriter mode skips them (no scroll when cursor is in an embed).

### Nested Blocks (Simplified in v1)

If your cursor is in a child of a nested block (e.g., a list item inside a list), only the immediate parent layer fades. Outer containers stay at 100% opacity. This is a simplification — recursive fading is deferred.

### Selection (Multi-line)

When you drag-select text, ripple focus and typewriter mode gracefully fade out (0.3s animation). The smooth cursor stays active.

### Suspended Edits & Popups

Read-only mode and block popups automatically suspend typewriter mode and pause ripple focus.

## Customization (v2.6.0)

Open `src/config.ts` to tweak:

| Parameter | Default | What it does |
|-----------|---------|--------------|
| `CURSOR_CONFIG.HEIGHT_RATIO` | `1.05` | Cursor height = line-height × this multiplier |
| `CURSOR_CONFIG.BLINK_DELAY_MS` | `1100` | Idle delay before blink resumes |
| `EDGE_FADE.ZONE` | `20` | Pixels from editor rect edge over which cursor fades out (top + bottom symmetric) |
| `TRANSITION.TIERS` | `[0.07, 0.15, 0.21, 0.30]` s | Distance-proportional transition duration: short moves snappy, long moves smooth |

Open `src/styles/index.scss` to tweak visual style:

```scss
#zentype-cursor {
  width: 3px;                                      // Cursor width
  background: var(--zt-cursor-color, #5d8cd7);     // Color (light theme)
  transition: transform 0.15s cubic-bezier(...);   // Movement curve
  animation: zentype-breathe 3s 1.5s ...;          // Blink animation
}
```

`pnpm run dev` rebuilds on save; SiYuan hot-reloads in 1-2 seconds.

### Edge Behavior (v2.6.0)

When the cursor scrolls off the visible editor area (top or bottom), it stays at the last visible position and smoothly fades to 0 opacity over `EDGE_FADE.ZONE` pixels. Returning to the viewport fades it back in. Top and bottom are now symmetric.

## Roadmap

See [docs/DESIGN.md](docs/DESIGN.md) for the full design.

## License

MIT
