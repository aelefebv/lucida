import { useSyncExternalStore } from "react";

/**
 * Which keyboard help overlay is open. One at a time, so a palette command
 * that opens the sheet swaps one for the other. Kept outside React so any
 * control can open either.
 */
export type KeyboardHelpOverlay = "commandPalette" | "shortcutSheet";

let open: KeyboardHelpOverlay | null = null;
const listeners = new Set<() => void>();

/** Open an overlay, or close whichever is open with null. */
export function showKeyboardHelp(overlay: KeyboardHelpOverlay | null): void {
  if (open === overlay) return;
  open = overlay;
  for (const listener of [...listeners]) listener();
}

export function useKeyboardHelp(): KeyboardHelpOverlay | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open,
  );
}
