import type { DatasetManifest } from "./manifestTypes.ts";

/** Stable, production-safe metadata included in the external capture probe. */
export interface CaptureDatasetSummary {
  datasetId: string;
  dataTypes: string[];
  channelCounts: number[];
}

/** The selected view values needed to verify channel/contrast correctness. */
export interface CaptureLayerSummary {
  datasetId: string;
  channel: number;
  contrastMin: number;
  contrastMax: number;
  gamma: number;
  contrastSource: "channel" | "dataset";
}

export interface CaptureViewSummary {
  t: number;
  c: number;
  z: number;
  multiChannel: boolean;
  /** Effective values for the first rendered layer, retained for simple probes. */
  contrastMin: number;
  contrastMax: number;
  /** Every intensity layer and the exact display values sent to the renderer. */
  layers: CaptureLayerSummary[];
}

/** DPR-independent evidence for the canonical 2D camera used by live capture. */
export interface CaptureCameraSummary {
  mode: "slice";
  center: [number, number];
  zoom: number;
  viewport: [number, number];
  viewportUnits: "css-pixels";
  projectionProbe: {
    world: [number, number];
    screen: [number, number];
  } | null;
}

export interface LucidaCaptureReadyState {
  ready: boolean;
  reason: string;
  frameCount: number;
  at: number;
  mode: "slice" | "volume";
  datasetCount: number;
  canvasWidth: number;
  canvasHeight: number;
  datasets: CaptureDatasetSummary[];
  view: CaptureViewSummary | null;
  camera: CaptureCameraSummary | null;
}

type CaptureDatasetEntry = { manifest: DatasetManifest };

export function captureDatasetSummaries(
  datasets: ReadonlyMap<string, CaptureDatasetEntry>,
): CaptureDatasetSummary[] {
  return [...datasets].map(([datasetId, { manifest }]) => ({
    datasetId,
    dataTypes: [...new Set(manifest.images.map((image) => image.multiscale.data_type))],
    channelCounts: manifest.images.map((image) => image.multiscale.levels[0]?.shape[1] ?? 0),
  }));
}

export interface CaptureSceneFacet {
  t(): number;
  c(): number;
  z(): number;
  multi_channel(): boolean;
  contrast_min(): number;
  contrast_max(): number;
  dataset_order(): string;
  all_dataset_settings(): string;
  export_presence?(): string;
  project_to_screen?(x: number, y: number, z: number): ArrayLike<number>;
}

/** Parse only the stable 2D camera fields from presence, failing closed. */
export function captureCameraSummary(
  scene: CaptureSceneFacet | null,
): CaptureCameraSummary | null {
  if (!scene?.export_presence) return null;
  try {
    const parsed = JSON.parse(scene.export_presence()) as {
      camera?: {
        mode?: unknown;
        center?: unknown;
        zoom?: unknown;
        viewport?: unknown;
      };
    };
    const camera = parsed.camera;
    if (camera?.mode !== "slice"
      || !Array.isArray(camera.center) || camera.center.length !== 2
      || !Array.isArray(camera.viewport) || camera.viewport.length !== 2
      || !camera.center.every((value) => typeof value === "number" && Number.isFinite(value))
      || !camera.viewport.every((value) => typeof value === "number" && Number.isFinite(value) && value > 0)
      || typeof camera.zoom !== "number" || !Number.isFinite(camera.zoom) || camera.zoom <= 0) {
      return null;
    }
    const probeWorld: [number, number] = [camera.center[0] + 16, camera.center[1] - 9];
    const projected = scene.project_to_screen?.(probeWorld[0], probeWorld[1], 0);
    const projectionProbe = projected
      && projected.length >= 2
      && Number.isFinite(projected[0])
      && Number.isFinite(projected[1])
      ? {
          world: probeWorld,
          screen: [Number(projected[0]), Number(projected[1])] as [number, number],
        }
      : null;
    return {
      mode: "slice",
      center: [camera.center[0], camera.center[1]],
      zoom: camera.zoom,
      viewport: [camera.viewport[0], camera.viewport[1]],
      viewportUnits: "css-pixels",
      projectionProbe,
    };
  } catch {
    return null;
  }
}

