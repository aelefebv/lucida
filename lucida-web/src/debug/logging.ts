/**
 * Debug logging registry. Single source of truth for enabled categories,
 * persisted in `localStorage.debug` as a comma-separated list (or `*` for
 * all). See `wiki/decisions/logging-conventions.md`.
 */

export const DEBUG_CATEGORIES = ["bridge", "wasm", "render", "cache", "orch"] as const;
export type DebugCategory = (typeof DEBUG_CATEGORIES)[number];

function readEnabled(): Set<string> {
  if (typeof localStorage === "undefined") return new Set();
  const raw = localStorage.getItem("debug");
  if (!raw) return new Set();
  if (raw === "*") return new Set(DEBUG_CATEGORIES);
  return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
}

export function isDebugEnabled(category: DebugCategory): boolean {
  return readEnabled().has(category);
}

export function setDebugEnabled(category: DebugCategory, enabled: boolean): void {
  if (typeof localStorage === "undefined") return;
  const current = readEnabled();
  if (enabled) current.add(category);
  else current.delete(category);
  if (current.size === 0) {
    localStorage.removeItem("debug");
  } else {
    localStorage.setItem("debug", Array.from(current).join(","));
  }
  notifyListeners();
}

export function getEnabledCategories(): DebugCategory[] {
  const enabled = readEnabled();
  return DEBUG_CATEGORIES.filter(c => enabled.has(c));
}

type ChangeListener = (enabled: DebugCategory[]) => void;
const listeners = new Set<ChangeListener>();

/**
 * Subscribe to category-change events. Used by consumers (like the WASM
 * module) that hold their own copy of the enabled set and need to be
 * pushed to when JS toggles a category.
 */
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

// ---------------------------------------------------------------------------
// Overlay toggles (separate registry from log categories)
// ---------------------------------------------------------------------------
//
// Overlays are visual debug layers drawn over the canvas, not log channels.
// Kept parallel to the category system on purpose: same shape (toggle +
// listener), different semantics (no console output, no WASM push-down,
// no `*` shorthand).

export const DEBUG_OVERLAYS = ["wellModes", "chunkGrid", "cachedTier", "plannedRank"] as const;
export type DebugOverlay = (typeof DEBUG_OVERLAYS)[number];

const OVERLAY_LS_KEY = "debug.overlays";

function readOverlays(): Set<string> {
  if (typeof localStorage === "undefined") return new Set();
  const raw = localStorage.getItem(OVERLAY_LS_KEY);
  if (!raw) return new Set();
  return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
}

export function isOverlayEnabled(name: DebugOverlay): boolean {
  return readOverlays().has(name);
}

export function setOverlayEnabled(name: DebugOverlay, enabled: boolean): void {
  if (typeof localStorage === "undefined") return;
  const current = readOverlays();
  if (enabled) current.add(name);
  else current.delete(name);
  if (current.size === 0) {
    localStorage.removeItem(OVERLAY_LS_KEY);
  } else {
    localStorage.setItem(OVERLAY_LS_KEY, Array.from(current).join(","));
  }
  for (const fn of overlayListeners) fn();
}

const overlayListeners = new Set<() => void>();

/** Subscribe to overlay-toggle changes. Returns an unsubscribe function. */
export function onOverlaysChanged(fn: () => void): () => void {
  overlayListeners.add(fn);
  return () => {
    overlayListeners.delete(fn);
  };
}
