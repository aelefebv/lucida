// Pure-function wrappers around the auth REST endpoints. Live outside
// the React hook so they're testable with a fake fetch and so future
// code (e.g. a manual "refresh auth" button) can call them without
// driving the hook.
//
// Most of these swallow network errors deliberately — every non-200
// from `/auth/whoami` is treated as "not authenticated", and
// sign-out's user-visible promise is "you're signed out now," with the
// next whoami refresh revealing the truth. `fetchSignOutUrl` is the
// exception.

import type { AuthPrincipal, AuthState } from "./types.ts";

// Relative paths so the browser sees a single origin (Vite dev proxies
// `/auth/*` to the backend in development; in production lucida-server
// serves the web bundle from the same origin). Cross-origin would
// silently break SameSite=Lax cookies.
//
// No sign-out URL here: the auth mode declares it, and the client
// reads it from `/auth/mode`.
export const WHOAMI_URL = "/auth/whoami";
export const AUTH_MODE_URL = "/auth/mode";
export const DEV_AUTH_STATUS_URL = "/auth/dev/status";
export const DEV_LOGIN_URL = "/auth/dev/login";

export interface DevAuthStatus {
  enabled: boolean;
  default_principal: AuthPrincipal;
}

export interface DevLoginRequest {
  email: string;
  display_name?: string;
  is_admin?: boolean;
}

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
    // the app indefinitely. We don't yet distinguish "server
    // unreachable" from "session rejected" here.
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
 * Ask the server where sign-out goes. Resolves to the URL, or to
 * `null` when the configured auth mode has nothing to sign out of.
 *
 * Unlike its neighbors here, this one rejects rather than swallowing
 * a failed call, so a call that never landed cannot pass itself off
 * as the mode saying it has no sign-out. Both leave the control
 * hidden today, but only one of them is the mode's verdict.
 */
export async function fetchSignOutUrl(fetchImpl: FetchLike = fetch): Promise<string | null> {
  const res = await fetchImpl(AUTH_MODE_URL, { credentials: "include" });
  if (!res.ok) throw new Error(`GET ${AUTH_MODE_URL}: ${res.status}`);
  const body = (await res.json()) as { sign_out_url?: string | null };
  return typeof body.sign_out_url === "string" ? body.sign_out_url : null;
}

/**
 * POST the sign-out URL `fetchSignOutUrl` returned. Under Google that
 * is `/auth/logout`, which clears the session row and replies 302 →
 * `/`. Under IAP it is the perimeter's own cookie-clearing URL, which
 * this server never sees. Either way we pass `redirect: "manual"` so
 * the browser doesn't actually navigate the SPA — the cookie the
 * response clears still lands, and the hook calls `fetchAuthState`
 * after this resolves, which flips us into the unauth branch without a
 * full page reload.
 *
 * Resolves once the server has acknowledged. Swallows network
 * errors: even a network blip shouldn't leave the user stuck logged
 * in client-side. The follow-up whoami refresh will then either
 * surface "still authenticated" (server didn't get the message) or
 * "unauthenticated" (server did).
 */
export async function postSignOut(
  url: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  try {
    await fetchImpl(url, {
      method: "POST",
      credentials: "include",
      redirect: "manual",
    });
  } catch {
    // Intentionally swallowed — see doc comment.
  }
}

export async function fetchDevAuthStatus(fetchImpl: FetchLike = fetch): Promise<DevAuthStatus> {
  const disabled: DevAuthStatus = {
    enabled: false,
    default_principal: {
      email: "dev@local",
      display_name: "Local Dev",
      picture_url: null,
      is_admin: false,
    },
  };
  try {
    const res = await fetchImpl(DEV_AUTH_STATUS_URL, { credentials: "include" });
    if (!res.ok) return disabled;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return disabled;
    return (await res.json()) as DevAuthStatus;
  } catch {
    return disabled;
  }
}

export async function postDevLogin(
  body: DevLoginRequest,
  fetchImpl: FetchLike = fetch,
): Promise<AuthPrincipal> {
  const res = await fetchImpl(DEV_LOGIN_URL, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const payload = await res.json();
      detail = payload.detail || payload.error || detail;
    } catch {
      // Keep status text.
    }
    throw new Error(detail);
  }
  return (await res.json()) as AuthPrincipal;
}
