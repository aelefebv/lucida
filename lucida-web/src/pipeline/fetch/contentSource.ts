// Transport only — resolves chunk requests to wire-format bytes; does
// not decode, normalize, or cache.

import { extractDataType, type WireFormat } from "../../manifestTypes.ts";
import type { GeneratedChunkStatus } from "../generatedAvailability.ts";
import type { ProxyKind } from "../assetCatalog.ts";
import { parseProxyHeader, proxyResponseKey, type ProxyHeaderJs } from "./wireProtocol.ts";
import { FetchError } from "./retry.ts";
import type { WireLabel } from "../../trace/types.ts";

export type { ProxyHeaderJs } from "./wireProtocol.ts";

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

export interface FetchRequest {
  datasetId: string;
  imageId: string;
  chunkKey: string;       // canonical "level/t/c/z/y/x"
}

export interface FetchResult {
  bytes: ArrayBuffer;
  wireFormat: WireFormat;
  dataType: string;
}

export interface FetchProxyRequest {
  datasetId: string;
  entityId: string;
  kind: ProxyKind;
  t: number;
  c: number;
}

export interface FetchProxyResult {
  header: ProxyHeaderJs;
  /** Raw u16 voxel bytes (little-endian), length `dims[0]*dims[1]*dims[2]*2`. */
  data: ArrayBuffer;
}

