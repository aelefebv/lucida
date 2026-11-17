import { useState } from "react";

/** A zoomed contrast span, and the full-range setting it was zoomed under. */
export interface ContrastZoom {
  span: readonly [number, number];
  fullRange: boolean;
}

/**
 * The zoom of one contrast bar, starting at `initial`. The bar's owner holds
 * it, so a second bar can open at the span the first shows and then zoom on
 * its own.
 */
export function useContrastZoom(
  fullRange: boolean,
  initial: ContrastZoom | null = null,
): [ContrastZoom | null, (zoom: ContrastZoom | null) => void] {
  const [zoom, setZoom] = useState(initial);
  // Turning the full range on or off asks for a different span, so it ends a zoom.
  if (zoom && zoom.fullRange !== fullRange) setZoom(null);
  return [zoom && zoom.fullRange === fullRange ? zoom : null, setZoom];
}
