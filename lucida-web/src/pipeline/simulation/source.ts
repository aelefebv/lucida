/**
 * The simulated server end of the fetch path: a {@link ContentSource} that
 * answers each chunk request after a fixed latency on the fake clock, and a
 * decode pool that hands the bytes straight back. Every answer is recorded so
 * a run that does not settle can say what the source last told the page.
 */

import type {
  ContentSource,
  FetchRequest,
  FetchResult,
  LabelSink,
} from "../fetch/contentSource.ts";
import type { DecodePool } from "../fetch/decodePool.ts";
import { FetchError } from "../fetch/retry.ts";
import type { DatasetManifest } from "../../manifestTypes.ts";

/**
 * How the source answers one chunk request, in the server's vocabulary:
 * bytes, a generated chunk not made yet, a store read that failed and may
 * work later, or one that never will.
 */
export type SourceAnswer = "ready" | "pending" | "transient" | "permanent";

export interface SourceRequest {
  datasetId: string;
  imageId: string;
  chunkKey: string;
  /** 1 on the first request for this chunk, counting retries. */
  attempt: number;
  /** The simulation clock when the answer is given. */
  nowMs: number;
}

export interface SourceSpec {
  /** Time from request to answer, in ms of the simulation clock. */
  latencyMs?: number;
  /** Defaults to serving every chunk. */
  answer?: (request: SourceRequest) => SourceAnswer;
}

export interface SourceRecord {
  requests: number;
  last: SourceAnswer | "aborted" | "outstanding";
}

export const DEFAULT_SOURCE_LATENCY_MS = 20;

export class SimulatedSource implements ContentSource {
  /** `${imageId}/${chunkKey}` → what happened to its requests. */
  readonly records = new Map<string, SourceRecord>();
  /** Every chunk request ever made, for the "requests nothing further" check. */
  requestCount = 0;
  private nextRid = 0;
  private readonly latencyMs: number;
  private readonly answer: (request: SourceRequest) => SourceAnswer;
  private readonly manifestFor: (datasetId: string) => DatasetManifest | undefined;

  constructor(
    spec: SourceSpec,
    manifestFor: (datasetId: string) => DatasetManifest | undefined,
  ) {
    this.latencyMs = spec.latencyMs ?? DEFAULT_SOURCE_LATENCY_MS;
    this.answer = spec.answer ?? (() => "ready");
    this.manifestFor = manifestFor;
  }

  fetch(request: FetchRequest, signal: AbortSignal, onLabel?: LabelSink): Promise<FetchResult> {
    const key = `${request.imageId}/${request.chunkKey}`;
    const record = this.records.get(key) ?? { requests: 0, last: "outstanding" };
    record.requests++;
    record.last = "outstanding";
    this.records.set(key, record);
    this.requestCount++;
    const attempt = record.requests;
    onLabel?.({ rid: this.nextRid++, connectionGeneration: 1 });

    return new Promise<FetchResult>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        record.last = "aborted";
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        const answer = this.answer({ ...request, attempt, nowMs: performance.now() });
        record.last = answer;
        switch (answer) {
          case "ready":
            resolve(this.bytesFor(request));
            return;
          case "pending":
            reject(new FetchError(`Generated chunk ${request.chunkKey} pending`, { kind: "pending" }));
            return;
          case "transient":
            reject(new FetchError(`Source chunk ${request.chunkKey} unavailable`, {
              kind: "transient",
              serverReported: true,
            }));
            return;
          case "permanent":
            reject(new FetchError(`Source chunk ${request.chunkKey} failed permanently`, {
              kind: "permanent",
              serverReported: true,
            }));
            return;
        }
      }, this.latencyMs);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  handleBinary(): void {}

  /**
   * A full chunk of uint16 samples, as the raw wire format carries an edge
   * chunk. Each answer fills with a different value, so the worker's
   * intensity sampling sees a range.
   */
  private bytesFor(request: FetchRequest): FetchResult {
    const image = this.manifestFor(request.datasetId)?.images.find(
      (img) => img.image_id === request.imageId,
    );
    const level = Number(request.chunkKey.split("/")[0]);
    const chunkShape = image?.multiscale.levels.find((l) => l.level_index === level)?.chunk_shape;
    if (!chunkShape) {
      throw new Error(`simulated source: no level ${level} for ${request.imageId}`);
    }
    const samples = chunkShape.reduce((a, b) => a * b, 1);
    const data = new Uint16Array(samples);
    data.fill(100 + (this.requestCount % 900));
    return {
      bytes: data.buffer,
      wireFormat: { Raw: { data_type: "Uint16" } },
      dataType: "Uint16",
    };
  }
}

/** A decode pool for raw bytes: the wire bytes are already the samples. */
export function passThroughDecodePool(size = 2): DecodePool {
  return {
    size,
    decode: (bytes: ArrayBuffer) => Promise.resolve(bytes),
  } as unknown as DecodePool;
}
