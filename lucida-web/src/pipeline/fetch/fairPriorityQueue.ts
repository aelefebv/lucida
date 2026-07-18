/**
 * Incremental priority queue with round-robin fairness between dataset-owned
 * buckets.
 *
 * Each bucket is a binary min-heap. Updates are O(log n) and removals are O(1)
 * through lazy invalidation; stale heap nodes are discarded when they reach the
 * root. A bounded compaction keeps repeated priority updates from accumulating
 * unbounded tombstones. `snapshotFair()` is intentionally the only O(N log N)
 * operation and exists for diagnostics/tests, never the fetch or upload hot
 * path.
 */

type QueueItem = {
  datasetId: string;
};

interface HeapNode<Item> {
  key: string;
  bucket: string;
  item: Item;
  version: number;
  sequence: number;
}

type LiveEntry<Item> = HeapNode<Item>;

interface Bucket<Item> {
  heap: Array<HeapNode<Item>>;
  liveCount: number;
}

export interface FairPriorityQueueOptions<Item extends QueueItem> {
  keyOf: (item: Item) => string;
  compare?: (a: Item, b: Item) => number;
  /** Defaults to one fair bucket per dataset. */
  bucketOf?: (item: Item) => string;
  /** Avoids creating a tombstone when a refreshed item is equivalent. */
  equals?: (a: Item, b: Item) => boolean;
}

export class FairPriorityQueue<Item extends QueueItem> {
  private readonly keyOf: (item: Item) => string;
  private readonly compareItems: (a: Item, b: Item) => number;
  private readonly bucketOf: (item: Item) => string;
  private readonly equals: (a: Item, b: Item) => boolean;

  private readonly entries = new Map<string, LiveEntry<Item>>();
  private readonly keysByDataset = new Map<string, Set<string>>();
  private readonly buckets = new Map<string, Bucket<Item>>();
  private readonly bucketOrder: string[] = [];
  private cursor = 0;
  private version = 0;
  private sequence = 0;

  constructor(options: FairPriorityQueueOptions<Item>) {
    this.keyOf = options.keyOf;
    this.compareItems = options.compare ?? (() => 0);
    this.bucketOf = options.bucketOf ?? ((item) => item.datasetId);
    this.equals = options.equals ?? ((a, b) => a === b);
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): Item | undefined {
    return this.entries.get(key)?.item;
  }

  upsert(item: Item): void {
    const key = this.keyOf(item);
    const bucketName = this.bucketOf(item);
    const existing = this.entries.get(key);
    if (
      existing &&
      existing.bucket === bucketName &&
      this.equals(existing.item, item)
    ) {
      return;
    }

    const bucket = this.ensureBucket(bucketName);
    if (!existing || existing.bucket !== bucketName) bucket.liveCount++;
    if (existing && existing.bucket !== bucketName) {
      this.decrementBucket(existing.bucket);
    }
    const entry: LiveEntry<Item> = {
      key,
      bucket: bucketName,
      item,
      version: ++this.version,
      sequence: existing?.sequence ?? this.sequence++,
    };
    this.entries.set(key, entry);
    this.keysForDataset(item.datasetId).add(key);
    if (existing && existing.item.datasetId !== item.datasetId) {
      this.keysByDataset.get(existing.item.datasetId)?.delete(key);
    }
    this.heapPush(bucket.heap, entry);
    this.compactIfNeeded(bucketName, bucket);
  }

  delete(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.decrementBucket(entry.bucket);
    const datasetKeys = this.keysByDataset.get(entry.item.datasetId);
    datasetKeys?.delete(key);
    if (datasetKeys?.size === 0) this.keysByDataset.delete(entry.item.datasetId);
    return true;
  }

  replaceDataset(datasetId: string, items: readonly Item[]): string[] {
    for (const item of items) {
      if (item.datasetId !== datasetId) {
        throw new Error(
          `FairPriorityQueue.replaceDataset(${datasetId}) received item owned by ${item.datasetId}`,
        );
      }
    }
    const desired = new Set(items.map((item) => this.keyOf(item)));
    const removed: string[] = [];
    for (const key of [...(this.keysByDataset.get(datasetId) ?? [])]) {
      if (!desired.has(key)) {
        this.delete(key);
        removed.push(key);
      }
    }
    for (const item of items) {
      this.upsert(item);
    }
    return removed;
  }

  applyDatasetDelta(
    datasetId: string,
    upserts: readonly Item[],
    removedKeys: readonly string[],
  ): string[] {
    for (const item of upserts) {
      if (item.datasetId !== datasetId) {
        throw new Error(
          `FairPriorityQueue.applyDatasetDelta(${datasetId}) received item owned by ${item.datasetId}`,
        );
      }
    }
    const removed: string[] = [];
    for (const key of removedKeys) {
      const current = this.entries.get(key);
      if (current?.item.datasetId === datasetId) {
        this.delete(key);
        removed.push(key);
      }
    }
    for (const item of upserts) {
      this.upsert(item);
    }
    return removed;
  }

  removeDataset(datasetId: string): string[] {
    const keys = [...(this.keysByDataset.get(datasetId) ?? [])];
    for (const key of keys) this.delete(key);
    return keys;
  }

  deleteWhere(predicate: (item: Item) => boolean): string[] {
    const removed: string[] = [];
    for (const [key, entry] of this.entries) {
      if (!predicate(entry.item)) continue;
      this.delete(key);
      removed.push(key);
    }
    return removed;
  }

