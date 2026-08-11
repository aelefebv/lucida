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
 * Failure statuses the server unicasts when a source chunk's store read
 * fails with a non-not-found error (`source_chunk_status` frames): revoked
 * access, backend fault, unreachable store. Mirror of
 * `lucida_protocol::SourceChunkStatus`; not-found is served as a
 * zero-filled binary frame and success as normal chunk bytes, so this
 * vocabulary is failure-only.
 */
export type SourceChunkStatus = "failed_permanent" | "unavailable";

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
   * Server-reported failure for a source chunk: the store read failed with a
   * non-not-found error. Both statuses reject the pending fetch — the bytes
   * will not arrive on this request — but with distinct classifications so a
   * retry is attempted only where it can help:
   *
   * - `failed_permanent` (revoked access, invalid credentials) → `permanent`.
   *   The store answered and will keep answering the same way, so a retry is
   *   futile; the delivery-failure streak counts it and the failure sticks.
   * - `unavailable` (backend fault, throttling, timeout, unreachable service)
   *   → `transient`. The store may recover, so this must self-heal like an
   *   ordinary blip rather than dark-holing the chunk until the dataset is
   *   reopened. This is the frame the server now emits when its own bounded
   *   retry budget is exhausted before the client's fetch would time out.
   */
  handleSourceChunkStatus(
    datasetId: string,
    imageId: string,
    chunkKey: string,
    status: SourceChunkStatus,
    message?: string | null,
  ): void {
    const compositeKey = `${datasetId}/${imageId}/${chunkKey}`;
    const entries = this.takePending(compositeKey);
    if (entries.length === 0) return;

    const detail = message ? `: ${message}` : "";
    const { reason, kind } =
      status === "failed_permanent"
        ? { reason: "failed permanently", kind: "permanent" as const }
        : { reason: "unavailable", kind: "transient" as const };
    for (const entry of entries) {
      clearTimeout(entry.timeoutId);
      // `serverReported` regardless of `kind`: the store answered with a
      // failure, so this feeds the delivery-failure streak even when the
      // classification is transient (so a persistently-unavailable source
      // still surfaces) — while the transient/permanent split keeps driving
      // retry as before.
      entry.reject(
        new FetchError(`Source chunk ${chunkKey} ${reason}${detail}`, {
          kind,
          serverReported: true,
        }),
      );
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
        this.removePending(compositeKey, pendingEntry);
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

  private removePending(key: string, entry: PendingRequest): void {
    const group = this.pending.get(key);
    if (!group) return;
    const next = group.entries.filter((candidate) => candidate !== entry);
    if (next.length === 0) {
      this.pending.delete(key);
    } else {
      // The label stays with the group: the wire request it names is still
      // in flight even though this caller has left.
      this.pending.set(key, { label: group.label, entries: next });
    }
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
