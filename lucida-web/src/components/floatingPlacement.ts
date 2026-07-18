export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

function intersectionArea(a: RectLike, b: RectLike): number {
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return width * height;
}

function placedRect(left: number, top: number, width: number, height: number): RectLike {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

/** Viewport coordinate that flips and clamps a floating surface. */
export function resolveFloatingViewportPlacement(
  anchor: RectLike,
  surface: Pick<RectLike, "width" | "height">,
  boundary: { width: number; height: number; left?: number; top?: number },
  gap = 10,
  padding = 8,
  obstacles: readonly RectLike[] = [],
): { left: number; top: number } {
  const boundaryLeft = boundary.left ?? 0;
  const boundaryTop = boundary.top ?? 0;
  const boundaryRight = boundaryLeft + boundary.width;
  const boundaryBottom = boundaryTop + boundary.height;
  let absoluteLeft = anchor.right + gap;
  if (absoluteLeft + surface.width > boundaryRight - padding) {
    absoluteLeft = anchor.left - surface.width - gap;
  }
  let absoluteTop = anchor.bottom + gap;
  if (absoluteTop + surface.height > boundaryBottom - padding) {
    absoluteTop = anchor.top - surface.height - gap;
  }

  const minLeft = boundaryLeft + padding;
  const minTop = boundaryTop + padding;
  const maxLeft = Math.max(minLeft, boundaryRight - padding - surface.width);
  const maxTop = Math.max(minTop, boundaryBottom - padding - surface.height);
  absoluteLeft = clamp(absoluteLeft, minLeft, maxLeft);
  absoluteTop = clamp(absoluteTop, minTop, maxTop);
  if (obstacles.length === 0) return { left: absoluteLeft, top: absoluteTop };

  // Treat placement as one shared collision problem instead of teaching each
  // popover about each toolbar. Candidate coordinates include every useful
  // edge around the anchor, viewport, and declared safe region. The score first
  // eliminates overlap, then keeps the winner as close as possible to the
  // normal flip/clamp placement. This lets a surface move farther than one
  // anchor-width when a dense mobile toolbar leaves no adjacent free slot.
  const xCandidates = new Set<number>([
    absoluteLeft,
    anchor.right + gap,
    anchor.left - surface.width - gap,
    anchor.left,
    anchor.right - surface.width,
    minLeft,
    maxLeft,
  ]);
  const yCandidates = new Set<number>([
    absoluteTop,
    anchor.bottom + gap,
    anchor.top - surface.height - gap,
    anchor.top,
    anchor.bottom - surface.height,
    minTop,
    maxTop,
  ]);
  for (const obstacle of obstacles) {
    xCandidates.add(obstacle.left - surface.width - gap);
    xCandidates.add(obstacle.right + gap);
    yCandidates.add(obstacle.top - surface.height - gap);
    yCandidates.add(obstacle.bottom + gap);
  }

  const overlapWeight = Math.max(1, boundary.width * boundary.height + 1);
  let best = { left: absoluteLeft, top: absoluteTop };
  let bestScore = Number.POSITIVE_INFINITY;
  for (const rawLeft of xCandidates) {
    for (const rawTop of yCandidates) {
      const left = clamp(rawLeft, minLeft, maxLeft);
      const top = clamp(rawTop, minTop, maxTop);
      const candidate = placedRect(left, top, surface.width, surface.height);
      const overlap = obstacles.reduce(
        (total, obstacle) => total + intersectionArea(candidate, obstacle),
        0,
      );
      const anchorOverlap = intersectionArea(candidate, anchor);
      const distance = Math.abs(left - absoluteLeft) + Math.abs(top - absoluteTop);
      const score = (overlap + anchorOverlap) * overlapWeight + distance;
      if (score < bestScore) {
        bestScore = score;
        best = { left, top };
      }
    }
  }
  return best;
}

/** Local offset for a surface rendered inside its anchor. */
export function resolveFloatingPlacement(
  anchor: RectLike,
  surface: Pick<RectLike, "width" | "height">,
  boundary: { width: number; height: number; left?: number; top?: number },
  gap = 10,
  padding = 8,
  obstacles: readonly RectLike[] = [],
): { left: number; top: number } {
  const absolute = resolveFloatingViewportPlacement(
    anchor,
    surface,
    boundary,
    gap,
    padding,
    obstacles,
  );
  return { left: absolute.left - anchor.left, top: absolute.top - anchor.top };
}