  /** Remove and return the next fair, locally-prioritized item. */
  shift(): Item | undefined {
    const bucketCount = this.bucketOrder.length;
    if (bucketCount === 0 || this.entries.size === 0) return undefined;

    for (let offset = 0; offset < bucketCount; offset++) {
      const index = (this.cursor + offset) % bucketCount;
      const bucketName = this.bucketOrder[index];
      const bucket = this.buckets.get(bucketName);
      if (!bucket) continue;
      const node = this.heapPopLive(bucket.heap);
      if (!node) continue;

      this.entries.delete(node.key);
      const removedBucket = this.decrementBucket(node.bucket);
      const datasetKeys = this.keysByDataset.get(node.item.datasetId);
      datasetKeys?.delete(node.key);
      if (datasetKeys?.size === 0) this.keysByDataset.delete(node.item.datasetId);
      const nextBucketCount = this.bucketOrder.length;
      this.cursor = nextBucketCount === 0
        ? 0
        : removedBucket
          ? index % nextBucketCount
          : (index + 1) % nextBucketCount;
      return node.item;
    }
    return undefined;
  }

  clear(): void {
    this.entries.clear();
    this.keysByDataset.clear();
    this.buckets.clear();
    this.bucketOrder.length = 0;
    this.cursor = 0;
  }

  /**
   * Diagnostic copy in the same round-robin order `shift()` would produce.
   * This never participates in scheduling or upload delivery.
   */
  snapshotFair(): Item[] {
    if (this.entries.size === 0) return [];
    const perBucket = new Map<string, LiveEntry<Item>[]>();
    for (const entry of this.entries.values()) {
      const items = perBucket.get(entry.bucket);
      if (items) items.push(entry);
      else perBucket.set(entry.bucket, [entry]);
    }
    for (const items of perBucket.values()) {
      items.sort((a, b) => this.compareNodes(a, b));
    }

    const offsets = new Map<string, number>();
    const result: Item[] = [];
    const bucketCount = this.bucketOrder.length;
    while (result.length < this.entries.size) {
      let progressed = false;
      for (let offset = 0; offset < bucketCount; offset++) {
        const bucketName = this.bucketOrder[(this.cursor + offset) % bucketCount];
        const items = perBucket.get(bucketName);
        const at = offsets.get(bucketName) ?? 0;
        if (!items || at >= items.length) continue;
        result.push(items[at].item);
        offsets.set(bucketName, at + 1);
        progressed = true;
      }
      if (!progressed) break;
    }
    return result;
  }

  private ensureBucket(name: string): Bucket<Item> {
    let bucket = this.buckets.get(name);
    if (bucket) return bucket;
    bucket = { heap: [], liveCount: 0 };
    this.buckets.set(name, bucket);
    this.bucketOrder.push(name);
    return bucket;
  }

  /** Decrement a bucket and remove its tombstone heap once no live key owns it. */
  private decrementBucket(name: string): boolean {
    const bucket = this.buckets.get(name);
    if (!bucket) return false;
    bucket.liveCount--;
    if (bucket.liveCount > 0) return false;
    this.buckets.delete(name);
    const index = this.bucketOrder.indexOf(name);
    if (index >= 0) {
      this.bucketOrder.splice(index, 1);
      if (index < this.cursor) this.cursor--;
      if (this.cursor >= this.bucketOrder.length) this.cursor = 0;
    }
    return true;
  }

  private keysForDataset(datasetId: string): Set<string> {
    let keys = this.keysByDataset.get(datasetId);
    if (!keys) {
      keys = new Set();
      this.keysByDataset.set(datasetId, keys);
    }
    return keys;
  }

  private compareNodes(a: HeapNode<Item>, b: HeapNode<Item>): number {
    return (
      this.compareItems(a.item, b.item) ||
      a.sequence - b.sequence ||
      a.key.localeCompare(b.key)
    );
  }

  private heapPush(heap: Array<HeapNode<Item>>, node: HeapNode<Item>): void {
    heap.push(node);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compareNodes(heap[parent], heap[index]) <= 0) break;
      [heap[parent], heap[index]] = [heap[index], heap[parent]];
      index = parent;
    }
  }

  private heapPop(heap: Array<HeapNode<Item>>): HeapNode<Item> | undefined {
    if (heap.length === 0) return undefined;
    const first = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < heap.length && this.compareNodes(heap[left], heap[smallest]) < 0) {
          smallest = left;
        }
        if (right < heap.length && this.compareNodes(heap[right], heap[smallest]) < 0) {
          smallest = right;
        }
        if (smallest === index) break;
        [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
        index = smallest;
      }
    }
    return first;
  }

  private heapPopLive(heap: Array<HeapNode<Item>>): LiveEntry<Item> | undefined {
    for (;;) {
      const node = this.heapPop(heap);
      if (!node) return undefined;
      const live = this.entries.get(node.key);
      if (live?.version === node.version && live.bucket === node.bucket) return live;
    }
  }

  private compactIfNeeded(bucketName: string, bucket: Bucket<Item>): void {
    if (bucket.heap.length <= bucket.liveCount * 3 + 32) return;
    bucket.heap = [];
    for (const entry of this.entries.values()) {
      if (entry.bucket === bucketName) this.heapPush(bucket.heap, entry);
    }
  }
}
