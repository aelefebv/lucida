import { useSyncExternalStore } from "react";

/**
 * The width classes as media queries. Stylesheets cannot import these, so
 * they write the same strings in their `@media` rules, and a test fails on a
 * width query in any stylesheet that is not one of them. Range syntax leaves
 * no gap at a fractional width such as 639.5px, which `max-width: 639px`
 * would.
 */
export const VIEWPORT_MEDIA = {
  phone: "(width < 640px)",
  tablet: "(640px <= width < 1024px)",
  desktop: "(width >= 1024px)",
  /** Phone or tablet: narrower than the desktop shell. */
  belowDesktop: "(width < 1024px)",
} as const;

/**
 * A finger rather than a mouse or pen, whatever the width. Touch sizing
 * follows this, never the width class; tokens.css uses the same query.
 */
export const POINTER_COARSE_MEDIA = "(pointer: coarse)";

export type ViewportClass = "phone" | "tablet" | "desktop";

function matches(query: string): boolean {
  return typeof matchMedia === "function" && matchMedia(query).matches;
}

function subscribeTo(queries: readonly string[]) {
  return (onChange: () => void): (() => void) => {
    if (typeof matchMedia !== "function") return () => {};
    const lists = queries.map((query) => matchMedia(query));
    for (const list of lists) list.addEventListener("change", onChange);
    return () => {
      for (const list of lists) list.removeEventListener("change", onChange);
    };
  };
}

/** The current width class, read from the same queries the stylesheets use. */
export function getViewportClass(): ViewportClass {
  if (typeof matchMedia !== "function") return "desktop";
  if (matches(VIEWPORT_MEDIA.phone)) return "phone";
  if (matches(VIEWPORT_MEDIA.desktop)) return "desktop";
  return "tablet";
}

/** Whether the primary pointer is coarse. */
export function isPointerCoarse(): boolean {
  return matches(POINTER_COARSE_MEDIA);
}

const subscribeViewport = subscribeTo([VIEWPORT_MEDIA.phone, VIEWPORT_MEDIA.desktop]);
const subscribePointer = subscribeTo([POINTER_COARSE_MEDIA]);

/** The width class, kept current as the window resizes or rotates. */
export function useViewportClass(): ViewportClass {
  return useSyncExternalStore(subscribeViewport, getViewportClass, () => "desktop");
}

/** Whether the primary pointer is coarse, kept current. */
export function usePointerCoarse(): boolean {
  return useSyncExternalStore(subscribePointer, isPointerCoarse, () => false);
}

export interface SafeAreaInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

const NO_INSETS: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
let insetProbe: HTMLElement | null = null;
let cachedInsets: SafeAreaInsets | null = null;

/**
 * The `--lc-safe-*` insets in CSS pixels, for code that places something in
 * script. Script has no direct reading of `env()`, so a hidden element padded
 * by the tokens reports them. They change only when the window does.
 */
export function readSafeAreaInsets(): SafeAreaInsets {
  if (typeof document === "undefined" || !document.body) return NO_INSETS;
  if (cachedInsets) return cachedInsets;
  if (!insetProbe) {
    insetProbe = document.createElement("div");
    insetProbe.setAttribute("aria-hidden", "true");
    insetProbe.style.cssText =
      "position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;" +
      "padding:var(--lc-safe-top) var(--lc-safe-right) var(--lc-safe-bottom) var(--lc-safe-left)";
    document.body.append(insetProbe);
    window.addEventListener("resize", () => {
      cachedInsets = null;
    });
  }
  const style = getComputedStyle(insetProbe);
  const px = (value: string) => parseFloat(value) || 0;
  cachedInsets = {
    top: px(style.paddingTop),
    right: px(style.paddingRight),
    bottom: px(style.paddingBottom),
    left: px(style.paddingLeft),
  };
  return cachedInsets;
}
