// React hook wrapping the auth REST helpers. Mounted by `AuthGate` so
// the rest of the app sees only an authenticated principal (or the
// unauth landing).
//
// Slice 3 (issue #459) extends the slice-1 read-only hook with a
// `signOut` action used by the new ProfileMenu. The hook returns
// `{ state, refresh, signOut }`; AuthGate destructures `state` for
// gating and consumers in the authed subtree can pull `signOut` from
// context wired up later (or via prop drilling for now — only the
// ProfileMenu actually invokes it in this slice).

import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthState } from "./types.ts";
import { fetchAuthState, postLogout } from "./whoami.ts";

export interface AuthStateHandle {
  state: AuthState;
  /** Re-runs `/auth/whoami`; updates `state` to whatever it returns. */
  refresh: () => Promise<void>;
  /** POSTs `/auth/logout`, then refreshes whoami. The server has
   *  cleared the session and set the `lucida_signed_out` marker; the
   *  whoami refresh sees the marker via the enriched 401 body and
   *  flips state to `{ authenticated: false, signedOut: true }`. */
  signOut: () => Promise<void>;
}

export function useAuthState(): AuthStateHandle {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  // The mounted flag protects against a `setState` after unmount when
  // a slow logout/whoami round-trip races with React tearing the tree
  // down. Without it React 19 logs a warning and the next mount sees
  // a leaked listener.
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    const next = await fetchAuthState();
    if (mountedRef.current) setState(next);
  }, []);

  const signOut = useCallback(async () => {
    await postLogout();
    // The whoami refresh hits the marker-aware middleware, which
    // returns 401 + `signedOut: true`. AuthGate renders UnauthLanding
    // with `signedOut`, which shows the static "Signed out" card
    // instead of auto-bouncing through Google. No full reload — the
    // signal travels via the enriched whoami response.
    await refresh();
  }, [refresh]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  return { state, refresh, signOut };
}
