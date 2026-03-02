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
  renderedSelection: RenderFrameSelection;
  targetSelection: RenderFrameSelection;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  grayscaleSamples: Uint16Array;
  sampleMax: number;
  pixelStats: FramePixelStats;
  minimap: MinimapState;
  warningNotice: string | null;
  loadingNotice: string | null;
};

export type RenderFrameSelection = {
  tIndex: number;
  zIndex: number;
  selectedChannels: number[];
  channelBlock: number;
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
const CHURN_WINDOW_MS = 600;
const CHURN_THRESHOLD = 3;
const PREFETCH_NEIGHBOR_LIMIT = 8;
const PREFETCH_REFINE_LIMIT = 6;

export class LiveRenderLoop {
  private readonly resolver: EngineDataPlaneUrlResolver;
  private readonly scheduler: RequestScheduler;
  private readonly frameStore: ProgressiveFrameStore;
  private readonly fetchImpl: FetchLike;
  private readonly onFrame: (state: RenderFrameState) => void;
  private readonly activeFetches: Set<string>;
  private currentSelectionKey: string | null;
  private currentDataSelectionKey: string | null;
  private currentPreviewRequestKey: string | null;
  private currentTileRequestKeys: Set<string>;
  private currentPrefetchRequestKeys: Set<string>;
  private selectionChangeTimestampsMs: number[];
  private dimensionsBySourceGeneration: Map<string, { width: number; height: number }>;
  private frameKindBySourceGeneration: Map<string, "preview" | "tile">;
  private grayscaleBySourceGeneration: Map<string, Uint16Array>;
  private sampleMaxBySourceGeneration: Map<string, number>;
  private pixelStatsBySourceGeneration: Map<string, FramePixelStats>;
  private renderedSelectionBySourceGeneration: Map<string, RenderFrameSelection>;
  private requestedSelectionBySourceGeneration: Map<string, RenderFrameSelection>;
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
    this.currentDataSelectionKey = null;
    this.currentPreviewRequestKey = null;
    this.currentTileRequestKeys = new Set();
    this.currentPrefetchRequestKeys = new Set();
    this.selectionChangeTimestampsMs = [];
    this.dimensionsBySourceGeneration = new Map();
    this.frameKindBySourceGeneration = new Map();
    this.grayscaleBySourceGeneration = new Map();
    this.sampleMaxBySourceGeneration = new Map();
    this.pixelStatsBySourceGeneration = new Map();
    this.renderedSelectionBySourceGeneration = new Map();
    this.requestedSelectionBySourceGeneration = new Map();
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
    const dataSelectionKey = frameDataSelectionKey(
      latest.sourceId,
      latest.generationSeq,
      latest.tIndex,
      latest.zIndex,
      latest.selectedChannels,
    );

    const isNewGeneration = latest.generationSeq > this.latestGenerationSeq;
    const selectionChanged = selectionKey !== this.currentSelectionKey;
    const dataSelectionChanged = dataSelectionKey !== this.currentDataSelectionKey;
    const now = Date.now();
    if (isNewGeneration) {
      this.scheduler.invalidateOlderGenerations(latest.generationSeq);
      this.frameStore.pruneOlderThan(latest.sourceId, latest.generationSeq);
    }
    const sourceGeneration = sourceGenerationKey(latest.sourceId, latest.generationSeq);
    const targetSelection: RenderFrameSelection = {
      tIndex: latest.tIndex,
      zIndex: latest.zIndex,
      selectedChannels: [...latest.selectedChannels],
      channelBlock: latest.channelBlock,
    };
    this.requestedSelectionBySourceGeneration.set(sourceGeneration, targetSelection);
    const previewLods = previewLodCandidatesForGeneration(
      clientState,
      latest.sourceId,
      latest.generationSeq,
      latest.tileLayout,
    );
    const previewStartLod = previewLods[0] ?? 0;
    const hasFrameForGeneration =
      this.frameStore.resolveFrame(latest.sourceId, latest.generationSeq) !== null;
    const hasTileFrameForGeneration =
      this.frameKindBySourceGeneration.get(sourceGeneration) === "tile";
    const hasFrameMetadataForGeneration =
      this.dimensionsBySourceGeneration.has(sourceGeneration) &&
      this.grayscaleBySourceGeneration.has(sourceGeneration) &&
      this.sampleMaxBySourceGeneration.has(sourceGeneration) &&
      this.pixelStatsBySourceGeneration.has(sourceGeneration);
    if (selectionChanged) {
      if (this.currentPreviewRequestKey !== null) {
        this.scheduler.cancel(this.currentPreviewRequestKey);
      }
      for (const tileRequestKey of this.currentTileRequestKeys) {
        this.scheduler.cancel(tileRequestKey);
      }
      for (const prefetchRequestKey of this.currentPrefetchRequestKeys) {
        this.scheduler.cancel(prefetchRequestKey);
      }
      this.currentTileRequestKeys = new Set();
      this.currentPrefetchRequestKeys = new Set();
      this.recordSelectionChange(now);
      this.currentSelectionKey = selectionKey;
      this.currentDataSelectionKey = dataSelectionKey;
      this.currentPreviewRequestKey = requestKey(
        "preview",
        latest.sourceId,
        latest.generationSeq,
        latest.tIndex,
        latest.zIndex,
        latest.channelBlock,
        previewStartLod,
        0,
        0,
      );
    }
    const skipPreviewFetch =
      selectionChanged &&
      !isNewGeneration &&
      !dataSelectionChanged &&
      hasTileFrameForGeneration &&
      hasFrameMetadataForGeneration;
    const deferPreviewPresentation =
      selectionChanged &&
      dataSelectionChanged &&
      hasFrameForGeneration &&
      hasFrameMetadataForGeneration;
    if (
      deferPreviewPresentation
    ) {
      this.emit(latest.sourceId, latest.generationSeq);
    }
    if (selectionChanged && dataSelectionChanged) {
      this.frameStore.clearGeneration(latest.sourceId, latest.generationSeq);
      this.frameKindBySourceGeneration.delete(sourceGeneration);
      this.grayscaleBySourceGeneration.delete(sourceGeneration);
      this.sampleMaxBySourceGeneration.delete(sourceGeneration);
      this.pixelStatsBySourceGeneration.delete(sourceGeneration);
      this.renderedSelectionBySourceGeneration.delete(sourceGeneration);
    }
    if (isNewGeneration || selectionChanged || !hasFrameForGeneration) {
      if (skipPreviewFetch) {
        this.currentPreviewRequestKey = null;
      }
      const prefetchEnabled = !this.isInteractionChurnHigh(now);
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
        previewLods,
        targetSelection,
        !deferPreviewPresentation,
        selectionKey,
        prefetchEnabled,
        skipPreviewFetch,
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
    previewLods: number[],
    targetSelection: RenderFrameSelection,
    emitPreviewFrame: boolean,
    selectionKey: string,
    prefetchEnabled: boolean,
    skipPreviewFetch: boolean,
  ): Promise<void> {
    const fetchKey = selectionKey;
    if (this.activeFetches.has(fetchKey)) {
      return;
    }
    const tileSelection = effectiveTileSelection(tIndex, zIndex, channelBlock);
    const visibleTileLod = finestLodIndex(tileLayout);
    const visibleTileTargets = resolveVisibleTileTargets(
      tileLayout,
      tileSelection,
      centerX,
      centerY,
      zoom,
      visibleTileLod,
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
          visibleTileLod,
          target.row,
          target.col,
        ),
      ),
    );
    this.activeFetches.add(fetchKey);
    let tileCanvas: TileCanvasGeometry | null = null;
    let previewRendered = false;
    if (skipPreviewFetch) {
      if (generationSeq > this.latestGenerationSeq) {
        this.latestGenerationSeq = generationSeq;
      }
      const sourceGeneration = sourceGenerationKey(sourceId, generationSeq);
      const dimensions = this.dimensionsBySourceGeneration.get(sourceGeneration);
      if (dimensions !== undefined) {
        tileCanvas = resolveTileCanvasGeometry(
          tileLayout,
          dimensions.width,
          dimensions.height,
        );
      }
    } else {
      const previewResult = await this.fetchCoarsePreviewForSelection({
        sourceId,
        generationSeq,
        tIndex,
        zIndex,
        channelBlock,
        tileLayout,
        previewLods,
        targetSelection,
        emitPreviewFrame,
        selectionKey,
      });
      if (previewResult.cancelled) {
        this.activeFetches.delete(fetchKey);
        return;
      }
      tileCanvas = previewResult.tileCanvas;
      previewRendered = previewResult.previewRendered;
    }

    let emittedTile = false;
    let prefetchQueued = false;
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
        visibleTileLod,
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
            return this.fetchFrame(
              {
                sourceId,
                generationSeq,
                assetKind: "tile2d",
                lod: visibleTileLod,
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
        const sourceGeneration = sourceGenerationKey(sourceId, generationSeq);
        const canvas = tileCanvas ?? {
          width: tile.width,
          height: tile.height,
          tileWidth: tile.width,
          tileHeight: tile.height,
        };
        this.dimensionsBySourceGeneration.set(sourceGeneration, {
          width: canvas.width,
          height: canvas.height,
        });
        this.frameKindBySourceGeneration.set(sourceGeneration, "tile");
        this.grayscaleBySourceGeneration.set(sourceGeneration, tile.grayscaleSamples);
        this.sampleMaxBySourceGeneration.set(sourceGeneration, tile.sampleMax);
        this.pixelStatsBySourceGeneration.set(sourceGeneration, tile.pixelStats);
        this.renderedSelectionBySourceGeneration.set(
          sourceGeneration,
          cloneFrameSelection(targetSelection),
        );
        this.frameStore.composeTilePatch(sourceId, generationSeq, {
          canvasWidth: canvas.width,
          canvasHeight: canvas.height,
          offsetX: target.col * canvas.tileWidth,
          offsetY: target.row * canvas.tileHeight,
          width: tile.width,
          height: tile.height,
          rgba: tile.rgba,
        });
        this.emit(sourceId, generationSeq);
        emittedTile = true;
        if (prefetchEnabled && !prefetchQueued) {
          this.queuePrefetchRequests({
            sourceId,
            generationSeq,
            tIndex: tileSelection.t,
            zIndex: tileSelection.z,
            channelBlock: tileSelection.channelBlock,
            tileLayout,
            visibleTargets: visibleTileTargets,
            selectionKey,
          });
          prefetchQueued = true;
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
      console.error("tile fetch failed", tileFailure);
      this.scheduleRetry();
    }
    if (!emittedTile && !previewRendered && this.currentSelectionKey === selectionKey) {
      this.scheduleRetry();
    }
    this.activeFetches.delete(fetchKey);
  }

  private async fetchCoarsePreviewForSelection(input: {
    sourceId: string;
    generationSeq: number;
    tIndex: number;
    zIndex: number;
    channelBlock: number;
    tileLayout: TileLayout | null;
    previewLods: number[];
    targetSelection: RenderFrameSelection;
    emitPreviewFrame: boolean;
    selectionKey: string;
  }): Promise<{ cancelled: boolean; previewRendered: boolean; tileCanvas: TileCanvasGeometry | null }> {
    const sourceGeneration = sourceGenerationKey(input.sourceId, input.generationSeq);
    const dimensions = this.dimensionsBySourceGeneration.get(sourceGeneration);
    let tileCanvas =
      dimensions === undefined
        ? null
        : resolveTileCanvasGeometry(input.tileLayout, dimensions.width, dimensions.height);
    const lodCandidates = input.previewLods.length === 0 ? [0] : input.previewLods;
    let sawNon404PreviewFailure = false;
    for (const previewLod of lodCandidates) {
      const previewRequestKey = requestKey(
        "preview",
        input.sourceId,
        input.generationSeq,
        input.tIndex,
        input.zIndex,
        input.channelBlock,
        previewLod,
        0,
        0,
      );
      this.currentPreviewRequestKey = previewRequestKey;
      try {
        const preview = await this.scheduler.schedule<DecodedFrame>({
          key: previewRequestKey,
          generationSeq: input.generationSeq,
          priorityClass: "coarse_fallback",
          execute: (signal) => {
            return this.fetchFrame(
              {
                sourceId: input.sourceId,
                generationSeq: input.generationSeq,
                assetKind: "preview2d",
                lod: previewLod,
                t: input.tIndex,
                z: input.zIndex,
                channelBlock: input.channelBlock,
                y: 0,
                x: 0,
              },
              signal,
            );
          },
        });
        if (this.currentSelectionKey !== input.selectionKey) {
          return { cancelled: true, previewRendered: false, tileCanvas };
        }
        if (input.generationSeq > this.latestGenerationSeq) {
          this.latestGenerationSeq = input.generationSeq;
        }
        tileCanvas = resolveTileCanvasGeometry(input.tileLayout, preview.width, preview.height);
        const normalizedPreview = frameForCanvas(preview, tileCanvas);
        this.dimensionsBySourceGeneration.set(sourceGeneration, {
          width: normalizedPreview.width,
          height: normalizedPreview.height,
        });
        this.frameKindBySourceGeneration.set(sourceGeneration, "preview");
        this.grayscaleBySourceGeneration.set(sourceGeneration, normalizedPreview.grayscaleSamples);
        this.sampleMaxBySourceGeneration.set(sourceGeneration, normalizedPreview.sampleMax);
        this.pixelStatsBySourceGeneration.set(sourceGeneration, normalizedPreview.pixelStats);
        this.renderedSelectionBySourceGeneration.set(
          sourceGeneration,
          cloneFrameSelection(input.targetSelection),
        );
        this.frameStore.setPreview(
          input.sourceId,
          input.generationSeq,
          normalizedPreview.rgba,
          normalizedPreview.width,
          normalizedPreview.height,
        );
        if (input.emitPreviewFrame) {
          this.emit(input.sourceId, input.generationSeq);
          return { cancelled: false, previewRendered: true, tileCanvas };
        }
        return { cancelled: false, previewRendered: false, tileCanvas };
      } catch (error) {
        if (this.currentSelectionKey !== input.selectionKey || isCancellationError(error)) {
          return { cancelled: true, previewRendered: false, tileCanvas };
        }
        if (error instanceof FrameFetchError && error.status === 404) {
          continue;
        }
        sawNon404PreviewFailure = true;
        console.error("preview fetch failed", error);
        break;
      }
    }
    if (sawNon404PreviewFailure) {
      this.scheduleRetry();
    }
    return { cancelled: false, previewRendered: false, tileCanvas };
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
    const renderedSelection = this.renderedSelectionBySourceGeneration.get(sourceGeneration);
    if (renderedSelection === undefined) {
      return;
    }
    const targetSelection =
      this.requestedSelectionBySourceGeneration.get(sourceGeneration) ?? renderedSelection;
    const loadingNotice = loadingNoticeForSelections(renderedSelection, targetSelection);
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
      renderedSelection: cloneFrameSelection(renderedSelection),
      targetSelection: cloneFrameSelection(targetSelection),
      width: dimensions.width,
      height: dimensions.height,
      rgba: frame,
      grayscaleSamples,
      sampleMax: contrastSampleMax,
      pixelStats,
      minimap,
      warningNotice: buildSessionNotice(warnings),
      loadingNotice,
    });
  }

  private queuePrefetchRequests(input: {
    sourceId: string;
    generationSeq: number;
    tIndex: number;
    zIndex: number;
    channelBlock: number;
    tileLayout: TileLayout | null;
    visibleTargets: VisibleTileTarget[];
    selectionKey: string;
  }): void {
    if (this.currentSelectionKey !== input.selectionKey) {
      return;
    }
    const plan = resolvePrefetchPlan(input.tileLayout, input.visibleTargets);
    const prefetchTargets = [
      ...plan.neighbors.slice(0, PREFETCH_NEIGHBOR_LIMIT),
      ...plan.refinements.slice(0, PREFETCH_REFINE_LIMIT),
    ];
    for (const target of prefetchTargets) {
      const prefetchKey = requestKey(
        "tile",
        input.sourceId,
        input.generationSeq,
        input.tIndex,
        input.zIndex,
        input.channelBlock,
        target.lod,
        target.row,
        target.col,
      );
      if (
        this.currentTileRequestKeys.has(prefetchKey) ||
        this.currentPrefetchRequestKeys.has(prefetchKey)
      ) {
        continue;
      }
      this.currentPrefetchRequestKeys.add(prefetchKey);
      void this.scheduler
        .schedule<DecodedFrame>({
          key: prefetchKey,
          generationSeq: input.generationSeq,
          priorityClass: target.priorityClass,
          execute: (signal) => {
            return this.fetchFrame(
              {
                sourceId: input.sourceId,
                generationSeq: input.generationSeq,
                assetKind: "tile2d",
                lod: target.lod,
                t: input.tIndex,
                z: input.zIndex,
                channelBlock: input.channelBlock,
                y: target.row,
                x: target.col,
              },
              signal,
            );
          },
        })
        .catch(() => {
          // Cancellation and 404 misses are expected in prefetch paths.
        })
        .finally(() => {
          this.currentPrefetchRequestKeys.delete(prefetchKey);
        });
    }
  }

  private recordSelectionChange(nowMs: number): void {
    this.pruneSelectionHistory(nowMs);
    this.selectionChangeTimestampsMs.push(nowMs);
  }

  private isInteractionChurnHigh(nowMs: number): boolean {
    this.pruneSelectionHistory(nowMs);
    return this.selectionChangeTimestampsMs.length >= CHURN_THRESHOLD;
  }

  private pruneSelectionHistory(nowMs: number): void {
    this.selectionChangeTimestampsMs = this.selectionChangeTimestampsMs.filter(
      (timestampMs) => nowMs - timestampMs <= CHURN_WINDOW_MS,
    );
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

function previewLodCandidatesForGeneration(
  clientState: ClientState,
  sourceId: string,
  generationSeq: number,
  tileLayout: TileLayout | null,
): number[] {
  const lods = new Set<number>();
  lods.add(0);
  const generation = clientState.generations[sourceGenerationKey(sourceId, generationSeq)];
  if (generation !== undefined) {
    for (const lod of generation.tile2dReadyLods) {
      if (Number.isFinite(lod) && lod >= 0) {
        lods.add(Math.floor(lod));
      }
    }
  }
  if (tileLayout !== null) {
    for (const lod of tileLayout.lods) {
      if (Number.isFinite(lod.lod) && lod.lod >= 0) {
        lods.add(Math.floor(lod.lod));
      }
    }
  }
  return [...lods].sort((left, right) => right - left);
}

type VisibleTileTarget = {
  row: number;
  col: number;
};

type TileCanvasGeometry = {
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
};

type PrefetchTileTarget = {
  lod: number;
  row: number;
  col: number;
  priorityClass: "prefetch_neighbor" | "prefetch_refine";
};

function resolveVisibleTileTargets(
  tileLayout: TileLayout | null,
  selection: { t: number; z: number; channelBlock: number },
  centerX: number,
  centerY: number,
  zoom: number,
  lodIndex: number,
): VisibleTileTarget[] {
  void selection;
  const visibleLod = lodLayoutForIndex(tileLayout, lodIndex);
  if (visibleLod === undefined) {
    return [{ row: 0, col: 0 }];
  }
  return visibleTileTargetsForViewport(visibleLod, centerX, centerY, zoom);
}

function resolveTileCanvasGeometry(
  tileLayout: TileLayout | null,
  fallbackWidth: number,
  fallbackHeight: number,
): TileCanvasGeometry {
  const fallback = {
    width: Math.max(1, Math.floor(fallbackWidth)),
    height: Math.max(1, Math.floor(fallbackHeight)),
    tileWidth: Math.max(1, Math.floor(fallbackWidth)),
    tileHeight: Math.max(1, Math.floor(fallbackHeight)),
  };
  const lod0 = lod0Layout(tileLayout);
  if (lod0 === undefined) {
    return fallback;
  }
  return {
    width: Math.max(1, Math.floor(lod0.width)),
    height: Math.max(1, Math.floor(lod0.height)),
    tileWidth: Math.max(1, Math.floor(lod0.tileWidth)),
    tileHeight: Math.max(1, Math.floor(lod0.tileHeight)),
  };
}

function lod0Layout(tileLayout: TileLayout | null): TileLodLayout | undefined {
  if (tileLayout === null) {
    return undefined;
  }
  return tileLayout.lods.find((lod) => lod.lod === 0) ?? tileLayout.lods[0];
}

function finestLodIndex(tileLayout: TileLayout | null): number {
  if (tileLayout === null || tileLayout.lods.length === 0) {
    return 0;
  }
  const lods = [...tileLayout.lods].sort((left, right) => left.lod - right.lod);
  return lods[0]?.lod ?? 0;
}

function lodLayoutForIndex(
  tileLayout: TileLayout | null,
  lodIndex: number,
): TileLodLayout | undefined {
  if (tileLayout === null) {
    return undefined;
  }
  return tileLayout.lods.find((lod) => lod.lod === lodIndex) ?? lod0Layout(tileLayout);
}

function resolvePrefetchPlan(
  tileLayout: TileLayout | null,
  visibleTargets: VisibleTileTarget[],
): { neighbors: PrefetchTileTarget[]; refinements: PrefetchTileTarget[] } {
  const lod0 = lod0Layout(tileLayout);
  if (lod0 === undefined || visibleTargets.length === 0 || tileLayout === null) {
    return { neighbors: [], refinements: [] };
  }
  return {
    neighbors: neighborPrefetchTargets(lod0, visibleTargets),
    refinements: refinementPrefetchTargets(tileLayout, lod0, visibleTargets),
  };
}

function neighborPrefetchTargets(
  lod0: TileLodLayout,
  visibleTargets: VisibleTileTarget[],
): PrefetchTileTarget[] {
  const visibleSet = new Set(
    visibleTargets.map((target) => `${target.row.toString()}:${target.col.toString()}`),
  );
  let minRow = Number.POSITIVE_INFINITY;
  let maxRow = Number.NEGATIVE_INFINITY;
  let minCol = Number.POSITIVE_INFINITY;
  let maxCol = Number.NEGATIVE_INFINITY;
  for (const target of visibleTargets) {
    minRow = Math.min(minRow, target.row);
    maxRow = Math.max(maxRow, target.row);
    minCol = Math.min(minCol, target.col);
    maxCol = Math.max(maxCol, target.col);
  }
  const maxRowBound = Math.max(0, Math.floor(lod0.rows) - 1);
  const maxColBound = Math.max(0, Math.floor(lod0.cols) - 1);
  const startRow = clamp(minRow - 1, 0, maxRowBound);
  const endRow = clamp(maxRow + 1, 0, maxRowBound);
  const startCol = clamp(minCol - 1, 0, maxColBound);
  const endCol = clamp(maxCol + 1, 0, maxColBound);
  const centerTarget = visibleTargets[0] ?? { row: 0, col: 0 };
  const neighbors: PrefetchTileTarget[] = [];
  for (let row = startRow; row <= endRow; row += 1) {
    for (let col = startCol; col <= endCol; col += 1) {
      if (visibleSet.has(`${row.toString()}:${col.toString()}`)) {
        continue;
      }
      neighbors.push({
        lod: 0,
        row,
        col,
        priorityClass: "prefetch_neighbor",
      });
    }
  }
  neighbors.sort((left, right) => {
    const leftDistance = tileDistance(left.row, left.col, centerTarget.row, centerTarget.col);
    const rightDistance = tileDistance(
      right.row,
      right.col,
      centerTarget.row,
      centerTarget.col,
    );
    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance;
    }
    if (left.row !== right.row) {
      return left.row - right.row;
    }
    return left.col - right.col;
  });
  return neighbors;
}

