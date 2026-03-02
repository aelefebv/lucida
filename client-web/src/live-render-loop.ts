import type {
  ClientState,
  TileLayout,
  TileLodLayout,
  WarningEntry,
} from "./client-store";
import type { ChunkKey } from "./chunk-key";
import { EngineDataPlaneUrlResolver } from "./object-url-resolver";
import { RequestScheduler } from "./request-scheduler";
import { ProgressiveFrameStore } from "./renderer-2d";
import { buildMinimapState, type MinimapState } from "./minimap";
import { buildSessionNotice } from "./warning-surface";

export type RenderFrameState = {
  sourceId: string;
  generationSeq: number;
  frameKind: "preview" | "tile";
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  grayscaleSamples: Uint16Array;
  sampleMax: number;
  pixelStats: FramePixelStats;
  minimap: MinimapState;
  warningNotice: string | null;
};

export type FramePixelStats = {
  min: number;
  max: number;
  nonZeroRatio: number;
  mean: number;
};

type DecodedFrame = {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  grayscaleSamples: Uint16Array;
  sampleMax: number;
  pixelStats: FramePixelStats;
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const defaultFetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init);

export class LiveRenderLoop {
  private readonly resolver: EngineDataPlaneUrlResolver;
  private readonly scheduler: RequestScheduler;
  private readonly frameStore: ProgressiveFrameStore;
  private readonly fetchImpl: FetchLike;
  private readonly onFrame: (state: RenderFrameState) => void;
  private readonly activeFetches: Set<string>;
  private currentSelectionKey: string | null;
  private currentPreviewRequestKey: string | null;
  private currentTileRequestKeys: Set<string>;
  private dimensionsBySourceGeneration: Map<string, { width: number; height: number }>;
  private frameKindBySourceGeneration: Map<string, "preview" | "tile">;
  private grayscaleBySourceGeneration: Map<string, Uint16Array>;
  private sampleMaxBySourceGeneration: Map<string, number>;
  private pixelStatsBySourceGeneration: Map<string, FramePixelStats>;
  private latestGenerationSeq: number;
  private latestPreferredSourceId: string | null;
  private latestClientState: ClientState | null;
  private retryTimer: ReturnType<typeof setTimeout> | null;

  public constructor(
    dataBase: string,
    onFrame: (state: RenderFrameState) => void,
    fetchImpl: FetchLike = defaultFetchImpl,
    cacheScope: string | null = null,
  ) {
    this.resolver =
      cacheScope === null
        ? new EngineDataPlaneUrlResolver(dataBase)
        : new EngineDataPlaneUrlResolver(dataBase, { cacheScope });
    this.scheduler = new RequestScheduler(2);
    this.frameStore = new ProgressiveFrameStore();
    this.fetchImpl = fetchImpl;
    this.onFrame = onFrame;
    this.activeFetches = new Set();
    this.currentSelectionKey = null;
    this.currentPreviewRequestKey = null;
    this.currentTileRequestKeys = new Set();
    this.dimensionsBySourceGeneration = new Map();
    this.frameKindBySourceGeneration = new Map();
    this.grayscaleBySourceGeneration = new Map();
    this.sampleMaxBySourceGeneration = new Map();
    this.pixelStatsBySourceGeneration = new Map();
    this.latestGenerationSeq = 0;
    this.latestPreferredSourceId = null;
    this.latestClientState = null;
    this.retryTimer = null;
  }

