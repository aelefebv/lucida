/** Whether `target` is a view's own pane (`ViewPanes`), rather than something drawn over it. */
export function isViewPane(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.dataset.viewPane !== undefined;
}
