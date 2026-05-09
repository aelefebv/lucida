// Pure REST wrappers around `/api/bookmarks`. No React, no DOM — kept
// separate from the `useBookmarks` hook so urlSync's `#b=<id>`
// resolution can call `getBookmark(id)` without dragging in the hook
// machinery (the bootstrap path runs before any React tree is mounted).
//
// Slice 2 (issue #475) defines the wire contract:
//   - GET /api/bookmarks?dataset=<url>&dataset=<url>
//   - GET /api/bookmarks/:id
//   - POST /api/bookmarks  body {name, datasets, view}
//   - PATCH /api/bookmarks/:id  body {name}
//   - DELETE /api/bookmarks/:id
//
// 401 means "not authenticated" — the caller should redirect through
// the existing UnauthLanding flow (already preserves the hash).
// 403 on PATCH/DELETE means "not the creator and not admin." 404 on a
// missing id. 5xx surfaces as `BookmarksApiError` with status.

import type { SavedView } from "./types.ts";

/** Server's `BookmarkResponse` shape (mirror of `lucida-server::bookmarks::handlers::BookmarkResponse`). */
export interface Bookmark {
  id: string;
  name: string;
  created_by: string;
  created_by_name: string;
  /** ISO-8601 timestamp from `chrono::DateTime<Utc>::to_rfc3339`. */
  created_at: string;
  datasets: string[];
  view: SavedView;
}

export class BookmarksApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "BookmarksApiError";
    this.status = status;
  }
}

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

const BASE = "/api/bookmarks";

/** Build `?dataset=A&dataset=B&...` honoring URL-encoding. Empty → "". */
function buildDatasetQuery(datasets: readonly string[]): string {
  if (datasets.length === 0) return "";
  const parts = datasets.map((u) => `dataset=${encodeURIComponent(u)}`);
  return `?${parts.join("&")}`;
}

async function readJsonOrThrow<T>(res: Response, op: string): Promise<T> {
  if (res.status >= 200 && res.status < 300) {
    return (await res.json()) as T;
  }
  // Try to surface the server's structured error body if present.
  let detail = "";
  try {
    const body = (await res.json()) as { error?: string; detail?: string };
    detail = body.detail ?? body.error ?? "";
  } catch {
    /* body not JSON — leave detail empty */
  }
  const msg = detail ? `${op}: ${res.status} ${detail}` : `${op}: ${res.status}`;
  throw new BookmarksApiError(res.status, msg);
}

export async function listBookmarks(
  datasets: readonly string[],
  fetchImpl: FetchLike = fetch,
): Promise<Bookmark[]> {
  const url = `${BASE}${buildDatasetQuery(datasets)}`;
  const res = await fetchImpl(url, { credentials: "include" });
  return readJsonOrThrow<Bookmark[]>(res, "listBookmarks");
}

export async function getBookmark(
  id: string,
  fetchImpl: FetchLike = fetch,
): Promise<Bookmark | null> {
  const res = await fetchImpl(`${BASE}/${encodeURIComponent(id)}`, {
    credentials: "include",
  });
  if (res.status === 404) return null;
  return readJsonOrThrow<Bookmark>(res, "getBookmark");
}

export async function createBookmark(
  body: { name: string; datasets: string[]; view: SavedView },
  fetchImpl: FetchLike = fetch,
): Promise<Bookmark> {
  const res = await fetchImpl(BASE, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJsonOrThrow<Bookmark>(res, "createBookmark");
}

export async function patchBookmarkName(
  id: string,
  name: string,
  fetchImpl: FetchLike = fetch,
): Promise<Bookmark> {
  const res = await fetchImpl(`${BASE}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return readJsonOrThrow<Bookmark>(res, "patchBookmarkName");
}

export async function deleteBookmark(
  id: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const res = await fetchImpl(`${BASE}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (res.status === 204 || res.status === 200) return;
  // Reuse the same path so 404/403/5xx all surface as BookmarksApiError.
  await readJsonOrThrow<unknown>(res, "deleteBookmark");
}
