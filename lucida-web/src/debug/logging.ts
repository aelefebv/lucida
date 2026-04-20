/**
 * Debug logging registry. Single source of truth for enabled categories,
 * persisted in `localStorage.debug` as a comma-separated list (or `*` for
 * all). See `wiki/decisions/logging-conventions.md`.
 */

export const DEBUG_CATEGORIES = ["bridge"] as const;
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
}

export function getEnabledCategories(): DebugCategory[] {
  const enabled = readEnabled();
  return DEBUG_CATEGORIES.filter(c => enabled.has(c));
}
