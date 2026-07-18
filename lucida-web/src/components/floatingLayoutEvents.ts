/** Shared post-commit signal for independently owned floating/persistent layouts. */
export const FLOATING_LAYOUT_SETTLED_EVENT = "lucida:floating-layout-settled";

export function announceFloatingLayoutSettled(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(FLOATING_LAYOUT_SETTLED_EVENT));
  }
}
