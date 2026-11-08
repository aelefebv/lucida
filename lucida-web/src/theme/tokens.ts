/** Every custom property tokens.css defines. A test keeps the two in step. */
export const TOKEN_NAMES = [
  "--lc-bg",
  "--lc-surface-1",
  "--lc-surface-2",
  "--lc-surface-3",
  "--lc-surface-float",
  "--lc-field-bg",
  "--lc-scrim",
  "--lc-thumb",
  "--lc-text",
  "--lc-text-muted",
  "--lc-text-subtle",
  "--lc-text-on-accent",
  "--lc-border",
  "--lc-border-strong",
  "--lc-accent",
  "--lc-accent-hover",
  "--lc-accent-subtle",
  "--lc-accent-text",
  "--lc-focus-ring",
  "--lc-danger",
  "--lc-danger-subtle",
  "--lc-warning",
  "--lc-warning-subtle",
  "--lc-success",
  "--lc-success-subtle",
  "--lc-info",
  "--lc-info-subtle",
  "--lc-chart-1",
  "--lc-chart-2",
  "--lc-chart-3",
  "--lc-chart-4",
  "--lc-chart-5",
  "--lc-chart-6",
  "--lc-chart-7",
  "--lc-chart-8",
  "--lc-chart-neutral",
  "--lc-float-chart-1",
  "--lc-float-chart-2",
  "--lc-float-chart-3",
  "--lc-float-chart-4",
  "--lc-canvas-bg",
  "--lc-canvas-stroke",
  "--lc-canvas-label",
  "--lc-canvas-axis-x",
  "--lc-canvas-axis-y",
  "--lc-canvas-axis-z",
  "--lc-canvas-viewport",
  "--lc-canvas-plane",
  "--lc-canvas-success",
  "--lc-canvas-warning",
  "--lc-canvas-danger",
  "--lc-canvas-info",
  "--lc-canvas-chart-1",
  "--lc-canvas-chart-2",
  "--lc-canvas-chart-3",
  "--lc-canvas-chart-4",
  "--lc-canvas-chart-5",
  "--lc-canvas-chart-6",
  "--lc-canvas-chart-7",
  "--lc-canvas-chart-8",
  "--lc-canvas-chart-neutral",
  "--lc-annotation-own",
  "--lc-annotation-peer",
  "--lc-annotation-ring",
  "--lc-annotation-shadow",
  "--lc-radius-sm",
  "--lc-radius",
  "--lc-radius-lg",
  "--lc-radius-full",
  "--lc-space-1",
  "--lc-space-2",
  "--lc-space-3",
  "--lc-space-4",
  "--lc-space-5",
  "--lc-space-6",
  "--lc-space-7",
  "--lc-space-8",
  "--lc-control-h",
  "--lc-control-h-sm",
  "--lc-target-min",
  "--lc-thumb-size",
  "--lc-safe-top",
  "--lc-safe-right",
  "--lc-safe-bottom",
  "--lc-safe-left",
  "--lc-font",
  "--lc-font-mono",
  "--lc-text-xs",
  "--lc-text-sm",
  "--lc-text-md",
  "--lc-text-lg",
  "--lc-text-xl",
  "--lc-text-2xl",
  "--lc-text-input",
  "--lc-shadow-1",
  "--lc-shadow-2",
  "--lc-motion-fast",
  "--lc-motion",
  "--lc-ease",
  "--lc-z-float",
  "--lc-z-panel",
  "--lc-z-dialog",
  "--lc-z-popover",
  "--lc-z-toast",
] as const;

export type TokenName = (typeof TOKEN_NAMES)[number];

