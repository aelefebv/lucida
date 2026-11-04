/**
 * The "restore my last view" toggle and the initial-view precedence for a bare
 * `/w/:id` open. The toggle defaults to on, so a flaky or unreadable store
 * never silently turns it off. `resolveInitialViewSource` is the one place the
 * precedence lives: a URL hash always beats the remembered last view.
 */

/** localStorage key for the toggle. Persisted, so it must stay stable across
 *  releases. */
export const RESTORE_LAST_VIEW_KEY = "lucida.restoreLastView";

/** The source the bootstrap should apply for a bare workspace open. */
export type InitialViewSource = "url" | "last-view" | "default" | "none";

/**
 * Whether the "restore my last view" toggle is on. Only a stored "false" or
 * "0" turns it off; a missing key, unreadable storage, or any other value reads
 * as on. Never throws.
 */
export function getRestoreLastViewEnabled(): boolean {
  if (typeof localStorage === "undefined") return true;
  let raw: string | null;
  try {
    raw = localStorage.getItem(RESTORE_LAST_VIEW_KEY);
  } catch {
    return true;
  }
  if (raw === null) return true;
  return raw !== "false" && raw !== "0";
}

/**
 * Persist the toggle. Storage failures are swallowed: the preference won't
 * survive a reload, which beats throwing out of a settings click.
 */
export function setRestoreLastViewEnabled(enabled: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(RESTORE_LAST_VIEW_KEY, enabled ? "true" : "false");
  } catch {
    // Best effort.
  }
}

/**
 * Which view a bare `/w/:id` open applies first: a URL hash, then the last
 * view when the toggle is on, then the workspace default, else none. Pure; the
 * bootstrap decides what to fetch from the verdict.
 */
export function resolveInitialViewSource({
  hasUrlHash,
  restoreEnabled,
  hasLastView,
  hasDefault,
}: {
  hasUrlHash: boolean;
  restoreEnabled: boolean;
  hasLastView: boolean;
  hasDefault: boolean;
}): InitialViewSource {
  if (hasUrlHash) return "url";
  if (restoreEnabled && hasLastView) return "last-view";
  if (hasDefault) return "default";
  return "none";
}
