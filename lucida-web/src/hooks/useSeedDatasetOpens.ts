import { useEffect, useRef } from "react";

interface Params {
  /** Dataset URLs/paths to auto-open exactly once, once `ready` is true. The
   *  "create workspace from dataset(s)" seed (#697). Undefined / empty in the
   *  normal open-existing-workspace case, making this a no-op there. */
  initialDatasetUrls?: readonly string[];
  /** Gate: only fire once the underlying transport is GENUINELY ready to carry
   *  the open — i.e. the WebSocket session is established (open + snapshot),
   *  NOT merely that a `Bridge` object exists. The bridge's `send` silently
   *  drops frames sent before the socket is OPEN, so a premature `true` here
   *  loses the seed open with no error and no retry. Passing `false` defers;
   *  the effect re-checks (and fires) when it flips true. */
  ready: boolean;
  /** Opens a single dataset URL/path — the same path the in-viewer "Open" flow
   *  uses, so dedup, progress, and the open-failed error surface all apply. */
  openDataset: (url: string) => void;
}

/**
 * One-shot auto-open of seed datasets for the "create workspace from
 * dataset(s)" flow (#697).
 *
 * The workspace is created and navigated into BEFORE this runs; here we simply
 * open the seed dataset(s) once the transport is ready. Firing at most once per
 * mount (a guard ref) is the load-bearing property: a re-render — or a peer
 * command bumping unrelated state — must never re-open the datasets. Because the
 * workspace already exists and the user is already in it, a FAILED open is left
 * to the caller's existing open-failed UI and does NOT unwind the workspace.
 *
 * The one-shot guard latches ONLY AFTER the opens are actually issued: while
 * `ready` is false (transport still connecting) the effect is a pure no-op that
 * leaves the guard unset, so when `ready` finally flips true the open fires
 * exactly once. This is why the gate MUST be a real readiness signal — latching
 * on a premature `ready` would burn the single attempt against a CONNECTING
 * socket that drops the send (the #697 silent-drop race).
 */
export function useSeedDatasetOpens({
  initialDatasetUrls,
  ready,
  openDataset,
}: Params): void {
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) return;
    if (!ready) return;
    if (!initialDatasetUrls || initialDatasetUrls.length === 0) return;
    // Latch only after we're past every guard and about to send, so a deferral
    // (not ready / no seed yet) never consumes the one-shot.
    firedRef.current = true;
    for (const url of initialDatasetUrls) {
      openDataset(url);
    }
  }, [initialDatasetUrls, ready, openDataset]);
}
