export interface Features {
  typewriter: boolean;
  ripple: boolean;
}

export interface CursorRect {
  x: number;
  y: number;
  height: number;
}

export interface EditorFrame {
  root: HTMLElement;
  editor: HTMLElement;
  editable: HTMLElement;
  block: HTMLElement;
  scroll: HTMLElement;
  range: Range;
  caret: CursorRect;
  viewport: { top: number; bottom: number; left: number; right: number };
  scrollViewport: { top: number; bottom: number };
  scrollTop: number;
  maxScroll: number;
  reducedMotion: boolean;
  zIndex: number;
}
