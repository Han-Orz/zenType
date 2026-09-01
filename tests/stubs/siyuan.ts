let activeEditor: unknown = null;

export function getActiveEditor(): any {
  return activeEditor;
}

export function setActiveEditor(editor: unknown): void {
  activeEditor = editor;
}

export function getFrontend(): string {
  return "desktop";
}
