// AuthSession context — separated from `AuthGate.tsx` so the
// component file only exports components (satisfies the
// react-refresh/only-export-components lint rule).
//
// The provider lives in AuthGate; consumers import `useAuthSession`
// from here.

import { createContext, useContext } from "react";
import type { AuthPrincipal } from "./types.ts";

/**
 * Provided to the authed subtree by `<AuthGate>`. `principal` is
 * non-null because the gate only renders the provider on the authed
 * branch.
 */
export interface AuthSession {
  principal: AuthPrincipal;
  signOut: () => Promise<void>;
}

export const AuthSessionContext = createContext<AuthSession | null>(null);

/** Hook for components inside the authed subtree. Throws if no provider. */
export function useAuthSession(): AuthSession {
  const ctx = useContext(AuthSessionContext);
  if (!ctx) {
    throw new Error(
      "useAuthSession must be used inside <AuthGate>'s authenticated subtree",
    );
  }
  return ctx;
}
