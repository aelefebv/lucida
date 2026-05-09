// Pure-function wrappers around the auth REST endpoints. Live outside
// the React hook so they're testable with a fake fetch and so future
// code (e.g. a manual "refresh auth" button) can call them without
// driving the hook.
//
// Slice 1 (issue #456) treats every non-200 from `/auth/whoami` as
// "not authenticated" and surfaces network errors the same way.
// Slice 3 (issue #459) adds `postLogout`. Both helpers swallow
// network errors deliberately — logout's user-visible promise is
// "you're signed out now," and the next whoami refresh will reveal
// that. The richer error model (provider-down vs. cookie-rejected)
// lands in slice 4 alongside the real error page.

import type { AuthPrincipal, AuthState } from "./types.ts";

// Relative paths so the browser sees a single origin (Vite dev proxies
// `/auth/*` to the backend in development; in production lucida-server
// serves the web bundle from the same origin). Cross-origin would
// silently break SameSite=Lax cookies.
export const WHOAMI_URL = "/auth/whoami";
export const LOGOUT_URL = "/auth/logout";

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Fetch the current principal. Resolves to an `AuthState` and never throws. */
export async function fetchAuthState(fetchImpl: FetchLike = fetch): Promise<AuthState> {
  let res: Response;
  try {
    res = await fetchImpl(WHOAMI_URL, { credentials: "include" });
  } catch {
    // Network failure: behave as unauthenticated rather than blocking
    // the app indefinitely. Slice 4 will distinguish "server unreachable"
    // from "session rejected".
    return { authenticated: false };
  }
  if (res.status === 200) {
    try {
      const principal = (await res.json()) as AuthPrincipal;
      return { authenticated: true, principal };
    } catch {
      return { authenticated: false };
    }
  }
  // 401 (or any other non-200): unauth. Server enriches the JSON body
  // with `signedOut: true` when the `lucida_signed_out` marker cookie
  // is present (post-logout). The cookie itself is HttpOnly so JS
  // can't read it; this is the SPA's only window into "did the user
  // just sign out?", which UnauthLanding uses to decide between
  // static-card and auto-bounce. Body parse failure (network blip,
  // older server) gracefully degrades to the cold-path branch.
  try {
    const body = (await res.json()) as { signedOut?: boolean };
    return { authenticated: false, signedOut: body.signedOut === true };
  } catch {
    return { authenticated: false };
  }
}

/**
 * POST `/auth/logout`. The server clears the session row and replies
 * 302 → `/`; fetch follows the redirect transparently. We pass
 * `redirect: "manual"` so the browser doesn't actually navigate the
 * SPA — the hook calls `fetchAuthState` after this resolves, which
 * flips us into the unauth branch without a full page reload.
 *
 * Resolves once the server has acknowledged. Swallows network
 * errors: even a network blip shouldn't leave the user stuck logged
 * in client-side. The follow-up whoami refresh will then either
 * surface "still authenticated" (server didn't get the message) or
 * "unauthenticated" (server did).
 */
export async function postLogout(fetchImpl: FetchLike = fetch): Promise<void> {
  try {
    await fetchImpl(LOGOUT_URL, {
      method: "POST",
      credentials: "include",
      redirect: "manual",
    });
  } catch {
    // Intentionally swallowed — see doc comment.
  }
}
