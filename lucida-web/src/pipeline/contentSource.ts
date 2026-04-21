/**
 * Content Source — resolves logical chunk requests to physical bytes via the network.
 *
 * Transport only. Returns raw wire-format bytes alongside transport metadata.
 * Does not decode, normalize, or cache.
 */

import type { WireFormat } from "../manifestTypes.ts";
import { extractDataType } from "./decodePool.ts";
import type { ProxyKind } from "./assetCatalog.ts";

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

/**
 * Parsed proxy header. Mirrors the Rust `ProxyHeader` after the binary
 * 64-byte little-endian record is decoded — see
 * `lucida_proxy::header::write_header` for the canonical layout.
 */
export interface ProxyHeaderJs {
  algorithmVersion: number;
  sourceContentHash: Uint8Array; // 32 bytes
  /** `[Z, Y, X]` voxel counts. */
  dims: [number, number, number];
  dtype: "u16";
}

export interface FetchProxyResult {
  header: ProxyHeaderJs;
  /** Raw u16 voxel bytes (little-endian), length `dims[0]*dims[1]*dims[2]*2`. */
  data: ArrayBuffer;
  /** Always `Raw { u16 }` for proxies in S5 — included for parity with chunk fetches. */
  wireFormat: WireFormat;
}

export interface ContentSource {
  fetch(request: FetchRequest, signal: AbortSignal): Promise<FetchResult>;
  /** S5: fetch a proxy asset. Resolves with header + raw voxel bytes. */
  fetchProxy(request: FetchProxyRequest, signal: AbortSignal): Promise<FetchProxyResult>;
}

// ---------------------------------------------------------------------------
// Proxy header parsing
// ---------------------------------------------------------------------------

/**
 * Parse a 64-byte proxy header out of `buffer` starting at `offset`.
 * Layout (little-endian, exactly mirrors `lucida_proxy::header`):
 *
 * ```text
 *  0..4    magic              "LPRX"
 *  4..8    algorithm version  u32
 *  8..20   dims [Z, Y, X]     u32 × 3
 * 20..24   dtype code         u32
 * 24..56   source hash        u8 × 32
 * 56..64   reserved
 * ```
 */
export function parseProxyHeader(buffer: ArrayBuffer, offset = 0): ProxyHeaderJs {
  if (buffer.byteLength < offset + 64) {
    throw new Error(`Proxy header truncated: need 64 bytes, got ${buffer.byteLength - offset}`);
  }
  const view = new DataView(buffer, offset, 64);

  // Magic check.
  if (
    view.getUint8(0) !== 0x4c /* 'L' */ ||
    view.getUint8(1) !== 0x50 /* 'P' */ ||
    view.getUint8(2) !== 0x52 /* 'R' */ ||
    view.getUint8(3) !== 0x58 /* 'X' */
  ) {
    throw new Error("Bad proxy header magic");
  }

  const algorithmVersion = view.getUint32(4, true);
  const dims: [number, number, number] = [
    view.getUint32(8, true),
    view.getUint32(12, true),
    view.getUint32(16, true),
  ];
  const dtypeCode = view.getUint32(20, true);
  if (dtypeCode !== 0) {
    throw new Error(`Unknown proxy dtype code: ${dtypeCode}`);
  }
  // Copy out the 32-byte hash so callers can hold it independently of `buffer`.
  const sourceContentHash = new Uint8Array(32);
  sourceContentHash.set(new Uint8Array(buffer, offset + 24, 32));

  return {
    algorithmVersion,
    sourceContentHash,
    dims,
    dtype: "u16",
  };
}

/**
 * Compose the proxy response key. Mirrors the server's
 * `proxy_response_key` (handler.rs); the two MUST stay in lockstep so the
 * client can route binary frames back to the right pending request.
 */
export function proxyResponseKey(
  entityId: string,
  kind: ProxyKind,
  t: number,
  c: number,
): string {
  return `proxy/${entityId}/${kind}/T${t.toString().padStart(5, "0")}_C${c.toString().padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// ProxiedContentSource — wraps the WebSocket bridge
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000;
/** Proxies can take longer to generate than chunks. */
const DEFAULT_PROXY_TIMEOUT_MS = 60_000;

interface PendingRequest {
  resolve: (data: ArrayBuffer) => void;
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

  /** Route binary chunk data from bridge. Called by the onChunkData handler. */
  handleChunkData(key: string, data: ArrayBuffer): void {
    const entry = this.pending.get(key);
    if (entry) {
      clearTimeout(entry.timeoutId);
      this.pending.delete(key);
      entry.resolve(data);
    }
  }

  /**
   * Route binary proxy data from bridge. Called when the bridge receives
   * a binary frame whose key starts with `proxy/`.
   */
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
        entry.reject(new Error("Dataset removed"));
      }
    }
    // Proxy keys aren't dataset-scoped (entity IDs are unique enough);
    // we don't selectively cancel them by dataset.
  }

  /** Reject all pending requests (on disconnect). */
  rejectAll(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timeoutId);
      entry.reject(new Error("Bridge disconnected"));
    }
    this.pending.clear();
    for (const [, entry] of this.pendingProxy) {
      clearTimeout(entry.timeoutId);
      entry.reject(new Error("Bridge disconnected"));
    }
    this.pendingProxy.clear();
  }

  /** Fetch raw wire-format bytes for a chunk. */
  fetch(request: FetchRequest, signal: AbortSignal): Promise<FetchResult> {
    const { datasetId, imageId, chunkKey } = request;
    const compositeKey = `${datasetId}/${imageId}/${chunkKey}`;
    const wireFormat = this.imageWireFormats.get(imageId);
    if (!wireFormat) {
      return Promise.reject(new Error(`No wire format registered for image ${imageId}`));
    }
    const dataType = extractDataType(wireFormat);

    return new Promise<FetchResult>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(compositeKey);
        reject(new Error(`Chunk ${chunkKey} timed out`));
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
        reject(new Error(`Proxy ${responseKey} timed out`));
      }, this.proxyTimeoutMs);

      this.pendingProxy.set(responseKey, {
        resolve: (raw) => {
          clearTimeout(timeoutId);
          let header: ProxyHeaderJs;
          try {
            header = parseProxyHeader(raw, 0);
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
            return;
          }
          const data = raw.slice(64);
          resolve({
            header,
            data,
            wireFormat: { Raw: { data_type: "uint16" } },
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
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  }
}
