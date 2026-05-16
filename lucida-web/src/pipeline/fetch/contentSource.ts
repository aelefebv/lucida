/**
 * Content Source — resolves logical chunk requests to physical bytes via the network.
 *
 * Transport only. Returns raw wire-format bytes alongside transport metadata.
 * Does not decode, normalize, or cache.
 */

import { extractDataType, type WireFormat } from "../../manifestTypes.ts";
import type { ProxyKind } from "../assetCatalog.ts";
import { parseProxyHeader, proxyResponseKey, type ProxyHeaderJs } from "./wireProtocol.ts";
import { FetchError } from "./retry.ts";

export type { ProxyHeaderJs } from "./wireProtocol.ts";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

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

// ---- Proxy fetch types ----

/** Identifies which proxy asset to fetch. */
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
  fetch(request: FetchRequest, signal: AbortSignal): Promise<FetchResult>;
  /** Fetch a proxy asset. Resolves with header + raw voxel bytes. */
  fetchProxy(request: FetchProxyRequest, signal: AbortSignal): Promise<FetchProxyResult>;
  /**
   * Route a binary frame from the transport layer (e.g. the bridge's
   * WebSocket) to the appropriate pending request. Owns the
   * chunk-vs-proxy dispatch decision so the transport stays generic.
   */
  handleBinary(key: string, data: ArrayBuffer): void;
}

// ---------------------------------------------------------------------------
// ProxiedContentSource — wraps the WebSocket bridge
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000;
/** Proxies can take longer to generate than chunks. */
const DEFAULT_PROXY_TIMEOUT_MS = 60_000;

interface PendingRequest {
  resolve: (data: ArrayBuffer) => void;
  // Accepts either a typed `FetchError` (`rejectDataset`, `rejectAll`)
  // or the `DOMException("AbortError")` raised on signal abort. The
  // catch block in `CpuCache.fetchAndDecode` routes both through
  // `classifyFetchError`.
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface PendingProxyRequest {
  resolve: (data: ArrayBuffer) => void;
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export class ProxiedContentSource implements ContentSource {
  private pending = new Map<string, PendingRequest>();
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

  /** Register an image's wire format. Called during dataset setup. */
  registerImage(imageId: string, wireFormat: WireFormat): void {
    this.imageWireFormats.set(imageId, wireFormat);
  }

  /**
   * Drop wire-format registrations for the listed images. Pair with
   * `cancelDataset` on the cache from the dataset-removal lifecycle —
   * without this, `imageWireFormats` accumulates entries indefinitely
   * across long sessions of open/close cycles.
   *
   * The caller passes the imageIds because `ProxiedContentSource` is
   * dataset-agnostic: it has no datasetId → imageIds mapping of its
   * own. The dataset-lifecycle owner (RenderLoop / useBridge) holds
   * that mapping in the manifest.
   */
  unregisterDataset(imageIds: readonly string[]): void {
    for (const id of imageIds) {
      this.imageWireFormats.delete(id);
    }
  }

  /**
   * Route a binary frame from the bridge to the matching pending
   * chunk- or proxy-request. The transport delivers (key, payload)
   * without knowing the application's chunk-vs-proxy taxonomy; this
   * method owns the dispatch by sniffing the `proxy/` key prefix.
   */
  handleBinary(key: string, data: ArrayBuffer): void {
    if (key.startsWith("proxy/")) {
      this.handleProxyData(key, data);
    } else {
      this.handleChunkData(key, data);
    }
  }

  /** Route binary chunk data to a pending chunk request. */
  handleChunkData(key: string, data: ArrayBuffer): void {
    const entry = this.pending.get(key);
    if (entry) {
      clearTimeout(entry.timeoutId);
      this.pending.delete(key);
      entry.resolve(data);
    }
  }

  /** Route binary proxy data to a pending proxy request. */
  handleProxyData(key: string, data: ArrayBuffer): void {
    const entry = this.pendingProxy.get(key);
    if (entry) {
      clearTimeout(entry.timeoutId);
      this.pendingProxy.delete(key);
      entry.resolve(data);
    }
  }

  /** Reject all pending requests for a dataset (on dataset removal). */
  rejectDataset(datasetId: string): void {
    const prefix = datasetId + "/";
    for (const [key, entry] of this.pending) {
      if (key.startsWith(prefix)) {
        clearTimeout(entry.timeoutId);
        this.pending.delete(key);
        // Dataset removal is a deliberate caller cancellation; treat
        // identically to a signal abort downstream.
        entry.reject(new FetchError("Dataset removed", { kind: "abort" }));
      }
    }
    // Proxy keys aren't dataset-scoped (entity IDs are unique enough);
    // we don't selectively cancel them by dataset.
  }

  /** Reject all pending requests (on disconnect). */
  rejectAll(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timeoutId);
      // Bridge drop is a transient condition: the reconnect path will
      // retry. The cache's `OnceTransientRetry` honours that semantics.
      entry.reject(new FetchError("Bridge disconnected", { kind: "transient" }));
    }
    this.pending.clear();
    for (const [, entry] of this.pendingProxy) {
      clearTimeout(entry.timeoutId);
      entry.reject(new FetchError("Bridge disconnected", { kind: "transient" }));
    }
    this.pendingProxy.clear();
  }