  public update(clientState: ClientState, preferredSourceId: string | null = null): void {
    this.latestClientState = clientState;
    this.latestPreferredSourceId = preferredSourceId;
    const latest = selectLatestGeneration(clientState, preferredSourceId);
    if (latest === null) {
      return;
    }
    const selectionKey = frameSelectionKey(
      latest.sourceId,
      latest.generationSeq,
      latest.tIndex,
      latest.zIndex,
      latest.selectedChannels,
      latest.centerX,
      latest.centerY,
      latest.zoom,
    );

    const isNewGeneration = latest.generationSeq > this.latestGenerationSeq;
    const selectionChanged = selectionKey !== this.currentSelectionKey;
    if (isNewGeneration) {
      this.scheduler.invalidateOlderGenerations(latest.generationSeq);
      this.frameStore.pruneOlderThan(latest.sourceId, latest.generationSeq);
    }
    const hasFrameForGeneration =
      this.frameStore.resolveFrame(latest.sourceId, latest.generationSeq) !== null;
    if (selectionChanged) {
      if (this.currentPreviewRequestKey !== null) {
        this.scheduler.cancel(this.currentPreviewRequestKey);
      }
      for (const tileRequestKey of this.currentTileRequestKeys) {
        this.scheduler.cancel(tileRequestKey);
      }
      this.currentTileRequestKeys = new Set();
      this.currentSelectionKey = selectionKey;
      this.currentPreviewRequestKey = requestKey(
        "preview",
        latest.sourceId,
        latest.generationSeq,
        latest.tIndex,
        latest.zIndex,
        latest.channelBlock,
        0,
        0,
      );
    }
    if (isNewGeneration || selectionChanged || !hasFrameForGeneration) {
      void this.fetchPreviewThenTiles(
        latest.sourceId,
        latest.generationSeq,
        latest.tIndex,
        latest.zIndex,
        latest.channelBlock,
        latest.centerX,
        latest.centerY,
        latest.zoom,
        latest.tileLayout,
        selectionKey,
      );
    }
  }