interface CaptureChannelSettings {
  visible?: boolean;
  contrast_min?: number;
  contrast_max?: number;
  gamma?: number;
}

interface CaptureDatasetSettings {
  visible?: boolean;
  contrast_min?: number;
  contrast_max?: number;
  gamma?: number;
  channel_settings?: CaptureChannelSettings[];
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Summarize the renderer inputs, not merely the scene's global display default.
 *
 * Rendering resolves intensity state per dataset and per active channel. A
 * channel override wins over its dataset fallback; multi-channel mode fans out
 * to all visible channels. This function deliberately mirrors that rule so the
 * external browser probe can prove which values actually reached a frame.
 */
export function captureViewSummary(
  scene: CaptureSceneFacet | null,
  loadedDatasetIds?: Iterable<string>,
): CaptureViewSummary | null {
  if (scene === null) return null;

  const activeC = scene.c();
  const multiChannel = scene.multi_channel();
  const globalMin = scene.contrast_min();
  const globalMax = scene.contrast_max();
  const loaded = loadedDatasetIds === undefined ? null : new Set(loadedDatasetIds);
  let order: string[] = [];
  let allSettings: Record<string, CaptureDatasetSettings> = {};
  try {
    const parsedOrder: unknown = JSON.parse(scene.dataset_order());
    const parsedSettings: unknown = JSON.parse(scene.all_dataset_settings());
    if (Array.isArray(parsedOrder)) {
      order = parsedOrder.filter((id): id is string => typeof id === "string");
    }
    if (parsedSettings !== null && typeof parsedSettings === "object" && !Array.isArray(parsedSettings)) {
      allSettings = parsedSettings as Record<string, CaptureDatasetSettings>;
    }
  } catch {
    // The wasm scene owns these JSON snapshots, but capture instrumentation
    // must never take down a production frame if a future schema is malformed.
  }

  const layers: CaptureLayerSummary[] = [];
  for (const datasetId of order) {
    if (loaded !== null && !loaded.has(datasetId)) continue;
    const settings = allSettings[datasetId];
    if (settings?.visible === false) continue;
    const channels = settings?.channel_settings ?? [];
    let activeChannels = [activeC];
    if (multiChannel && channels.length > 0) {
      activeChannels = channels.flatMap((channel, index) => channel.visible === true ? [index] : []);
      // Match getActiveChannels(): a fully hidden list still falls back to 0.
      if (activeChannels.length === 0) activeChannels = [0];
    }
    for (const channel of activeChannels) {
      const channelSettings = channels[channel];
      const datasetMin = finiteOr(settings?.contrast_min, globalMin);
      const datasetMax = finiteOr(settings?.contrast_max, globalMax);
      const datasetGamma = finiteOr(settings?.gamma, 1);
      const hasChannelContrast =
        typeof channelSettings?.contrast_min === "number"
        && Number.isFinite(channelSettings.contrast_min)
        && typeof channelSettings?.contrast_max === "number"
        && Number.isFinite(channelSettings.contrast_max);
      layers.push({
        datasetId,
        channel,
        contrastMin: finiteOr(channelSettings?.contrast_min, datasetMin),
        contrastMax: finiteOr(channelSettings?.contrast_max, datasetMax),
        gamma: finiteOr(channelSettings?.gamma, datasetGamma),
        contrastSource: hasChannelContrast ? "channel" : "dataset",
      });
    }
  }

  const representative = layers[0];
  return {
    t: scene.t(),
    c: activeC,
    z: scene.z(),
    multiChannel,
    contrastMin: representative?.contrastMin ?? globalMin,
    contrastMax: representative?.contrastMax ?? globalMax,
    layers,
  };
}