/** Tokens that differ between the dark and light presets. */
export const THEMED_TOKEN_NAMES = [
  "--lc-bg",
  "--lc-surface-1",
  "--lc-surface-2",
  "--lc-surface-3",
  "--lc-surface-float",
  "--lc-field-bg",
  "--lc-scrim",
  "--lc-text",
  "--lc-text-muted",
  "--lc-text-subtle",
  "--lc-border",
  "--lc-border-strong",
  "--lc-accent-hover",
  "--lc-accent-subtle",
  "--lc-accent-text",
  "--lc-focus-ring",
  "--lc-danger",
  "--lc-danger-subtle",
  "--lc-warning",
  "--lc-warning-subtle",
  "--lc-success",
  "--lc-success-subtle",
  "--lc-info",
  "--lc-info-subtle",
  "--lc-chart-1",
  "--lc-chart-2",
  "--lc-chart-3",
  "--lc-chart-4",
  "--lc-chart-5",
  "--lc-chart-6",
  "--lc-chart-7",
  "--lc-chart-8",
  "--lc-chart-neutral",
  "--lc-float-chart-1",
  "--lc-float-chart-2",
  "--lc-float-chart-3",
  "--lc-float-chart-4",
  "--lc-shadow-1",
  "--lc-shadow-2",
] as const satisfies readonly TokenName[];

/** Tokens that follow the canvas background preference rather than the theme. */
export const CANVAS_TOKEN_NAMES = [
  "--lc-canvas-bg",
  "--lc-canvas-stroke",
  "--lc-canvas-label",
  "--lc-canvas-axis-x",
  "--lc-canvas-axis-y",
  "--lc-canvas-axis-z",
  "--lc-canvas-viewport",
  "--lc-canvas-plane",
  "--lc-canvas-success",
  "--lc-canvas-warning",
  "--lc-canvas-danger",
  "--lc-canvas-info",
  "--lc-canvas-chart-1",
  "--lc-canvas-chart-2",
  "--lc-canvas-chart-3",
  "--lc-canvas-chart-4",
  "--lc-canvas-chart-5",
  "--lc-canvas-chart-6",
  "--lc-canvas-chart-7",
  "--lc-canvas-chart-8",
  "--lc-canvas-chart-neutral",
] as const satisfies readonly TokenName[];

/** A token's computed value as written, e.g. `13px` or `color-mix(...)`. */
export function readToken(name: TokenName, element: Element = document.documentElement): string {
  return getComputedStyle(element).getPropertyValue(name).trim();
}

/** A color resolved to sRGB, channels in 0..1, ready for a GPU clear color. */
export interface ResolvedColor {
  r: number;
  g: number;
  b: number;
  a: number;
  /** The same color as `rgba(...)`, for a 2D canvas. */
  css: string;
}

let probe: { element: HTMLElement; context: CanvasRenderingContext2D | null } | null = null;

/**
 * Resolve a color token to sRGB. Canvas and GPU code reads colors through
 * this, because a derived token's computed value is an unresolved
 * `color-mix()` or `oklch(from ...)` that neither can parse. Re-read after
 * `subscribeAppearance` fires.
 */
export function readColorToken(
  name: TokenName,
  element: Element = document.documentElement,
): ResolvedColor {
  if (!probe) {
    const el = document.createElement("span");
    el.style.display = "none";
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    probe = { element: el, context: canvas.getContext("2d", { willReadFrequently: true }) };
  }
  element.appendChild(probe.element);
  probe.element.style.color = `var(${name})`;
  const computed = getComputedStyle(probe.element).color;
  probe.element.remove();

  const ctx = probe.context;
  if (!ctx) return parseRgb(computed);
  // The 2D context normalizes every CSS color syntax to 8-bit sRGB.
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = computed;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return toResolved(r / 255, g / 255, b / 255, a / 255);
}

function parseRgb(value: string): ResolvedColor {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?/.exec(value);
  if (!m) return toResolved(0, 0, 0, 1);
  const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return toResolved(+m[1] / 255, +m[2] / 255, +m[3] / 255, alpha);
}

function toResolved(r: number, g: number, b: number, a: number): ResolvedColor {
  const byte = (c: number) => Math.round(c * 255);
  const alpha = Math.round(a * 1000) / 1000;
  return { r, g, b, a, css: `rgba(${byte(r)}, ${byte(g)}, ${byte(b)}, ${alpha})` };
}