  public dispose(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private async fetchPreviewThenTiles(
    sourceId: string,
    generationSeq: number,
    tIndex: number,
    zIndex: number,
    channelBlock: number,
    centerX: number,
    centerY: number,
    zoom: number,
    tileLayout: TileLayout | null,
    selectionKey: string,
  ): Promise<void> {
    const fetchKey = selectionKey;
    if (this.activeFetches.has(fetchKey)) {
      return;
    }
    const previewRequestKey = requestKey(
      "preview",
      sourceId,
      generationSeq,
      tIndex,
      zIndex,
      channelBlock,
      0,
      0,
    );
    const tileSelection = effectiveTileSelection(tIndex, zIndex, channelBlock);
    const visibleTileTargets = resolveVisibleTileTargets(
      tileLayout,
      tileSelection,
      centerX,
      centerY,
      zoom,
    );
    this.currentTileRequestKeys = new Set(
      visibleTileTargets.map((target) =>
        requestKey(
          "tile",
          sourceId,
          generationSeq,
          tileSelection.t,
          tileSelection.z,
          tileSelection.channelBlock,
          target.row,
          target.col,
        ),
      ),
    );
    this.activeFetches.add(fetchKey);
    try {
      const preview = await this.scheduler.schedule<DecodedFrame>({
        key: previewRequestKey,
        generationSeq,
        priorityClass: "coarse_fallback",
        execute: (signal) => {
          return this.fetchFrame(
            {
              sourceId,
              generationSeq,
              assetKind: "preview2d",
              lod: 0,
              t: tIndex,
              z: zIndex,
              channelBlock,
              y: 0,
              x: 0,
            },
            signal,
          );
        },
      });
      if (this.currentSelectionKey !== selectionKey) {
        this.activeFetches.delete(fetchKey);
        return;
      }
      if (generationSeq > this.latestGenerationSeq) {
        this.latestGenerationSeq = generationSeq;
      }
      const sourceGeneration = sourceGenerationKey(sourceId, generationSeq);
      this.dimensionsBySourceGeneration.set(sourceGeneration, {
        width: preview.width,
        height: preview.height,
      });
      this.frameKindBySourceGeneration.set(sourceGeneration, "preview");
      this.grayscaleBySourceGeneration.set(
        sourceGeneration,
        preview.grayscaleSamples,
      );
      this.sampleMaxBySourceGeneration.set(sourceGeneration, preview.sampleMax);
      this.pixelStatsBySourceGeneration.set(sourceGeneration, preview.pixelStats);
      this.frameStore.setPreview(sourceId, generationSeq, preview.rgba);
      this.emit(sourceId, generationSeq);
    } catch (error) {
      if (!isCancellationError(error) && this.currentSelectionKey === selectionKey) {
        console.error("preview fetch failed", error);
        this.scheduleRetry();
      }
      this.activeFetches.delete(fetchKey);
      return;
    }

    let emittedTile = false;
    let tileFailure: unknown = null;
    for (let index = 0; index < visibleTileTargets.length; index += 1) {
      if (this.currentSelectionKey !== selectionKey) {
        this.activeFetches.delete(fetchKey);
        return;
      }
      const target = visibleTileTargets[index];
      if (target === undefined) {
        continue;
      }
      const tileRequestKey = requestKey(
        "tile",
        sourceId,
        generationSeq,
        tileSelection.t,
        tileSelection.z,
        tileSelection.channelBlock,
        target.row,
        target.col,
      );
      try {
        const tile = await this.scheduler.schedule<DecodedFrame>({
          key: tileRequestKey,
          generationSeq,
          priorityClass: index === 0 ? "visible_center" : "visible_ring",
          priority: 100 - index,
          execute: (signal) => {
            return this.fetchTileWithFallback(
              {
                sourceId,
                generationSeq,
                assetKind: "tile2d",
                lod: 0,
                t: tileSelection.t,
                z: tileSelection.z,
                channelBlock: tileSelection.channelBlock,
                y: target.row,
                x: target.col,
              },
              signal,
            );
          },
        });
        if (this.currentSelectionKey !== selectionKey) {
          this.activeFetches.delete(fetchKey);
          return;
        }
        if (!emittedTile) {
          const sourceGeneration = sourceGenerationKey(sourceId, generationSeq);
          this.dimensionsBySourceGeneration.set(sourceGeneration, {
            width: tile.width,
            height: tile.height,
          });
          this.frameKindBySourceGeneration.set(sourceGeneration, "tile");
          this.grayscaleBySourceGeneration.set(sourceGeneration, tile.grayscaleSamples);
          this.sampleMaxBySourceGeneration.set(sourceGeneration, tile.sampleMax);
          this.pixelStatsBySourceGeneration.set(sourceGeneration, tile.pixelStats);
          this.frameStore.setTiles(sourceId, generationSeq, tile.rgba);
          this.emit(sourceId, generationSeq);
          emittedTile = true;
        }
      } catch (error) {
        if (this.currentSelectionKey !== selectionKey || isCancellationError(error)) {
          this.activeFetches.delete(fetchKey);
          return;
        }
        tileFailure = error;
      }
    }
    if (!emittedTile && tileFailure !== null && this.currentSelectionKey === selectionKey) {
      // Keep preview frame active when tile refinement is unavailable.
      console.error("tile fetch failed", tileFailure);
      this.scheduleRetry();
    }
    this.activeFetches.delete(fetchKey);
  }

  private async fetchFrame(
    key: ChunkKey,
    signal: AbortSignal,
  ): Promise<DecodedFrame> {
    const url = this.resolver.resolveChunkUrl(key);
    const response = await this.fetchImpl(url, { signal });
    if (!response.ok) {
      throw new FrameFetchError(response.status, url);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const framePayload = decodeFramePayload(bytes);
    return decodePortableGraymap(framePayload);
  }

  private async fetchTileWithFallback(
    key: ChunkKey,
    signal: AbortSignal,
  ): Promise<DecodedFrame> {
    try {
      return await this.fetchFrame(key, signal);
    } catch (error) {
      if (!(error instanceof FrameFetchError) || error.status !== 404) {
        throw error;
      }
      if (key.t === 0 && key.z === 0 && key.channelBlock === 0) {
        throw error;
      }
    }
    return this.fetchFrame(
      {
        ...key,
        t: 0,
        z: 0,
        channelBlock: 0,
      },
      signal,
    );
  }

  private emit(sourceId: string, generationSeq: number): void {
    if (this.latestClientState === null) {
      return;
    }
    const sourceGeneration = sourceGenerationKey(sourceId, generationSeq);
    const frame = this.frameStore.resolveFrame(sourceId, generationSeq);
    if (frame === null) {
      return;
    }
    const dimensions = this.dimensionsBySourceGeneration.get(sourceGeneration);
    if (dimensions === undefined) {
      return;
    }
    const frameKind = this.frameKindBySourceGeneration.get(sourceGeneration);
    if (frameKind === undefined) {
      return;
    }
    const pixelStats = this.pixelStatsBySourceGeneration.get(sourceGeneration);
    if (pixelStats === undefined) {
      return;
    }
    const grayscaleSamples = this.grayscaleBySourceGeneration.get(sourceGeneration);
    if (grayscaleSamples === undefined) {
      return;
    }
    const sampleMax = this.sampleMaxBySourceGeneration.get(sourceGeneration);
    if (sampleMax === undefined) {
      return;
    }
    const sourceDtype = sourceDtypeFor(this.latestClientState, sourceId);
    const contrastSampleMax = contrastSampleMaxForDtype(sourceDtype) ?? sampleMax;

    const warnings = this.latestClientState.warnings as WarningEntry[];
    const layerList = Object.values(this.latestClientState.layers).map((layer) => ({
      layerId: layer.layerId,
      name: layer.name,
      sourceId: null,
    }));

    const minimap = buildMinimapState(
      layerList,
      null,
      this.latestClientState.activeLayerId,
      dimensions.width,
      dimensions.height,
      {
        centerX: dimensions.width / 2,
        centerY: dimensions.height / 2,
        zoom: 1,
      },
      0,
      1,
    );

    this.onFrame({
      sourceId,
      generationSeq,
      frameKind,
      width: dimensions.width,
      height: dimensions.height,
      rgba: frame,
      grayscaleSamples,
      sampleMax: contrastSampleMax,
      pixelStats,
      minimap,
      warningNotice: buildSessionNotice(warnings),
    });
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.latestClientState !== null) {
        this.update(this.latestClientState, this.latestPreferredSourceId);
      }
    }, 250);
  }
}

