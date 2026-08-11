/**
 * Debug logging registry. Single source of truth for enabled categories,
 * persisted in `localStorage.debug` as a comma-separated list (or `*` for
 * all). See `wiki/decisions/0012-logging-conventions.md`.
 *
 * There is no UI over the categories: `localStorage.debug = 'bridge,cache'`
 * plus a reload is the interface (ADR 0012, as amended by ADR 0052).
 *
 * The persisted set is read ONCE at module init and cached in
 * `enabledCategories`; the per-call gate (`isDebugEnabled`) sits on hot
 * paths — every `bridgeLog`, cache/upload telemetry event, and render-loop
 * dirty log routes through it — so it must never do a synchronous
 * `localStorage` read per call. The cache stays current through the
 * window `storage` event (writes from other tabs). A same-tab write
 * (DevTools console) doesn't fire `storage` in the writing tab; call
 * `refreshDebugCategories()` afterwards, or reload.
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

let enabledCategories: Set<string> = readEnabled();

export function isDebugEnabled(category: DebugCategory): boolean {
  return enabledCategories.has(category);
}

/**
 * Re-read `localStorage.debug` into the cached set and notify listeners
 * (the WASM logger holds its own copy and needs the push). Wired to the
 * cross-tab `storage` event below; also the explicit refresh path after
 * an out-of-band same-tab write.
 */
export function refreshDebugCategories(): void {
  enabledCategories = readEnabled();
  notifyListeners();
}

export function getEnabledCategories(): DebugCategory[] {
  return DEBUG_CATEGORIES.filter(c => enabledCategories.has(c));
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

// Overlays are visual debug layers drawn over the canvas, not log channels.
// Kept parallel to the category system on purpose: same shape (toggle +
// listener), different semantics (no console output, no WASM push-down,
// no `*` shorthand).

export const DEBUG_OVERLAYS = ["groupModes", "chunkGrid", "chunkTier", "renderRadius", "cachedTier", "plannedRank"] as const;
export type DebugOverlay = (typeof DEBUG_OVERLAYS)[number];

const OVERLAY_LS_KEY = "debug.overlays";

function readOverlays(): Set<string> {
  if (typeof localStorage === "undefined") return new Set();
  const raw = localStorage.getItem(OVERLAY_LS_KEY);
  if (!raw) return new Set();
  return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
}

// Same init-once + write-through caching as the category set above:
// `isOverlayEnabled` is polled from render (App decides whether to mount
// the overlay layer), so it must stay a pure in-memory read.
let enabledOverlays: Set<string> = readOverlays();

export function isOverlayEnabled(name: DebugOverlay): boolean {
  return enabledOverlays.has(name);
}

export function setOverlayEnabled(name: DebugOverlay, enabled: boolean): void {
  if (typeof localStorage === "undefined") return;
  const current = new Set(enabledOverlays);
  if (enabled) current.add(name);
  else current.delete(name);
  if (current.size === 0) {
    localStorage.removeItem(OVERLAY_LS_KEY);
  } else {
    localStorage.setItem(OVERLAY_LS_KEY, Array.from(current).join(","));
  }
  enabledOverlays = current;
  for (const fn of overlayListeners) fn();
}

function refreshOverlays(): void {
  enabledOverlays = readOverlays();
  for (const fn of overlayListeners) fn();
}

const overlayListeners = new Set<() => void>();

export function onOverlaysChanged(fn: () => void): () => void {
  overlayListeners.add(fn);
  return () => {
    overlayListeners.delete(fn);
  };
}

export type RenderRadiusPreviewTier = "detail" | "coarse";

let renderRadiusPreviewTier: RenderRadiusPreviewTier | null = null;
const renderRadiusPreviewListeners = new Set<() => void>();

export function getRenderRadiusPreviewTier(): RenderRadiusPreviewTier | null {
  return renderRadiusPreviewTier;
}

export function setRenderRadiusPreviewTier(tier: RenderRadiusPreviewTier | null): void {
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

// Cross-tab refresh: `storage` fires in every OTHER tab when one tab
// writes localStorage, so a toggle flipped in tab A reaches tab B's
// cached gates (and, via the listeners, the WASM logger's copy) without
// reintroducing per-call reads. `key === null` is a full-storage clear.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e: StorageEvent) => {
    if (e.key === "debug" || e.key === null) refreshDebugCategories();
    if (e.key === OVERLAY_LS_KEY || e.key === null) refreshOverlays();
  });
}
