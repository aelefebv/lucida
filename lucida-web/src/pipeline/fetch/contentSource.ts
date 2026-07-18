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
  /** Exact binary response frame bytes reserved before the request is sent. */
  expectedResponseBytes: number;
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

/**
 * Client response-credit window below the server's fixed 32 MiB outbox.
 * Eight MiB remains for control traffic and for peers that are not this
 * implementation. The server outbox remains the final slow-reader guard; a
 * healthy client should never reach it during ordinary chunk flow.
 */
export const DEFAULT_RESPONSE_BYTES_IN_FLIGHT = 24 * 1024 * 1024;

interface PendingRequest {
  resolve: (data: ArrayBuffer) => void;
  // Accepts `FetchError` (rejectDataset/rejectAll) and
  // `DOMException("AbortError")` (signal abort). Both pass through
  // `classifyFetchError` in the cache.
  reject: (err: Error) => void;
  settled: boolean;
  abort: () => void;
}

interface PendingGroup {
  request: FetchRequest;
  registrationGeneration: number;
  entries: PendingRequest[];
  sent: boolean;
  joinable: boolean;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

interface DeferredRequest {
  key: string;
  request: FetchRequest;
  registrationGeneration: number;
  entry: PendingRequest;
}

interface ImageRegistration {
  wireFormat: WireFormat;
  generation: number;
}

export class ProxiedContentSource implements ContentSource {
  private pending = new Map<string, PendingGroup>();
  private sendQueue: string[] = [];
  private deferredUntilNextTransport: DeferredRequest[] = [];
  private transportBoundaryPending = false;
  private responseBytesInFlight = 0;
  private imageWireFormats = new Map<string, Map<string, ImageRegistration>>();
  private registrationGenerations = new Map<string, number>();

  private sendMessage: (json: string) => boolean;
  private resetTransport: () => void;
  private timeoutMs: number;
  private readonly maxResponseBytesInFlight: number;

  constructor(
    sendMessage: (json: string) => boolean,
    resetTransport: () => void,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytesInFlight = DEFAULT_RESPONSE_BYTES_IN_FLIGHT,
  ) {
    if (!Number.isSafeInteger(maxResponseBytesInFlight) || maxResponseBytesInFlight <= 0) {
      throw new Error("Response byte budget must be a positive safe integer");
    }
    this.sendMessage = sendMessage;
    this.resetTransport = resetTransport;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytesInFlight = maxResponseBytesInFlight;
  }

  registerImage(datasetId: string, imageId: string, wireFormat: WireFormat): void {
    let datasetFormats = this.imageWireFormats.get(datasetId);
    if (!datasetFormats) {
      datasetFormats = new Map();
      this.imageWireFormats.set(datasetId, datasetFormats);
    }
    const current = datasetFormats.get(imageId);
    if (current && JSON.stringify(current.wireFormat) === JSON.stringify(wireFormat)) return;
    this.invalidateRegistration(datasetId, imageId);
    const generationKey = this.registrationKey(datasetId, imageId);
    const generation = (this.registrationGenerations.get(generationKey) ?? 0) + 1;
    this.registrationGenerations.set(generationKey, generation);
    datasetFormats.set(imageId, { wireFormat, generation });
  }

  unregisterImage(datasetId: string, imageId: string): void {
    this.invalidateRegistration(datasetId, imageId);
    const datasetFormats = this.imageWireFormats.get(datasetId);
    if (!datasetFormats) return;
    datasetFormats.delete(imageId);
    if (datasetFormats.size === 0) this.imageWireFormats.delete(datasetId);
  }

