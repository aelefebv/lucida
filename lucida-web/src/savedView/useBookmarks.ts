// The bookmarks REST API plus the sidebar's list and filter state.
//
// `BookmarkChanged` broadcasts keep the list live: created or updated
// refetches the row by id, deleted drops it. Self-broadcasts are not filtered;
// the refetch returns the same canonical row the optimistic update wrote.
// Rename and delete are optimistic and roll back on failure.

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
  /** Email from `/auth/whoami`, for the "Mine only" toggle. `null` means
   *  auth hasn't resolved; the toggle then hides everything. */
  currentUserEmail: string | null;
  /** Bridge for live cross-peer updates. Without one, the list refreshes
   *  only on demand. */
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
  /** Kept for symmetry. `urlSync` resolves `#b=<id>` through `bookmarksApi`
   *  directly so it doesn't depend on a mounted hook. */
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

  // The parent often passes a fresh array with the same URLs; key on the
  // sorted set so equal sets don't refetch.
  const datasetsKey = useMemo(
    () => [...loadedDatasets].sort().join("\n"),
    [loadedDatasets],
  );

  // So a stale response can't overwrite a fresher one.
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

  // Depend on the key, not `refresh`: refreshing more often than the set
  // changes drops in-flight optimistic creates.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [datasetsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyed only on `bridge`, so filter and dataset changes never open a gap
  // between unsubscribe and resubscribe where a broadcast is missed.
  useEffect(() => {
    if (!bridge) return;
    const unsubscribe = bridge.subscribeBookmarkChanged((id, action, _datasetUrls) => {
      if (action === "deleted") {
        setAllBookmarks((prev) => prev.filter((b) => b.id !== id));
        return;
      }
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
          // Best effort: the next mutation's broadcast resyncs.
          console.warn("[useBookmarks] failed to refetch on broadcast:", e);
        });
    });
    return unsubscribe;
  }, [bridge]);

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

  const createBookmark = useCallback(
    async (name: string, datasets: string[], view: SavedView): Promise<Bookmark> => {
      const created = await apiCreate({ name, datasets, view });
      // De-dupe by id: a racing refresh may already have inserted the row.
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
      setAllBookmarks((prev) => prev.map((b) => (b.id === id ? { ...b, name: newName } : b)));
      try {
        const updated = await apiPatch(id, newName);
        setAllBookmarks((prev) => prev.map((b) => (b.id === id ? updated : b)));
        return updated;
      } catch (e) {
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

/** Format an ISO timestamp as relative time ("3 days ago", "now"). */
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
 * Default bookmark name: dataset basenames, then ` · ` and the layout name if
 * any, truncated to 60 chars. "Untitled" with no datasets.
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
  // Works for gs://bucket/path.zarr, file paths, and URLs with a query.
  const noQuery = url.split("?")[0].split("#")[0];
  const cleaned = noQuery.replace(/\/+$/, "");
  const slash = cleaned.lastIndexOf("/");
  return slash >= 0 ? cleaned.slice(slash + 1) : cleaned;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