function refinementPrefetchTargets(
  tileLayout: TileLayout,
  lod0: TileLodLayout,
  visibleTargets: VisibleTileTarget[],
): PrefetchTileTarget[] {
  const lods = [...tileLayout.lods]
    .filter((lod) => lod.lod > 0)
    .sort((left, right) => left.lod - right.lod);
  const centerTarget = visibleTargets[0] ?? { row: 0, col: 0 };
  const targets: PrefetchTileTarget[] = [];
  const seen = new Set<string>();
  for (const lod of lods) {
    for (const visible of visibleTargets) {
      const mapped = mapLod0TargetToLod(visible, lod0, lod);
      const key = `${lod.lod.toString()}:${mapped.row.toString()}:${mapped.col.toString()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      targets.push({
        lod: lod.lod,
        row: mapped.row,
        col: mapped.col,
        priorityClass: "prefetch_refine",
      });
    }
  }
  targets.sort((left, right) => {
    if (left.lod !== right.lod) {
      return left.lod - right.lod;
    }
    const leftDistance = tileDistance(left.row, left.col, centerTarget.row, centerTarget.col);
    const rightDistance = tileDistance(right.row, right.col, centerTarget.row, centerTarget.col);
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

function mapLod0TargetToLod(
  visible: VisibleTileTarget,
  lod0: TileLodLayout,
  lod: TileLodLayout,
): VisibleTileTarget {
  const lod0TileWidth = Math.max(1, Math.floor(lod0.tileWidth));
  const lod0TileHeight = Math.max(1, Math.floor(lod0.tileHeight));
  const lodTileWidth = Math.max(1, Math.floor(lod.tileWidth));
  const lodTileHeight = Math.max(1, Math.floor(lod.tileHeight));
  const centerX = visible.col * lod0TileWidth + lod0TileWidth / 2;
  const centerY = visible.row * lod0TileHeight + lod0TileHeight / 2;
  const maxRow = Math.max(0, Math.floor(lod.rows) - 1);
  const maxCol = Math.max(0, Math.floor(lod.cols) - 1);
  return {
    row: clamp(Math.floor(centerY / lodTileHeight), 0, maxRow),
    col: clamp(Math.floor(centerX / lodTileWidth), 0, maxCol),
  };
}

function tileDistance(
  row: number,
  col: number,
  centerRow: number,
  centerCol: number,
): number {
  return Math.abs(row - centerRow) + Math.abs(col - centerCol);
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

function frameDataSelectionKey(
  sourceId: string,
  generationSeq: number,
  tIndex: number,
  zIndex: number,
  selectedChannels: number[],
): string {
  return `${sourceId}:${generationSeq.toString()}:t${tIndex.toString()}:z${zIndex.toString()}:c${selectedChannels.join(",")}`;
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
  lodIndex: number,
  yIndex: number,
  xIndex: number,
): string {
  return `${kind}:${sourceId}:${generationSeq.toString()}:t${tIndex.toString()}:z${zIndex.toString()}:cb${channelBlock.toString()}:lod${lodIndex.toString()}:y${yIndex.toString()}:x${xIndex.toString()}`;
}

function cloneFrameSelection(selection: RenderFrameSelection): RenderFrameSelection {
  return {
    tIndex: selection.tIndex,
    zIndex: selection.zIndex,
    selectedChannels: [...selection.selectedChannels],
    channelBlock: selection.channelBlock,
  };
}

function loadingNoticeForSelections(
  renderedSelection: RenderFrameSelection,
  targetSelection: RenderFrameSelection,
): string | null {
  if (
    renderedSelection.tIndex === targetSelection.tIndex &&
    renderedSelection.zIndex === targetSelection.zIndex &&
    renderedSelection.channelBlock === targetSelection.channelBlock &&
    renderedSelection.selectedChannels.join(",") === targetSelection.selectedChannels.join(",")
  ) {
    return null;
  }
  return `LOADING TARGET SLICE: requested z ${targetSelection.zIndex.toString()} t ${targetSelection.tIndex.toString()} channels [${targetSelection.selectedChannels.join(", ")}]; currently showing z ${renderedSelection.zIndex.toString()} t ${renderedSelection.tIndex.toString()} channels [${renderedSelection.selectedChannels.join(", ")}].`;
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

function frameForCanvas(
  frame: DecodedFrame,
  canvas: TileCanvasGeometry,
): DecodedFrame {
  if (frame.width === canvas.width && frame.height === canvas.height) {
    return frame;
  }
  const upsampledRgba = resampleRgbaNearest(
    frame.rgba,
    frame.width,
    frame.height,
    canvas.width,
    canvas.height,
  );
  const upsampledSamples = resampleU16Nearest(
    frame.grayscaleSamples,
    frame.width,
    frame.height,
    canvas.width,
    canvas.height,
  );
  return {
    width: canvas.width,
    height: canvas.height,
    rgba: upsampledRgba,
    grayscaleSamples: upsampledSamples,
    sampleMax: frame.sampleMax,
    pixelStats: pixelStatsForSamples(upsampledSamples),
  };
}

function resampleRgbaNearest(
  source: Uint8ClampedArray,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Uint8ClampedArray {
  const output = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  const widthScale = sourceWidth / targetWidth;
  const heightScale = sourceHeight / targetHeight;
  for (let row = 0; row < targetHeight; row += 1) {
    const sourceRow = Math.min(sourceHeight - 1, Math.floor(row * heightScale));
    for (let col = 0; col < targetWidth; col += 1) {
      const sourceCol = Math.min(sourceWidth - 1, Math.floor(col * widthScale));
      const sourceOffset = (sourceRow * sourceWidth + sourceCol) * 4;
      const targetOffset = (row * targetWidth + col) * 4;
      output[targetOffset] = source[sourceOffset] ?? 0;
      output[targetOffset + 1] = source[sourceOffset + 1] ?? 0;
      output[targetOffset + 2] = source[sourceOffset + 2] ?? 0;
      output[targetOffset + 3] = source[sourceOffset + 3] ?? 255;
    }
  }
  return output;
}

function resampleU16Nearest(
  source: Uint16Array,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Uint16Array {
  const output = new Uint16Array(targetWidth * targetHeight);
  const widthScale = sourceWidth / targetWidth;
  const heightScale = sourceHeight / targetHeight;
  for (let row = 0; row < targetHeight; row += 1) {
    const sourceRow = Math.min(sourceHeight - 1, Math.floor(row * heightScale));
    for (let col = 0; col < targetWidth; col += 1) {
      const sourceCol = Math.min(sourceWidth - 1, Math.floor(col * widthScale));
      const sourceIndex = sourceRow * sourceWidth + sourceCol;
      const targetIndex = row * targetWidth + col;
      output[targetIndex] = source[sourceIndex] ?? 0;
    }
  }
  return output;
}

function pixelStatsForSamples(samples: Uint16Array): FramePixelStats {
  const sampleCount = samples.length;
  if (sampleCount === 0) {
    return {
      min: 0,
      max: 0,
      nonZeroRatio: 0,
      mean: 0,
    };
  }
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let nonZeroCount = 0;
  let sum = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const value = samples[index] ?? 0;
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
  return {
    min,
    max,
    nonZeroRatio: nonZeroCount / sampleCount,
    mean: sum / sampleCount,
  };
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
