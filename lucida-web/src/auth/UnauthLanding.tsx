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
}

export function UnauthLanding({ navigate, location }: UnauthLandingProps = {}) {
  // useRef + useEffect so a single AuthGate render produces exactly
  // one navigation. React 18+ in strict mode double-invokes effect
  // bodies; the ref guards against navigating twice.
  const navigatedRef = useRef(false);

  useEffect(() => {
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
  }, [navigate, location]);

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
