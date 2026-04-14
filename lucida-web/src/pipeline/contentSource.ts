/**
 * Content Source — resolves logical chunk requests to physical bytes via the network.
 *
 * Transport only. Returns raw wire-format bytes alongside transport metadata.
 * Does not decode, normalize, or cache.
 */

import type { WireFormat } from "../contentTypes.ts";
import { extractDataType } from "./decodePool.ts";

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

export interface ContentSource {
  fetch(request: FetchRequest, signal: AbortSignal): Promise<FetchResult>;
}

// ---------------------------------------------------------------------------
// ProxiedContentSource — wraps the WebSocket bridge
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000;

interface PendingRequest {
  resolve: (data: ArrayBuffer) => void;
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export class ProxiedContentSource implements ContentSource {
  private pending = new Map<string, PendingRequest>();
  private imageWireFormats = new Map<string, WireFormat>();

  constructor(
    private sendMessage: (json: string) => void,
    private timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

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
  }

  /** Reject all pending requests (on disconnect). */
  rejectAll(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timeoutId);
      entry.reject(new Error("Bridge disconnected"));
    }
    this.pending.clear();
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
}