class FrameFetchError extends Error {
  public readonly status: number;

  public readonly url: string;

  public constructor(status: number, url: string) {
    super(`frame fetch failed with status ${status.toString()} for ${url}`);
    this.status = status;
    this.url = url;
  }
}

function decodeFramePayload(bytes: Uint8Array): Uint8Array {
  if (isPortableGraymap(bytes)) {
    return bytes;
  }
  if (isChannelBlockPayload(bytes)) {
    return decodeChannelBlockPayload(bytes);
  }
  throw new Error("unsupported frame payload format");
}

function isPortableGraymap(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x35;
}

function isChannelBlockPayload(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x4c &&
    bytes[1] === 0x43 &&
    bytes[2] === 0x42 &&
    bytes[3] === 0x4b
  );
}

function decodeChannelBlockPayload(bytes: Uint8Array): Uint8Array {
  const headerLength = 20;
  if (bytes.length < headerLength) {
    throw new Error("channel block payload is shorter than header");
  }
  const version = bytes[4] ?? -1;
  if (version !== 1) {
    throw new Error(`unsupported channel block version ${version.toString()}`);
  }
  const codec = bytes[6] ?? -1;
  const encodedLength = readUint32LE(bytes, 12);
  const decodedLength = readUint32LE(bytes, 16);
  const payloadStart = headerLength;
  const payloadEnd = payloadStart + encodedLength;
  if (payloadEnd > bytes.length) {
    throw new Error("channel block encoded length exceeds payload size");
  }
  const encodedPayload = bytes.slice(payloadStart, payloadEnd);

  let decodedPayload: Uint8Array;
  if (codec === 0) {
    decodedPayload = encodedPayload;
  } else {
    throw new Error(
      `unsupported channel block codec ${codec.toString()} in browser runtime`,
    );
  }
  if (decodedPayload.length !== decodedLength) {
    throw new Error("channel block decoded length mismatch");
  }
  return decodedPayload;
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  );
}

