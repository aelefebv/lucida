// React hook wrapping the bookmarks REST API plus local list/filter state.
//
// The sidebar lists bookmarks scoped to currently-loaded datasets,
// with a substring search across name + creator name + creator email
// and a "Mine only" toggle.
//
// A live WebSocket subscription layers on top: when any peer mutates
// a bookmark whose dataset URLs overlap a loaded dataset in this
// session, the server broadcasts `ServerMessage::BookmarkChanged`.
// The hook subscribes via `bridge.subscribeBookmarkChanged` and
// reconciles local state without requiring a manual refresh:
//   - Created/Updated: refetch by id and merge (insert if missing,
//     replace if present). Cheaper + more accurate than embedding the
//     full payload in the broadcast.
//   - Deleted: remove the entry from local state.
// Self-broadcasts (the originating client also receives the message)
// are not filtered — optimistic local updates reconcile cleanly
// because the broadcast-driven refetch returns the same canonical
// state.
//
// CRUD wrappers are optimistic: create inserts immediately and reconciles
// with the server response; rename patches in-place; delete removes
// immediately and rolls back on failure. The same hook owns the filter
// state so components stay free of bookkeeping.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Bridge } from "../bridge.ts";
import {
  createBookmark as apiCreate,
  deleteBookmark as apiDelete,
  getBookmark as apiGet,
  listBookmarks as apiList,
  patchBookmarkName as apiPatch,
  type Bookmark,
} from "./bookmarksApi.ts";
import type { SavedView } from "./types.ts";

export type { Bookmark } from "./bookmarksApi.ts";

export interface BookmarkFilter {
  search: string;
  mineOnly: boolean;
}

export interface UseBookmarksOptions {
  /** Currently-loaded dataset URLs. The hook re-fetches whenever this set
   *  changes (the sidebar narrows by dataset overlap). */
  loadedDatasets: readonly string[];
  /** Email of the currently-authed principal (from `/auth/whoami`).
   *  Used to evaluate the "Mine only" toggle. `null` ≡ no auth resolved
   *  yet — the toggle hides everything when checked. */
  currentUserEmail: string | null;
  /** Optional WebSocket bridge for live cross-peer updates (slice 4).
   *  When provided, the hook subscribes to `bookmark_changed` broadcasts
   *  and reconciles local state on Created/Updated/Deleted events.
   *  When `null` or `undefined`, the hook degrades cleanly to manual
   *  refresh — same behavior as before slice 4 landed. */
  bridge?: Bridge | null;
}

export interface UseBookmarksHandle {
  /** Bookmarks after applying the local filter (search + mineOnly). */
  bookmarks: Bookmark[];
  /** Raw list from the server, before filtering. */
  allBookmarks: Bookmark[];
  isLoading: boolean;
  error: string | null;
  filter: BookmarkFilter;
  setSearch: (s: string) => void;
  setMineOnly: (v: boolean) => void;

  refresh: () => Promise<void>;
  createBookmark: (
    name: string,
    datasets: string[],
    view: SavedView,
  ) => Promise<Bookmark>;
  renameBookmark: (id: string, newName: string) => Promise<Bookmark>;
  deleteBookmark: (id: string) => Promise<void>;
  /** Used by `urlSync` for `#b=<id>` resolution. Kept on the hook for
   *  symmetry; the slice-3 wiring resolves through the React-free
   *  `bookmarksApi` directly so it doesn't depend on a mounted hook. */
  getBookmark: (id: string) => Promise<Bookmark | null>;
}

