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
export type Unlinkable = "empty" | "cameras" | "not_yet";

export interface PropertyLink {
  readonly property: LinkProperty;
  readonly mode: LinkMode;
  readonly unlinkable?: Unlinkable;
}

export interface ViewLinks {
  /** Null while a view shows nothing. */
  readonly basis: LinkBasis | null;
  readonly properties: readonly PropertyLink[];
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
};

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
    case "not_yet":
      return "Z links once depth is a physical place.";
    case "cameras":
      return property === "orientation"
        ? "Links between two 3D views."
        : "Links between two 2D views of one plane, or two 3D views.";
  }
}

/** What the links compare in, as a sentence. */
export function basisNote(basis: LinkBasis): string {
  return basis === "physical"
    ? "In physical units, which both datasets declare."
    : "In voxels, since the datasets don't both declare physical units.";
}
