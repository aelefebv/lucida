/**
 * What Escape undoes, innermost first, for transient state that is not an
 * overlay, such as a shape being drawn. It pushes a layer while it lasts,
 * and the viewer's Escape shortcut runs the newest one before falling back
 * to its own action. Overlays close themselves on Escape and need no layer.
 */

const layers: { readonly onEscape: () => void }[] = [];

/** Push a layer until the returned function runs. */
export function pushEscapeLayer(onEscape: () => void): () => void {
  const layer = { onEscape };
  layers.push(layer);
  return () => {
    const at = layers.lastIndexOf(layer);
    if (at >= 0) layers.splice(at, 1);
  };
}

export function hasEscapeLayer(): boolean {
  return layers.length > 0;
}

/** Pop the newest layer and run it. Returns false when there is none. */
export function escapeTopLayer(): boolean {
  const layer = layers.pop();
  if (!layer) return false;
  layer.onEscape();
  return true;
}

/** Drop every layer. Tests only. */
export function __resetEscapeLayersForTesting(): void {
  layers.length = 0;
}
