import { useCallback, useEffect, useRef, useState } from "react";
import { searchListings, type ListingResult, type ListingsQuery } from "./listingsApi.ts";

/** How long typing pauses before a search goes out. */
export const SEARCH_DEBOUNCE_MS = 150;

/** What a search asks, its page aside. */
export type ListingSearchRequest = Omit<ListingsQuery, "cursor">;

export interface ListingSearch {
  results: readonly ListingResult[];
  /** Whether `results` answer an earlier request than the one asked now, or nothing has answered yet. */
  stale: boolean;
  /** Why the last search failed, or null. */
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  /** Whether the server offers the caller's own listings as a scope, as of the last answer. */
  mineAvailable: boolean;
  /** Listings that matched but the scope left out. */
  outsideScope: number;
}

interface Answer {
  key: string;
  results: readonly ListingResult[];
  nextCursor: string | null;
  error: string | null;
  mineAvailable: boolean;
  outsideScope: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The server's answer to `request`, a page at a time. A newer request
 * cancels an older one's, so an answer never lands for a request no longer
 * asked. Until the first answer for `request` arrives, the last answer
 * stays, for the caller to show as out of date rather than blank.
 */
export function useListingSearch(request: ListingSearchRequest): ListingSearch {
  const { q, scope, kind = null, since = null } = request;
  const key = JSON.stringify([q, scope ?? null, kind, since]);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const moreRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    // The empty query is the first one a dialog asks, and nobody is typing it.
    const timer = setTimeout(
      () => {
        searchListings({ q, scope, kind, since }, signal).then(
          (page) => {
            if (signal.aborted) return;
            setAnswer({
              key,
              results: page.results,
              nextCursor: page.next_cursor,
              error: null,
              mineAvailable: page.mine_available,
              outsideScope: page.outside_scope,
            });
          },
          (error: unknown) => {
            if (signal.aborted) return;
            setAnswer((current) => ({
              key,
              results: [],
              nextCursor: null,
              error: messageOf(error),
              mineAvailable: current?.mineAvailable ?? false,
              outsideScope: 0,
            }));
          },
        );
      },
      q ? SEARCH_DEBOUNCE_MS : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
      moreRequest.current?.abort();
      moreRequest.current = null;
    };
  }, [key, q, scope, kind, since]);

  const loadMore = useCallback(() => {
    if (!answer?.nextCursor || answer.key !== key || moreRequest.current) return;
    const cursor = answer.nextCursor;
    const controller = new AbortController();
    const { signal } = controller;
    moreRequest.current = controller;
    setLoadingMore(true);
    searchListings({ q, scope, kind, since, cursor }, signal)
      .then(
        (page) => {
          if (signal.aborted) return;
          setAnswer((current) =>
            current && current.key === key && current.nextCursor === cursor
              ? { ...current, results: [...current.results, ...page.results], nextCursor: page.next_cursor }
              : current,
          );
        },
        (error: unknown) => {
          if (!signal.aborted) setAnswer((current) => current && { ...current, error: messageOf(error) });
        },
      )
      .finally(() => {
        if (moreRequest.current === controller) moreRequest.current = null;
        setLoadingMore(false);
      });
  }, [answer, key, q, scope, kind, since]);

  return {
    results: answer?.results ?? [],
    stale: answer?.key !== key,
    error: answer?.error ?? null,
    hasMore: Boolean(answer?.nextCursor),
    loadingMore,
    loadMore,
    mineAvailable: answer?.mineAvailable ?? false,
    outsideScope: answer?.outsideScope ?? 0,
  };
}
