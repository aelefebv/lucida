/**
 * Off-context logic for annotation pins. A pin belongs to the Z and T it was
 * placed on and to the channels its layer showed then; on any other Z or T, or
 * when none of those channels shows, it renders dimmed with a label naming
 * where it lives. This is a pure function of pin and view, so overlays keep no
 * off-context state and navigating back restores the pin on the next render.
 */
import { positionLabel } from "../axes.ts";
import type { Annotation } from "./annotationDocument.ts";
import { deriveHandle } from "./annotationParticipants.ts";

/** The current view's selectors, and the channels the pin's layer shows now. */
export interface ViewContext {
  z: number;
  t: number;
  /** The resolved layer's shown channels, ascending. */
  channels: readonly number[];
}

/** A pin's placement Z/T as integers, with absent fields defaulting to 0 as
 * on the wire. A 3D-dropped pin's voxel depth rounds to its slice. */
function pinZT(pin: Annotation): { z: number; t: number } {
  return {
    z: Math.round(pin.z ?? 0),
    t: Math.round(pin.t ?? 0),
  };
}

/** The channels the pin's layer showed at placement, as the scene derives
 * them; a pin read without them belongs to its `c`. */
export function pinChannels(pin: Annotation): readonly number[] {
  return pin.channels ?? [Math.round(pin.c ?? 0)];
}

/** Whether some channel the view shows was shown when the pin was placed, so a
 * pin placed in the composite stays in context when one of its channels is
 * soloed. Mirrors `lucida_core::scene::in_channel_context`. */
export function inChannelContext(placement: readonly number[], shown: readonly number[]): boolean {
  return shown.some((c) => placement.includes(c));
}

/** `ignoreZ` is for the 3D view, which renders all slices at once. Without it a
 * 3D-created pin, whose picked depth is rarely the slider's z, would always
 * read off-context. */
export interface OffContextOptions {
  ignoreZ?: boolean;
}

/** Whether `pin` differs from `view` in Z or T, or shares no channel with it. */
export function isOffContext(pin: Annotation, view: ViewContext, opts?: OffContextOptions): boolean {
  const { z, t } = pinZT(pin);
  const zOff = opts?.ignoreZ ? false : z !== Math.round(view.z);
  return zOff || t !== Math.round(view.t) || !inChannelContext(pinChannels(pin), view.channels);
}

/** The off-context label naming the pin's own Z/T and channels. */
export function offContextLabel(pin: Annotation): string {
  const { z, t } = pinZT(pin);
  const channels = pinChannels(pin);
  const channelPart = channels.length === 1
    ? positionLabel("Channel", channels[0])
    : `Channels ${channels.map((c) => c + 1).join(", ")}`;
  return [positionLabel("Z", z), positionLabel("T", t), channelPart].join(" · ");
}

/** A pin marker's accessible name: whose it is, its comment count, and, off the view, where it lives. */
export function pinLabel(pin: Annotation, mine: boolean, offContext: boolean): string {
  const count = pin.comments?.length ?? 0;
  return [
    `Pin by ${mine ? "you" : deriveHandle(pin.author)}`,
    count > 0 ? `${count} comment${count === 1 ? "" : "s"}` : null,
    offContext ? offContextLabel(pin) : null,
  ]
    .filter(Boolean)
    .join(", ");
}
