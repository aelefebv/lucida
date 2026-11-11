/** The drag data a layer carries when dragged from the panel onto a view: its dataset id. */
export const DATASET_DRAG_TYPE = "application/x-lucida-dataset";

/** Whether `target` is a view's own pane (`ViewPanes`), rather than something drawn over it. */
export function isViewPane(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.dataset.viewPane !== undefined;
}
