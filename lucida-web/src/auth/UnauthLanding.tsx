// UnauthLanding — what AuthGate renders when whoami says
// "unauthenticated". Mirrors the inline HTML the server middleware
// returns for a fresh browser navigation, but this component runs
// inside the already-mounted React tree (e.g. after sign-out or when
// a session expires while the SPA is open).
//
// Behavior: capture `location.hash`, redirect to
// `/auth/start?path=…&hash=…`. The server's `/auth/start` then
// stashes intent + 302s to Google. After the round-trip, the
// browser lands at the originally-requested URL and AuthGate flips
// back to the authed branch.

import { useEffect, useRef } from "react";
import type { LogoutFailure } from "./whoami.ts";

/** Where /auth/start lives on the same origin. Relative — Vite dev
 *  proxies `/auth/*` to the backend; production serves the web bundle
 *  from the same origin as lucida-server. Cross-origin would break
 *  SameSite=Lax cookies on the resulting redirect chain. */
const AUTH_START_PATH = "/auth/start";

/** Empty so URLs build as `/auth/start?...` (browser resolves against
 *  current origin). Kept as a constant so tests can still find the
 *  path-portion via toContain. */
const SERVER_BASE = "";

/** Build the redirect URL. Exported so unit tests can verify the shape
 * without driving a navigation. Path always defaults to `/` if empty
 * so the server's intent-row is well-formed. */
// Co-located with the consumer; splitting to a sibling file would just
// add ceremony for one helper that exists for testability.
// eslint-disable-next-line react-refresh/only-export-components
export function buildSignInUrl(loc: {
  pathname: string;
  search: string;
  hash: string;
}): string {
  const pathAndQuery = (loc.pathname || "/") + (loc.search || "");
  // Strip leading '#' from hash so the server stores the bare value
  // (handler re-prefixes when reconstructing the redirect target).
  const hash = loc.hash.startsWith("#") ? loc.hash.slice(1) : loc.hash;
  const params = new URLSearchParams({ path: pathAndQuery, hash });
  return `${SERVER_BASE}${AUTH_START_PATH}?${params.toString()}`;
}

export interface UnauthLandingProps {
  /** Override the bounce target. Tests inject a recorder; production
   *  passes `undefined` and the component navigates `window.location`. */
  navigate?: (url: string) => void;
  /** Override `window.location` for tests. */
  location?: { pathname: string; search: string; hash: string };
  /** True when the marker-aware /auth/whoami response told us "the
   *  user just signed out." Suppresses the auto-bounce and renders
   *  a static "Sign in again" card so we don't immediately re-auth
   *  them via Google's still-active session. */
  signedOut?: boolean;
  /** A failed logout takes precedence over the ordinary signed-out card. */
  logoutFailure?: LogoutFailure;
}

export function UnauthLanding({
  navigate,
  location,
  signedOut,
  logoutFailure,
}: UnauthLandingProps = {}) {
  // useRef + useEffect so a single AuthGate render produces exactly
  // one navigation. React 18+ in strict mode double-invokes effect
  // bodies; the ref guards against navigating twice.
  const navigatedRef = useRef(false);

  useEffect(() => {
    if (signedOut || logoutFailure) return;
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    const loc = location ?? window.location;
    const url = buildSignInUrl(loc);
    if (navigate) {
      navigate(url);
    } else {
      // replace() so the unauth landing isn't a separate history
      // entry the user can hit back into.
      window.location.replace(url);
    }
  }, [navigate, location, signedOut, logoutFailure]);

  if (logoutFailure) {
    return (
      <SignOutFailureCard
        failure={logoutFailure}
        navigate={navigate}
        location={location}
      />
    );
  }

  if (signedOut) {
    return <SignedOutCard navigate={navigate} location={location} />;
  }

  return (
    <div
      style={{
        padding: "2rem",
        color: "var(--text-muted)",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      Redirecting to sign-in...
    </div>
  );
}

function SignOutFailureCard({
  failure,
  navigate,
  location,
}: {
  failure: LogoutFailure;
  navigate?: (url: string) => void;
  location?: { pathname: string; search: string; hash: string };
}) {
  const onSignIn = () => {
    const loc = location ?? window.location;
    const url = buildSignInUrl(loc);
    if (navigate) navigate(url);
    else window.location.assign(url);
  };
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--surface-1)",
        color: "var(--text-primary)",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div
        role="alert"
        style={{
          padding: "24px 32px",
          border: "1px solid var(--danger-border)",
          borderRadius: 8,
          background: "var(--surface-2)",
          maxWidth: 440,
        }}
      >
        <h1 style={{ marginTop: 0 }}>Sign-out incomplete</h1>
        <p>{failure.message}</p>
        {failure.localSession === "cleared" && (
          <p style={{ color: "var(--text-muted)" }}>
            This browser is locally signed out, but this is not confirmation
            that every copy of the session credential was revoked.
          </p>
        )}
        <p style={{ color: "var(--text-muted)" }}>
          {failure.retryable
            ? "If another authenticated session is available, retry there when the service recovers; otherwise contact an administrator."
            : "Contact an administrator before relying on this sign-out."}
        </p>
        <button type="button" onClick={onSignIn} style={signInButtonStyle}>
          Sign in again
        </button>
      </div>
    </div>
  );
}

/** Shown when /auth/whoami's enriched 401 indicated `signedOut: true`.
 *  Static — no auto-bounce. The user clicks "Sign in again" to
 *  re-enter the OAuth flow; the marker cookie is still set, so
 *  /auth/start adds prompt=select_account and Google shows the
 *  account chooser. */
function SignedOutCard({
  navigate,
  location,
}: {
  navigate?: (url: string) => void;
  location?: { pathname: string; search: string; hash: string };
}) {
  const onSignIn = () => {
    const loc = location ?? window.location;
    const url = buildSignInUrl(loc);
    if (navigate) navigate(url);
    else window.location.assign(url);
  };
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--surface-1)",
        color: "var(--text-primary)",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          padding: "24px 32px",
          border: "1px solid var(--border-strong)",
          borderRadius: 8,
          background: "var(--surface-2)",
          maxWidth: 360,
        }}
      >
        <h1 style={{ marginTop: 0 }}>Signed out</h1>
        <p style={{ color: "var(--text-muted)" }}>You've been signed out of lucida.</p>
        <button
          type="button"
          onClick={onSignIn}
          style={signInButtonStyle}
        >
          Sign in again
        </button>
      </div>
    </div>
  );
}

const signInButtonStyle = {
  marginTop: 8,
  padding: "8px 16px",
  background: "var(--accent-strong)",
  color: "var(--accent-contrast)",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  font: "inherit",
};
