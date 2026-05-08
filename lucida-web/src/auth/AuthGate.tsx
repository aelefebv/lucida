// Top-level wrapper rendered above `<App />`. Drives `useAuthState`
// and gates the app until authentication resolves.
//
// Slice 4 (issue #460) replaces the slice-1 `UnauthPlaceholder` with
// the real `UnauthLanding`, which mirrors the inline HTML the server
// middleware returns for fresh browser navigations: capture
// `location.hash`, redirect to `/auth/start`. This branch only fires
// when the SPA is already mounted and whoami flips to unauth (e.g.
// the user signed out, or their session expired in the open tab).
// Cold-start unauth is handled server-side before React boots.
//
// Slice 3 (issue #459): publishes the resolved principal and the
// `signOut` action through `AuthSessionContext` so the new
// `ProfileMenu` (and any future authed-subtree consumer) can read
// them without prop-drilling.

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
    return <UnauthLanding />;
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
