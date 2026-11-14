/**
 * The listings routes: search the datasets the server's sources offer,
 * resolve a pasted URL to the listing it names, and list the datasets the
 * caller opened recently. The server searches and orders; a caller shows
 * what comes back as it comes back.
 */

export type ListingKind = "image" | "collection";

export interface ListingGroup {
  id: string;
  label: string;
  /** What the group's source calls a group, such as "Folder". */
  noun: string;
}

export interface ListingField {
  name: string;
  value: string;
}

export interface Listing {
  /** Canonical, ready to open. */
  url: string;
  title: string;
  kind: ListingKind;
  /** How many tiles a collection lays out, when its source knows. */
  tiles: number | null;
  owner: string | null;
  /** ISO-8601. */
  date: string | null;
  group: ListingGroup | null;
  fields: ListingField[];
}

export interface ListingResult {
  group: ListingGroup | null;
  /** The group's label matched, so the whole group came back. */
  collapsed: boolean;
  /** How many listings the group holds, matched or not. */
  size: number;
  listings: Listing[];
}

export interface ListingsPage {
  results: ListingResult[];
  /** Send back with the same query for the next page; null on the last. */
  next_cursor: string | null;
}

/** A dataset in a workspace the caller opened recently. */
export interface RecentDataset {
  /** Canonical, ready to open. */
  url: string;
  /** The dataset's own name. */
  name: string;
  /** What a source offers at `url`, when one does. */
  listing: Listing | null;
}

export interface ListingsQuery {
  /** Words that must each appear; empty matches every listing. */
  q: string;
  cursor?: string | null;
}

async function requestJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin", signal });
  if (res.ok) return (await res.json()) as T;
  let detail = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { detail?: string; error?: string };
    detail = body.detail || body.error || detail;
  } catch {
    // Keep the status line.
  }
  throw new Error(detail);
}

export function searchListings({ q, cursor }: ListingsQuery, signal?: AbortSignal): Promise<ListingsPage> {
  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim());
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return requestJson<ListingsPage>(query ? `/api/listings?${query}` : "/api/listings", signal);
}

/** The listing `url` names, or null when no source offers it. */
export async function resolveListing(url: string, signal?: AbortSignal): Promise<Listing | null> {
  const body = await requestJson<{ listing: Listing | null }>(
    `/api/listings/resolve?url=${encodeURIComponent(url)}`,
    signal,
  );
  return body.listing;
}

/** The datasets in the workspaces the caller opened most recently, newest first. */
export async function recentDatasets(signal?: AbortSignal): Promise<RecentDataset[]> {
  const body = await requestJson<{ recent: RecentDataset[] }>("/api/listings/recent", signal);
  return body.recent;
}
