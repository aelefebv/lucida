import { useEffect, useState } from "react";
import { fetchDevAuthStatus } from "./whoami.ts";

/** Whether dev auth is on, so the account menu offers the dev-user switcher. */
export function useDevAuthEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void fetchDevAuthStatus().then((status) => {
      if (!cancelled) setEnabled(status.enabled);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return enabled;
}