function selectLatestGeneration(
  clientState: ClientState,
  preferredSourceId: string | null,
): {
  sourceId: string;
  generationSeq: number;
  tIndex: number;
  zIndex: number;
  selectedChannels: number[];
  channelBlock: number;
  centerX: number;
  centerY: number;
  zoom: number;
  tileLayout: TileLayout | null;
} | null {
  const selectedChannels = [...clientState.selectedChannels];
  const channelBlock = selectedChannelBlock(selectedChannels);
  if (preferredSourceId !== null) {
    const preferred = clientState.sources[preferredSourceId];
    if (preferred !== undefined && preferred.latestWorkingGenerationSeq > 0) {
      return {
        sourceId: preferred.sourceId,
        generationSeq: preferred.latestWorkingGenerationSeq,
        tIndex: clientState.tIndex,
        zIndex: clientState.zIndex,
        selectedChannels,
        channelBlock,
        centerX: clientState.centerX,
        centerY: clientState.centerY,
        zoom: clientState.zoom,
        tileLayout: lod0TileLayoutForGeneration(
          clientState,
          preferred.sourceId,
          preferred.latestWorkingGenerationSeq,
        ),
      };
    }
  }

  const sourceValues = Object.values(clientState.sources);
  let latest:
    | {
        sourceId: string;
        generationSeq: number;
        tIndex: number;
        zIndex: number;
        selectedChannels: number[];
        channelBlock: number;
        centerX: number;
        centerY: number;
        zoom: number;
        tileLayout: TileLayout | null;
      }
    | null = null;
  for (const source of sourceValues) {
    if (source.latestWorkingGenerationSeq <= 0) {
      continue;
    }
    if (
      latest === null ||
      source.latestWorkingGenerationSeq >= latest.generationSeq
    ) {
      latest = {
        sourceId: source.sourceId,
        generationSeq: source.latestWorkingGenerationSeq,
        tIndex: clientState.tIndex,
        zIndex: clientState.zIndex,
        selectedChannels,
        channelBlock,
        centerX: clientState.centerX,
        centerY: clientState.centerY,
        zoom: clientState.zoom,
        tileLayout: lod0TileLayoutForGeneration(
          clientState,
          source.sourceId,
          source.latestWorkingGenerationSeq,
        ),
      };
    }
  }
  return latest;
}

function lod0TileLayoutForGeneration(
  clientState: ClientState,
  sourceId: string,
  generationSeq: number,
): TileLayout | null {
  const generation = clientState.generations[sourceGenerationKey(sourceId, generationSeq)];
  if (generation === undefined || generation.tileLayout === null || generation.tileLayout === undefined) {
    return null;
  }
  return generation.tileLayout;
}

type VisibleTileTarget = {
  row: number;
  col: number;
};

function resolveVisibleTileTargets(
  tileLayout: TileLayout | null,
  selection: { t: number; z: number; channelBlock: number },
  centerX: number,
  centerY: number,
  zoom: number,
): VisibleTileTarget[] {
  void selection;
  if (tileLayout === null) {
    return [{ row: 0, col: 0 }];
  }
  const lod0 = tileLayout.lods.find((lod) => lod.lod === 0) ?? tileLayout.lods[0];
  if (lod0 === undefined) {
    return [{ row: 0, col: 0 }];
  }
  return visibleTileTargetsForViewport(lod0, centerX, centerY, zoom);
}

