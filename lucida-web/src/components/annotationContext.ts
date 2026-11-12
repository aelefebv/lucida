/**
 * Off-context logic for annotation pins. A pin belongs to the planes it lies
 * on, the T it was placed on and the channels its layer showed then. A slice
 * view whose cut misses its planes, or a view on any other T or showing none
 * of those channels, renders it dimmed with a label naming where it lives.
 * This is a pure function of pin and view, so overlays keep no off-context
 * state and navigating back restores the pin on the next render.
 */
import { positionLabel, positionNumber } from "../axes.ts";
import type { ResolvedLayer } from "../resolvedLayers.ts";
import { cutAxis, xyz, type SlicePlane, type SpatialAxis } from "../renderer/slicePlane.ts";
import type { Annotation } from "./annotationDocument.ts";
import { annotationVertices } from "./annotationGeometry.ts";
import { deriveHandle } from "./annotationParticipants.ts";

/** Where a slice view cuts a layer: its planes `start` up to `end` along `axis`. */
export interface ViewCut {
  axis: SpatialAxis;
  start: number;
  end: number;
}

/** The current view's selectors, and the channels the pin's layer shows now. */
export interface ViewContext {
  /** Where the view cuts the pin's layer, or null in a volume view, which
   * shows every plane. */
  cut: ViewCut | null;
  t: number;
  /** The resolved layer's shown channels, ascending. */
  channels: readonly number[];
}

/** Where a slice view of `plane` cuts `layer`. */
export function viewCut(layer: ResolvedLayer, plane: SlicePlane): ViewCut {
  const axis = cutAxis(plane);
  if (axis === "z") return { axis, start: layer.z_range.start, end: layer.z_range.end };
  const index = axis === "y" ? layer.y : layer.x;
  return { axis, start: index, end: index + 1 };
}

/** The first and last plane a pin's shape lies on along `axis`: each vertex's
 * plane is the one holding it, the sample `i` spanning `i` up to `i + 1`. */
function planesAlong(pin: Annotation, axis: SpatialAxis): [number, number] {
  const planes = annotationVertices(pin).map((v) => Math.floor(v[xyz(axis)]));
  return [Math.min(...planes), Math.max(...planes)];
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

/** Whether `pin` lies off the planes `view` cuts, differs from it in T, or
 * shares no channel with it. */
export function isOffContext(pin: Annotation, view: ViewContext): boolean {
  const cut = view.cut;
  const [first, last] = cut ? planesAlong(pin, cut.axis) : [0, 0];
  const cutOff = cut !== null && (last < cut.start || first >= cut.end);
  return cutOff || Math.round(pin.t ?? 0) !== Math.round(view.t) || !inChannelContext(pinChannels(pin), view.channels);
}

/** The off-context label naming where the pin lives: its planes along `axis`,
 * the axis the view cuts, then its T and channels. */
export function offContextLabel(pin: Annotation, axis: SpatialAxis = "z"): string {
  const name = axis.toUpperCase();
  const [first, last] = planesAlong(pin, axis);
  const planes = first === last ? positionLabel(name, first) : `${positionLabel(name, first)}–${positionNumber(last)}`;
  const channels = pinChannels(pin);
  const channelPart = channels.length === 1
    ? positionLabel("Channel", channels[0])
    : `Channels ${channels.map((c) => c + 1).join(", ")}`;
  return [planes, positionLabel("T", Math.round(pin.t ?? 0)), channelPart].join(" · ");
}

/** A pin marker's accessible name: whose it is, its comment count, and, off
 * the view, where it lives along `axis`. */
export function pinLabel(pin: Annotation, mine: boolean, offContext: boolean, axis: SpatialAxis = "z"): string {
  const count = pin.comments?.length ?? 0;
  return [
    `Pin by ${mine ? "you" : deriveHandle(pin.author)}`,
    count > 0 ? `${count} comment${count === 1 ? "" : "s"}` : null,
    offContext ? offContextLabel(pin, axis) : null,
  ]
    .filter(Boolean)
    .join(", ");
}
