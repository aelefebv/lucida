// React hook wrapping `fetchAuthState`. Mounted by `AuthGate` so the
// rest of the app sees only an authenticated principal (or the unauth
// landing).

import { useEffect, useState } from "react";
import type { AuthState } from "./types.ts";
import { fetchAuthState } from "./whoami.ts";

export function useAuthState(): AuthState {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetchAuthState().then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
