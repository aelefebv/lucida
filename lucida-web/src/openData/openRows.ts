import type { Listing, ListingGroup, ListingResult } from "./listingsApi.ts";

/** A dataset someone chose to open. */
export interface OpenChoice {
  /** Canonical. */
  url: string;
  /** What a new workspace is named after; null to name it after the URL. */
  title: string | null;
  /** The group its listing sits in, which names a workspace opened from several of one group. */
  group: ListingGroup | null;
}

/** A typed or pasted location, checked, and resolved when it checks out. */
export interface TypedLocation {
  raw: string;
  /** Canonical, or null when the check refused it or hasn't run. */
  url: string | null;
  /** Why it can't open, from the location check. */
  problem: string | null;
  /** The title of the listing it names, when a source offers it. */
  title: string | null;
}

export type OpenRow =
  | ({ type: "location"; key: string } & TypedLocation)
  | GroupRow
  | { type: "listing"; key: string; listing: Listing; parent: string | null }
  | { type: "recent"; key: string; url: string; parent: string }
  | { type: "more"; key: string };

export interface GroupRow {
  type: "group";
  key: string;
  label: string;
  /** What the group is, such as "Folder"; null for the recent list. */
  noun: string | null;
  /** The group's full id, for a tooltip that tells like labels apart. */
  id: string | null;
  /** How many listings the group holds, matched or not; null for the recent list. */
  size: number | null;
  expanded: boolean;
  children: readonly OpenRow[];
}

export interface RowInputs {
  location: TypedLocation | null;
  recents: readonly string[];
  results: readonly ListingResult[];
  /** Groups someone expanded or collapsed, by key, over what the server said. */
  toggled: ReadonlyMap<string, boolean>;
  hasMore: boolean;
}

export const RECENT_GROUP_KEY = "recent";
export const MORE_KEY = "more";

function groupKey(result: ListingResult): string | null {
  // A group id is unique within its source only, and the noun tells sources apart.
  return result.group && `group:${result.group.noun}:${result.group.id}`;
}

/**
 * The rows, top level first, each group holding its children. The order is
 * the server's: the dialog neither filters nor ranks.
 */
export function buildRows({ location, recents, results, toggled, hasMore }: RowInputs): OpenRow[] {
  const rows: OpenRow[] = [];
  if (location) rows.push({ type: "location", key: "location", ...location });
  if (recents.length > 0) {
    rows.push({
      type: "group",
      key: RECENT_GROUP_KEY,
      label: "Recent",
      noun: null,
      id: null,
      size: null,
      expanded: toggled.get(RECENT_GROUP_KEY) ?? true,
      children: recents.map((url) => ({ type: "recent", key: `recent:${url}`, url, parent: RECENT_GROUP_KEY })),
    });
  }
  for (const result of results) {
    const key = groupKey(result);
    const listings = result.listings.map(
      (listing): OpenRow => ({ type: "listing", key: `listing:${key ?? ""}:${listing.url}`, listing, parent: key }),
    );
    if (key === null || !result.group) {
      rows.push(...listings);
      continue;
    }
    rows.push({
      type: "group",
      key,
      label: result.group.label,
      noun: result.group.noun,
      id: result.group.id,
      size: result.size,
      expanded: toggled.get(key) ?? !result.collapsed,
      children: listings,
    });
  }
  if (hasMore) rows.push({ type: "more", key: MORE_KEY });
  return rows;
}

/** The rows on screen, in order: each group followed by its children while expanded. */
export function visibleRows(rows: readonly OpenRow[]): OpenRow[] {
  return rows.flatMap((row) => (row.type === "group" && row.expanded ? [row, ...row.children] : [row]));
}

/** The group a row sits in, or null at the top level. */
export function parentOf(row: OpenRow): string | null {
  return row.type === "listing" || row.type === "recent" ? row.parent : null;
}

/** What opening `row` opens, or null for a row that opens nothing. */
export function choiceOf(row: OpenRow): OpenChoice | null {
  switch (row.type) {
    case "location":
      return row.url && !row.problem ? { url: row.url, title: row.title, group: null } : null;
    case "listing":
      return listingChoice(row.listing);
    case "recent":
      return { url: row.url, title: null, group: null };
    default:
      return null;
  }
}

export function listingChoice(listing: Listing): OpenChoice {
  return { url: listing.url, title: listing.title, group: listing.group };
}

/** How many datasets the rows hold, the recent list aside. */
export function countListings(rows: readonly OpenRow[]): number {
  return rows.reduce(
    (n, row) =>
      n + (row.type === "listing" ? 1 : row.type === "group" && row.noun !== null ? row.children.length : 0),
    0,
  );
}