export function useBookmarks({
  loadedDatasets,
  currentUserEmail,
  bridge,
}: UseBookmarksOptions): UseBookmarksHandle {
  const [allBookmarks, setAllBookmarks] = useState<Bookmark[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<BookmarkFilter>({
    search: "",
    mineOnly: false,
  });

  // Stable identity for the loaded-datasets dependency: React re-checks
  // array identity, but the parent often passes a fresh array each render
  // even when the URLs haven't changed. We key on a sorted-joined string
  // so equal sets don't trigger fetches.
  const datasetsKey = useMemo(
    () => [...loadedDatasets].sort().join("\n"),
    [loadedDatasets],
  );

  // Tracks the in-flight request id so a stale response can't overwrite
  // a fresher one (the user opens a new dataset before the old fetch
  // returns).
  const reqIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const reqId = ++reqIdRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const list = await apiList(loadedDatasets);
      if (reqIdRef.current === reqId) {
        setAllBookmarks(list);
      }
    } catch (e) {
      if (reqIdRef.current === reqId) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (reqIdRef.current === reqId) {
        setIsLoading(false);
      }
    }
  }, [loadedDatasets]);

  // Re-fetch on dataset-set change. We deliberately depend on the joined
  // key (not the array reference) so fresh arrays with the same contents
  // don't churn.
  // refresh closes over loadedDatasets, but the list it builds depends
  // only on the joined key — refreshing more often than necessary is
  // wrong (drops in-flight optimistic creates). The setState calls inside
  // refresh ARE the intended effect: dataset set changed → re-fetch.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [datasetsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to cross-peer broadcasts. Created/Updated → fetch by id
  // and merge; Deleted → drop from local state. Self-broadcasts
  // arrive too — they reconcile cleanly because the optimistic state
  // we already inserted matches what the GET returns.
  //
  // The subscription is keyed only on `bridge` identity; it stays
  // mounted across filter and dataset-set changes so we never miss a
  // broadcast in the gap between unsubscribe and resubscribe.
  useEffect(() => {
    if (!bridge) return;
    const unsubscribe = bridge.subscribeBookmarkChanged((id, action, _datasetUrls) => {
      if (action === "deleted") {
        setAllBookmarks((prev) => prev.filter((b) => b.id !== id));
        return;
      }
      // Created or Updated: refetch the canonical row and merge.
      void apiGet(id)
        .then((fetched) => {
          if (fetched === null) return;
          setAllBookmarks((prev) => {
            const idx = prev.findIndex((b) => b.id === fetched.id);
            if (idx < 0) return [fetched, ...prev];
            const next = prev.slice();
            next[idx] = fetched;
            return next;
          });
        })
        .catch((e) => {
          // Best-effort — broadcast will resync on the next mutation.
          console.warn("[useBookmarks] failed to refetch on broadcast:", e);
        });
    });
    return unsubscribe;
  }, [bridge]);

  // --- Filter (purely local; no network) -------------------------------

  const bookmarks = useMemo(() => {
    const needle = filter.search.trim().toLowerCase();
    return allBookmarks.filter((b) => {
      if (filter.mineOnly) {
        if (currentUserEmail === null) return false;
        if (b.created_by !== currentUserEmail) return false;
      }
      if (needle.length > 0) {
        const hay = `${b.name}\n${b.created_by_name}\n${b.created_by}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [allBookmarks, filter, currentUserEmail]);

  const setSearch = useCallback((s: string) => {
    setFilter((f) => ({ ...f, search: s }));
  }, []);
  const setMineOnly = useCallback((v: boolean) => {
    setFilter((f) => ({ ...f, mineOnly: v }));
  }, []);

  // --- CRUD wrappers (optimistic) --------------------------------------

  const createBookmark = useCallback(
    async (name: string, datasets: string[], view: SavedView): Promise<Bookmark> => {
      const created = await apiCreate({ name, datasets, view });
      // Server-authoritative insertion: we de-dupe by id in case a stale
      // refresh raced and already inserted the row.
      setAllBookmarks((prev) => {
        if (prev.some((b) => b.id === created.id)) return prev;
        return [created, ...prev];
      });
      return created;
    },
    [],
  );

  const renameBookmark = useCallback(
    async (id: string, newName: string): Promise<Bookmark> => {
      const original = allBookmarks.find((b) => b.id === id) ?? null;
      // Optimistic in-place rename.
      setAllBookmarks((prev) => prev.map((b) => (b.id === id ? { ...b, name: newName } : b)));
      try {
        const updated = await apiPatch(id, newName);
        setAllBookmarks((prev) => prev.map((b) => (b.id === id ? updated : b)));
        return updated;
      } catch (e) {
        // Roll back to original.
        if (original) {
          setAllBookmarks((prev) => prev.map((b) => (b.id === id ? original : b)));
        }
        throw e;
      }
    },
    [allBookmarks],
  );

  const deleteBookmark = useCallback(async (id: string): Promise<void> => {
    const original = allBookmarks.find((b) => b.id === id) ?? null;
    setAllBookmarks((prev) => prev.filter((b) => b.id !== id));
    try {
      await apiDelete(id);
    } catch (e) {
      if (original) {
        setAllBookmarks((prev) => [original, ...prev.filter((b) => b.id !== id)]);
      }
      throw e;
    }
  }, [allBookmarks]);

  const getBookmark = useCallback(
    (id: string): Promise<Bookmark | null> => apiGet(id),
    [],
  );

  return {
    bookmarks,
    allBookmarks,
    isLoading,
    error,
    filter,
    setSearch,
    setMineOnly,
    refresh,
    createBookmark,
    renameBookmark,
    deleteBookmark,
    getBookmark,
  };
}

// --- Misc helpers (exported so the sidebar can reuse) -------------------

/**
 * Format an ISO timestamp as "3d ago", "2h ago", "just now". Uses
 * `Intl.RelativeTimeFormat` (no extra dependency).
 */
export function relativeTimeFromIso(iso: string, now: Date = new Date()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diffSec = Math.round((t - now.getTime()) / 1000);
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 60) return rtf.format(Math.round(diffSec), "second");
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diffSec / 86400), "day");
  if (abs < 86400 * 365) return rtf.format(Math.round(diffSec / 86400 / 30), "month");
  return rtf.format(Math.round(diffSec / 86400 / 365), "year");
}

/**
 * Build a sensible default name for a fresh bookmark.
 * - With datasets: `${dataset_basenames_joined} · ${active_layout_name}`,
 *   truncated to 60 chars. If no layout name (or just an id), drop it.
 * - With no datasets: "Untitled".
 */
export function defaultBookmarkName(
  datasetUrls: readonly string[],
  activeLayoutName: string | null,
): string {
  if (datasetUrls.length === 0) return "Untitled";
  const names = datasetUrls.map(urlBasename).filter((n) => n.length > 0);
  let base = names.join(", ");
  if (activeLayoutName && activeLayoutName.trim().length > 0) {
    base = `${base} · ${activeLayoutName}`;
  }
  return truncate(base, 60);
}

function urlBasename(url: string): string {
  // Strip query/fragment, then take the last path segment without a
  // trailing slash. Works for gs://bucket/path.zarr, file paths, etc.
  const noQuery = url.split("?")[0].split("#")[0];
  const cleaned = noQuery.replace(/\/+$/, "");
  const slash = cleaned.lastIndexOf("/");
  return slash >= 0 ? cleaned.slice(slash + 1) : cleaned;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