  /** Fetch raw wire-format bytes for a chunk. */
  fetch(request: FetchRequest, signal: AbortSignal): Promise<FetchResult> {
    const { datasetId, imageId, chunkKey } = request;
    const compositeKey = `${datasetId}/${imageId}/${chunkKey}`;
    const wireFormat = this.imageWireFormats.get(imageId);
    if (!wireFormat) {
      // Setup bug — retrying won't recover. Raised as a typed
      // permanent FetchError so the cache's classifier doesn't fall
      // through to the transient-by-default branch.
      return Promise.reject(
        new FetchError(`No wire format registered for image ${imageId}`, {
          kind: "permanent",
        }),
      );
    }
    const dataType = extractDataType(wireFormat);

    return new Promise<FetchResult>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(compositeKey);
        // Timeouts surface as transient so `OnceTransientRetry`
        // grants a single retry before marking transient-failed.
        reject(new FetchError(`Chunk ${chunkKey} timed out`, { kind: "transient" }));
      }, this.timeoutMs);

      this.pending.set(compositeKey, {
        resolve: (bytes) => { clearTimeout(timeoutId); resolve({ bytes, wireFormat, dataType }); },
        reject: (err) => { clearTimeout(timeoutId); reject(err); },
        timeoutId,
      });

      this.sendMessage(JSON.stringify({
        type: "chunk_request",
        dataset_id: datasetId,
        image_id: imageId,
        key: chunkKey,
      }));

      signal.addEventListener("abort", () => {
        clearTimeout(timeoutId);
        this.pending.delete(compositeKey);
        // `DOMException` AbortError is promoted to
        // `FetchError(kind: "abort")` by `classifyFetchError`. Raising
        // it directly here keeps the AbortError shape for any
        // downstream `instanceof DOMException` matcher.
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  }

  /**
   * Fetch a proxy asset. Sends an `asset_request` JSON message and awaits
   * the binary response keyed by [`proxyResponseKey`]. The first 64 bytes
   * of the response are the header; the rest is the u16 voxel payload.
   */
  fetchProxy(request: FetchProxyRequest, signal: AbortSignal): Promise<FetchProxyResult> {
    const { datasetId, entityId, kind, t, c } = request;
    const responseKey = proxyResponseKey(entityId, kind, t, c);

    return new Promise<FetchProxyResult>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingProxy.delete(responseKey);
        // Proxy retry policy is `NeverRetry`, so the cache won't retry
        // — but the timeout is still semantically transient (the next
        // plan tick may resubmit). Keeping the same kind discipline
        // here means consumers can reason about kind uniformly.
        reject(new FetchError(`Proxy ${responseKey} timed out`, { kind: "transient" }));
      }, this.proxyTimeoutMs);

      this.pendingProxy.set(responseKey, {
        resolve: (raw) => {
          clearTimeout(timeoutId);
          let header: ProxyHeaderJs;
          try {
            header = parseProxyHeader(raw, 0);
          } catch (e) {
            // Malformed header → permanent. `parseProxyHeader` throws
            // a plain `Error` for bad magic / version; wrap it as a
            // typed `FetchError` so the cache classifies it correctly.
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

      this.sendMessage(JSON.stringify({
        type: "asset_request",
        dataset_id: datasetId,
        entity_id: entityId,
        kind,
        t,
        c,
      }));

      signal.addEventListener("abort", () => {
        clearTimeout(timeoutId);
        this.pendingProxy.delete(responseKey);
        // Matches the chunk-path abort site: raise the DOMException
        // directly; `classifyFetchError` promotes it to
        // `FetchError(kind: "abort")` downstream.
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  }
}
