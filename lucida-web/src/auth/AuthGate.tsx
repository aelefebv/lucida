// Top-level wrapper rendered above `<App />`. Drives `useAuthState`
// and gates the app until authentication resolves.
//
// `UnauthLanding` mirrors the inline HTML the server middleware
// returns for fresh browser navigations: capture `location.hash`,
// redirect to `/auth/start`. This branch only fires when the SPA is
// already mounted and whoami flips to unauth (e.g. the user signed
// out, or their session expired in the open tab). Cold-start unauth
// is handled server-side before React boots.
//
// The resolved principal and the `signOut` action are published via
// `AuthSessionContext` so the authed-subtree (ProfileMenu, future
// consumers) can read them without prop-drilling.

import type { ReactNode } from "react";
import { AuthSessionContext } from "./AuthSession.ts";
import { UnauthLanding } from "./UnauthLanding.tsx";
import { useAuthState } from "./useAuthState.ts";

interface AuthGateProps {
  children: ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  const { state, signOut } = useAuthState();

  if ("status" in state && state.status === "loading") {
    return <AuthLoading />;
  }

  if (!("authenticated" in state) || !state.authenticated) {
    // `signedOut` rides the enriched /auth/whoami 401 response from
    // the marker-aware middleware. UnauthLanding renders a static
    // "Signed out — Sign in again" card when set; auto-bounces
    // otherwise (cold visit / session expiry mid-tab).
    const signedOut = "signedOut" in state && state.signedOut === true;
    return <UnauthLanding signedOut={signedOut} />;
  }

  return (
    <AuthSessionContext.Provider value={{ principal: state.principal, signOut }}>
      {children}
    </AuthSessionContext.Provider>
  );
}

// Minimal "checking auth" screen. The whoami probe is fast on the
// happy path so this is rarely visible.
function AuthLoading() {
  return (
    <div style={{ padding: "2rem", color: "#888" }}>
      Checking authentication...
    </div>
  );
}