  unregisterDataset(datasetId: string): void {
    this.invalidateRegistration(datasetId);
    this.imageWireFormats.delete(datasetId);
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
    if (!entries) return;

    for (const entry of entries.entries) {
      this.rejectEntry(entry, generatedStatusToFetchError(status, chunkKey, failure, message));
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
    if (!entries) return;

    const detail = message ? `: ${message}` : "";
    const reason = status === "failed_permanent" ? "failed permanently" : "unavailable";
    const kind = failure.retryable ? "transient" as const : "permanent" as const;
    for (const entry of entries.entries) {
      // `serverReported` regardless of `kind`: the store answered with a
      // failure, so this feeds the delivery-failure streak even when the
      // classification is transient (so a persistently-unavailable source
      // still surfaces) — while the transient/permanent split keeps driving
      // retry as before.
      this.rejectEntry(entry,
        new FetchError(`Source chunk ${chunkKey} ${reason}${detail}`, {
          kind,
          serverReported: true,
          failure,
        }),
      );
    }
  }

  handleChunkData(key: string, data: ArrayBuffer): void {
    const group = this.takePending(key);
    if (!group) return;
    group.entries.forEach((entry, idx) => {
      if (entry.settled) return;
      entry.settled = true;
      entry.resolve(idx === 0 ? data : data.slice(0));
    });
  }

  /** Treated as `abort` downstream; matches caller-driven cancellation. */
  rejectDataset(datasetId: string): void {
    const prefix = datasetId + "/";
    for (const [key, group] of this.pending) {
      if (key.startsWith(prefix)) {
        for (const entry of [...group.entries]) {
          this.rejectEntry(entry, new FetchError("Dataset removed", { kind: "abort" }));
        }
        group.entries = [];
        group.joinable = false;
        // A sent request cannot be cancelled on today's wire. Retain its
        // reservation/tombstone and its original response deadline until a
        // response/status or connection teardown. If the server never answers,
        // that deadline resets the socket epoch instead of leaking credit
        // forever. Unsent work owns no credit and can be removed immediately.
        if (!group.sent) {
          if (group.timeoutId !== null) clearTimeout(group.timeoutId);
          group.timeoutId = null;
          this.removeQueuedGroup(key, group);
        } else {
          this.requestTransportBoundary();
        }
      }
    }
    const retained: DeferredRequest[] = [];
    for (const deferred of this.deferredUntilNextTransport) {
      if (deferred.request.datasetId === datasetId) {
        this.rejectEntry(deferred.entry, new FetchError("Dataset removed", { kind: "abort" }));
      } else {
        retained.push(deferred);
      }
    }
    this.deferredUntilNextTransport = retained;
  }

  /** Transient so the cache's `OnceTransientRetry` covers the reconnect. */
  rejectAll(): void {
    for (const [, group] of this.pending) {
      if (group.timeoutId !== null) clearTimeout(group.timeoutId);
      for (const entry of group.entries) {
        this.rejectEntry(entry, new FetchError("Bridge disconnected", { kind: "transient" }));
      }
    }
    this.pending.clear();
    this.sendQueue = [];
    for (const deferred of this.deferredUntilNextTransport) {
      this.rejectEntry(deferred.entry, new FetchError("Bridge disconnected", { kind: "transient" }));
    }
    this.deferredUntilNextTransport = [];
    this.transportBoundaryPending = false;
    this.responseBytesInFlight = 0;
  }

  fetch(request: FetchRequest, signal: AbortSignal): Promise<FetchResult> {
    const { datasetId, imageId, chunkKey } = request;
    if (!Number.isSafeInteger(request.expectedResponseBytes) || request.expectedResponseBytes <= 0) {
      return Promise.reject(
        new FetchError("Invalid chunk response-size contract", { kind: "permanent" }),
      );
    }
    const compositeKey = `${datasetId}/${imageId}/${chunkKey}`;
    const registration = this.imageWireFormats.get(datasetId)?.get(imageId);
    if (!registration) {
      // Setup bug — retrying won't recover.
      return Promise.reject(
        new FetchError(`No wire format registered for image ${imageId}`, {
          kind: "permanent",
        }),
      );
    }
    const wireFormat = registration.wireFormat;
    const dataType = extractDataType(wireFormat);

    return new Promise<FetchResult>((resolve, reject) => {
      const pendingEntry: PendingRequest = {
        resolve: (bytes) => resolve({ bytes, wireFormat, dataType }),
        reject,
        settled: false,
        abort: () => {},
      };
      pendingEntry.abort = () => {
        if (pendingEntry.settled) return;
        const group = this.pending.get(compositeKey);
        if (!group) {
          const deferredIndex = this.deferredUntilNextTransport.findIndex(
            (candidate) => candidate.entry === pendingEntry,
          );
          if (deferredIndex < 0) return;
          this.deferredUntilNextTransport.splice(deferredIndex, 1);
          this.rejectEntry(pendingEntry, new DOMException("Aborted", "AbortError"));
          return;
        }
        group.entries = group.entries.filter((candidate) => candidate !== pendingEntry);
        this.rejectEntry(pendingEntry, new DOMException("Aborted", "AbortError"));
        if (group.entries.length === 0) {
          // Keep a sent group's original response deadline armed. The caller is
          // settled now, but only a response/status or disconnect can release
          // its credit safely; a missing response must eventually reset this
          // socket epoch. Unsent work owns no credit and can disappear now.
          if (!group.sent) {
            if (group.timeoutId !== null) clearTimeout(group.timeoutId);
            group.timeoutId = null;
            this.removeQueuedGroup(compositeKey, group);
          }
        }
      };

      if (signal.aborted) {
        this.rejectEntry(pendingEntry, new DOMException("Aborted", "AbortError"));
        return;
      }
      this.addPending(compositeKey, request, registration.generation, pendingEntry);
      if (signal.aborted) pendingEntry.abort();
      else signal.addEventListener("abort", pendingEntry.abort, { once: true });
    });
  }

  private addPending(
    key: string,
    request: FetchRequest,
    registrationGeneration: number,
    entry: PendingRequest,
  ): void {
    if (this.transportBoundaryPending) {
      this.deferredUntilNextTransport.push({ key, request, registrationGeneration, entry });
      return;
    }
    const group = this.pending.get(key);
    if (group) {
      if (!group.joinable || group.registrationGeneration !== registrationGeneration) {
        this.requestTransportBoundary();
        this.deferredUntilNextTransport.push({ key, request, registrationGeneration, entry });
        return;
      }
      if (group.request.expectedResponseBytes !== request.expectedResponseBytes) {
        this.rejectEntry(entry, new FetchError("Conflicting response-size contract", { kind: "permanent" }));
        return;
      }
      group.entries.push(entry);
      this.armResponseDeadline(key, group);
      return;
    }
    this.pending.set(key, {
      request,
      registrationGeneration,
      entries: [entry],
      sent: false,
      joinable: true,
      timeoutId: null,
    });
    this.sendQueue.push(key);
    this.drainSendQueue();
  }

  private drainSendQueue(): void {
    for (;;) {
      const key = this.sendQueue[0];
      if (!key) return;
      const group = this.pending.get(key);
      if (!group || group.sent || group.entries.length === 0) {
        this.sendQueue.shift();
        continue;
      }
      const bytes = group.request.expectedResponseBytes;
      if (this.responseBytesInFlight > 0 && this.responseBytesInFlight + bytes > this.maxResponseBytesInFlight) {
        return;
      }

      try {
        const { datasetId, imageId, chunkKey } = group.request;
        const sent = this.sendMessage(JSON.stringify({
          type: "chunk_request",
          dataset_id: datasetId,
          image_id: imageId,
          key: chunkKey,
        }));
        if (!sent) return;
        this.sendQueue.shift();
        group.sent = true;
        this.responseBytesInFlight += bytes;
        this.armResponseDeadline(key, group);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        const waiters = group.entries;
        group.entries = [];
        this.removeQueuedGroup(key, group);
        for (const entry of waiters) this.rejectEntry(entry, failure);
      }
    }
  }

  private takePending(key: string): PendingGroup | undefined {
    const group = this.pending.get(key);
    if (!group) return undefined;
    this.pending.delete(key);
    if (group.timeoutId !== null) clearTimeout(group.timeoutId);
    if (group.sent) {
      this.responseBytesInFlight = Math.max(
        0,
        this.responseBytesInFlight - group.request.expectedResponseBytes,
      );
    }
    this.drainSendQueue();
    return group;
  }

  private armResponseDeadline(key: string, group: PendingGroup): void {
    if (!group.sent || group.timeoutId !== null || group.entries.length === 0) return;
    group.timeoutId = setTimeout(() => {
      if (this.pending.get(key) !== group) return;
      group.timeoutId = null;
      const waiters = group.entries;
      group.entries = [];
      for (const entry of waiters) {
        this.rejectEntry(
          entry,
          new FetchError(`Chunk ${group.request.chunkKey} timed out`, { kind: "transient" }),
        );
      }
      // The deadline settles any remaining local waiters, but it does not
      // release response credit: the server may still deliver this frame on
      // the current connection. Force the definitive connection-epoch
      // terminal now, including for a tombstone whose callers already aborted
      // or whose dataset was removed. Retrying on the same socket would overlap
      // an unaccounted late response.
      this.requestTransportBoundary();
    }, this.timeoutMs);
  }

  /**
   * Definitive terminal for the current WebSocket epoch. Unlike `rejectAll`,
   * a boundary we initiated preserves requests deliberately deferred until the
   * replacement epoch; every old-epoch request and response credit is retired.
   */
  handleTransportClosed(): void {
    const preserveDeferred = this.transportBoundaryPending;
    for (const [, group] of this.pending) {
      if (group.timeoutId !== null) clearTimeout(group.timeoutId);
      for (const entry of group.entries) {
        this.rejectEntry(entry, new FetchError("Bridge disconnected", { kind: "transient" }));
      }
    }
    this.pending.clear();
    this.sendQueue = [];
    this.responseBytesInFlight = 0;
    this.transportBoundaryPending = false;
    if (!preserveDeferred) {
      for (const deferred of this.deferredUntilNextTransport) {
        this.rejectEntry(deferred.entry, new FetchError("Bridge disconnected", { kind: "transient" }));
      }
      this.deferredUntilNextTransport = [];
    }
  }

  /** Retry locally queued requests after a WebSocket transitions to OPEN. */
  handleTransportReady(): void {
    if (this.transportBoundaryPending) return;
    const deferred = this.deferredUntilNextTransport;
    this.deferredUntilNextTransport = [];
    for (const waiting of deferred) {
      if (waiting.entry.settled) continue;
      const registration = this.imageWireFormats
        .get(waiting.request.datasetId)
        ?.get(waiting.request.imageId);
      if (!registration || registration.generation !== waiting.registrationGeneration) {
        this.rejectEntry(
          waiting.entry,
          new FetchError("Chunk registration changed before transport reconnect", {
            kind: "transient",
          }),
        );
        continue;
      }
      this.addPending(
        waiting.key,
        waiting.request,
        waiting.registrationGeneration,
        waiting.entry,
      );
    }
    this.drainSendQueue();
  }

  private invalidateRegistration(datasetId: string, imageId?: string): void {
    let needsBoundary = false;
    for (const [key, group] of this.pending) {
      if (
        group.request.datasetId !== datasetId ||
        (imageId !== undefined && group.request.imageId !== imageId)
      ) {
        continue;
      }
      group.joinable = false;
      const waiters = group.entries;
      group.entries = [];
      for (const entry of waiters) {
        this.rejectEntry(
          entry,
          new FetchError("Chunk registration changed", { kind: "transient" }),
        );
      }
      if (group.sent) {
        needsBoundary = true;
      } else {
        if (group.timeoutId !== null) clearTimeout(group.timeoutId);
        group.timeoutId = null;
        this.removeQueuedGroup(key, group);
      }
    }
    const retained: DeferredRequest[] = [];
    for (const waiting of this.deferredUntilNextTransport) {
      if (
        waiting.request.datasetId === datasetId &&
        (imageId === undefined || waiting.request.imageId === imageId)
      ) {
        this.rejectEntry(
          waiting.entry,
          new FetchError("Chunk registration changed", { kind: "transient" }),
        );
      } else {
        retained.push(waiting);
      }
    }
    this.deferredUntilNextTransport = retained;
    if (needsBoundary) this.requestTransportBoundary();
  }

  private requestTransportBoundary(): void {
    if (this.transportBoundaryPending) return;
    this.transportBoundaryPending = true;
    this.resetTransport();
  }

  private registrationKey(datasetId: string, imageId: string): string {
    return `${datasetId.length}:${datasetId}${imageId.length}:${imageId}`;
  }

  private removeQueuedGroup(key: string, group: PendingGroup): void {
    if (this.pending.get(key) !== group || group.sent) return;
    this.pending.delete(key);
    this.sendQueue = this.sendQueue.filter((candidate) => candidate !== key);
  }

  private rejectEntry(entry: PendingRequest, error: Error): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.reject(error);
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
