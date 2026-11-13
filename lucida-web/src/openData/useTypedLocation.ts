import { useEffect, useMemo, useState } from "react";
import { initWasmOnce } from "../wasmInit.ts";
import { resolveListing, type Listing } from "./listingsApi.ts";
import type { TypedLocation } from "./openRows.ts";
import { checkSource, looksLikeLocation } from "./sourceInput.ts";
import { SEARCH_DEBOUNCE_MS } from "./useListingSearch.ts";

/**
 * What `text` names when it reads as a location: checked by the server's own
 * location parse through the wasm build, and looked up among the listings
 * once it checks out. A listing it names lends its title, and its URL, which
 * is the form every other open of that dataset uses. Null for search words.
 */
export function useTypedLocation(text: string): TypedLocation | null {
  // The dashboard has no viewer to have loaded the wasm build already.
  const [wasmReady, setWasmReady] = useState(false);
  const [resolved, setResolved] = useState<{ url: string; listing: Listing | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void initWasmOnce().then(() => {
      if (!cancelled) setWasmReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const check = useMemo(
    () => (wasmReady && looksLikeLocation(text) ? checkSource(text) : null),
    [text, wasmReady],
  );
  const url = check?.kind === "ok" ? check.url : null;

  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    const { signal } = controller;
    const timer = setTimeout(() => {
      resolveListing(url, signal).then(
        (listing) => {
          if (!signal.aborted) setResolved({ url, listing });
        },
        // A failed lookup only costs the title; the URL still opens.
        () => {},
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [url]);

  if (!looksLikeLocation(text)) return null;
  const listing = resolved && resolved.url === url ? resolved.listing : null;
  return {
    raw: text.trim(),
    url: listing?.url ?? url,
    problem: check?.kind === "rejected" ? check.message : null,
    title: listing?.title ?? null,
  };
}
