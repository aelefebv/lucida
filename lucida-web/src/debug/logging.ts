/**
 * Debug logging registry: the enabled categories, kept as a preference. There
 * is no UI: set `localStorage.debug = 'bridge,cache'` (or `'*'`) and reload,
 * and the page moves it into the preference.
 *
 * `isDebugEnabled` sits on hot paths, so it reads a set cached in memory and
 * refreshed when preferences change, here or in another tab.
 */

import type { ResidencyTier } from "../pipeline/residencyTier.ts";
import {
  definePreference,
  getPreference,
  migrateLegacyKeys,
  setPreference,
  subscribePreferences,
  type Preference,
} from "../theme/preferences.ts";

export const DEBUG_CATEGORIES = ["bridge", "wasm", "render", "cache", "orch"] as const;
export type DebugCategory = (typeof DEBUG_CATEGORIES)[number];

/** A list of the names in `known`; unknown names are dropped rather than failing the whole list. */
function namesPreference<const N extends string>(
  key: string,
  known: readonly N[],
): Preference<readonly N[]> {
  return definePreference<readonly N[]>(key, [], (raw) =>
    Array.isArray(raw) ? known.filter((name) => raw.includes(name)) : undefined,
  );
}

function commaList(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export const debugCategoriesPreference = namesPreference("debug.categories", DEBUG_CATEGORIES);

migrateLegacyKeys(
  (key) => key === "debug",
  (old) => {
    for (const raw of old.values()) {
      const categories = raw.trim() === "*" ? DEBUG_CATEGORIES : debugCategoriesPreference.parse(commaList(raw));
      setPreference(debugCategoriesPreference, categories ?? []);
    }
  },
);

let enabledCategories: ReadonlySet<string> = new Set(getPreference(debugCategoriesPreference));

export function isDebugEnabled(category: DebugCategory): boolean {
  return enabledCategories.has(category);
}

/** Turn on exactly `categories`, persisting the choice. */
export function setDebugCategories(categories: readonly DebugCategory[]): void {
  setPreference(debugCategoriesPreference, categories);
}

export function getEnabledCategories(): DebugCategory[] {
  return DEBUG_CATEGORIES.filter(c => enabledCategories.has(c));
}

type ChangeListener = (enabled: DebugCategory[]) => void;
const listeners = new Set<ChangeListener>();

/** For consumers, like the WASM module, that hold their own copy of the set. */
export function onDebugCategoriesChanged(fn: ChangeListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notifyListeners(): void {
  const enabled = getEnabledCategories();
  for (const fn of listeners) fn(enabled);
}

/**
 * Generic gated logger. Use category-specialized helpers (`bridgeLog`)
 * when one exists; reach for this when no helper applies (e.g. render
 * loop events that don't ride on the bridge).
 */
export function debugLog(category: DebugCategory, event: string, data: Record<string, unknown> = {}): void {
  if (!isDebugEnabled(category)) return;
  console.log(`[${category}] ${event}`, data);
}

// Overlays are visual debug layers drawn over the canvas, not log channels.
// Kept parallel to the category system on purpose: same shape (toggle +
// listener), different semantics (no console output, no WASM push-down,
// no `*` shorthand).

export const DEBUG_OVERLAYS = [
  "groupModes",
  "chunkGrid",
  "chunkTier",
  "renderRadius",
  "cachedTier",
  "plannedRank",
  "phaseColor",
  "churnTint",
] as const;
export type DebugOverlay = (typeof DEBUG_OVERLAYS)[number];

export const debugOverlaysPreference = namesPreference("debug.overlays", DEBUG_OVERLAYS);

migrateLegacyKeys(
  (key) => key === "debug.overlays",
  (old) => {
    for (const raw of old.values()) {
      setPreference(debugOverlaysPreference, debugOverlaysPreference.parse(commaList(raw)) ?? []);
    }
  },
);

// `isOverlayEnabled` is polled from render (App decides whether to mount the
// overlay layer), so it stays a pure in-memory read like the category gate.
let enabledOverlays: ReadonlySet<string> = new Set(getPreference(debugOverlaysPreference));

export function isOverlayEnabled(name: DebugOverlay): boolean {
  return enabledOverlays.has(name);
}

export function setOverlayEnabled(name: DebugOverlay, enabled: boolean): void {
  const current = new Set(enabledOverlays);
  if (enabled) current.add(name);
  else current.delete(name);
  setPreference(
    debugOverlaysPreference,
    DEBUG_OVERLAYS.filter((overlay) => current.has(overlay)),
  );
}

const overlayListeners = new Set<() => void>();

export function onOverlaysChanged(fn: () => void): () => void {
  overlayListeners.add(fn);
  return () => {
    overlayListeners.delete(fn);
  };
}

// The store returns the same array until a value changes, so comparing
// references finds the changes without re-reading every list.
let seenCategories = getPreference(debugCategoriesPreference);
let seenOverlays = getPreference(debugOverlaysPreference);
subscribePreferences(() => {
  const categories = getPreference(debugCategoriesPreference);
  if (categories !== seenCategories) {
    seenCategories = categories;
    enabledCategories = new Set(categories);
    notifyListeners();
  }
  const overlays = getPreference(debugOverlaysPreference);
  if (overlays !== seenOverlays) {
    seenOverlays = overlays;
    enabledOverlays = new Set(overlays);
    for (const fn of overlayListeners) fn();
  }
});

let renderRadiusPreviewTier: ResidencyTier | null = null;
const renderRadiusPreviewListeners = new Set<() => void>();

export function getRenderRadiusPreviewTier(): ResidencyTier | null {
  return renderRadiusPreviewTier;
}

export function setRenderRadiusPreviewTier(tier: ResidencyTier | null): void {
  if (renderRadiusPreviewTier === tier) return;
  renderRadiusPreviewTier = tier;
  for (const fn of renderRadiusPreviewListeners) fn();
}

export function onRenderRadiusPreviewChanged(fn: () => void): () => void {
  renderRadiusPreviewListeners.add(fn);
  return () => {
    renderRadiusPreviewListeners.delete(fn);
  };
}
