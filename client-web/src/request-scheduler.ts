export type RequestPriorityClass =
  | "visible_center"
  | "visible_ring"
  | "coarse_fallback"
  | "refine"
  | "prefetch_neighbor"
  | "prefetch_refine";

export type ScheduledRequest<T> = {
  key: string;
  generationSeq: number;
  priority?: number;
  priorityClass?: RequestPriorityClass;
  execute: (signal: AbortSignal) => Promise<T>;
};

type QueueEntry<T> = {
  request: ScheduledRequest<T>;
  effectivePriority: number;
  sequence: number;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

export class RequestScheduler {
  private readonly maxConcurrent: number;
  private readonly maxQueueSize: number;
  private queue: QueueEntry<unknown>[];
  private readonly active: Map<
    string,
    { controller: AbortController; generationSeq: number }
  >;
  private sequenceCounter: number;

  public constructor(maxConcurrent = 4, maxQueueSize = 128) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.maxQueueSize = Math.max(1, maxQueueSize);
    this.queue = [];
    this.active = new Map();
    this.sequenceCounter = 0;
  }

  public schedule<T>(request: ScheduledRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const effectivePriority = requestPriority(request);
      this.queue = this.queue.filter((entry) => {
        const existing = entry.request as ScheduledRequest<unknown>;
        if (
          existing.key === request.key &&
          existing.generationSeq < request.generationSeq
        ) {
          entry.reject(new Error("request superseded by newer generation"));
          return false;
        }
        return true;
      });
      this.queue.push({
        request,
        effectivePriority,
        sequence: this.sequenceCounter,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.sequenceCounter += 1;
      this.queue.sort(compareQueueEntries);
      this.applyQueuePressure();
      this.pump();
    });
  }

  public cancel(key: string): void {
    this.queue = this.queue.filter((entry) => {
      if (entry.request.key === key) {
        entry.reject(new Error("request cancelled"));
        return false;
      }
      return true;
    });
    const active = this.active.get(key);
    if (active !== undefined) {
      active.controller.abort();
      this.active.delete(key);
    }
  }

  public invalidateOlderGenerations(minGenerationSeq: number): void {
    this.queue = this.queue.filter((entry) => {
      if (entry.request.generationSeq < minGenerationSeq) {
        entry.reject(new Error("request invalidated by generation change"));
        return false;
      }
      return true;
    });
    for (const [key, active] of this.active.entries()) {
      if (active.generationSeq < minGenerationSeq) {
        active.controller.abort();
        this.active.delete(key);
      }
    }
  }

  private pump(): void {
    while (this.active.size < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next === undefined) {
        break;
      }
      const controller = new AbortController();
      this.active.set(next.request.key, {
        controller,
        generationSeq: next.request.generationSeq,
      });
      next.request
        .execute(controller.signal)
        .then((value) => {
          this.active.delete(next.request.key);
          next.resolve(value);
          this.pump();
        })
        .catch((error) => {
          this.active.delete(next.request.key);
          next.reject(error);
          this.pump();
        });
    }
  }

  private applyQueuePressure(): void {
    while (this.queue.length > this.maxQueueSize) {
      const dropped = this.queue.pop();
      if (dropped === undefined) {
        return;
      }
      dropped.reject(new Error("request dropped due queue pressure"));
    }
  }
}

type CacheEntry<T> = {
  value: T;
  generationSeq: number;
};

export class LruGenerationCache<T> {
  private readonly maxEntries: number;
  private readonly entries: Map<string, CacheEntry<T>>;

  public constructor(maxEntries: number) {
    this.maxEntries = Math.max(1, maxEntries);
    this.entries = new Map();
  }

  public get(key: string): CacheEntry<T> | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) {
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  public set(key: string, value: T, generationSeq: number): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, { value, generationSeq });
    this.evictIfNeeded();
  }

  public invalidateOlderGenerations(minGenerationSeq: number): void {
    for (const [key, entry] of this.entries.entries()) {
      if (entry.generationSeq < minGenerationSeq) {
        this.entries.delete(key);
      }
    }
  }

  public size(): number {
    return this.entries.size;
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      this.entries.delete(oldestKey);
    }
  }
}

const PRIORITY_BY_CLASS: Record<RequestPriorityClass, number> = {
  visible_center: 100,
  visible_ring: 90,
  coarse_fallback: 80,
  refine: 70,
  prefetch_neighbor: 50,
  prefetch_refine: 40,
};

function requestPriority(request: ScheduledRequest<unknown>): number {
  if (typeof request.priority === "number" && Number.isFinite(request.priority)) {
    return request.priority;
  }
  if (request.priorityClass !== undefined) {
    return PRIORITY_BY_CLASS[request.priorityClass];
  }
  return 0;
}

function compareQueueEntries(
  left: QueueEntry<unknown>,
  right: QueueEntry<unknown>,
): number {
  if (left.effectivePriority !== right.effectivePriority) {
    return right.effectivePriority - left.effectivePriority;
  }
  return left.sequence - right.sequence;
}
