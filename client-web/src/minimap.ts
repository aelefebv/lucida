export type Viewport = {
  centerX: number;
  centerY: number;
  zoom: number;
};

export type ViewportRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type OverviewLayer = {
  layerId: string;
  name: string;
  sourceId: string | null;
};

export type MinimapState = {
  overviewLayerId: string | null;
  viewportRect: ViewportRect;
  zIndicatorLabel: string;
};

export function selectOverviewLayer(
  layers: OverviewLayer[],
  pinnedOverviewLayerId: string | null,
  activeLayerId: string | null,
): string | null {
  if (pinnedOverviewLayerId !== null) {
    const exists = layers.some((layer) => layer.layerId === pinnedOverviewLayerId);
    if (exists) {
      return pinnedOverviewLayerId;
    }
  }

  if (activeLayerId !== null) {
    const exists = layers.some((layer) => layer.layerId === activeLayerId);
    if (exists) {
      return activeLayerId;
    }
  }
  return layers[0]?.layerId ?? null;
}

export function computeViewportRect(
  imageWidth: number,
  imageHeight: number,
  viewport: Viewport,
): ViewportRect {
  const visibleWidth = imageWidth / Math.max(viewport.zoom, 0.01);
  const visibleHeight = imageHeight / Math.max(viewport.zoom, 0.01);
  const x = clamp(viewport.centerX - visibleWidth / 2, 0, imageWidth - visibleWidth);
  const y = clamp(viewport.centerY - visibleHeight / 2, 0, imageHeight - visibleHeight);
  return {
    x,
    y,
    width: Math.max(1, visibleWidth),
    height: Math.max(1, visibleHeight),
  };
}

export function buildMinimapState(
  layers: OverviewLayer[],
  pinnedOverviewLayerId: string | null,
  activeLayerId: string | null,
  imageWidth: number,
  imageHeight: number,
  viewport: Viewport,
  zIndex: number,
  maxZ: number,
): MinimapState {
  const overviewLayerId = selectOverviewLayer(
    layers,
    pinnedOverviewLayerId,
    activeLayerId,
  );
  const viewportRect = computeViewportRect(imageWidth, imageHeight, viewport);
  return {
    overviewLayerId,
    viewportRect,
    zIndicatorLabel: `z ${zIndex.toString()} / ${Math.max(0, maxZ - 1).toString()}`,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}
