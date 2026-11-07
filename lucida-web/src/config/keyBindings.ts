import type { KeyCombo } from "../ui/shortcuts.ts";

/** A motion that lasts as long as its key is held, read by a frame loop. */
export type HeldAction =
  | "forward"
  | "backward"
  | "left"
  | "right"
  | "up"
  | "down"
  | "pitchUp"
  | "pitchDown"
  | "yawLeft"
  | "yawRight"
  | "rollLeft"
  | "rollRight"
  | "clipNearer"
  | "clipFarther";

/**
 * One row of the shortcut sheet: several keys, each holding its own action,
 * listed in the order the label names them.
 */
export interface HeldBinding {
  readonly id: string;
  readonly label: string;
  readonly keys: readonly (readonly [KeyCombo, HeldAction])[];
}

/** The fly camera's keys. They take precedence over global keys in fly mode. */
export const FLY_BINDINGS: readonly HeldBinding[] = [
  {
    id: "fly.move",
    label: "Move forward, left, back, right",
    keys: [["W", "forward"], ["A", "left"], ["S", "backward"], ["D", "right"]],
  },
  { id: "fly.rise", label: "Move down, up", keys: [["Q", "down"], ["E", "up"]] },
  {
    id: "fly.look",
    label: "Look up, left, down, right",
    keys: [["I", "pitchUp"], ["J", "yawLeft"], ["K", "pitchDown"], ["L", "yawRight"]],
  },
  { id: "fly.roll", label: "Roll right, left", keys: [["U", "rollRight"], ["O", "rollLeft"]] },
];

/** Clip-plane keys, in either 3D camera. */
export const CLIP_BINDINGS: readonly HeldBinding[] = [
  {
    id: "view.clip",
    label: "Move the clip plane nearer, farther",
    keys: [["[", "clipNearer"], ["]", "clipFarther"]],
  },
];

/** Switches between the orbit and fly cameras in 3D. */
export const TOGGLE_FLY_KEYS: readonly KeyCombo[] = ["F"];