function visibleTileTargetsForViewport(
  lod: TileLodLayout,
  centerX: number,
  centerY: number,
  zoom: number,
): VisibleTileTarget[] {
  const normalizedZoom = Number.isFinite(zoom) ? Math.max(zoom, 0.01) : 1;
  const imageWidth = Math.max(1, Math.floor(lod.width));
  const imageHeight = Math.max(1, Math.floor(lod.height));
  const tileWidth = Math.max(1, Math.floor(lod.tileWidth));
  const tileHeight = Math.max(1, Math.floor(lod.tileHeight));
  const maxCol = Math.max(0, Math.floor(lod.cols) - 1);
  const maxRow = Math.max(0, Math.floor(lod.rows) - 1);

  const halfVisibleWidth = imageWidth / (2 * normalizedZoom);
  const halfVisibleHeight = imageHeight / (2 * normalizedZoom);
  const minX = clamp(centerX - halfVisibleWidth, 0, imageWidth - 1);
  const maxX = clamp(centerX + halfVisibleWidth, 0, imageWidth - 1);
  const minY = clamp(centerY - halfVisibleHeight, 0, imageHeight - 1);
  const maxY = clamp(centerY + halfVisibleHeight, 0, imageHeight - 1);

  const startCol = clamp(Math.floor(minX / tileWidth), 0, maxCol);
  const endCol = clamp(Math.floor(maxX / tileWidth), 0, maxCol);
  const startRow = clamp(Math.floor(minY / tileHeight), 0, maxRow);
  const endRow = clamp(Math.floor(maxY / tileHeight), 0, maxRow);
  const centerCol = clamp(Math.floor(centerX / tileWidth), 0, maxCol);
  const centerRow = clamp(Math.floor(centerY / tileHeight), 0, maxRow);

  const targets: VisibleTileTarget[] = [];
  for (let row = startRow; row <= endRow; row += 1) {
    for (let col = startCol; col <= endCol; col += 1) {
      targets.push({ row, col });
    }
  }
  targets.sort((left, right) => {
    const leftDistance = Math.abs(left.row - centerRow) + Math.abs(left.col - centerCol);
    const rightDistance =
      Math.abs(right.row - centerRow) + Math.abs(right.col - centerCol);
    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance;
    }
    if (left.row !== right.row) {
      return left.row - right.row;
    }
    return left.col - right.col;
  });
  return targets;
}

function frameSelectionKey(
  sourceId: string,
  generationSeq: number,
  tIndex: number,
  zIndex: number,
  selectedChannels: number[],
  centerX: number,
  centerY: number,
  zoom: number,
): string {
  return `${sourceId}:${generationSeq.toString()}:t${tIndex.toString()}:z${zIndex.toString()}:c${selectedChannels.join(",")}:cx${centerX.toFixed(3)}:cy${centerY.toFixed(3)}:zm${zoom.toFixed(3)}`;
}

function sourceGenerationKey(sourceId: string, generationSeq: number): string {
  return `${sourceId}:${generationSeq.toString()}`;
}

function sourceDtypeFor(clientState: ClientState, sourceId: string): string | null {
  for (const dataset of Object.values(clientState.datasets)) {
    if (dataset.sourceId === sourceId) {
      return typeof dataset.dtype === "string" ? dataset.dtype : null;
    }
  }
  return null;
}

function contrastSampleMaxForDtype(dtype: string | null): number | null {
  if (dtype === null) {
    return null;
  }
  switch (dtype) {
    case "uint8":
    case "int8":
      return 255;
    case "uint16":
    case "int16":
    case "uint32":
    case "int32":
    case "uint64":
    case "int64":
    case "float32":
    case "float64":
      return 65535;
    default:
      return null;
  }
}

function requestKey(
  kind: "preview" | "tile",
  sourceId: string,
  generationSeq: number,
  tIndex: number,
  zIndex: number,
  channelBlock: number,
  yIndex: number,
  xIndex: number,
): string {
  return `${kind}:${sourceId}:${generationSeq.toString()}:t${tIndex.toString()}:z${zIndex.toString()}:cb${channelBlock.toString()}:y${yIndex.toString()}:x${xIndex.toString()}`;
}

function selectedChannelBlock(channels: readonly number[]): number {
  const primary = channels[0] ?? 0;
  if (!Number.isFinite(primary) || primary < 0) {
    return 0;
  }
  return Math.floor(primary);
}

function isCancellationError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes("abort") ||
      message.includes("cancel") ||
      message.includes("invalidat") ||
      message.includes("supersed")
    );
  }
  return false;
}

function effectiveTileSelection(
  tIndex: number,
  zIndex: number,
  channelBlock: number,
): { t: number; z: number; channelBlock: number } {
  return { t: tIndex, z: zIndex, channelBlock };
}

