import { useViewportClass } from "../theme/viewport.ts";
import { layoutsFor, mostViews } from "../viewLayout.ts";
import { listingChoice, type GroupRow, type OpenChoice } from "./openRows.ts";

/**
 * The most datasets that open together on this screen. A new workspace
 * gives each its own view, so it is the most views the screen's layouts
 * hold: four, or two on a phone.
 */
export function useOpenTogetherLimit(): number {
  return mostViews(layoutsFor(useViewportClass() === "phone"));
}

/**
 * `ticked` with `choice` ticked or unticked, in the order they were ticked;
 * null when it would tick one past `limit`.
 */
export function toggleTick(ticked: readonly OpenChoice[], choice: OpenChoice, limit: number): OpenChoice[] | null {
  if (ticked.some((t) => t.url === choice.url)) return ticked.filter((t) => t.url !== choice.url);
  if (ticked.length >= limit) return null;
  return [...ticked, choice];
}

/**
 * What "Open group" opens: every listing in the group, when the rows hold
 * all of them and no more than `limit`. Null otherwise, since a search can
 * return a group's matching listings alone, and opening those as the group
 * would leave the rest out.
 */
export function groupChoices(row: GroupRow, limit: number): OpenChoice[] | null {
  if (row.size === null || row.size > limit || row.children.length !== row.size) return null;
  return row.children.flatMap((child) => (child.type === "listing" ? [listingChoice(child.listing)] : []));
}
