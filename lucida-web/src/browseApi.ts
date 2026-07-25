// REST wrapper around `/api/browse` — the server-side filesystem listing
// behind the FileBrowser modal. No React, no DOM.
//
// Wire contract:
//   - GET /api/browse            → platform-default root (see below)
//   - GET /api/browse?path=<p>   → listing of `p`
//
// The request path is RELATIVE and the fetch is `credentials: "same-origin"`,
// matching every other `/api` call in the client. That is load-bearing, not
// cosmetic: `/api/browse` sits inside the server's auth middleware, so the
// session cookie has to ride along. An absolute `http://localhost:<port>/…`
// URL points at the *viewer's* machine and is cross-origin for every
// deployment that isn't the developer's own laptop, which both misses the
// cookie and bypasses the Vite dev proxy that exists to keep dev single-origin.
//
// Errors: the handler answers with a plain-text body (`(StatusCode, String)`),
// while the auth middleware in front of it answers a 401 with a JSON body
// (`{error, detail, signedOut}`). Neither shape is parsed — the body is
// surfaced verbatim and the status line is only the empty-body fallback.

export interface BrowseEntry {
  name: string;
  type: "directory" | "file";
}

export interface BrowseResponse {
  path: string;
  entries: BrowseEntry[];
}

const BASE = "/api/browse";

/**
 * Build the relative request URL for a browse of `path`.
 *
 * An empty `path` omits the query param entirely so the server takes its
 * platform-default-root branch (listing of `/` on Unix, a synthetic drives
 * list on Windows). Non-empty paths are URL-encoded verbatim — they are
 * already in canonical forward-slash form.
 */
export function browseUrl(path: string): string {
  return path ? `${BASE}?path=${encodeURIComponent(path)}` : BASE;
}

/** List `path` on the server's filesystem. Throws on any non-2xx. */
export async function browse(path: string): Promise<BrowseResponse> {
  const res = await fetch(browseUrl(path), { credentials: "same-origin" });
  if (!res.ok) {
    let text = "";
    try {
      text = await res.text();
    } catch {
      // Body unreadable — fall back to the status line.
    }
    throw new Error(text || `${res.status} ${res.statusText}`.trim());
  }
  return (await res.json()) as BrowseResponse;
}
