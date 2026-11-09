// Transport only — resolves chunk requests to wire-format bytes; does
// not decode, normalize, or cache.

import { extractDataType, type MultiscaleInfo, type WireFormat } from "../../manifestTypes.ts";
import type { GeneratedChunkStatus } from "../generatedAvailability.ts";
import { FetchError } from "./retry.ts";
import type { WireLabel } from "../../trace/types.ts";

/**
 * Failure statuses the server unicasts for a source chunk request it answers
 * without bytes (`source_chunk_status` frames). Mirror of
 * `lucida_protocol::SourceChunkStatus`; not-found is served as a
 * zero-filled binary frame and success as normal chunk bytes, so this
 * vocabulary is failure-only.
 */
export type SourceChunkStatus = "failed_permanent" | "unavailable";

/**
 * Why the server sent no bytes for a source chunk request. Mirror of
 * `lucida_protocol::ChunkFailureKind`. The status says whether to retry;
 * this says why, so a trace and a person can name the failure.
 */
export type ChunkFailureKind =
  | "malformed_key"
  | "unknown_dataset"
  | "unknown_image"
  | "unknown_level"
  | "corrupt_chunk"
  | "wrong_size"
  | "unsupported_codec"
  | "permission"
  | "storage_backend";

const CHUNK_FAILURE_WORDS: Record<ChunkFailureKind, string> = {
  malformed_key: "has a malformed key",
  unknown_dataset: "names a dataset the server does not hold",
  unknown_image: "names an image the dataset does not have",
  unknown_level: "names a level the image does not have",
  corrupt_chunk: "is corrupt and could not be decoded",
  wrong_size: "decoded to the wrong size",
  unsupported_codec: "is compressed in a way lucida cannot decode",
  permission: "was refused by the store for lack of permission",
  storage_backend: "could not be read from the store",
};

/**
 * The fetch error a `source_chunk_status` frame rejects with, classified so a
 * retry happens only where it can help:
 *
 * - `failed_permanent` is `permanent`: the same request fails the same way.
 * - `unavailable` is `transient`, so it self-heals instead of dark-holing
 *   the chunk until the dataset reopens.
 *
 * `serverReported` regardless of status, so a persistently unavailable source
 * still feeds the delivery-failure streak. A server that predates the kind
 * sends none, and the message falls back to the status.
 */
export function sourceChunkFailure(
  chunkKey: string,
  status: SourceChunkStatus,
  failure: ChunkFailureKind | null,
  message: string | null,
): FetchError {
  const words = failure
    ? CHUNK_FAILURE_WORDS[failure]
    : status === "failed_permanent" ? "failed permanently" : "is unavailable";
  const detail = message ? `: ${message}` : "";
  return new FetchError(`Source chunk ${chunkKey} ${words}${detail}`, {
    kind: status === "failed_permanent" ? "permanent" : "transient",
    serverReported: true,
    failure,
  });
}

/** Planes of a chunk, half-open along the chunk's own Z: `[3, 5]` is its fourth and fifth. */
export type PlaneRange = readonly [number, number];

/** Whether `outer` holds every plane of `inner`. */
export function holdsPlanes(outer: PlaneRange, inner: PlaneRange): boolean {
  return outer[0] <= inner[0] && inner[1] <= outer[1];
}

export interface FetchRequest {
  datasetId: string;
  imageId: string;
  chunkKey: string;       // canonical "level/t/c/z/y/x"
  /** Planes to fetch in place of the whole chunk. */
  planes?: PlaneRange;
}

export interface FetchResult {
  bytes: ArrayBuffer;
  wireFormat: WireFormat;
  dataType: string;
  /**
   * The codec list of an encoded frame: the bytes are still in the codecs
   * the chunk was stored in. Absent when they arrived decoded.
   */
  codecs?: Uint8Array;
  /**
   * What the bytes decode to, from their level's metadata. Encoded bytes
   * decode to exactly this or fail. Absent when the level is unknown.
   */
  decodedBytes?: number;
  /**
   * The planes the bytes hold. Absent when they hold the whole chunk, which
   * the server may send for any request.
   */
  planes?: PlaneRange;
}

