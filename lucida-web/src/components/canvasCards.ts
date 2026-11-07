import { useSyncExternalStore } from "react";
import {
  getPreference,
  oneOfPreference,
  setPreference,
  subscribePreferences,
  usePreference,
  type Preference,
} from "../theme/preferences.ts";
import { getViewportClass, useViewportClass, type ViewportClass } from "../theme/viewport.ts";

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

// On a phone the canvas is the whole screen, so these start hidden rather
// than folded. Shown there, they hide again without storing it, since the
// person never hid them on purpose.
const HIDDEN_ON_PHONE = new Set([minimapCardPreference.key]);

function subscribeBelowDesktop(listener: () => void): () => void {
  belowDesktopListeners.add(listener);
  return () => belowDesktopListeners.delete(listener);
}

/** Calls `listener` when any card's state may have changed. */
export function subscribeCanvasCards(listener: () => void): () => void {
  const stopPreferences = subscribePreferences(listener);
  const stopBelowDesktop = subscribeBelowDesktop(listener);
  return () => {
    stopPreferences();
    stopBelowDesktop();
  };
}

function resolve(
  key: string,
  stored: CanvasCardState,
  viewport: ViewportClass,
  folded: Exclude<CanvasCardState, "hidden"> | undefined,
): CanvasCardState {
  if (viewport === "desktop" || stored === "hidden") return stored;
  return folded ?? (viewport === "phone" && HIDDEN_ON_PHONE.has(key) ? "hidden" : "collapsed");
}

/** How a card shows in the window's width class now. */
export function getCanvasCardState(preference: Preference<CanvasCardState>): CanvasCardState {
  return resolve(preference.key, getPreference(preference), getViewportClass(), belowDesktop.get(preference.key));
}

/** Shows, folds, or hides a card in the window's width class. */
export function setCanvasCardState(preference: Preference<CanvasCardState>, next: CanvasCardState): void {
  const viewport = getViewportClass();
  const stored = getPreference(preference);
  if (next === "hidden") {
    if (viewport === "phone" && HIDDEN_ON_PHONE.has(preference.key) && stored !== "hidden") {
      setBelowDesktop(preference.key, undefined);
      return;
    }
    setPreference(preference, "hidden");
    // Brought back by any route, the card returns whole.
    setBelowDesktop(preference.key, "open");
  } else if (viewport === "desktop") {
    setPreference(preference, next);
  } else {
    if (stored === "hidden") setPreference(preference, "open");
    setBelowDesktop(preference.key, next);
  }
}

/** How a card shows in the window's width class, and how to change it. */
export function useCanvasCardState(
  preference: Preference<CanvasCardState>,
): [CanvasCardState, (state: CanvasCardState) => void] {
  const [stored] = usePreference(preference);
  const viewport = useViewportClass();
  const folded = useSyncExternalStore(
    subscribeBelowDesktop,
    () => belowDesktop.get(preference.key),
    () => undefined,
  );
  const state = resolve(preference.key, stored, viewport, folded);
  return [state, (next: CanvasCardState) => setCanvasCardState(preference, next)];
}

function setBelowDesktop(key: string, state: Exclude<CanvasCardState, "hidden"> | undefined): void {
  if (state === undefined) belowDesktop.delete(key);
  else belowDesktop.set(key, state);
  for (const listener of [...belowDesktopListeners]) listener();
}

/** Forgets what was folded below desktop. Tests only. */
export function __resetCanvasCardsForTesting(): void {
  belowDesktop.clear();
}
