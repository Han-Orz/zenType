export interface Features {
  typewriter: boolean;
  ripple: boolean;
}
export interface CursorRect { x: number; y: number; height: number }
export interface EditorFrame {
  root: HTMLElement;
  editor: HTMLElement;
  scroll: HTMLElement;
  editable: HTMLElement | null;
  block: HTMLElement | null;
  range: Range | null;
  caret: CursorRect | null;
  selection: "caret" | "range" | "missing";
  viewport: { top: number; bottom: number; left: number; right: number };
  scrollViewport: { top: number; bottom: number; left: number };
  scrollTop: number;
  scrollLeft: number;
  origin: { x: number; y: number };
  nestedScroll: Array<{ element: HTMLElement; left: number; top: number }>;
  maxScroll: number;
  reducedMotion: boolean;
  zIndex: number;
}
