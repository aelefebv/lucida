// Top-level wrapper rendered above `<App />`. Drives `useAuthState`
// and gates the app until authentication resolves.
//
// Slice 1 (issue #456): the unauthenticated branch shows a placeholder
// "not signed in" screen — the real `UnauthLanding` (which captures
// `location.hash` and redirects to `/auth/start`) lands in slice 4.

import type { ReactNode } from "react";
import { useAuthState } from "./useAuthState.ts";

interface AuthGateProps {
  children: ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  const state = useAuthState();

  if ("status" in state && state.status === "loading") {
    return <AuthLoading />;
  }

  if (!("authenticated" in state) || !state.authenticated) {
    return <UnauthPlaceholder />;
  }

  return <>{children}</>;
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

// Placeholder for the slice-4 `UnauthLanding`. Kept intentionally
// minimal so it's obvious in code review that the real sign-in UX has
// not landed yet.
function UnauthPlaceholder() {
  return (
    <div style={{ padding: "2rem" }}>
      <h2>Not signed in</h2>
      <p>
        Sign-in flow has not been wired up yet. This placeholder lands in
        slice 1 of the auth project (issue #456); the real sign-in
        landing comes in slice 4.
      </p>
    </div>
  );
}
