/**
 * The simulated server end of the fetch path: a {@link ContentSource} that
 * answers each chunk request after a fixed latency on the fake clock, and a
 * decode pool that hands the bytes straight back. Every answer is recorded so
 * a run that does not settle can say what the source last told the page.
 */

import {
  sourceChunkFailure,
  type ChunkFailureKind,
  type ContentSource,
  type FetchRequest,
  type FetchResult,
  type LabelSink,
  type SourceChunkStatus,
} from "../fetch/contentSource.ts";
import type { DecodePool } from "../fetch/decodePool.ts";
import { FetchError } from "../fetch/retry.ts";
import type { DatasetManifest } from "../../manifestTypes.ts";

/**
 * How the source answers one chunk request, in the server's vocabulary:
 * bytes, a generated chunk not made yet, or a `source_chunk_status` frame.
 * `transient` and `permanent` are a frame that names no kind, as a server
 * that predates kinds sends.
 */
export type SourceAnswer =
  | "ready"
  | "pending"
  | "transient"
  | "permanent"
  | { status: SourceChunkStatus; failure: ChunkFailureKind };

export interface SourceRequest {
  datasetId: string;
  imageId: string;
  chunkKey: string;
  /** 1 on the first request for this chunk, counting retries. */
  attempt: number;
  /** The simulation clock when the answer is given. */
  nowMs: number;
}

/** The chunk a request names. */
export interface SourceChunk {
  imageId: string;
  chunkKey: string;
}

export interface SourceSpec {
  /** Time from request to answer, in ms of the simulation clock, for every chunk or per chunk. */
  latencyMs?: number | ((chunk: SourceChunk) => number);
  /** Defaults to serving every chunk. */
  answer?: (request: SourceRequest) => SourceAnswer;
  /** A chunk's `count` uint16 samples. Defaults to {@link rampSamples}. */
  samples?: (chunk: SourceChunk, count: number) => Uint16Array<ArrayBuffer>;
}

export interface SourceRecord {
  requests: number;
  /** The last answer, by its name or the failure it named. */
  last: string;
}

export const DEFAULT_SOURCE_LATENCY_MS = 20;

export class SimulatedSource implements ContentSource {
  /** `${imageId}/${chunkKey}` → what happened to its requests. */
  readonly records = new Map<string, SourceRecord>();
  /** Every chunk request ever made, for the "requests nothing further" check. */
  requestCount = 0;
  /** `${imageId}/${chunkKey}` of each chunk served, in the order the bytes went out. */
  readonly served: string[] = [];
  private nextRid = 0;
  private readonly latencyMs: (chunk: SourceChunk) => number;
  private readonly samples: (chunk: SourceChunk, count: number) => Uint16Array<ArrayBuffer>;
  private readonly answer: (request: SourceRequest) => SourceAnswer;
  private readonly manifestFor: (datasetId: string) => DatasetManifest | undefined;

  constructor(
    spec: SourceSpec,
    manifestFor: (datasetId: string) => DatasetManifest | undefined,
  ) {
    const latency = spec.latencyMs ?? DEFAULT_SOURCE_LATENCY_MS;
    this.latencyMs = typeof latency === "number" ? () => latency : latency;
    this.samples = spec.samples ?? rampSamples;
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
        record.last = typeof answer === "string" ? answer : answer.failure;
        if (typeof answer === "object") {
          reject(sourceChunkFailure(request.chunkKey, answer.status, answer.failure, null));
          return;
        }
        switch (answer) {
          case "ready":
            this.served.push(key);
            resolve(this.bytesFor(request));
            return;
          case "pending":
            reject(new FetchError(`Generated chunk ${request.chunkKey} pending`, { kind: "pending" }));
            return;
          case "transient":
            reject(sourceChunkFailure(request.chunkKey, "unavailable", null, null));
            return;
          case "permanent":
            reject(sourceChunkFailure(request.chunkKey, "failed_permanent", null, null));
            return;
        }
      }, this.latencyMs(request));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  handleBinary(): void {}

  /** A full chunk of uint16 samples, as the raw wire format carries an edge chunk. */
  private bytesFor(request: FetchRequest): FetchResult {
    const image = this.manifestFor(request.datasetId)?.images.find(
      (img) => img.image_id === request.imageId,
    );
    const level = Number(request.chunkKey.split("/")[0]);
    const chunkShape = image?.multiscale.levels.find((l) => l.level_index === level)?.chunk_shape;
    if (!chunkShape) {
      throw new Error(`simulated source: no level ${level} for ${request.imageId}`);
    }
    const data = this.samples(request, chunkShape.reduce((a, b) => a * b, 1));
    return {
      bytes: data.buffer,
      wireFormat: { Raw: { data_type: "Uint16" } },
      dataType: "Uint16",
    };
  }
}

/**
 * Samples that depend on the chunk alone, never on when it was asked for,
 * so two runs that fetch in different orders see the same data. Each chunk
 * is a ramp from its own base, so chunks differ and so do samples within one.
 */
export function rampSamples(chunk: SourceChunk, count: number): Uint16Array<ArrayBuffer> {
  let h = 0x811c9dc5;
  for (const ch of `${chunk.imageId}/${chunk.chunkKey}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  const base = 100 + ((h >>> 0) % 900);
  const data = new Uint16Array(count);
  for (let i = 0; i < count; i++) data[i] = base + (i % 251);
  return data;
}

/** A decode pool for raw bytes: the wire bytes are already the samples. */
export function passThroughDecodePool(size = 2): DecodePool {
  return {
    size,
    decode: (bytes: ArrayBuffer) => Promise.resolve(bytes),
  } as unknown as DecodePool;
}
