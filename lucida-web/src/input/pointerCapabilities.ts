import { useSyncExternalStore } from "react";

function subscribeMedia(query: string, onChange: () => void): () => void {
  if (typeof matchMedia !== "function") return () => {};
  const list = matchMedia(query);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

function mediaMatches(query: string): boolean {
  return typeof matchMedia === "function" && matchMedia(query).matches;
}

/** Whether the primary pointer is a finger, so targets should be sized for one. */
export function usePointerCoarse(): boolean {
  return useSyncExternalStore(
    (onChange) => subscribeMedia("(pointer: coarse)", onChange),
    () => mediaMatches("(pointer: coarse)"),
    () => false,
  );
}

// No API says whether a keyboard is attached, so a key pressed outside a text
// field stands in: an on-screen keyboard only types into a focused field.
let keyboardSeen = false;
const keyboardListeners = new Set<() => void>();

function onKeyDown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  if (target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return;
  keyboardSeen = true;
  window.removeEventListener("keydown", onKeyDown, true);
  for (const listener of [...keyboardListeners]) listener();
}

function subscribeKeyboard(onChange: () => void): () => void {
  if (keyboardSeen) return () => {};
  if (keyboardListeners.size === 0) window.addEventListener("keydown", onKeyDown, true);
  keyboardListeners.add(onChange);
  return () => {
    keyboardListeners.delete(onChange);
    if (keyboardListeners.size === 0) window.removeEventListener("keydown", onKeyDown, true);
  };
}

/** Forget a keyboard seen. Tests only. */
export function __resetKeyboardSeenForTesting(): void {
  keyboardSeen = false;
}

/**
 * Whether a mouse, trackpad, or keyboard is around: any fine pointer, or a key
 * pressed outside a text field. A best guess, since a tablet may gain a
 * keyboard at any time; it turns true then and stays true.
 */
export function useFineInputAvailable(): boolean {
  const finePointer = useSyncExternalStore(
    (onChange) => subscribeMedia("(any-pointer: fine)", onChange),
    () => mediaMatches("(any-pointer: fine)"),
    () => true,
  );
  const keyboard = useSyncExternalStore(subscribeKeyboard, () => keyboardSeen, () => false);
  return finePointer || keyboard;
}
