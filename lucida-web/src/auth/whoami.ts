// Pure-function wrappers around the auth REST endpoints. Live outside
// the React hook so they're testable with a fake fetch and so future
// code (e.g. a manual "refresh auth" button) can call them without
// driving the hook.
//
// `/auth/whoami` degrades to unauthenticated on transport failure. Logout is
// intentionally stricter: a 503 means this browser's cookie was cleared but
// durable credential deletion failed, which must remain visible to the user.

import type { AuthPrincipal, AuthState } from "./types.ts";

// Relative paths so the browser sees a single origin (Vite dev proxies
// `/auth/*` to the backend in development; in production lucida-server
// serves the web bundle from the same origin). Cross-origin would
// silently break SameSite=Lax cookies.
export const WHOAMI_URL = "/auth/whoami";
export const LOGOUT_URL = "/auth/logout";
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

export type LogoutFailureKind = "partial_signout" | "request_failed";

/** Stable UI-facing description of a failed sign-out attempt. */
export interface LogoutFailure {
  kind: LogoutFailureKind;
  message: string;
  retryable: boolean;
  localSession: "cleared" | "unknown";
  status?: number;
}

/** Typed transport error thrown by `postLogout` and preserved by the hook. */
export class LogoutRequestError extends Error {
  readonly failure: LogoutFailure;

  constructor(failure: LogoutFailure, options?: ErrorOptions) {
    super(failure.message, options);
    this.name = "LogoutRequestError";
    this.failure = failure;
  }
}

export function logoutFailureFrom(error: unknown): LogoutFailure {
  if (error instanceof LogoutRequestError) return error.failure;
  return {
    kind: "request_failed",
    message: "Lucida could not confirm sign-out. Your session may still be active.",
    retryable: true,
    localSession: "unknown",
  };
}

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
 * POST `/auth/logout`. The server clears the session row and replies
 * 302 → `/`; fetch follows the redirect transparently. We pass
 * `redirect: "manual"` so the browser doesn't actually navigate the
 * SPA — the hook calls `fetchAuthState` after this resolves, which
 * flips us into the unauth branch without a full page reload.
 *
 * Resolves only when the server acknowledges successful durable revocation.
 * A 503 is a partial sign-out: Set-Cookie has cleared this browser's local
 * session, but the stored credential may remain usable if it was copied.
 * Transport and other HTTP failures are typed so the hook can refresh the
 * observed auth state without discarding the failure.
 */
export async function postLogout(fetchImpl: FetchLike = fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(LOGOUT_URL, {
      method: "POST",
      credentials: "include",
      redirect: "manual",
    });
  } catch (cause) {
    throw new LogoutRequestError(
      {
        kind: "request_failed",
        message: "Lucida could not reach the server to confirm sign-out. Try again.",
        retryable: true,
        localSession: "unknown",
      },
      { cause },
    );
  }

  // Manual redirects appear as either their 3xx status or an opaque redirect,
  // depending on the browser. Both are the successful logout contract.
  if (
    response.ok ||
    (response.status >= 300 && response.status < 400) ||
    response.type === "opaqueredirect"
  ) {
    return;
  }

  if (response.status === 503) {
    throw new LogoutRequestError({
      kind: "partial_signout",
      message:
        "This browser's local session was cleared, but lucida could not remove the stored session. A copied session credential may still work.",
      retryable: true,
      localSession: "cleared",
      status: response.status,
    });
  }

  throw new LogoutRequestError({
    kind: "request_failed",
    message: "Lucida could not complete sign-out. Your session may still be active.",
    retryable: response.status >= 500,
    localSession: "unknown",
    status: response.status,
  });
}

export async function fetchDevAuthStatus(fetchImpl: FetchLike = fetch): Promise<DevAuthStatus> {
  const disabled: DevAuthStatus = {
    enabled: false,
    default_principal: {
      email: "dev@local",
      display_name: "Local Dev",
      picture_url: null,
      is_admin: true,
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
