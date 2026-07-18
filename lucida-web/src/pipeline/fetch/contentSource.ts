// Transport only — resolves chunk requests to wire-format bytes; does
// not decode, normalize, or cache.

import { extractDataType, type WireFormat } from "../../manifestTypes.ts";
import type { GeneratedChunkStatus } from "../generatedAvailability.ts";
import type { FailureDescriptor } from "../../failureContract.ts";
import { FetchError } from "./retry.ts";


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

export interface ContentSource {
  fetch(request: FetchRequest, signal: AbortSignal): Promise<FetchResult>;
  /** Route a binary chunk frame back to its pending request. */
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

interface PendingRequest {
  resolve: (data: ArrayBuffer) => void;
  // Accepts `FetchError` (rejectDataset/rejectAll) and
  // `DOMException("AbortError")` (signal abort). Both pass through
  // `classifyFetchError` in the cache.
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export class ProxiedContentSource implements ContentSource {
  private pending = new Map<string, PendingRequest[]>();
  private imageWireFormats = new Map<string, WireFormat>();

  private sendMessage: (json: string) => void;
  private timeoutMs: number;

  constructor(
    sendMessage: (json: string) => void,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.sendMessage = sendMessage;
    this.timeoutMs = timeoutMs;
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

  handleBinary(key: string, data: ArrayBuffer): void {
    this.handleChunkData(key, data);
  }

  handleChunkStatus(
    datasetId: string,
    imageId: string,
    chunkKey: string,
    status: GeneratedChunkStatus,
    failure?: FailureDescriptor | null,
    message?: string | null,
  ): void {
    const compositeKey = `${datasetId}/${imageId}/${chunkKey}`;
    const entries = this.takePending(compositeKey);
    if (entries.length === 0) return;

    for (const entry of entries) {
      clearTimeout(entry.timeoutId);
      entry.reject(generatedStatusToFetchError(status, chunkKey, failure, message));
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
    failure: FailureDescriptor,
    message?: string | null,
  ): void {
    const compositeKey = `${datasetId}/${imageId}/${chunkKey}`;
    const entries = this.takePending(compositeKey);
    if (entries.length === 0) return;

    const detail = message ? `: ${message}` : "";
    const reason = status === "failed_permanent" ? "failed permanently" : "unavailable";
    const kind = failure.retryable ? "transient" as const : "permanent" as const;
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
          failure,
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

  /** Treated as `abort` downstream; matches caller-driven cancellation. */
  rejectDataset(datasetId: string): void {
    const prefix = datasetId + "/";
    for (const [key, entries] of this.pending) {
      if (key.startsWith(prefix)) {
        this.pending.delete(key);
        for (const entry of entries) {
          clearTimeout(entry.timeoutId);
          entry.reject(new FetchError("Dataset removed", { kind: "abort" }));
        }
      }
    }
  }

  /** Transient so the cache's `OnceTransientRetry` covers the reconnect. */
  rejectAll(): void {
    for (const [, entries] of this.pending) {
      for (const entry of entries) {
        clearTimeout(entry.timeoutId);
        entry.reject(new FetchError("Bridge disconnected", { kind: "transient" }));
      }
    }
    this.pending.clear();
  }

  fetch(request: FetchRequest, signal: AbortSignal): Promise<FetchResult> {
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

      const shouldSend = this.addPending(compositeKey, pendingEntry);
      if (shouldSend) {
        this.sendMessage(JSON.stringify({
          type: "chunk_request",
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

  private addPending(key: string, entry: PendingRequest): boolean {
    const entries = this.pending.get(key);
    if (entries) {
      entries.push(entry);
      return false;
    }
    this.pending.set(key, [entry]);
    return true;
  }

  private removePending(key: string, entry: PendingRequest): void {
    const entries = this.pending.get(key);
    if (!entries) return;
    const next = entries.filter((candidate) => candidate !== entry);
    if (next.length === 0) {
      this.pending.delete(key);
    } else {
      this.pending.set(key, next);
    }
  }

  private takePending(key: string): PendingRequest[] {
    const entries = this.pending.get(key) ?? [];
    this.pending.delete(key);
    return entries;
  }
}

function generatedStatusToFetchError(
    status: GeneratedChunkStatus,
    chunkKey: string,
    failure?: FailureDescriptor | null,
    message?: string | null,
): FetchError {
  const detail = message ? `: ${message}` : "";
  switch (status) {
    case "pending":
      return new FetchError(`Generated chunk ${chunkKey} pending${detail}`, {
        kind: "pending",
        failure,
      });
    case "failed_transient":
      return new FetchError(`Generated chunk ${chunkKey} transient failure${detail}`, {
        kind: failure?.retryable === false ? "permanent" : "transient",
        failure,
      });
    case "unavailable":
    case "failed_permanent":
      return new FetchError(`Generated chunk ${chunkKey} unavailable${detail}`, {
        kind: failure?.retryable === true ? "transient" : "permanent",
        failure,
      });
    case "ready":
      return new FetchError(`Generated chunk ${chunkKey} reported ready without bytes${detail}`, {
        kind: "transient",
        failure,
      });
  }
}
