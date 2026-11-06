import { useSyncExternalStore } from "react";
import {
  definePreference,
  getPreference,
  oneOfPreference,
  subscribePreferences,
} from "./preferences.ts";

export const THEME_OPTIONS = ["dark", "light", "system"] as const;
export type ThemeOption = (typeof THEME_OPTIONS)[number];
export type ResolvedTheme = "dark" | "light";

export const ACCENT_PRESETS = ["indigo", "blue", "teal", "green", "amber", "rose"] as const;
export type AccentPreset = (typeof ACCENT_PRESETS)[number];
/** Six-digit hex, e.g. `#3a7bd5`. */
export type HexColor = `#${string}`;
export type Accent = AccentPreset | HexColor;

export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

export const CANVAS_BACKGROUNDS = ["black", "dark-gray", "white", "theme"] as const;
export type CanvasBackground = (typeof CANVAS_BACKGROUNDS)[number];

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function isHexColor(value: unknown): value is HexColor {
  return typeof value === "string" && HEX_COLOR.test(value);
}

function parseAccent(raw: unknown): Accent | undefined {
  if (isHexColor(raw)) return raw;
  return typeof raw === "string" && (ACCENT_PRESETS as readonly string[]).includes(raw)
    ? (raw as AccentPreset)
    : undefined;
}

// The inline script in index.html reads these keys and values before first
// paint; appearance.test.ts runs it against applyAppearance to keep them equal.
export const themePreference = oneOfPreference("appearance.theme", THEME_OPTIONS, "dark");
export const accentPreference = definePreference<Accent>("appearance.accent", "indigo", parseAccent);
export const densityPreference = oneOfPreference("appearance.density", DENSITIES, "comfortable");
export const canvasBackgroundPreference = oneOfPreference(
  "appearance.canvasBackground",
  CANVAS_BACKGROUNDS,
  "black",
);

/** The appearance as applied to the document, with System resolved. */
export interface Appearance {
  readonly theme: ResolvedTheme;
  readonly accent: Accent;
  readonly density: Density;
  readonly canvasBackground: CanvasBackground;
}

const LIGHT_QUERY = "(prefers-color-scheme: light)";

function systemTheme(): ResolvedTheme {
  return typeof matchMedia === "function" && matchMedia(LIGHT_QUERY).matches ? "light" : "dark";
}

export function resolveAppearance(): Appearance {
  const theme = getPreference(themePreference);
  return {
    theme: theme === "system" ? systemTheme() : theme,
    accent: getPreference(accentPreference),
    density: getPreference(densityPreference),
    canvasBackground: getPreference(canvasBackgroundPreference),
  };
}

/** Write an appearance onto an element as the attributes tokens.css keys on. */
export function applyAppearance(root: HTMLElement, appearance: Appearance): void {
  root.dataset.theme = appearance.theme;
  root.dataset.density = appearance.density;
  root.dataset.canvas = appearance.canvasBackground;
  if (isHexColor(appearance.accent)) {
    root.dataset.accent = "custom";
    root.style.setProperty("--lc-accent", appearance.accent);
  } else {
    root.dataset.accent = appearance.accent;
    root.style.removeProperty("--lc-accent");
  }
}

let current: Appearance | null = null;
const listeners = new Set<() => void>();

function sameAppearance(a: Appearance, b: Appearance): boolean {
  return (
    a.theme === b.theme &&
    a.accent === b.accent &&
    a.density === b.density &&
    a.canvasBackground === b.canvasBackground
  );
}

function refresh(): void {
  const next = resolveAppearance();
  if (current && sameAppearance(current, next)) return;
  current = next;
  applyAppearance(document.documentElement, next);
  for (const listener of [...listeners]) listener();
}

/**
 * Keep `<html>` in step with the appearance preferences and, under System,
 * with the OS setting. Call once at startup; returns a teardown.
 */
export function installAppearance(): () => void {
  current = null;
  refresh();
  const unsubscribe = subscribePreferences(refresh);
  const media = typeof matchMedia === "function" ? matchMedia(LIGHT_QUERY) : null;
  media?.addEventListener("change", refresh);
  return () => {
    unsubscribe();
    media?.removeEventListener("change", refresh);
  };
}

/**
 * Fires after the document's appearance changes. Canvas and GPU code re-reads
 * its colors here, since tokens.css cannot reach them.
 */
export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The applied appearance, for code that draws outside CSS. */
export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribeAppearance, () => (current ??= resolveAppearance()));
}
