import { oneOfPreference, type Preference } from "../theme/preferences.ts";

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
