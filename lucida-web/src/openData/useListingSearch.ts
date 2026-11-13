import { useCallback, useEffect, useRef, useState } from "react";
import { searchListings, type ListingResult } from "./listingsApi.ts";

/** How long typing pauses before a search goes out. */
export const SEARCH_DEBOUNCE_MS = 150;

export interface ListingSearch {
  results: readonly ListingResult[];
  /** The query `results` answer, or null before the first answer. */
  answered: string | null;
  /** Why the last search failed, or null. */
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
}

interface Answer {
  q: string;
  results: readonly ListingResult[];
  nextCursor: string | null;
  error: string | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The server's answer to `q`, a page at a time. A newer query cancels an
 * older one's request, so an answer never lands for a query no longer typed.
 * Until the first answer for `q` arrives, the last answer stays, for the
 * caller to show as out of date rather than blank.
 */
export function useListingSearch(q: string): ListingSearch {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const moreRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    // The empty query is the first one a dialog asks, and nobody is typing it.
    const timer = setTimeout(
      () => {
        searchListings({ q }, signal).then(
          (page) => {
            if (!signal.aborted) setAnswer({ q, results: page.results, nextCursor: page.next_cursor, error: null });
          },
          (error: unknown) => {
            if (!signal.aborted) setAnswer({ q, results: [], nextCursor: null, error: messageOf(error) });
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
  }, [q]);

  const loadMore = useCallback(() => {
    if (!answer?.nextCursor || answer.q !== q || moreRequest.current) return;
    const cursor = answer.nextCursor;
    const controller = new AbortController();
    const { signal } = controller;
    moreRequest.current = controller;
    setLoadingMore(true);
    searchListings({ q, cursor }, signal)
      .then(
        (page) => {
          if (signal.aborted) return;
          setAnswer((current) =>
            current && current.q === q && current.nextCursor === cursor
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
  }, [answer, q]);

  return {
    results: answer?.results ?? [],
    answered: answer?.q ?? null,
    error: answer?.error ?? null,
    hasMore: Boolean(answer?.nextCursor),
    loadingMore,
    loadMore,
  };
}
