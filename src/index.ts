import { Plugin, showMessage } from "siyuan";
import { createWritingSession, type WritingSession } from "./session";
import type { Features } from "./types";
import mainCss from "./styles/index.scss";

const ICON = `<svg class="zt-galaxy-icon" viewBox="0 0 1024 1024" width="24" height="24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><g class="zt-galaxy-art" transform="translate(0 -128)"><g class="zt-galaxy-planet zt-galaxy-planet--red"><path d="M296 456m-40 0a40 40 0 1 0 80 0 40 40 0 1 0-80 0Z" fill="#FF2E04"/></g><g class="zt-galaxy-planet zt-galaxy-planet--orange"><path d="M504 136m-40 0a40 40 0 1 0 80 0 40 40 0 1 0-80 0Z" fill="#FD7504"/></g><g class="zt-galaxy-planet zt-galaxy-planet--purple"><path d="M816 760a56 56 0 1 1-56-56 56 56 0 0 1 56 56z" fill="#D82FEA"/><path d="M707.84 780.16a56 56 0 0 1 72.32-72.32 56 56 0 0 1-72.32 72.32z" fill="#E667F9"/></g><g class="zt-galaxy-planet zt-galaxy-planet--teal"><path d="M864 408a72 72 0 1 1-72-72 72 72 0 0 1 72 72z" fill="#2DE0C7"/><path d="M727.68 440.32a72 72 0 0 1 96-96 72.16 72.16 0 0 1-96 96z" fill="#93E6D9"/></g><g class="zt-galaxy-planet zt-galaxy-planet--green"><path d="M400 768a48 48 0 1 1-48-48 48 48 0 0 1 48 48z" fill="#84E507"/><path d="M306.08 781.92a48 48 0 0 1 59.84-59.84 48 48 0 0 1-59.84 59.84z" fill="#C5EE09"/></g><path d="M616 587.52a78.88 78.88 0 0 0-64 46.72 80 80 0 0 0-80 0 78.56 78.56 0 0 0-64-46.72A78.24 78.24 0 0 0 384 512a78.24 78.24 0 0 0 24.48-75.52 78.88 78.88 0 0 0 64-46.72 80 80 0 0 0 80 0 78.88 78.88 0 0 0 64 46.72A78.24 78.24 0 0 0 640 512a78.24 78.24 0 0 0-24 75.52z" fill="#FD7504"/><path d="M592 512a80 80 0 1 1-80-80 80 80 0 0 1 80 80z" fill="#FDA736"/><path d="M441.76 550.24a80 80 0 0 1 108.48-108.48 80 80 0 0 1-108.48 108.48z" fill="#FED370"/><path d="M512 608c-24.64 0-67.2-12.32-53.92-34.88a16 16 0 0 1 21.92-5.76 64 64 0 1 0-29.92-40.32 16 16 0 0 1-31.04 8A96 96 0 1 1 512 608zM294.08 411.36A240.96 240.96 0 0 1 512 272a16 16 0 0 1 0 32 208 208 0 0 0-188.8 120.8 16 16 0 0 1-29.12-13.44zM272 512v-18.08a16 16 0 0 1 32 2.88V512a16 16 0 0 1-32 0zM512 752a16 16 0 0 1 0-32 208 208 0 0 0 208-208 16 16 0 0 1 32 0 240 240 0 0 1-240 240zM312.32 756.96c-16 0-90.72-75.36-112.96-176a16 16 0 0 1 32-6.88 288 288 0 0 0 92.16 154.88 16 16 0 0 1-11.2 28zM192 528.8v-16a16 16 0 0 1 32 0v16a16 16 0 0 1-32 0zM512 832a314.4 314.4 0 0 1-124.64-25.28 16 16 0 0 1-8.48-20.96c11.84-28 35.84 14.24 133.12 14.24a16 16 0 0 1 0 32zM800 512a276.8 276.8 0 0 0-1.92-33.44 16 16 0 0 1 32-3.84A305.12 305.12 0 0 1 832 512a16 16 0 0 1-32 0zM750.4 350.72a288 288 0 0 0-132.16-106.4 16 16 0 0 1 11.84-29.76 320 320 0 0 1 146.88 118.24 16 16 0 0 1-26.56 17.92zM577.76 231.2c-4.16 0-4.32-1.12-20.32-3.68a16 16 0 0 1 4.96-32c6.4 0.96 12.64 2.08 18.72 3.52a16 16 0 0 1-3.36 32.16zM209.28 250.56A399.04 399.04 0 0 1 462.4 115.2a16 16 0 0 1 3.84 32A368 368 0 0 0 233.44 272a16 16 0 0 1-24.16-21.44zM117.28 448a394.88 394.88 0 0 1 57.6-150.56 16 16 0 0 1 22.08-4.8c27.04 17.28-28.8 41.44-48 160A16 16 0 0 1 117.28 448zM112 512v-16a16 16 0 0 1 32 1.28v14.4A16 16 0 0 1 112 512z" fill="#35214C"/><path d="M677.12 496.8a45.6 45.6 0 0 1-22.56-69.6 16 16 0 0 0-17.92-24.48 45.92 45.92 0 0 1-59.2-43.2 16 16 0 0 0-28.8-9.28 45.92 45.92 0 0 1-73.28 0 16 16 0 0 0-28.8 9.28 45.76 45.76 0 0 1-59.2 43.2 16 16 0 0 0-17.92 24.48 45.76 45.76 0 0 1-22.56 69.6 16 16 0 0 0 0 30.4 45.6 45.6 0 0 1 22.56 69.6 16 16 0 0 0 17.92 24.48 45.76 45.76 0 0 1 59.2 43.2 16 16 0 0 0 28.8 9.28 45.92 45.92 0 0 1 73.28 0 16 16 0 0 0 17.76 5.6c20-6.4 1.28-30.56 29.92-51.36s45.6 4.48 58.08-12.48-17.12-25.76-5.92-59.2S688 533.6 688 512a16 16 0 0 0-10.88-15.2z m-61.12 90.72a78.88 78.88 0 0 0-64 46.72 80 80 0 0 0-80 0 78.56 78.56 0 0 0-64-46.72A78.24 78.24 0 0 0 384 512a78.24 78.24 0 0 0 24.48-75.52 78.88 78.88 0 0 0 64-46.72 80 80 0 0 0 80 0 78.88 78.88 0 0 0 64 46.72A78.24 78.24 0 0 0 640 512a78.24 78.24 0 0 0-24 75.52zM504 192A56 56 0 1 1 560 136a56 56 0 0 1-56 56z m0-80a24 24 0 0 0 0 48 24 24 0 0 0 0-48zM792 496a88 88 0 1 1 14.24-174.88 16 16 0 0 1-5.12 32 56 56 0 1 0 40.16 28.48 16 16 0 0 1 28.16-15.04A88 88 0 0 1 792 496z" fill="#35214C"/><path d="M296 512a56 56 0 1 1 56-56 56 56 0 0 1-56 56z m0-80a24 24 0 0 0 0 48 24 24 0 0 0 0-48zM512 880a16 16 0 0 1 0-32h14.72a16 16 0 0 1 1.28 32zM574.08 874.56a16 16 0 0 1-2.72-32A334.56 334.56 0 0 0 708.8 784a16 16 0 0 1 18.88 25.92c-57.44 41.76-132 64.64-153.6 64.64zM816 656a326.4 326.4 0 0 0 28.96-96 16 16 0 0 1 32 4.48 361.76 361.76 0 0 1-32 105.28A16 16 0 0 1 816 656z" fill="#35214C"/><path d="M760 832a72 72 0 1 1 72-72 72.16 72.16 0 0 1-72 72z m0-112a40 40 0 1 0 40 40 40 40 0 0 0-40-40zM144 624a48 48 0 1 0 48 48 48 48 0 0 0-48-48z m0 64a16 16 0 0 1 0-32 16 16 0 0 1 0 32z" fill="#35214C"/><path d="M160 672a16 16 0 0 1-32 0 16 16 0 0 1 32 0z" fill="#898EC9"/><path d="M728 128a40 40 0 1 0 40 40A40 40 0 0 0 728 128z m0 48a8 8 0 0 1 0-16 8 8 0 0 1 0 16z" fill="#35214C"/><path d="M736 168a8 8 0 0 1-16 0 8 8 0 0 1 16 0z" fill="#69CC00"/><path d="M352 832a64 64 0 1 1 64-64 64 64 0 0 1-64 64z m0-96a32 32 0 1 0 32 32 32 32 0 0 0-32-32zM416 944a32 32 0 1 1 32-32 32 32 0 0 1-32 32z m0-32z m0 0z m0 0z m0 0z m0 0z m0 0z m0 0z m0 0z" fill="#35214C"/></g></svg>`;

