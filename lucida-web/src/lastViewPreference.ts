/**
 * The "restore my last view" toggle and the initial-view precedence for a bare
 * `/w/:id` open. The toggle defaults to on, so a flaky or unreadable store
 * never silently turns it off. `resolveInitialViewSource` is the one place the
 * precedence lives: a URL hash always beats the remembered last view.
 */

import {
  booleanPreference,
  getPreference,
  migrateLegacyKeys,
  setPreference,
} from "./theme/preferences.ts";

export const restoreLastViewPreference = booleanPreference("viewer.restoreLastView", true);

migrateLegacyKeys(
  (key) => key === "lucida.restoreLastView",
  (old) => {
    // Only "false" or "0" ever turned it off.
    for (const raw of old.values()) setPreference(restoreLastViewPreference, raw !== "false" && raw !== "0");
  },
);

/** The source the bootstrap should apply for a bare workspace open. */
export type InitialViewSource = "url" | "last-view" | "default" | "none";

/** Whether the "restore my last view" toggle is on. */
export function getRestoreLastViewEnabled(): boolean {
  return getPreference(restoreLastViewPreference);
}

export function setRestoreLastViewEnabled(enabled: boolean): void {
  setPreference(restoreLastViewPreference, enabled);
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
