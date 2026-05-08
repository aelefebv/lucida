// Pure-function wrapper around `GET /auth/whoami`. Lives outside the
// React hook so it's testable with a fake fetch and so future code
// (e.g. a manual "refresh auth" button) can call it without driving
// the hook.
//
// Slice 1 (issue #456) treats every non-200 as "not authenticated"
// and surfaces network errors the same way. The richer error model
// (provider-down vs. cookie-rejected) lands in slice 4 alongside the
// real error page.

import type { AuthPrincipal, AuthState } from "./types.ts";

export const WHOAMI_URL = "http://localhost:9876/auth/whoami";

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
  return { authenticated: false };
}
