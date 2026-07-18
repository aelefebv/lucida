/** Shared types + math for the live box/line draw preview
 * ({@link AnnotationDraftOverlay}). Kept out of the `.tsx` so the component file
 * only exports a component (react-refresh) and so the gesture handlers
 * (SliceViewer/VolumeViewer) can import the type without importing the component. */

/** In-progress draw, in CSS px relative to the canvas (`(x0,y0)` = anchor /
 * press point, `(x1,y1)` = current pointer). `null` when nothing is being drawn. */
export interface AnnotationDraft {
  kind: "line" | "box";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Event-driven channel shared by canvas gestures and the isolated overlay. */
export class AnnotationDraftStore {
  private draft: AnnotationDraft | null = null;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): AnnotationDraft | null => this.draft;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(draft: AnnotationDraft | null): void {
    if (Object.is(this.draft, draft)) return;
    this.draft = draft;
    for (const listener of this.listeners) listener();
  }
}

/** Normalize a press→cursor box to a non-negative SVG rect, so dragging in any
 * direction (up/left as well as down/right) yields a valid rectangle. */
export function draftBoxRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}
