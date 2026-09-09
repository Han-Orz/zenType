import { showMessage, type Plugin } from "siyuan";
import { initDebugHook } from "../debug";
import { createDebugBundleFilename, downloadDebugBundle } from "../debug/download";
import type { DebugHookController } from "../debug/types";

/** Development-only UI wiring; production tree-shaking removes this module. */
export async function installDebugKit(plugin: Pick<Plugin, "addCommand">): Promise<DebugHookController> {
  const debug = initDebugHook();
  const toggle = async () => {
    try {
      const started = await debug.toggle();
      showMessage(started
        ? "zenType：DebugKit 已开始（全量记录）"
        : "zenType：DebugKit 已结束（记录仍保留，可导出）", 3500, "info");
    } catch (error) {
      console.error("[zenType] DebugKit toggle failed", error);
      showMessage("zenType：DebugKit 切换失败", 4000, "error");
    }
  };
  const exportRecording = async () => {
    try {
      const wasActive = debug.getState().active;
      if (wasActive) {
        await debug.stop();
        showMessage("zenType：DebugKit 已结束，正在导出…", 2500, "info");
      }
      const contents = debug.exportRecording();
      const state = debug.getState();
      downloadDebugBundle(contents, createDebugBundleFilename(state.buildFingerprint));
      showMessage(wasActive ? "zenType：DebugKit 已结束并导出" : "zenType：DebugKit 已导出（记录此前已结束）", 3500, "info");
    } catch (error) {
      console.error("[zenType] DebugKit export failed", error);
      showMessage("zenType：DebugKit 导出失败", 4000, "error");
    }
  };

  await debug.start("default", { profile: "full", includeText: true });
  showMessage("zenType：DebugKit 已开始（全量记录）", 3000, "info");
  plugin.addCommand({
    langKey: "debugkit-toggle",
    langText: "zenType：切换 DebugKit",
    callback: () => { void toggle(); },
  });
  plugin.addCommand({
    langKey: "debugkit-export",
    langText: "zenType：导出 DebugKit",
    callback: () => { void exportRecording(); },
  });
  return debug;
}
