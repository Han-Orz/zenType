export interface DebugDownloadEnvironment {
  document: Pick<Document, "createElement" | "body">;
  url: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
  Blob: typeof Blob;
  defer(callback: () => void): void;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function createDebugBundleFilename(
  fingerprint: string | null | undefined,
  now = new Date(),
): string {
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = fingerprint?.slice(0, 8) || "unknown";
  return `zentype-debug-${timestamp}-${suffix}.json`;
}

export function downloadDebugBundle(
  contents: string,
  filename: string,
  environment: DebugDownloadEnvironment = {
    document,
    url: URL,
    Blob,
    defer: (callback) => setTimeout(callback, 0),
  },
): void {
  const blob = new environment.Blob([contents], { type: "application/json;charset=utf-8" });
  const href = environment.url.createObjectURL(blob);
  const anchor = environment.document.createElement("a");
  try {
    anchor.href = href;
    anchor.download = filename;
    anchor.style.display = "none";
    environment.document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    environment.defer(() => environment.url.revokeObjectURL(href));
  }
}
