/**
 * What a view's scale bar shows, which lucida-core reads from the view's
 * camera and its top dataset's placement, and whether the page draws one.
 */
import { isCaptureSurface } from "../captureSurface.ts";
import { booleanPreference, usePreference } from "../theme/preferences.ts";

/** One arm of the bar: a stretch along one axis of the screen. */
export interface ScaleBarArm {
  /** The dataset's axis it lies along, or null in a volume view. */
  readonly axis: "x" | "y" | "z" | null;
  /** The CSS pixels it spans. */
  readonly pixels: number;
  /** Its length as it reads, such as `50 µm` or `20 samples`. */
  readonly label: string;
}

/** `Scene::scale_bar`'s reading for one view. */
export interface ScaleBarReading {
  readonly dataset_id: string;
  /** Physical length in meters, or samples of a dataset without units. */
  readonly measure: "length" | "samples";
  /** Meters, or samples, per CSS pixel across the screen and down it. */
  readonly per_pixel: readonly [number, number];
  readonly across: ScaleBarArm;
  /** Only when the screen's down axis measures differently. */
  readonly down: ScaleBarArm | null;
  /** The reading holds at the depth of the orbit center alone. */
  readonly at_orbit_center: boolean;
  /** A person scaled the dataset by hand along an axis the bar measures. */
  readonly scaled_by_hand: boolean;
}

/** `scene.scale_bar(view)`'s JSON as a reading, or null when the view shows no bar. */
export function parseScaleBar(json: string): ScaleBarReading | null {
  if (!json) return null;
  return JSON.parse(json) as ScaleBarReading | null;
}

/** An arm's label, led by its axis when there are two arms to tell apart. */
export function armLabel(arm: ScaleBarArm, twoArms: boolean): string {
  return twoArms && arm.axis ? `${arm.axis.toUpperCase()} ${arm.label}` : arm.label;
}

/** What qualifies the reading, or null when nothing does. */
export function scaleBarNote(reading: ScaleBarReading): string | null {
  const notes = [reading.at_orbit_center && "at orbit center", reading.scaled_by_hand && "scaled by hand"];
  const said = notes.filter((note): note is string => typeof note === "string");
  return said.length > 0 ? said.join(", ") : null;
}

export const scaleBarPreference = booleanPreference("view.scaleBar", true);

/**
 * The query parameter that decides for the page's life whether views draw
 * their bar, `1` or `0`, so a capture can ask for it whoever's settings the
 * browser holds.
 */
export const SCALE_BAR_PARAM = "scale_bar";

/**
 * Whether views draw their scale bar: as the page's URL asks, and otherwise
 * as the setting says. The capture surface draws one only when asked, so
 * the frames the trace driver and other captures take stay as they were.
 */
export function scaleBarShown(setting: boolean, search?: string): boolean {
  const raw = search ?? (typeof window === "undefined" ? "" : window.location.search);
  const asked = new URLSearchParams(raw).get(SCALE_BAR_PARAM);
  if (asked === "1") return true;
  if (asked === "0") return false;
  return setting && !isCaptureSurface(raw);
}

/** {@link scaleBarShown} for this page, following the setting. */
export function useScaleBarShown(): boolean {
  const [setting] = usePreference(scaleBarPreference);
  return scaleBarShown(setting);
}
