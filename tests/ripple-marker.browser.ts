import { createRipple } from "../src/modules/ripple";
import type { EditorFrame } from "../src/types";

// Browser regression: a theme opacity transition must not survive a list-owner
// handoff. DOM-only stubs cannot model CSS transition precedence over WAAPI.
const theme = document.createElement("style");
theme.textContent = ".protyle-action { transition: opacity 300ms linear; }";
document.head.append(theme);
const editor = document.createElement("div");
editor.innerHTML = `<div data-node-id="parent" data-type="NodeListItem">
  <span class="protyle-action">•</span><div data-node-id="parent-text">Parent</div>
  <div data-node-id="nested"><div data-node-id="child" data-type="NodeListItem">
    <span class="protyle-action">•</span><div data-node-id="active">Child</div>
  </div></div>
</div>`;
document.body.append(editor);
const parent = editor.firstElementChild as HTMLElement;
const marker = parent.firstElementChild as HTMLElement;
const nested = parent.lastElementChild as HTMLElement;
const child = nested.firstElementChild as HTMLElement;
const active = child.lastElementChild as HTMLElement;
const ripple = createRipple();
const frame = { editor, block: active, editable: active, range: null,
  selection: "caret", reducedMotion: false } as unknown as EditorFrame;
// A real collapsed Range is needed by Ripple's preparation contract.
frame.range = document.createRange();
frame.range.selectNodeContents(active);
frame.range.collapse(true);
const samples: number[] = [];
const visibleAlpha = () => Number(getComputedStyle(marker).opacity) * Number(getComputedStyle(parent).opacity);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  ripple.prepare(frame, true, true, true);
  document.getAnimations().forEach(animation => animation.finish());
  await delay(30);
  samples.push(visibleAlpha());
  editor.append(child);
  nested.remove();
  ripple.prepare(frame, true, true, true);
  samples.push(visibleAlpha());
  await delay(60);
  samples.push(visibleAlpha());
  await delay(120);
  samples.push(visibleAlpha());
  if (samples.some(value => Math.abs(value - 0.4) > 0.02)) throw new Error(`marker flashed: ${samples}`);
  ripple.clear();
  if (marker.style.getPropertyValue("transition-property")) throw new Error("transition override leaked");
  if (getComputedStyle(marker).transitionDuration !== "0.3s") throw new Error("theme transition not restored");
  document.body.textContent = "PASS " + JSON.stringify(samples);
}
run().catch(error => { document.body.textContent = "FAIL " + error.message; }).finally(() => ripple.destroy());
