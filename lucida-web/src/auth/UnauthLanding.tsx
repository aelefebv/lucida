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
//
// Slice 4 (issue #460). Replaces slice 1's `UnauthPlaceholder` stub.

import { useEffect, useRef } from "react";

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
}

export function UnauthLanding({ navigate, location, signedOut }: UnauthLandingProps = {}) {
  // useRef + useEffect so a single AuthGate render produces exactly
  // one navigation. React 18+ in strict mode double-invokes effect
  // bodies; the ref guards against navigating twice.
  const navigatedRef = useRef(false);

  useEffect(() => {
    if (signedOut) return;
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
  }, [navigate, location, signedOut]);

  if (signedOut) {
    return <SignedOutCard navigate={navigate} location={location} />;
  }

  return (
    <div
      style={{
        padding: "2rem",
        color: "#aaa",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      Redirecting to sign-in...
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
        background: "#1a1a1f",
        color: "#eee",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          padding: "24px 32px",
          border: "1px solid #444",
          borderRadius: 8,
          background: "#22222a",
          maxWidth: 360,
        }}
      >
        <h1 style={{ marginTop: 0 }}>Signed out</h1>
        <p style={{ color: "#aaa" }}>You've been signed out of lucida.</p>
        <button
          type="button"
          onClick={onSignIn}
          style={{
            marginTop: 8,
            padding: "8px 16px",
            background: "#646cff",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            cursor: "pointer",
            font: "inherit",
          }}
        >
          Sign in again
        </button>
      </div>
    </div>
  );
}
