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
  minimap: MinimapState;
  warningNotice: string | null;
};

type DecodedFrame = {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
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
  private dimensionsByGeneration: Map<number, { width: number; height: number }>;
  private frameKindByGeneration: Map<number, "preview" | "tile">;
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
    this.dimensionsByGeneration = new Map();
    this.frameKindByGeneration = new Map();
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

    const isNewGeneration = latest.generationSeq > this.latestGenerationSeq;
    if (isNewGeneration) {
      this.scheduler.invalidateOlderGenerations(latest.generationSeq);
      this.frameStore.pruneOlderThan(latest.generationSeq);
    }
    const hasFrameForGeneration =
      this.frameStore.resolveFrame(latest.generationSeq) !== null;
    if (isNewGeneration || !hasFrameForGeneration) {
      void this.fetchPreviewThenTiles(latest.sourceId, latest.generationSeq);
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
  ): Promise<void> {
    const fetchKey = `${sourceId}:${generationSeq.toString()}`;
    if (this.activeFetches.has(fetchKey)) {
      return;
    }
    this.activeFetches.add(fetchKey);
    try {
      const preview = await this.scheduler.schedule<DecodedFrame>({
        key: `preview:${sourceId}`,
        generationSeq,
        priority: 20,
        execute: (signal) => {
          return this.fetchFrame(
            {
              sourceId,
              generationSeq,
              assetKind: "preview2d",
              lod: 0,
              t: 0,
              z: 0,
              channelBlock: 0,
              y: 0,
              x: 0,
            },
            signal,
          );
        },
      });
      if (generationSeq > this.latestGenerationSeq) {
        this.latestGenerationSeq = generationSeq;
      }
      this.dimensionsByGeneration.set(generationSeq, {
        width: preview.width,
        height: preview.height,
      });
      this.frameKindByGeneration.set(generationSeq, "preview");
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
        key: `tile:${sourceId}`,
        generationSeq,
        priority: 10,
        execute: (signal) => {
          return this.fetchFrame(
            {
              sourceId,
              generationSeq,
              assetKind: "tile2d",
              lod: 0,
              t: 0,
              z: 0,
              channelBlock: 0,
              y: 0,
              x: 0,
            },
            signal,
          );
        },
      });
      this.dimensionsByGeneration.set(generationSeq, {
        width: tile.width,
        height: tile.height,
      });
      this.frameKindByGeneration.set(generationSeq, "tile");
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
): { sourceId: string; generationSeq: number } | null {
  const sourceValues = Object.values(clientState.sources);
  let latest: { sourceId: string; generationSeq: number } | null = null;
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
      };
    }
  }
  return latest;
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
    maxValue !== 255
  ) {
    throw new Error("unsupported PGM dimensions or max value");
  }

  while (index < bytes.length && isWhitespace(bytes[index] ?? 0)) {
    index += 1;
  }
  const pixelCount = width * height;
  const payload = bytes.slice(index);
  if (payload.length < pixelCount) {
    throw new Error("PGM payload is truncated");
  }

  const rgba = new Uint8ClampedArray(pixelCount * 4);
  for (let i = 0; i < pixelCount; i += 1) {
    const value = payload[i] ?? 0;
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
  };
}

function isWhitespace(value: number): boolean {
  return value === 0x20 || value === 0x09 || value === 0x0a || value === 0x0d;
}
