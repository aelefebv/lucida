import type { ChromePart, ChromePartName, ChromeReading } from "./types.ts";

/**
 * The chrome a person needs fully on screen, by the element each layout
 * renders it as. A part the page did not render is left out, so the capture
 * surface, which renders none, reads no parts.
 */
const PARTS: readonly { part: ChromePartName; selector: string }[] = [
  { part: "top bar", selector: ".lc-shell > .lc-topbar, .lc-shell > .lc-phone-topbar" },
  { part: "bottom sheet", selector: ".lc-shell .lc-phone-sheet" },
];

/**
 * Where the viewer's chrome sits against the viewport of `doc`. The boxes
 * are relative to the viewport, so a part a scroll carried off the screen
 * reads as off it.
 */
export function readChrome(doc: Document = document): ChromeReading {
  const root = doc.scrollingElement ?? doc.documentElement;
  const parts: ChromePart[] = [];
  for (const { part, selector } of PARTS) {
    const element = doc.querySelector(selector);
    if (!element) continue;
    const box = element.getBoundingClientRect();
    parts.push({
      part,
      left: hundredths(box.left),
      top: hundredths(box.top),
      right: hundredths(box.right),
      bottom: hundredths(box.bottom),
    });
  }
  return { viewportWidth: root.clientWidth, viewportHeight: root.clientHeight, parts };
}

/** Layout places boxes in fractions of a pixel no reader needs. */
function hundredths(px: number): number {
  return Math.round(px * 100) / 100;
}
