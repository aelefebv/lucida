import { useEffect, useRef } from "react";

/**
 * What Escape undoes, innermost first. Something transient (an open thread,
 * a shape being drawn) pushes a layer while it lasts, and the viewer's
 * Escape shortcut calls the newest one before falling back to its own
 * action. Overlays built on the primitives close themselves on Escape and
 * need no layer.
 */

const layers: { current: () => void }[] = [];

/** Push a layer until the returned function runs. For gestures, outside React. */
export function pushEscapeLayer(onEscape: () => void): () => void {
  const layer = { current: onEscape };
  layers.push(layer);
  return () => {
    const at = layers.lastIndexOf(layer);
    if (at >= 0) layers.splice(at, 1);
  };
}

/** Hold a layer while `active`. `onEscape` may change on every render. */
export function useEscapeLayer(active: boolean, onEscape: () => void): void {
  const ref = useRef(onEscape);
  useEffect(() => {
    ref.current = onEscape;
  });
  useEffect(() => (active ? pushEscapeLayer(() => ref.current()) : undefined), [active]);
}

export function hasEscapeLayer(): boolean {
  return layers.length > 0;
}

/** Pop the newest layer and run it. Returns false when there is none. */
export function escapeTopLayer(): boolean {
  const layer = layers.pop();
  if (!layer) return false;
  layer.current();
  return true;
}

/** Drop every layer. Tests only. */
export function __resetEscapeLayersForTesting(): void {
  layers.length = 0;
}
