# zenType 2.9.0

Smooth caret, typewriter scrolling, and ripple focus for SiYuan. This is the first v2.9 rewrite, ready for hands-on validation in SiYuan.

## Behavior

- Short caret movements ease into place; large jumps snap. The caret breathes after inactivity.
- Typewriter scrolling uses a comfort band after a 400ms typing pause. Visibility takes priority at viewport edges.
- Ripple dims neighboring blocks and list branches, with sentence focus inside the current block.
- Pointer interaction, manual scrolling, vertical navigation, blur, and editor switches end automatic following.
- IME composition uses the native caret and pauses scrolling.
- Invalid geometry, selections, read-only content, titles, databases, embedded editors, and popovers retain native behavior.
- Reduced-motion preferences disable animation.

Use the topbar button or Ctrl+Alt+Z to toggle typewriter and ripple together. Individual commands are available in the command palette. Both features are enabled by default and activate when writing in the document body.

## Build and try

With dependencies already installed:

```sh
npm run typecheck
npm run build:dev
npm run build
```

Development files are in `dev/`, production files in `dist/`, and the installable bundle is `package.zip`. Extract the bundle into your SiYuan workspace's `data/plugins/zenType/` directory and reload the plugin.

An existing development link can keep using `dev/`. To create one, run `node scripts/make_dev_link.js --workspace <workspace-path>`; it refuses to overwrite an existing plugin directory. `npm run dev` watches source changes. There is no DebugKit or debug bridge.

Try IME composition, rapid navigation, repeated Enter/Backspace, list indentation, manual scrolling, split editors, and disabling the plugin. Verify native caret behavior returns when appropriate.

## Architecture

One input entry point, one frame scheduler, and three direct effects. Geometry reads precede visual writes. No structural FLIP, settle transactions, animation ownership handoffs, or persistent sentence identities.

Text and structure edits settle to the current state. Navigation through stable text has at most one entering/leaving sentence transition.

Historical tests are unchanged and were not run or adapted for this rewrite. Current validation consists of type checking, builds, and hands-on SiYuan feedback.

See [the implementation spec](docs/DESIGN.md). Motion settings live in `src/config.ts`.
