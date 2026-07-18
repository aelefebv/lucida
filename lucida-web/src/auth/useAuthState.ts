// React hook wrapping the auth REST helpers. Mounted by `AuthGate` so
// the rest of the app sees only an authenticated principal (or the
// unauth landing).
//
// The hook returns `{ state, refresh, signOut }`. AuthGate
// destructures `state` for gating; consumers in the authed subtree
// can pull `signOut` (e.g. ProfileMenu) via prop drilling.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthState } from "./types.ts";
import {
  fetchAuthState,
  logoutFailureFrom,
  postLogout,
  type LogoutFailure,
} from "./whoami.ts";

export interface AuthStateHandle {
  state: AuthState;
  /** Last sign-out failure, preserved across the follow-up whoami refresh. */
  logoutFailure: LogoutFailure | null;
  /** Re-runs `/auth/whoami`; updates `state` to whatever it returns. */
  refresh: () => Promise<void>;
  /** POSTs `/auth/logout`, then refreshes whoami. The server has
   *  cleared the session and set the `lucida_signed_out` marker; the
   *  whoami refresh sees the marker via the enriched 401 body and
   *  flips state to `{ authenticated: false, signedOut: true }`. */
  signOut: () => Promise<boolean>;
}

export function useAuthState(): AuthStateHandle {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [logoutFailure, setLogoutFailure] = useState<LogoutFailure | null>(null);
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
    setLogoutFailure(null);
    try {
      await postLogout();
    } catch (error) {
      const failure = logoutFailureFrom(error);
      // Always refresh the observed auth state: on a 503 the local cookie was
      // cleared even though durable deletion failed; on a transport error the
      // request may or may not have reached the server. Preserve the typed
      // failure after that refresh instead of declaring signed-out success.
      await refresh();
      if (mountedRef.current) setLogoutFailure(failure);
      return false;
    }
    // The whoami refresh hits the marker-aware middleware, which
    // returns 401 + `signedOut: true`. AuthGate renders UnauthLanding
    // with `signedOut`, which shows the static "Signed out" card
    // instead of auto-bouncing through Google. No full reload — the
    // signal travels via the enriched whoami response.
    await refresh();
    return true;
  }, [refresh]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  return { state, logoutFailure, refresh, signOut };
}
