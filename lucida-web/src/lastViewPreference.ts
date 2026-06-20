/**
 * "Remember my last view per workspace" preference + initial-view priority
 * (issue #700).
 *
 * Two concerns live here, deliberately kept tiny and dependency-free so they
 * are trivially unit-testable and reusable from the urlSync bootstrap:
 *
 *   1. A browser-local **user toggle** ("Restore my last view"), persisted in
 *      `localStorage`. It defaults to **on**: a brand-new browser, an
 *      unreadable store (SSR / private browsing / quota), or a corrupt value
 *      all read back as enabled, so the restore behavior is the out-of-the-box
 *      default and a flaky store never silently turns it off. Only an explicit
 *      stored "off" disables it.
 *
 *   2. The **pure priority function** `resolveInitialViewSource`, the single
 *      source of truth for "what should a bare `/w/:id` open apply first?":
 *      a URL hash (`#view=` / `#b=`) ALWAYS wins; otherwise the per-user last
 *      view iff the toggle is on AND one exists; otherwise the shared
 *      workspace default iff present; otherwise nothing. Keeping it pure means
 *      the bootstrap wiring and the tests agree on the precedence by
 *      construction — the invariant ("a URL hash always overrides the
 *      remembered last view", "recording/remembering never promotes to the
 *      shared default") is enforced in one readable place.
 */

/** localStorage key for the per-user "restore my last view" toggle. The exact
 *  string is part of the persisted contract — a returning browser reads back
 *  whatever is stored here, so it must stay stable across releases. */
export const RESTORE_LAST_VIEW_KEY = "lucida.restoreLastView";

/** The source the bootstrap should apply for a bare workspace open. */
export type InitialViewSource = "url" | "last-view" | "default" | "none";

/**
 * Whether the per-user "restore my last view" toggle is on.
 *
 * Contract:
 *  - **defaults to `true`** — absent key, unreadable/throwing storage, or any
 *    unrecognized value all yield `true`;
 *  - returns `false` ONLY when an explicit "off" value ("false" / "0") was
 *    stored by {@link setRestoreLastViewEnabled}.
 *
 * Never throws: a missing/throwing `localStorage` degrades to the default-on
 * behavior rather than crashing the workspace bootstrap.
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
  // Only an explicit, recognized "off" disables it; everything else is on.
  return raw !== "false" && raw !== "0";
}

/**
 * Persist the per-user "restore my last view" toggle. Stores the canonical
 * "true"/"false" strings that {@link getRestoreLastViewEnabled} reads back.
 * Swallows storage failures (quota / private browsing): the preference simply
 * won't survive a reload, which still beats throwing out of a settings click.
 */
export function setRestoreLastViewEnabled(enabled: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(RESTORE_LAST_VIEW_KEY, enabled ? "true" : "false");
  } catch {
    // ignore — best effort.
  }
}

/**
 * Pure priority resolver for the initial view on a bare `/w/:id` open.
 *
 * Precedence (highest first):
 *   1. `"url"`       — a `#view=`/`#b=` hash is present (`hasUrlHash`). A URL
 *                      hash ALWAYS wins, regardless of the toggle or any
 *                      remembered/default view.
 *   2. `"last-view"` — no hash, the toggle is on AND the member has a
 *                      remembered last view (`restoreEnabled && hasLastView`).
 *   3. `"default"`   — no hash, no eligible last view, but the workspace has a
 *                      shared default (`hasDefault`).
 *   4. `"none"`      — nothing to apply.
 *
 * No side effects, no I/O — the bootstrap decides what to *fetch/apply* from
 * this verdict.
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
