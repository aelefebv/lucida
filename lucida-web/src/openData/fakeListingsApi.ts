import type { Listing, ListingGroup, ListingResult, ListingsPage } from "./listingsApi.ts";

/**
 * A stand-in for the server's listings routes, for tests. It keeps the
 * contract's shape: every word must appear, a group whose label holds every
 * word comes back whole and collapsed, groups keep the order given, and a
 * page ends after `pageSize` results with a cursor for the next. Kind, date
 * and scope narrow before the words match, and mine answers for everyone
 * unless the caller has an email and some listing has an owner.
 */
export interface FakeListingsApi {
  fetch: typeof globalThis.fetch;
  /** Every query searched, in order. */
  queries: string[];
  /** Every search's parameters, in order. */
  searches: URLSearchParams[];
  /** Answer nothing until released, as a server still on its first refresh would. */
  hold(): () => void;
}

export interface FakeListingsOptions {
  pageSize?: number;
  /** The caller's email, or null for a server whose callers aren't signed in. */
  me?: string | null;
}

export function folder(id: string, label = id.split("/").pop() ?? id): ListingGroup {
  return { id, label, noun: "Folder" };
}

export function listing(url: string, overrides: Partial<Listing> = {}): Listing {
  const title = url.split("/").pop() ?? url;
  return { url, title, kind: "image", tiles: null, owner: null, date: null, group: null, fields: [], ...overrides };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function fakeListingsApi(
  listings: readonly Listing[],
  { pageSize = 50, me = "viewer@example.com" }: FakeListingsOptions = {},
): FakeListingsApi {
  const queries: string[] = [];
  const searches: URLSearchParams[] = [];
  let held: Promise<void> | null = null;
  const mineAvailable = me !== null && listings.some((item) => item.owner);

  const search = (params: URLSearchParams): { results: ListingResult[]; outside: number } => {
    const words = (params.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const kind = params.get("kind");
    const since = params.get("since");
    const mine = params.get("scope") === "mine" && mineAvailable;
    const holdsAll = (text: string) => words.every((word) => text.toLowerCase().includes(word));
    const results: ListingResult[] = [];
    const byGroup = new Map<string, ListingResult>();
    let outside = 0;
    for (const item of listings) {
      if (kind && item.kind !== kind) continue;
      if (since && (item.date === null || Date.parse(item.date) < Date.parse(since))) continue;
      const key = item.group?.id ?? null;
      const collapsed = words.length > 0 && item.group !== null && holdsAll(item.group.label);
      if (!collapsed && !holdsAll(`${item.title} ${item.url} ${item.fields.map((f) => f.value).join(" ")}`)) continue;
      if (mine && item.owner?.toLowerCase() !== me?.toLowerCase()) {
        outside += 1;
        continue;
      }
      const existing = key === null ? undefined : byGroup.get(key);
      if (existing) {
        existing.listings.push(item);
        continue;
      }
      const result = { group: item.group, collapsed, listings: [item] };
      results.push(result);
      if (key !== null) byGroup.set(key, result);
    }
    return { results, outside };
  };

  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (held) await held;
    if (url.pathname === "/api/listings/resolve") {
      // The server looks a URL up without its trailing slashes.
      const wanted = url.searchParams.get("url")?.replace(/\/+$/, "");
      return json({ listing: listings.find((item) => item.url === wanted) ?? null });
    }
    if (url.pathname === "/api/listings") {
      queries.push(url.searchParams.get("q") ?? "");
      searches.push(url.searchParams);
      const { results, outside } = search(url.searchParams);
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const end = start + pageSize;
      const mine = url.searchParams.get("scope") === "mine" && mineAvailable;
      const page: ListingsPage = {
        results: results.slice(start, end),
        next_cursor: end < results.length ? String(end) : null,
        scope: mine ? "mine" : "everyone",
        mine_available: mineAvailable,
        outside_scope: outside,
      };
      return json(page);
    }
    return json({ error: "not_found" }, 404);
  }) as typeof globalThis.fetch;

  return {
    fetch,
    queries,
    searches,
    hold() {
      let release = () => {};
      held = new Promise<void>((resolve) => {
        release = () => {
          held = null;
          resolve();
        };
      });
      return release;
    },
  };
}
