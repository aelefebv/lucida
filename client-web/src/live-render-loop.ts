import type { ClientState, WarningEntry } from "./client-store";
import type { ChunkKey } from "./chunk-key";
import { EngineDataPlaneUrlResolver } from "./object-url-resolver";
import { RequestScheduler } from "./request-scheduler";
import { ProgressiveFrameStore } from "./renderer-2d";
import { buildMinimapState, type MinimapState } from "./minimap";
import { buildSessionNotice } from "./warning-surface";

export type RenderFrameState = {
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
  private currentTileRequestKey: string | null;
  private dimensionsByGeneration: Map<number, { width: number; height: number }>;
  private frameKindByGeneration: Map<number, "preview" | "tile">;
  private grayscaleByGeneration: Map<number, Uint16Array>;
  private sampleMaxByGeneration: Map<number, number>;
  private pixelStatsByGeneration: Map<number, FramePixelStats>;
  private latestGenerationSeq: number;
  private latestClientState: ClientState | null;
  private retryTimer: ReturnType<typeof setTimeout> | null;

  public constructor(
    dataBase: string,
    onFrame: (state: RenderFrameState) => void,
    fetchImpl: FetchLike = defaultFetchImpl,
  ) {
    this.resolver = new EngineDataPlaneUrlResolver(dataBase);
    this.scheduler = new RequestScheduler(2);
    this.frameStore = new ProgressiveFrameStore();
    this.fetchImpl = fetchImpl;
    this.onFrame = onFrame;
    this.activeFetches = new Set();
    this.currentSelectionKey = null;
    this.currentPreviewRequestKey = null;
    this.currentTileRequestKey = null;
    this.dimensionsByGeneration = new Map();
    this.frameKindByGeneration = new Map();
    this.grayscaleByGeneration = new Map();
    this.sampleMaxByGeneration = new Map();
    this.pixelStatsByGeneration = new Map();
    this.latestGenerationSeq = 0;
    this.latestClientState = null;
    this.retryTimer = null;
  }

  public update(clientState: ClientState): void {
    this.latestClientState = clientState;
    const latest = selectLatestGeneration(clientState);
    if (latest === null) {
      return;
    }
    const selectionKey = frameSelectionKey(
      latest.sourceId,
      latest.generationSeq,
      latest.tIndex,
      latest.zIndex,
    );

    const isNewGeneration = latest.generationSeq > this.latestGenerationSeq;
    const selectionChanged = selectionKey !== this.currentSelectionKey;
    if (isNewGeneration) {
      this.scheduler.invalidateOlderGenerations(latest.generationSeq);
      this.frameStore.pruneOlderThan(latest.generationSeq);
    }
    const hasFrameForGeneration =
      this.frameStore.resolveFrame(latest.generationSeq) !== null;
    if (selectionChanged) {
      if (this.currentPreviewRequestKey !== null) {
        this.scheduler.cancel(this.currentPreviewRequestKey);
      }
      if (this.currentTileRequestKey !== null) {
        this.scheduler.cancel(this.currentTileRequestKey);
      }
      this.currentSelectionKey = selectionKey;
      this.currentPreviewRequestKey = requestKey(
        "preview",
        latest.sourceId,
        latest.generationSeq,
        latest.tIndex,
        latest.zIndex,
      );
      this.currentTileRequestKey = requestKey(
        "tile",
        latest.sourceId,
        latest.generationSeq,
        latest.tIndex,
        latest.zIndex,
      );
    }
    if (isNewGeneration || selectionChanged || !hasFrameForGeneration) {
      void this.fetchPreviewThenTiles(
        latest.sourceId,
        latest.generationSeq,
        latest.tIndex,
        latest.zIndex,
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
    );
    const tileRequestKey = requestKey(
      "tile",
      sourceId,
      generationSeq,
      tIndex,
      zIndex,
    );
    this.activeFetches.add(fetchKey);
    try {
      const preview = await this.scheduler.schedule<DecodedFrame>({
        key: previewRequestKey,
        generationSeq,
        priority: 20,
        execute: (signal) => {
          return this.fetchFrame(
            {
              sourceId,
              generationSeq,
              assetKind: "preview2d",
              lod: 0,
              t: tIndex,
              z: zIndex,
              channelBlock: 0,
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
      this.dimensionsByGeneration.set(generationSeq, {
        width: preview.width,
        height: preview.height,
      });
      this.frameKindByGeneration.set(generationSeq, "preview");
      this.grayscaleByGeneration.set(generationSeq, preview.grayscaleSamples);
      this.sampleMaxByGeneration.set(generationSeq, preview.sampleMax);
      this.pixelStatsByGeneration.set(generationSeq, preview.pixelStats);
      this.frameStore.setPreview(generationSeq, preview.rgba);
      this.emit(generationSeq);
    } catch (error) {
      console.error("preview fetch failed", error);
      this.scheduleRetry();
      this.activeFetches.delete(fetchKey);
      return;
    }

    try {
      const tile = await this.scheduler.schedule<DecodedFrame>({
        key: tileRequestKey,
        generationSeq,
        priority: 10,
        execute: (signal) => {
          return this.fetchFrame(
            {
              sourceId,
              generationSeq,
              assetKind: "tile2d",
              lod: 0,
              t: tIndex,
              z: zIndex,
              channelBlock: 0,
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
      this.dimensionsByGeneration.set(generationSeq, {
        width: tile.width,
        height: tile.height,
      });
      this.frameKindByGeneration.set(generationSeq, "tile");
      this.grayscaleByGeneration.set(generationSeq, tile.grayscaleSamples);
      this.sampleMaxByGeneration.set(generationSeq, tile.sampleMax);
      this.pixelStatsByGeneration.set(generationSeq, tile.pixelStats);
      this.frameStore.setTiles(generationSeq, tile.rgba);
      this.emit(generationSeq);
    } catch (error) {
      // Keep preview frame active when tile refinement is unavailable.
      console.error("tile fetch failed", error);
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
      throw new Error(
        `frame fetch failed with status ${response.status.toString()} for ${url}`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const framePayload = decodeFramePayload(bytes);
    return decodePortableGraymap(framePayload);
  }

  private emit(generationSeq: number): void {
    if (this.latestClientState === null) {
      return;
    }
    const frame = this.frameStore.resolveFrame(generationSeq);
    if (frame === null) {
      return;
    }
    const dimensions = this.dimensionsByGeneration.get(generationSeq);
    if (dimensions === undefined) {
      return;
    }
    const frameKind = this.frameKindByGeneration.get(generationSeq);
    if (frameKind === undefined) {
      return;
    }
    const pixelStats = this.pixelStatsByGeneration.get(generationSeq);
    if (pixelStats === undefined) {
      return;
    }
    const grayscaleSamples = this.grayscaleByGeneration.get(generationSeq);
    if (grayscaleSamples === undefined) {
      return;
    }
    const sampleMax = this.sampleMaxByGeneration.get(generationSeq);
    if (sampleMax === undefined) {
      return;
    }

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
      generationSeq,
      frameKind,
      width: dimensions.width,
      height: dimensions.height,
      rgba: frame,
      grayscaleSamples,
      sampleMax,
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
        this.update(this.latestClientState);
      }
    }, 250);
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
): { sourceId: string; generationSeq: number; tIndex: number; zIndex: number } | null {
  const sourceValues = Object.values(clientState.sources);
  let latest:
    | { sourceId: string; generationSeq: number; tIndex: number; zIndex: number }
    | null = null;
  for (const source of sourceValues) {
    if (source.latestWorkingGenerationSeq <= 0) {
      continue;
    }
    if (
      latest === null ||
      source.latestWorkingGenerationSeq > latest.generationSeq
    ) {
      latest = {
        sourceId: source.sourceId,
        generationSeq: source.latestWorkingGenerationSeq,
        tIndex: clientState.tIndex,
        zIndex: clientState.zIndex,
      };
    }
  }
  return latest;
}

function frameSelectionKey(
  sourceId: string,
  generationSeq: number,
  tIndex: number,
  zIndex: number,
): string {
  return `${sourceId}:${generationSeq.toString()}:t${tIndex.toString()}:z${zIndex.toString()}`;
}

function requestKey(
  kind: "preview" | "tile",
  sourceId: string,
  generationSeq: number,
  tIndex: number,
  zIndex: number,
): string {
  return `${kind}:${sourceId}:${generationSeq.toString()}:t${tIndex.toString()}:z${zIndex.toString()}`;
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

  while (index < bytes.length && isWhitespace(bytes[index] ?? 0)) {
    index += 1;
  }
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

function isWhitespace(value: number): boolean {
  return value === 0x20 || value === 0x09 || value === 0x0a || value === 0x0d;
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
