import { useSyncExternalStore } from "react";
import { oneOfPreference, usePreference, type Preference } from "../theme/preferences.ts";
import { useViewportClass } from "../theme/viewport.ts";

/**
 * How a card over the canvas shows: whole, folded to its header, or not at
 * all. One value rather than two flags, so a card brought back from hidden
 * always returns whole.
 */
export type CanvasCardState = "open" | "collapsed" | "hidden";

const CARD_STATES = ["open", "collapsed", "hidden"] as const;

export const navigatorCardPreference = oneOfPreference("cards.navigator", CARD_STATES, "open");
export const minimapCardPreference = oneOfPreference("cards.minimap", CARD_STATES, "open");

export interface CanvasCardEntry {
  readonly preference: Preference<CanvasCardState>;
  /** What the settings menu calls the card. */
  readonly label: string;
}

/** The cards a person can hide and bring back, in the order settings lists them. */
export const CANVAS_CARDS: readonly CanvasCardEntry[] = [
  { preference: navigatorCardPreference, label: "Collection selector" },
  { preference: minimapCardPreference, label: "Minimap" },
];

// Below desktop a card covers far more of the canvas, so each starts folded
// there. Folding and unfolding it there lasts the page's life and never
// reaches the stored desktop state. Hiding is stored either way, since
// settings lists it.
const belowDesktop = new Map<string, Exclude<CanvasCardState, "hidden">>();
const belowDesktopListeners = new Set<() => void>();

function subscribeBelowDesktop(listener: () => void): () => void {
  belowDesktopListeners.add(listener);
  return () => belowDesktopListeners.delete(listener);
}

/** How a card shows in the window's width class, and how to change it. */
export function useCanvasCardState(
  preference: Preference<CanvasCardState>,
): [CanvasCardState, (state: CanvasCardState) => void] {
  const [stored, setStored] = usePreference(preference);
  const desktop = useViewportClass() === "desktop";
  const folded = useSyncExternalStore(
    subscribeBelowDesktop,
    () => belowDesktop.get(preference.key),
    () => undefined,
  );
  const state = desktop || stored === "hidden" ? stored : (folded ?? "collapsed");
  const setState = (next: CanvasCardState) => {
    if (next === "hidden") {
      setStored("hidden");
      // Brought back by any route, the card returns whole.
      foldBelowDesktop(preference.key, "open");
    } else if (desktop) {
      setStored(next);
    } else {
      if (stored === "hidden") setStored("open");
      foldBelowDesktop(preference.key, next);
    }
  };
  return [state, setState];
}

function foldBelowDesktop(key: string, state: Exclude<CanvasCardState, "hidden">): void {
  belowDesktop.set(key, state);
  for (const listener of [...belowDesktopListeners]) listener();
}

/** Forgets what was folded below desktop. Tests only. */
export function __resetCanvasCardsForTesting(): void {
  belowDesktop.clear();
}