export default class ZenType extends Plugin {
  private features: Features = { typewriter: true, ripple: true };
  private session: WritingSession | null = null;
  private style: HTMLStyleElement | null = null;
  private topbar: HTMLElement | null = null;
  private off: Array<() => void> = [];
  private saving: Promise<unknown> = Promise.resolve();
  private disposed = false;

  async onload(): Promise<void> {
    const saved = await this.loadData("zentype-enabled");
    if (this.disposed) return;
    for (const name of ["typewriter", "ripple"] as const) {
      if (typeof saved?.[name] === "boolean") this.features[name] = saved[name];
    }
    try {
      this.style = document.createElement("style");
      this.style.textContent = mainCss;
      document.head.appendChild(this.style);
      this.session = createWritingSession(this.features);
      for (const name of ["typewriter", "ripple"] as const) {
        this.addCommand({
          langKey: "toggle-" + name,
          langText: name === "typewriter" ? "切换打字机" : "切换涟漪",
          callback: () => {
            this.features[name] = !this.features[name];
            this.updateFeatures();
          },
        });
      }
      this.addCommand({
        langKey: "toggle-type", langText: "切换联合（打字机+涟漪）", hotkey: "⌃⌥Z",
        callback: () => this.toggleBoth(),
      });
      this.topbar = this.addTopBar({ icon: ICON, title: "zenType", callback: () => this.toggleBoth() });
      this.updateIcon();
      const refresh = () => this.session?.refresh();
      const suspend = () => this.session?.suspend();
      this.eventBus.on("loaded-protyle-static", refresh);
      this.eventBus.on("loaded-protyle-dynamic", refresh);
      this.eventBus.on("switch-protyle", suspend);
      this.eventBus.on("open-menu-content", suspend);
      this.off = [
        () => this.eventBus.off("loaded-protyle-static", refresh),
        () => this.eventBus.off("loaded-protyle-dynamic", refresh),
        () => this.eventBus.off("switch-protyle", suspend),
        () => this.eventBus.off("open-menu-content", suspend),
      ];
    } catch (error) {
      this.onunload();
      throw error;
    }
  }

  private toggleBoth(): void {
    const enabled = !(this.features.typewriter && this.features.ripple);
    this.features = { typewriter: enabled, ripple: enabled };
    this.updateFeatures();
  }

  private updateFeatures(): void {
    this.session?.configure(this.features);
    this.updateIcon();
    const snapshot = { ...this.features };
    this.saving = this.saving.then(() => this.saveData("zentype-enabled", snapshot)).catch(error => {
      console.error("[zenType] settings could not be saved", error);
      showMessage("zenType：设置未能保存", 4000, "error");
    });
  }

  private updateIcon(): void {
    const on = this.features.typewriter && this.features.ripple;
    this.topbar?.classList.toggle("zentype-topbar-icon--on", on);
    this.topbar?.classList.toggle("zentype-topbar-icon--off", !on);
    this.topbar?.setAttribute("aria-label", on ? "zenType · 聚焦/打字机：开" : "zenType · 聚焦/打字机：关");
  }

  onunload(): void {
    this.disposed = true;
    this.off.splice(0).forEach(off => off());
    this.session?.destroy();
    this.session = null;
    this.style?.remove();
    this.style = null;
    this.topbar = null;
  }
}
