import type { Listing, ListingGroup, ListingResult, ListingsPage } from "./listingsApi.ts";

/**
 * A stand-in for the server's listings routes, for tests. It keeps the
 * contract's shape: every word must appear, a group whose label holds every
 * word comes back whole and collapsed, groups keep the order given, and a
 * page ends after `pageSize` results with a cursor for the next.
 */
export interface FakeListingsApi {
  fetch: typeof globalThis.fetch;
  /** Every query searched, in order. */
  queries: string[];
  /** Answer nothing until released, as a server still on its first refresh would. */
  hold(): () => void;
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

export function fakeListingsApi(listings: readonly Listing[], { pageSize = 50 } = {}): FakeListingsApi {
  const queries: string[] = [];
  let held: Promise<void> | null = null;

  const search = (q: string): ListingResult[] => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const holdsAll = (text: string) => words.every((word) => text.toLowerCase().includes(word));
    const results: ListingResult[] = [];
    const byGroup = new Map<string, ListingResult>();
    for (const item of listings) {
      const key = item.group?.id ?? null;
      const collapsed = words.length > 0 && item.group !== null && holdsAll(item.group.label);
      if (!collapsed && !holdsAll(`${item.title} ${item.url} ${item.fields.map((f) => f.value).join(" ")}`)) continue;
      const existing = key === null ? undefined : byGroup.get(key);
      if (existing) {
        existing.listings.push(item);
        continue;
      }
      const result = { group: item.group, collapsed, listings: [item] };
      results.push(result);
      if (key !== null) byGroup.set(key, result);
    }
    return results;
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
      const q = url.searchParams.get("q") ?? "";
      queries.push(q);
      const results = search(q);
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const end = start + pageSize;
      const page: ListingsPage = {
        results: results.slice(start, end),
        next_cursor: end < results.length ? String(end) : null,
      };
      return json(page);
    }
    return json({ error: "not_found" }, 404);
  }) as typeof globalThis.fetch;

  return {
    fetch,
    queries,
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
