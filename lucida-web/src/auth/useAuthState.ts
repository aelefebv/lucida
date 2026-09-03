// React hook wrapping the auth REST helpers. Mounted by `AuthGate` so
// the rest of the app sees only an authenticated principal (or the
// unauth landing).
//
// The hook returns `{ state, refresh, signOut }`. AuthGate
// destructures `state` for gating; consumers in the authed subtree
// can pull `signOut` (e.g. ProfileMenu) via prop drilling.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthState } from "./types.ts";
import { fetchAuthState, fetchSignOutUrl, postSignOut } from "./whoami.ts";

export interface AuthStateHandle {
  state: AuthState;
  /** Re-runs `/auth/whoami`; updates `state` to whatever it returns. */
  refresh: () => Promise<void>;
  /** POSTs the mode's sign-out URL, then refreshes whoami. Under
   *  Google the server has cleared the session and set the
   *  `lucida_signed_out` marker; the whoami refresh sees the marker
   *  via the enriched 401 body and flips state to
   *  `{ authenticated: false, signedOut: true }`.
   *
   *  Null until `/auth/mode` answers, and null for good if it answers
   *  with no URL or never answers. Callers render their sign-out
   *  control off this. */
  signOut: (() => Promise<void>) | null;
}

export function useAuthState(): AuthStateHandle {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  // Starts null so the sign-out control stays hidden while
  // `/auth/mode` is in flight, rather than flickering in and out for a
  // mode that has none.
  const [signOutUrl, setSignOutUrl] = useState<string | null>(null);
  // The mounted flag protects against a `setState` after unmount when
  // a slow sign-out/whoami round-trip races with React tearing the
  // tree down. Without it React 19 logs a warning and the next mount
  // sees a leaked listener.
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    const next = await fetchAuthState();
    if (mountedRef.current) setState(next);
  }, []);

  const signOut = useCallback(async () => {
    if (!signOutUrl) return;
    await postSignOut(signOutUrl);
    // The whoami refresh hits the marker-aware middleware, which
    // returns 401 + `signedOut: true`. AuthGate renders UnauthLanding
    // with `signedOut`, which shows the static "Signed out" card
    // instead of auto-bouncing through Google. No full reload — the
    // signal travels via the enriched whoami response.
    await refresh();
  }, [refresh, signOutUrl]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  // The mode's answer is fixed for the life of the server, so one read
  // settles it. A read that fails leaves the control hidden until the
  // page reloads, which beats showing one the mode may not have.
  useEffect(() => {
    let cancelled = false;
    void fetchSignOutUrl().then(
      (url) => {
        if (!cancelled) setSignOutUrl(url);
      },
      () => {
        // Nothing to record. `signOutUrl` is already null.
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return { state, refresh, signOut: signOutUrl === null ? null : signOut };
}
