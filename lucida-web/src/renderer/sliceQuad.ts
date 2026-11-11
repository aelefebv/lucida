/**
 * Where a slice layer lies in the scene frame the slice camera views: its
 * unit square, `u` across and `v` down, maps to
 * `origin + u * across + v * down`. A dataset whose placement turns it in the
 * plane draws a turned quad; one it doesn't draws `across = [width, 0]` and
 * `down = [0, height]`, and every function here keeps that case's arithmetic
 * exactly as an axis-aligned rect's, so an unturned frame draws the same
 * pixels.
 */

type Vec2 = readonly [number, number];

export interface SliceQuad {
  origin: Vec2;
  across: Vec2;
  down: Vec2;
}

/** The quad of a rect at `x, y` spanning `w × h`, turning nothing. */
export function axisAlignedQuad(x: number, y: number, w: number, h: number): SliceQuad {
  return { origin: [x, y], across: [w, 0], down: [0, h] };
}

/** Whether `q` turns nothing, so it is a rect along the scene's axes. */
export function isAxisAlignedQuad(q: SliceQuad): boolean {
  return q.across[1] === 0 && q.down[0] === 0;
}

/** The scene point at `u, v` of the quad's unit square. */
export function quadPoint(q: SliceQuad, u: number, v: number): [number, number] {
  return [
    q.origin[0] + u * q.across[0] + v * q.down[0],
    q.origin[1] + u * q.across[1] + v * q.down[1],
  ];
}

/** The quad's `[u, v]` at scene point `x, y`, inside its unit square when the point is inside the quad. */
export function quadUV(q: SliceQuad, x: number, y: number): [number, number] {
  const dx = x - q.origin[0];
  const dy = y - q.origin[1];
  if (isAxisAlignedQuad(q)) return [dx / q.across[0], dy / q.down[1]];
  const [a, c] = q.across;
  const [b, d] = q.down;
  const det = a * d - b * c;
  return [(d * dx - b * dy) / det, (a * dy - c * dx) / det];
}

/** How long the quad's edges are, `[across, down]`, in scene units. */
export function quadEdgeLengths(q: SliceQuad): [number, number] {
  if (isAxisAlignedQuad(q)) return [q.across[0], q.down[1]];
  return [Math.hypot(q.across[0], q.across[1]), Math.hypot(q.down[0], q.down[1])];
}

/** The smallest rect along the scene's axes around the quad, `{ x, y, w, h }`. */
export function quadBounds(q: SliceQuad): { x: number; y: number; w: number; h: number } {
  if (isAxisAlignedQuad(q)) return { x: q.origin[0], y: q.origin[1], w: q.across[0], h: q.down[1] };
  const xs = [0, q.across[0], q.down[0], q.across[0] + q.down[0]];
  const ys = [0, q.across[1], q.down[1], q.across[1] + q.down[1]];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: q.origin[0] + minX,
    y: q.origin[1] + minY,
    w: Math.max(...xs) - minX,
    h: Math.max(...ys) - minY,
  };
}