export interface ContentSource {
  fetch(request: FetchRequest, signal: AbortSignal, onLabel?: LabelSink): Promise<FetchResult>;
  /**
   * A binary chunk frame off the socket, keyed by its composite chunk key,
   * with its codec list when the frame is encoded and its planes when it
   * holds only some of the chunk.
   */
  handleBinary(
    key: string,
    data: ArrayBuffer,
    codecs?: Uint8Array | null,
    planes?: PlaneRange | null,
  ): void;
}

/**
 * The codecs the decode workers undo, declared to the server on every
 * connection so it can relay a chunk still in the codecs it was stored in.
 * Mirror of `lucida_protocol::codec::ChunkCodec`.
 */
export const DECODED_CODECS = ["gzip", "zlib", "zstd", "lz4", "blosc", "crc32c"] as const;

/** Bytes one sample takes as stored and as the wire carries it, decoded. */
function storedBytesPerSample(dataType: string): number {
  switch (dataType.toLowerCase()) {
    case "uint8":
    case "int8":
    case "bool":
      return 1;
    case "uint16":
    case "int16":
    case "float16":
      return 2;
    case "uint32":
    case "int32":
    case "float32":
      return 4;
    default:
      return 8;
  }
}

/** What one wire chunk of a level decodes to, and the planes it holds along Z. */
export interface LevelChunkSize {
  bytes: number;
  planes: number;
}

/**
 * What one wire chunk of each level decodes to, by level index: one
 * timepoint and one channel of the level's chunk shape, at the data type's
 * own width.
 */
export function levelChunkSizes(multiscale: MultiscaleInfo): LevelChunkSize[] {
  const sample = storedBytesPerSample(multiscale.data_type);
  const sizes: LevelChunkSize[] = [];
  for (const level of multiscale.levels) {
    const [, , z, y, x] = level.chunk_shape;
    sizes[level.level_index] = { bytes: z * y * x * sample, planes: Math.max(z, 1) };
  }
  return sizes;
}

/**
 * Client-side fetch timeout for a single chunk read. Mirrors lucida-store
 * `backend::CLIENT_FETCH_TIMEOUT` and must be kept in sync with it: the store's
 * worst-case per-read budget (retry-loop budget plus a final per-attempt
 * request timeout) must stay under this value so the client, not the server,
 * wins the timeout race. If the server outlasts this timeout, the client gives
 * up and re-sends the read while the original is still in flight, duplicating
 * work.
 */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Told the correlation label the request rode on, synchronously at fetch
 * time. Synchronous and up front because a request that times out or fails
 * still needs to be joinable — the label is identity, not a result.
 */
export type LabelSink = (label: WireLabel) => void;

/** One request's in-flight fetch, and the label it was sent under. */
interface PendingGroup {
  /**
   * The first sender's label, handed to every caller that coalesces onto
   * this group. One wire request, one label, however many rows point at it.
   */
  label: WireLabel;
  entries: PendingRequest[];
}

interface PendingRequest {
  resolve: (data: ArrayBuffer, codecs: Uint8Array | null, planes: PlaneRange | null) => void;
  // Accepts `FetchError` (rejectDataset/rejectAll) and
  // `DOMException("AbortError")` (signal abort). Both pass through
  // `classifyFetchError` in the cache.
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

/**
 * The key a request waits under: its composite chunk key for the whole
 * chunk, and that key with its planes for some planes, so a request for the
 * whole chunk and one for its planes are two wire requests.
 */
function pendingKey(compositeKey: string, planes: PlaneRange | undefined): string {
  return planes ? `${compositeKey}#${planes[0]}:${planes[1]}` : compositeKey;
}

export class ProxiedContentSource implements ContentSource {
  private pending = new Map<string, PendingGroup>();
  /**
   * Each chunk's waiting plane requests, by composite key. A whole chunk, or
   * the failure of its read, answers every one of them as well.
   */
  private planeKeys = new Map<string, Set<string>>();
  /**
   * The connection's label counter. Uniqueness is across the connection:
   * gaps in the sequence are harmless, since nothing derives order from
   * contiguity.
   */
  private nextRid = 0;
  private connectionGeneration = 0;
  /**
   * Labels of chunk requests no caller wants any more, sent as one
   * `chunk_cancel` once the current task is done: a replan aborts many
   * requests at once, and one message each would rival the requests.
   */
  private cancelledRids: number[] = [];
  private imageWireFormats = new Map<string, WireFormat>();
  private imageChunkSizes = new Map<string, readonly LevelChunkSize[]>();

