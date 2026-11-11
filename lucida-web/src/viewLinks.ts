/**
 * How the two views link, as the scene holds it. lucida-core picks each
 * property's default from the datasets the views show, carries a steer of
 * one view to the other, and says when a property can't link; the web shows
 * the modes and the reasons, and sets a mode.
 */
import type { WasmScene } from "lucida-core";
import type { LinkMode, LinkProperty } from "./commands.ts";

/** What linked positions and sizes compare in. */
export type LinkBasis = "physical" | "voxel";

/** Why a property can't link between the views as they stand. */
export type Unlinkable = "empty" | "cameras" | "shared";

/**
 * A channel of the first view's dataset and the one of the second's that its
 * contrast and colormap links reach: paired by name, or, where neither found
 * its name across, by place.
 */
export interface ChannelPair {
  readonly first: number;
  readonly second: number;
  readonly first_name: string;
  readonly second_name: string;
  readonly by: "name" | "index";
}

/** Why a pair compared in its own samples links by default. */
export type Alike = "same_dataset" | "same_placement";

/** What a link left a view showing none of. */
export type LinkNotice = { readonly kind: "position" } | { readonly kind: "depth" } | { readonly kind: "time"; readonly last: number };

export interface ViewLinkNotices {
  readonly view: number;
  readonly notices: readonly LinkNotice[];
}

export interface PropertyLink {
  readonly property: LinkProperty;
  readonly mode: LinkMode;
  readonly unlinkable?: Unlinkable;
}

export interface ViewLinks {
  /** Null while a view shows nothing. */
  readonly basis: LinkBasis | null;
  readonly alike?: Alike;
  readonly properties: readonly PropertyLink[];
  /** Where the links take each view past what it shows. */
  readonly notices: readonly ViewLinkNotices[];
  /** Which channels the contrast and colormap links pair; absent when both views show one dataset. */
  readonly channels?: readonly ChannelPair[];
}

/** The views' links, or null with one view. */
export function readViewLinks(scene: Pick<WasmScene, "view_links">): ViewLinks | null {
  return JSON.parse(scene.view_links()) as ViewLinks | null;
}

export const LINK_LABELS: Readonly<Record<LinkProperty, string>> = {
  pan: "Pan",
  zoom: "Zoom",
  orientation: "3D orientation",
  z: "Z",
  t: "Time",
  contrast: "Contrast",
  colormap: "Colormap",
};

/** The modes each property offers: a colormap links or stays off, with no offset to keep. */
export function linkModes(property: LinkProperty): readonly LinkMode[] {
  return property === "colormap" ? ["linked", "off"] : ["linked", "relative", "off"];
}

export const LINK_MODE_LABELS: Readonly<Record<LinkMode, string>> = {
  linked: "Linked",
  relative: "Relative",
  off: "Off",
};

export function isLinkProperty(value: string): value is LinkProperty {
  return Object.hasOwn(LINK_LABELS, value);
}

export function isLinkMode(value: string): value is LinkMode {
  return Object.hasOwn(LINK_MODE_LABELS, value);
}

/** Why `property` can't link now, as a sentence. */
export function unlinkableReason(property: LinkProperty, unlinkable: Unlinkable): string {
  switch (unlinkable) {
    case "empty":
      return "Each view needs a layer to link.";
    case "shared":
      return "Both views show one dataset, so its channels share one setting.";
    case "cameras":
      if (property === "orientation") return "Links between two 3D views.";
      if (property === "z") return "Links between two 2D views of one plane.";
      return "Links between two 2D views of one plane, or two 3D views.";
  }
}

/** What the links compare in, as a sentence. */
export function basisNote(basis: LinkBasis, alike?: Alike): string {
  if (basis === "physical") return "In physical units, which both datasets declare.";
  if (alike === "same_dataset") return "In samples; both views show the same dataset.";
  if (alike === "same_placement") return "In samples; both datasets have the same shape and placement.";
  return "In samples, since the datasets don't both declare physical units.";
}

/** A channel pair as the link popover lists it, saying when it pairs by place. */
export function channelPairText(pair: ChannelPair): string {
  const joined = `${pair.first_name} ↔ ${pair.second_name}`;
  return pair.by === "index" ? `${joined} (by place)` : joined;
}

/** Where a link took a view past what it shows, as a sentence. */
export function linkNoticeMessage(notice: LinkNotice): string {
  switch (notice.kind) {
    case "position":
      return "The linked position is outside this view's data.";
    case "depth":
      return "The linked depth is outside this view's data, so nothing is drawn.";
    case "time":
      return `The linked time is past this view's data, so it shows its last timepoint, ${notice.last + 1}.`;
  }
}
