import { listingChoice, type GroupRow, type OpenChoice } from "./openRows.ts";

/**
 * The most datasets that open together. A new workspace gives each its own
 * view, and no view layout holds more than four.
 */
export const MAX_OPEN_TOGETHER = 4;

/**
 * `ticked` with `choice` ticked or unticked, in the order they were ticked;
 * null when it would tick one past the limit.
 */
export function toggleTick(ticked: readonly OpenChoice[], choice: OpenChoice): OpenChoice[] | null {
  if (ticked.some((t) => t.url === choice.url)) return ticked.filter((t) => t.url !== choice.url);
  if (ticked.length >= MAX_OPEN_TOGETHER) return null;
  return [...ticked, choice];
}

/**
 * What "Open group" opens: every listing in the group, when the rows hold
 * all of them and they fit. Null otherwise, since a search can return a
 * group's matching listings alone, and opening those as the group would
 * leave the rest out.
 */
export function groupChoices(row: GroupRow): OpenChoice[] | null {
  if (row.size === null || row.size > MAX_OPEN_TOGETHER || row.children.length !== row.size) return null;
  return row.children.flatMap((child) => (child.type === "listing" ? [listingChoice(child.listing)] : []));
}