function decodePortableGraymap(bytes: Uint8Array): DecodedFrame {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x35) {
    throw new Error("payload is not a binary PGM (P5) frame");
  }

  let index = 2;
  const tokens: string[] = [];
  while (tokens.length < 3) {
    while (index < bytes.length && isWhitespace(bytes[index] ?? 0)) {
      index += 1;
    }
    if (bytes[index] === 0x23) {
      while (index < bytes.length && bytes[index] !== 0x0a) {
        index += 1;
      }
      continue;
    }
    const start = index;
    while (index < bytes.length && !isWhitespace(bytes[index] ?? 0)) {
      index += 1;
    }
    if (index === start) {
      throw new Error("invalid PGM header");
    }
    const token = new TextDecoder().decode(bytes.slice(start, index));
    tokens.push(token);
  }

  const width = Number.parseInt(tokens[0] ?? "", 10);
  const height = Number.parseInt(tokens[1] ?? "", 10);
  const maxValue = Number.parseInt(tokens[2] ?? "", 10);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    !Number.isFinite(maxValue) ||
    maxValue <= 0 ||
    maxValue > 65535
  ) {
    throw new Error("unsupported PGM dimensions or max value");
  }

  index = consumePgmHeaderDelimiter(bytes, index);
  const pixelCount = width * height;
  const payload = bytes.slice(index);
  const bytesPerSample = maxValue <= 255 ? 1 : 2;
  const expectedPayloadLength = pixelCount * bytesPerSample;
  if (payload.length < expectedPayloadLength) {
    throw new Error("PGM payload is truncated");
  }

  const grayscaleSamples = new Uint16Array(pixelCount);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let nonZeroCount = 0;
  let sum = 0;
  if (bytesPerSample === 1) {
    for (let i = 0; i < pixelCount; i += 1) {
      const value = payload[i] ?? 0;
      grayscaleSamples[i] = value;
      if (value < min) {
        min = value;
      }
      if (value > max) {
        max = value;
      }
      if (value !== 0) {
        nonZeroCount += 1;
      }
      sum += value;
    }
  } else {
    for (let i = 0; i < pixelCount; i += 1) {
      const sampleOffset = i * 2;
      const value = ((payload[sampleOffset] ?? 0) << 8) | (payload[sampleOffset + 1] ?? 0);
      grayscaleSamples[i] = value;
      if (value < min) {
        min = value;
      }
      if (value > max) {
        max = value;
      }
      if (value !== 0) {
        nonZeroCount += 1;
      }
      sum += value;
    }
  }

  const autoWindow = normalizedAutoWindow(min, max, maxValue);
  const rgba = new Uint8ClampedArray(pixelCount * 4);
  const span = autoWindow.max - autoWindow.min;
  for (let i = 0; i < pixelCount; i += 1) {
    const sample = grayscaleSamples[i] ?? 0;
    const value = mapSampleToDisplay(sample, autoWindow.min, span);
    const offset = i * 4;
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }

  return {
    width,
    height,
    rgba,
    grayscaleSamples,
    sampleMax: maxValue,
    pixelStats: {
      min,
      max,
      nonZeroRatio: nonZeroCount / pixelCount,
      mean: sum / pixelCount,
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  if (value <= min) {
    return min;
  }
  if (value >= max) {
    return max;
  }
  return value;
}

function isWhitespace(value: number): boolean {
  return value === 0x20 || value === 0x09 || value === 0x0a || value === 0x0d;
}

function consumePgmHeaderDelimiter(bytes: Uint8Array, index: number): number {
  if (index >= bytes.length) {
    throw new Error("PGM payload is truncated");
  }
  const delimiter = bytes[index] ?? 0;
  if (!isWhitespace(delimiter)) {
    throw new Error("invalid PGM header delimiter");
  }
  let next = index + 1;
  // Accept CRLF as a single line ending delimiter without discarding payload bytes.
  if (delimiter === 0x0d && (bytes[next] ?? -1) === 0x0a) {
    next += 1;
  }
  return next;
}

function normalizedAutoWindow(
  min: number,
  max: number,
  sampleMax: number,
): { min: number; max: number } {
  if (max <= min) {
    return {
      min: 0,
      max: sampleMax,
    };
  }
  return { min, max };
}

function mapSampleToDisplay(
  value: number,
  min: number,
  span: number,
): number {
  if (value <= min) {
    return 0;
  }
  if (value >= min + span) {
    return 255;
  }
  if (span <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(255, Math.round(((value - min) * 255) / span)));
}