export interface ContentSource {
  fetch(request: FetchRequest, signal: AbortSignal, onLabel?: LabelSink): Promise<FetchResult>;
  fetchProxy(
    request: FetchProxyRequest,
    signal: AbortSignal,
    onLabel?: LabelSink,
  ): Promise<FetchProxyResult>;
  /** Owns the chunk-vs-proxy dispatch so the transport stays generic. */
  handleBinary(key: string, data: ArrayBuffer): void;
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
/** Proxies can take longer to generate than chunks. */
const DEFAULT_PROXY_TIMEOUT_MS = 60_000;

/**
 * Told the correlation label the request rode on, synchronously at fetch
 * time. Synchronous and up front because a request that times out or fails
 * still needs to be joinable — the label is identity, not a result.
 */
export type LabelSink = (label: WireLabel) => void;

/** One composite key's in-flight fetch, and the label it was sent under. */
interface PendingGroup {
  /**
   * The first sender's label, handed to every caller that coalesces onto
   * this group. One wire request, one label, however many rows point at it.
   */
  label: WireLabel;
  entries: PendingRequest[];
}

interface PendingRequest {
  resolve: (data: ArrayBuffer) => void;
  // Accepts `FetchError` (rejectDataset/rejectAll) and
  // `DOMException("AbortError")` (signal abort). Both pass through
  // `classifyFetchError` in the cache.
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface PendingProxyRequest {
  resolve: (data: ArrayBuffer) => void;
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export class ProxiedContentSource implements ContentSource {
  private pending = new Map<string, PendingGroup>();
  /**
   * The connection's label counter, shared by chunk and asset requests.
   * Uniqueness is across the connection, not within a family: a label that
   * is ambiguous until you also know the message type is not a join key.
   * Gaps in either family's sequence are harmless — nothing derives order
   * from contiguity.
   */
  private nextRid = 0;
  private connectionGeneration = 0;
  /**
   * Labels of chunk requests no caller wants any more, sent as one
   * `chunk_cancel` once the current task is done: a replan aborts many
   * requests at once, and one message each would rival the requests.
   */
  private cancelledRids: number[] = [];
  private pendingProxy = new Map<string, PendingProxyRequest>();
  private imageWireFormats = new Map<string, WireFormat>();

  private sendMessage: (json: string) => void;
  private timeoutMs: number;
  private proxyTimeoutMs: number;

  constructor(
    sendMessage: (json: string) => void,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    proxyTimeoutMs = DEFAULT_PROXY_TIMEOUT_MS,
  ) {
    this.sendMessage = sendMessage;
    this.timeoutMs = timeoutMs;
    this.proxyTimeoutMs = proxyTimeoutMs;
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
  }

  registerImage(imageId: string, wireFormat: WireFormat): void {
    this.imageWireFormats.set(imageId, wireFormat);
  }

  /**
   * Drop wire-format registrations. Caller supplies imageIds because
   * this class is dataset-agnostic; the manifest owns the mapping.
   */
  unregisterDataset(imageIds: readonly string[]): void {
    for (const id of imageIds) {
      this.imageWireFormats.delete(id);
    }
  }

  /** Sniffs `proxy/` prefix to dispatch chunk vs proxy. */
  handleBinary(key: string, data: ArrayBuffer): void {
    if (key.startsWith("proxy/")) {
      this.handleProxyData(key, data);
    } else {
      this.handleChunkData(key, data);
    }
  }

  handleChunkStatus(
    datasetId: string,
    imageId: string,
    chunkKey: string,
    status: GeneratedChunkStatus,
    message?: string | null,
  ): void {
    const compositeKey = `${datasetId}/${imageId}/${chunkKey}`;
    const entries = this.takePending(compositeKey);
    if (entries.length === 0) return;

    for (const entry of entries) {
      clearTimeout(entry.timeoutId);
      entry.reject(generatedStatusToFetchError(status, chunkKey, message));
    }
  }

  /**
   * Server-reported failure for a source chunk request. Every status
   * rejects the pending fetch; see {@link sourceChunkFailure} for how.
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
    const entries = this.takePending(compositeKey);
    if (entries.length === 0) return;

    for (const entry of entries) {
      clearTimeout(entry.timeoutId);
      entry.reject(sourceChunkFailure(chunkKey, status, failure ?? null, message ?? null));
    }
  }

  handleChunkData(key: string, data: ArrayBuffer): void {
    const entries = this.takePending(key);
    entries.forEach((entry, idx) => {
      clearTimeout(entry.timeoutId);
      entry.resolve(idx === 0 ? data : data.slice(0));
    });
  }

  handleProxyData(key: string, data: ArrayBuffer): void {
    const entry = this.pendingProxy.get(key);
    if (entry) {
      clearTimeout(entry.timeoutId);
      this.pendingProxy.delete(key);
      entry.resolve(data);
    }
  }

  /** Treated as `abort` downstream; matches caller-driven cancellation. */
  rejectDataset(datasetId: string): void {
    const prefix = datasetId + "/";
    for (const [key, group] of this.pending) {
      if (key.startsWith(prefix)) {
        this.pending.delete(key);
        this.cancel(group.label);
        for (const entry of group.entries) {
          clearTimeout(entry.timeoutId);
          entry.reject(new FetchError("Dataset removed", { kind: "abort" }));
        }
      }
    }
    // Proxy keys aren't dataset-scoped — entity IDs are unique enough.
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
    for (const [, entry] of this.pendingProxy) {
      clearTimeout(entry.timeoutId);
      entry.reject(new FetchError("Bridge disconnected", { kind: "transient" }));
    }
    this.pendingProxy.clear();
  }

  fetch(request: FetchRequest, signal: AbortSignal, onLabel?: LabelSink): Promise<FetchResult> {
    const { datasetId, imageId, chunkKey } = request;
    const compositeKey = `${datasetId}/${imageId}/${chunkKey}`;
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

    return new Promise<FetchResult>((resolve, reject) => {
      const pendingEntry: PendingRequest = {
        resolve: (bytes) => { clearTimeout(pendingEntry.timeoutId); resolve({ bytes, wireFormat, dataType }); },
        reject: (err) => { clearTimeout(pendingEntry.timeoutId); reject(err); },
        timeoutId: setTimeout(() => {
          this.removePending(compositeKey, pendingEntry);
          reject(new FetchError(`Chunk ${chunkKey} timed out`, { kind: "transient" }));
        }, this.timeoutMs),
      };

      const { label, send } = this.addPending(compositeKey, pendingEntry);
      onLabel?.(label);
      if (send) {
        this.sendMessage(JSON.stringify({
          type: "chunk_request",
          rid: label.rid,
          dataset_id: datasetId,
          image_id: imageId,
          key: chunkKey,
        }));
      }

      signal.addEventListener("abort", () => {
        clearTimeout(pendingEntry.timeoutId);
        // Only an abort tells the server to stop. A timed-out request is
        // retried at once, and the retry rides the read still in flight.
        const emptied = this.removePending(compositeKey, pendingEntry);
        if (emptied) this.cancel(emptied);
        // Keep the AbortError shape for downstream `instanceof DOMException`.
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  }

  /** First 64 bytes are the header; rest is the u16 voxel payload. */
  fetchProxy(
    request: FetchProxyRequest,
    signal: AbortSignal,
    onLabel?: LabelSink,
  ): Promise<FetchProxyResult> {
    const { datasetId, entityId, kind, t, c } = request;
    const responseKey = proxyResponseKey(entityId, kind, t, c);

    return new Promise<FetchProxyResult>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingProxy.delete(responseKey);
        // Cache won't retry (NeverRetry) but the kind is still transient
        // so consumers reason about kind uniformly.
        reject(new FetchError(`Proxy ${responseKey} timed out`, { kind: "transient" }));
      }, this.proxyTimeoutMs);

      this.pendingProxy.set(responseKey, {
        resolve: (raw) => {
          clearTimeout(timeoutId);
          let header: ProxyHeaderJs;
          try {
            header = parseProxyHeader(raw, 0);
          } catch (e) {
            // Malformed header → permanent.
            const message = e instanceof Error ? e.message : String(e);
            reject(new FetchError(message, { kind: "permanent", cause: e }));
            return;
          }
          const data = raw.slice(64);
          resolve({
            header,
            data,
          });
        },
        reject: (err) => { clearTimeout(timeoutId); reject(err); },
        timeoutId,
      });

      // Assets draw from the same counter as chunks, so the label is unique
      // across the connection rather than within a family.
      const label = this.mintLabel();
      onLabel?.(label);
      this.sendMessage(JSON.stringify({
        type: "asset_request",
        rid: label.rid,
        dataset_id: datasetId,
        entity_id: entityId,
        kind,
        t,
        c,
      }));

      signal.addEventListener("abort", () => {
        clearTimeout(timeoutId);
        this.pendingProxy.delete(responseKey);
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

  private takePending(key: string): PendingRequest[] {
    const group = this.pending.get(key);
    this.pending.delete(key);
    return group?.entries ?? [];
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