  private sendMessage: (json: string) => void;
  private timeoutMs: number;

  constructor(sendMessage: (json: string) => void, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.sendMessage = sendMessage;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Start a new connection's label sequence. The counter restarts because
   * labels are per connection; the generation is what keeps two `rid: 0`
   * requests on either side of a reconnect from looking like one.
   */
  resetConnection(generation: number): void {
    this.connectionGeneration = generation;
    this.nextRid = 0;
    // The old connection's labels mean nothing on the new one, and the
    // server dropped that connection's requests when it closed.
    this.cancelledRids = [];
    // The server forgets a connection's codecs with it.
    this.sendMessage(JSON.stringify({ type: "chunk_codecs", codecs: DECODED_CODECS }));
  }

  /**
   * `chunkSizes` is what one chunk of each level decodes to
   * ({@link levelChunkSizes}). Without it, an encoded frame for the image
   * fails rather than decode unbounded.
   */
  registerImage(imageId: string, wireFormat: WireFormat, chunkSizes?: readonly LevelChunkSize[]): void {
    this.imageWireFormats.set(imageId, wireFormat);
    if (chunkSizes) this.imageChunkSizes.set(imageId, chunkSizes);
  }

  /**
   * Drop wire-format registrations. Caller supplies imageIds because
   * this class is dataset-agnostic; the manifest owns the mapping.
   */
  unregisterDataset(imageIds: readonly string[]): void {
    for (const id of imageIds) {
      this.imageWireFormats.delete(id);
      this.imageChunkSizes.delete(id);
    }
  }

  handleBinary(
    key: string,
    data: ArrayBuffer,
    codecs: Uint8Array | null = null,
    planes: PlaneRange | null = null,
  ): void {
    // Whole bytes answer every request for the chunk, and planes the
    // requests for planes they hold.
    const entries = planes
      ? this.takePlanes(key, (wanted) => holdsPlanes(planes, wanted))
      : this.takeChunk(key);
    entries.forEach((entry, idx) => {
      clearTimeout(entry.timeoutId);
      entry.resolve(idx === 0 ? data : data.slice(0), codecs, planes);
    });
  }

  handleChunkStatus(
    datasetId: string,
    imageId: string,
    chunkKey: string,
    status: GeneratedChunkStatus,
    message?: string | null,
  ): void {
    const compositeKey = `${datasetId}/${imageId}/${chunkKey}`;
    const entries = this.takeChunk(compositeKey);
    if (entries.length === 0) return;

    for (const entry of entries) {
      clearTimeout(entry.timeoutId);
      entry.reject(generatedStatusToFetchError(status, chunkKey, message));
    }
  }

  /**
   * Server-reported failure for a source chunk request. Every status
   * rejects the pending fetch, and every request for the chunk's planes,
   * since the server reads the whole chunk for either; see
   * {@link sourceChunkFailure} for how.
   */
  handleSourceChunkStatus(
    datasetId: string,
    imageId: string,
    chunkKey: string,
    status: SourceChunkStatus,
    message?: string | null,
    failure?: ChunkFailureKind | null,
  ): void {
    const compositeKey = `${datasetId}/${imageId}/${chunkKey}`;
    const entries = this.takeChunk(compositeKey);
    if (entries.length === 0) return;

    for (const entry of entries) {
      clearTimeout(entry.timeoutId);
      entry.reject(sourceChunkFailure(chunkKey, status, failure ?? null, message ?? null));
    }
  }

  /** Treated as `abort` downstream; matches caller-driven cancellation. */
  rejectDataset(datasetId: string): void {
    const prefix = datasetId + "/";
    for (const [key, group] of this.pending) {
      if (key.startsWith(prefix)) {
        this.pending.delete(key);
        this.planeKeys.delete(key.split("#", 1)[0]);
        this.cancel(group.label);
        for (const entry of group.entries) {
          clearTimeout(entry.timeoutId);
          entry.reject(new FetchError("Dataset removed", { kind: "abort" }));
        }
      }
    }
  }

  /** Transient so the cache's `OnceTransientRetry` covers the reconnect. */
  rejectAll(): void {
    for (const [, group] of this.pending) {
      for (const entry of group.entries) {
        clearTimeout(entry.timeoutId);
        entry.reject(new FetchError("Bridge disconnected", { kind: "transient" }));
      }
    }
    this.pending.clear();
    this.planeKeys.clear();
  }

  fetch(request: FetchRequest, signal: AbortSignal, onLabel?: LabelSink): Promise<FetchResult> {
    const { datasetId, imageId, chunkKey, planes } = request;
    const compositeKey = `${datasetId}/${imageId}/${chunkKey}`;
    const key = pendingKey(compositeKey, planes);
    const wireFormat = this.imageWireFormats.get(imageId);
    if (!wireFormat) {
      // Setup bug — retrying won't recover.
      return Promise.reject(
        new FetchError(`No wire format registered for image ${imageId}`, {
          kind: "permanent",
        }),
      );
    }
    const dataType = extractDataType(wireFormat);
    const size = this.imageChunkSizes.get(imageId)?.[Number(chunkKey.split("/", 1)[0])];

    return new Promise<FetchResult>((resolve, reject) => {
      const pendingEntry: PendingRequest = {
        resolve: (bytes, codecs, arrived) => {
          clearTimeout(pendingEntry.timeoutId);
          const result: FetchResult = { bytes, wireFormat, dataType };
          if (codecs) result.codecs = codecs;
          if (arrived) result.planes = arrived;
          if (size !== undefined) {
            result.decodedBytes = arrived
              ? (size.bytes / size.planes) * (arrived[1] - arrived[0])
              : size.bytes;
          }
          resolve(result);
        },
        reject: (err) => { clearTimeout(pendingEntry.timeoutId); reject(err); },
        timeoutId: setTimeout(() => {
          this.removePending(key, pendingEntry);
          reject(new FetchError(`Chunk ${chunkKey} timed out`, { kind: "transient" }));
        }, this.timeoutMs),
      };

      const { label, send } = this.addPending(key, pendingEntry);
      if (send && planes) this.trackPlanes(compositeKey, key);
      onLabel?.(label);
      if (send) {
        this.sendMessage(JSON.stringify({
          type: "chunk_request",
          rid: label.rid,
          dataset_id: datasetId,
          image_id: imageId,
          key: chunkKey,
          ...(planes ? { planes: [planes[0], planes[1]] } : {}),
        }));
      }

      signal.addEventListener("abort", () => {
        clearTimeout(pendingEntry.timeoutId);
        // Only an abort tells the server to stop. A timed-out request is
        // retried at once, and the retry rides the read still in flight.
        const emptied = this.removePending(key, pendingEntry);
        if (emptied) this.cancel(emptied);
        // Keep the AbortError shape for downstream `instanceof DOMException`.
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  }

  /**
   * Attach to the in-flight fetch for `key`, or open one. Returns the label
   * this caller's row carries: a fresh one when it is the sender, the first
   * sender's when it is coalescing onto an existing request.
   */
  private addPending(key: string, entry: PendingRequest): { label: WireLabel; send: boolean } {
    const group = this.pending.get(key);
    if (group) {
      group.entries.push(entry);
      return { label: group.label, send: false };
    }
    const label = this.mintLabel();
    this.pending.set(key, { label, entries: [entry] });
    return { label, send: true };
  }

  /** Returns the group's label when this caller was the last one in it. */
  private removePending(key: string, entry: PendingRequest): WireLabel | null {
    const group = this.pending.get(key);
    if (!group || !group.entries.includes(entry)) return null;
    const next = group.entries.filter((candidate) => candidate !== entry);
    if (next.length === 0) {
      this.pending.delete(key);
      this.untrackPlanes(key);
      return group.label;
    }
    // The label stays with the group: the wire request it names is still
    // in flight even though this caller has left.
    this.pending.set(key, { label: group.label, entries: next });
    return null;
  }

  private cancel(label: WireLabel): void {
    if (label.connectionGeneration !== this.connectionGeneration) return;
    if (this.cancelledRids.length === 0) {
      queueMicrotask(() => this.flushCancels());
    }
    this.cancelledRids.push(label.rid);
  }

  private flushCancels(): void {
    if (this.cancelledRids.length === 0) return;
    const rids = this.cancelledRids;
    this.cancelledRids = [];
    this.sendMessage(JSON.stringify({ type: "chunk_cancel", rids }));
  }

  /** Every request waiting on the chunk: its whole bytes and any of its planes. */
  private takeChunk(compositeKey: string): PendingRequest[] {
    const entries = this.takePlanes(compositeKey, () => true);
    const whole = this.pending.get(compositeKey);
    this.pending.delete(compositeKey);
    return whole ? [...whole.entries, ...entries] : entries;
  }

  /** The chunk's plane requests whose planes `wanted` accepts. */
  private takePlanes(compositeKey: string, wanted: (planes: PlaneRange) => boolean): PendingRequest[] {
    const keys = this.planeKeys.get(compositeKey);
    if (!keys) return [];
    const entries: PendingRequest[] = [];
    for (const key of keys) {
      const [first, end] = key.slice(key.lastIndexOf("#") + 1).split(":").map(Number);
      if (!wanted([first, end])) continue;
      entries.push(...(this.pending.get(key)?.entries ?? []));
      this.pending.delete(key);
      keys.delete(key);
    }
    if (keys.size === 0) this.planeKeys.delete(compositeKey);
    return entries;
  }

  private trackPlanes(compositeKey: string, key: string): void {
    let keys = this.planeKeys.get(compositeKey);
    if (!keys) {
      keys = new Set();
      this.planeKeys.set(compositeKey, keys);
    }
    keys.add(key);
  }

  private untrackPlanes(key: string): void {
    const at = key.lastIndexOf("#");
    if (at < 0) return;
    const compositeKey = key.slice(0, at);
    const keys = this.planeKeys.get(compositeKey);
    if (!keys) return;
    keys.delete(key);
    if (keys.size === 0) this.planeKeys.delete(compositeKey);
  }

  private mintLabel(): WireLabel {
    // u32 on the wire; wrapping is unreachable on one connection, but a
    // silently negative or float label would be worse than a wrap.
    const rid = this.nextRid;
    this.nextRid = (this.nextRid + 1) >>> 0;
    return { rid, connectionGeneration: this.connectionGeneration };
  }
}

function generatedStatusToFetchError(
  status: GeneratedChunkStatus,
  chunkKey: string,
  message?: string | null,
): FetchError {
  const detail = message ? `: ${message}` : "";
  switch (status) {
    case "pending":
      return new FetchError(`Generated chunk ${chunkKey} pending${detail}`, {
        kind: "pending",
      });
    case "failed_transient":
      return new FetchError(`Generated chunk ${chunkKey} transient failure${detail}`, {
        kind: "transient",
      });
    case "unavailable":
    case "failed_permanent":
      return new FetchError(`Generated chunk ${chunkKey} unavailable${detail}`, {
        kind: "permanent",
      });
    case "ready":
      return new FetchError(`Generated chunk ${chunkKey} reported ready without bytes${detail}`, {
        kind: "transient",
      });
  }
}
