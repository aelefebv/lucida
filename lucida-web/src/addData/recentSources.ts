import { normalize_dataset_url } from "lucida-core";
import {
  definePreference,
  getPreference,
  setPreference,
  usePreference,
} from "../theme/preferences.ts";

/** How many recent sources the add-data dialog keeps, newest first. */
export const RECENT_SOURCES_LIMIT = 5;

const NONE: readonly string[] = [];

/**
 * Sources this browser opened through Add data, as canonical URLs, newest
 * first. Per browser because a local path only means something on the
 * machine whose server reads it.
 */
export const recentSourcesPreference = definePreference<readonly string[]>(
  "addData.recent",
  NONE,
  (raw) =>
    Array.isArray(raw) && raw.every((entry) => typeof entry === "string")
      ? raw.slice(0, RECENT_SOURCES_LIMIT)
      : undefined,
);

/** `list` with `url` moved or added to the front, capped. */
export function withRecentSource(list: readonly string[], url: string): readonly string[] {
  return [url, ...list.filter((entry) => entry !== url)].slice(0, RECENT_SOURCES_LIMIT);
}

/**
 * Sources this page added to the list. The open's outcome arrives later and
 * names only the URL, so a failure takes back these alone and never drops an
 * entry an earlier visit earned.
 */
const addedThisPage = new Set<string>();

/** Record an open the user just asked for. `url` is canonical. */
export function rememberRecentSource(url: string): void {
  const list = getPreference(recentSourcesPreference);
  if (!list.includes(url)) addedThisPage.add(url);
  setPreference(recentSourcesPreference, withRecentSource(list, url));
}

export function forgetRecentSource(url: string): void {
  addedThisPage.delete(url);
  const list = getPreference(recentSourcesPreference);
  if (list.includes(url)) {
    setPreference(
      recentSourcesPreference,
      list.filter((entry) => entry !== url),
    );
  }
}

/**
 * A dataset open failed. A source this page put in the list leaves it again,
 * so a mistyped path never lingers as a recent dataset.
 */
export function noteSourceOpenFailed(url: string): void {
  const canonical = normalize_dataset_url(url);
  if (addedThisPage.has(canonical)) forgetRecentSource(canonical);
}

export function useRecentSources(): readonly string[] {
  return usePreference(recentSourcesPreference)[0];
}

/** What a source is called in a list: its last path segment. */
export function sourceName(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name || url;
}

/** Tests only. */
export function __resetRecentSourcesForTesting(): void {
  addedThisPage.clear();
}
