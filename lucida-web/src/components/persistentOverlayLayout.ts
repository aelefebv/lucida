export interface OverlayBoundary {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface OverlaySize {
  width: number;
  height: number;
}

export interface OverlayRect extends OverlaySize {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PersistentOverlayLayout {
  collection: OverlayRect | null;
  minimap: OverlayRect | null;
  stacked: boolean;
}

function intersects(left: OverlayRect, right: OverlayRect): boolean {
  return left.left < right.right
    && left.right > right.left
    && left.top < right.bottom
    && left.bottom > right.top;
}

/**
 * Give transient dialogs/popovers priority over persistent canvas chrome.
 *
 * The persistent surfaces retain their deterministic base positions; if an
 * unusually constrained viewport leaves one of those positions underneath an
 * active transient surface, omit only the colliding persistent surface. This
 * avoids an unstable two-way "chase" where both independent placement owners
 * continuously move in response to each other.
 */
export function suppressPersistentOverlayCollisions(
  layout: PersistentOverlayLayout,
  transientObstacles: readonly OverlayRect[],
): PersistentOverlayLayout {
  const available = (candidate: OverlayRect | null) => candidate
    && !transientObstacles.some((obstacle) => intersects(candidate, obstacle))
    ? candidate
    : null;
  const collection = available(layout.collection);
  const minimap = available(layout.minimap);
  return {
    collection,
    minimap,
    stacked: Boolean(collection && minimap && layout.stacked),
  };
}

const OVERLAY_GAP = 12;
const MIN_COLLECTION_WIDTH = 96;
const MIN_COLLECTION_HEIGHT = 44;

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function rect(left: number, top: number, size: OverlaySize): OverlayRect {
  return {
    left,
    top,
    right: left + size.width,
    bottom: top + size.height,
    ...size,
  };
}

/**
 * Place the two persistent canvas overlays as one geometry problem.
 *
 * The selector remains first in DOM, focus, and visual order. When both
 * surfaces fit, they keep their familiar bottom-left/bottom-right desktop
 * positions. When they cannot share a row, the selector stacks above the
 * minimap and becomes internally scrollable if the available height is
 * smaller than its natural height.
 */
export function resolvePersistentOverlayLayout(
  boundary: OverlayBoundary,
  collectionSize: OverlaySize | null,
  minimapSize: OverlaySize | null,
  gap = OVERLAY_GAP,
): PersistentOverlayLayout {
  const normalizedBoundary = {
    left: finiteNonNegative(boundary.left),
    top: finiteNonNegative(boundary.top),
    width: finiteNonNegative(boundary.width),
    height: finiteNonNegative(boundary.height),
  };
  const right = normalizedBoundary.left + normalizedBoundary.width;
  const bottom = normalizedBoundary.top + normalizedBoundary.height;
  const collectionCandidate = collectionSize && {
    width: Math.min(finiteNonNegative(collectionSize.width), normalizedBoundary.width),
    height: Math.min(finiteNonNegative(collectionSize.height), normalizedBoundary.height),
  };
  const collectionNatural = collectionCandidate
    && collectionCandidate.width >= MIN_COLLECTION_WIDTH
    && collectionCandidate.height >= MIN_COLLECTION_HEIGHT
    ? collectionCandidate
    : null;
  const minimapCandidate = minimapSize && {
    width: finiteNonNegative(minimapSize.width),
    height: finiteNonNegative(minimapSize.height),
  };
  // The minimap owns a fixed-resolution rendering contract. Do not leave a
  // cropped sliver alive when its full surface cannot fit; hiding it is safer
  // than exposing a misleading or pointer-intercepting partial overview.
  const minimap = minimapCandidate
    && minimapCandidate.width > 0
    && minimapCandidate.height > 0
    && minimapCandidate.width <= normalizedBoundary.width
    && minimapCandidate.height <= normalizedBoundary.height
    ? minimapCandidate
    : null;

  if (!collectionNatural && !minimap) {
    return { collection: null, minimap: null, stacked: false };
  }
  if (!collectionNatural) {
    return {
      collection: null,
      minimap: minimap
        ? rect(right - minimap.width, bottom - minimap.height, minimap)
        : null,
      stacked: false,
    };
  }
  if (!minimap) {
    return {
      collection: rect(
        normalizedBoundary.left,
        bottom - collectionNatural.height,
        collectionNatural,
      ),
      minimap: null,
      stacked: false,
    };
  }

  const stacked = collectionNatural.width + minimap.width + gap > normalizedBoundary.width;
  if (!stacked) {
    return {
      collection: rect(
        normalizedBoundary.left,
        bottom - collectionNatural.height,
        collectionNatural,
      ),
      minimap: rect(right - minimap.width, bottom - minimap.height, minimap),
      stacked: false,
    };
  }

  // Keep the minimap at its familiar bottom-end anchor. The selector appears
  // above it, matching DOM/tab order. Its scrollport owns any height pressure;
  // controls are never covered by the later-painted minimap.
  const collection = {
    width: collectionNatural.width,
    height: Math.min(
      collectionNatural.height,
      Math.max(0, normalizedBoundary.height - minimap.height - gap),
    ),
  };
  if (collection.height < MIN_COLLECTION_HEIGHT) {
    // Collection navigation is interactive and can remain useful in a compact
    // scrollport. The minimap is passive context, so when both cannot coexist
    // preserve navigation and omit the overview.
    return {
      collection: rect(
        normalizedBoundary.left,
        bottom - collectionNatural.height,
        collectionNatural,
      ),
      minimap: null,
      stacked: false,
    };
  }
  return {
    collection: rect(
      normalizedBoundary.left,
      bottom - minimap.height - gap - collection.height,
      collection,
    ),
    minimap: rect(right - minimap.width, bottom - minimap.height, minimap),
    stacked: true,
  };
}
