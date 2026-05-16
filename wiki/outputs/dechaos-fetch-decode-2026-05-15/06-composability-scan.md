# Pass 6 — Composability Scan: fetch/decode subsystem

Goal: identify logic trapped inside large workflows that could be lifted out as small, reusable, swappable pieces.

## Quick verifications from Pass 5

- ✅ **`ChunkRequest.lane: "proxy"` is unused in production.** No hits across `lucida-web/src/`. Drop from the union; the cache's lane-routing branch becomes simpler.
- ✅ **Plan IS sorted by priority before submission** (`plan.ts:120-122`). `submit()` preserves the order by rebuilding `pendingRequests` in plan iteration order. `startChunkFetches` does FIFO `shift()` on the sorted list. Critical-if-broken issue resolves to "correct." Note: `submit()` discards any leftover `pendingRequests` from the previous tick; they're re-emitted by the next plan if still wanted. Worth a one-line doc.

## Composable units already present

A few already-extracted pieces work well as standalone units:

- `extractDataType(wireFormat)` — pure helper, ~5 LOC. Wrong location (Pass 3) but composable. ✅
- `parseProxyHeader(buffer, offset)` — pure decoder, 37 LOC. Tested only via cache integration. ✅
- `proxyResponseKey(entityId, kind, t, c)` — pure key composer. ✅
- `decompressLz4(src)` — pure transform, re-exported for tests. ✅
- `normalize(buf, dataType)` — pure transform, re-exported. ✅
- `defaultPoolSize()` — pure heuristic. ✅
- `freshTierCounters()` / `percentile()` — small pure helpers in cpuCache.ts. ✅

The decode worker pipeline (`decompress → normalize`) is a textbook composable two-stage pipeline. Healthy.

## Logic trapped inside `CpuCache`

Each item below is a candidate for extraction into its own composable primitive.

### 1. The dedup ladder (in `submit`, lines 431-470)

Inside `submit()`'s per-request loop, four conditions are inlined:
```
if (rejectedKeys.has(req)) skip
if (cached) refresh + skip
if (inFlight.has(key)) skip
if (failed-not-cleared) skip
push to pending
```

Trapped because:
- Order matters (rejected before cached; cached before in-flight; in-flight before failed).
- Side effects: cached path bumps `totalHits` and refreshes `lastSeenTick + priority`; rejected path does NOT refresh (deliberate); failed path does not refresh.
- Reuse: 0 today. But it's the same logic the orchestrator uses (informally) to decide whether to bother re-sending — see `orchestrator:1467-1490`.

**Suggested primitive:**
```ts
type DedupVerdict =
  | { action: "skip"; reason: "rejected" | "in-flight" | "failed" }
  | { action: "refresh"; entry: CacheEntry }     // hit; refresh metadata
  | { action: "enqueue" };                        // genuinely new

dedup(req: ChunkRequest, store, scheduler, failures, rejections): DedupVerdict
```

The pure verdict makes the side-effect application explicit (caller does the refresh / push-to-pending separately) and lets tests exercise each branch independently.

### 2. Active-set tier promotion/demotion (in `submit`, lines 417-423)

```
const newActiveIds = new Set(plan.activeSet.map(e => e.entityId));
for (const entityId of activeEntityIds) {
  if (!newActiveIds.has(entityId)) demoteEntity(entityId);
}
activeEntityIds = newActiveIds;
```

Trapped because: shared mutable state, tied to `submit`'s tick.

**Suggested primitive:**
```ts
class ActiveSetTracker {
  promote(activeIds: Set<string>): { demoted: string[] };
}
```
Returns the diff; cache uses it to drive `demoteEntity`. Or fold both into a `Store.applyActiveSet(activeIds)` method on the store itself. Mechanical.

### 3. The fetch-and-decode happy path (lines 1083-1230)

148 LOC of interleaved try/catch/retry/byte-accounting/decode/insert/notify/recurse. Pass 3 sketched the decomposition:

- `tryFetch(req, signal): Promise<FetchOutcome>` — handles abort + classify + retry once.
- `tryDecode(bytes, wireFormat): Promise<DecodeOutcome>` — wraps timing.
- `cacheAndDeliver(req, decoded, ...): void` — builds entry, routes, pushes ready.

Each is independently testable. `tryFetch` becomes a great primitive for retry-policy variations (e.g., never-retry for proxies; multi-retry for overview).

### 4. The fetch scheduler loop (lines 1035-1067 and 1236-1246)

Two near-identical loops:
```
while (pending.length && inFlight.size < cap && bytes < cap) {
  const req = pending.shift();
  start(req);
}
```

Plus the chunk version emits a backpressure log if pending > 0 after the loop.

**Suggested primitive:** `Scheduler` class with `enqueue(req)`, `start()` (drain to capacity), `inFlightCount`, `inFlightBytes`. Both chunks and proxies become instances of this. Backpressure logging is a callback or a `BackpressureReporter` collaborator.

This is **the highest-payoff composability win** because it's the seam where chunk and proxy paths can finally share code (Seam A from Pass 2).

### 5. Eviction policies (lines 1480-1540 + `evictProxyIfNeeded` 1342-1366)

Three policies in two helpers:
- `evictLRU(cache, bytesNeeded, cacheType)` — pure LRU
- `evictTiered(cache, bytesNeeded)` — tier order driven by interaction mode + active-detail tiebreaker
- `evictProxyIfNeeded(incomingBytes)` — pure LRU across all dataset proxies

Trapped because each policy is hard-coded inside the `if`/branch that selects it.

**Suggested primitive:** `EvictionPolicy` interface with `selectVictims(entries, bytesNeeded): CacheEntry[]`. Three implementations:
- `LRUPolicy` — pure insertion order.
- `TieredPolicy(modeProvider)` — interaction-mode-driven tier order, with active-detail tiebreaker.
- `LRUAcrossDatasetsPolicy` — for proxy.

Each store carries its policy. The cache doesn't decide; it asks.

This is the cleanest "strategy pattern" win. Today the policies are inseparable from the cache; tomorrow they could be unit-tested against synthetic entry lists with no cache plumbing.

### 6. Interaction mode detection (lines 1593-1606)

```
class InteractionModeDetector {
  push(epochs: SceneEpochs): void;
  current(): "panning" | "scrubbing" | "idle";
}
```

Self-contained, ~25 LOC. Used by `TieredPolicy` (above) and by `telemetry()`. Both consumers depend on it explicitly. Mechanical to extract.

### 7. Telemetry counters (~16 fields)

A single `CacheTelemetry` object with explicit verbs:
```
class TelemetryCounters {
  recordRequest(): void;
  recordHit(): void;
  recordEviction(tier: EvictionTier): void;
  recordDecode(ms: number): void;
  recordFetchFailure(isPermanent: boolean, message: string): void;

  snapshot(): CacheTelemetry;          // window-resetting (rename from telemetry())
  peek(): CacheTelemetry;              // optional non-resetting
}
```

Burst-log state lives on this collaborator (or a sibling `BurstLogger`). Cache stops mutating 16 individual fields; instead it calls verbs.

### 8. Failure classification (line 1104) + retry decision

```
const isPermanent = message.includes("404") || message.includes("malformed");
if (!isPermanent && retryCount < MAX_TRANSIENT_RETRIES) { retry }
else { fail }
```

Mixed in with `fetchAndDecode`. Trapped.

**Suggested primitive:**
```ts
function classifyFetchError(err: unknown): { kind: "permanent" | "transient" | "abort", message: string };
class RetryPolicy {
  shouldRetry(verdict, attemptCount): boolean;
  delayMs(attemptCount): number;
}
```

Combined with the typed `FetchError` from Pass 5 / Boundary 2 issue C, this becomes ~20 LOC of policy that's swappable per request kind (chunks retry once, overview retries twice, proxies don't retry — etc.).

### 9. The cache dump producers (lines 887-963)

`getCacheDump`, `getProxyCacheDump`, `getPendingDump` are pure readers over internal Maps. They format internal entry shapes into debug-friendly rows.

**Suggested primitive:** each store exposes its own `dump(): Row[]` method. Cache no longer owns the formatting. Mechanical.

## Logic trapped outside `CpuCache`

### 1. The orchestrator's resend pass (orchestrator.ts:1455-1489)

The orchestrator iterates `_lastFilteredRequests` looking for chunks that aren't `deliverySentToWorker` or `deliveryRejectedByWorker` and tries to look them up in `cpuCache.getCachedChunk`.

This is the inverse of `cpuCache.snapshot()` — instead of asking "what's cached?", it asks "for this request, do you have it?". Both questions answer the same need (chunk-residency check) but with different ergonomics.

Not strictly trapped (it's a clean public API), but the iteration shape suggests the cache could expose `forEachCachedRequest(plan, callback)` or a bulk `getCachedDeliveries(requests)`. Worth considering once the store is extracted.

### 2. `setupFetchPipeline`'s wire-format registration (useBridge.ts:475)

Hard-coded to `Proxied` variant; silent on `Direct` and `Local` (logs a single "unsupported" event then continues). The dispatcher logic is trapped inside an `if ("Proxied" in fetchDesc)`.

**Suggested primitive:** a `ContentSourceFactory` or a per-variant `setupFor(fetchDesc, contentSource)` that returns the right `ContentSource` instance.

```ts
function makeContentSource(fetchDesc: FetchSource, sendMessage: SendFn): ContentSource {
  if ("Proxied" in fetchDesc) return new ProxiedContentSource(sendMessage); // and registerImage loop
  if ("Direct" in fetchDesc)  return new DirectContentSource(fetchDesc.Direct);
  if ("Local" in fetchDesc)   return new LocalContentSource(fetchDesc.Local);
  throw new Error(`Unsupported FetchSource variant: ${Object.keys(fetchDesc)[0]}`);
}
```

Defers building Direct/Local impls but **establishes the seam** so future work doesn't have to revisit `useBridge.ts`.

Today this is premature (no concrete plan to add Direct/Local). Mention as a candidate when those land.

## Repeated near-identical workflows

The chunk and proxy paths inside `CpuCache` repeat the same 8-step pattern with subtle variations. Counting:

| Step | Chunk | Proxy | Notes |
|---|---|---|---|
| Dedup | 4 conditions inline | 2 conditions inline | proxy lacks rejection + failure check |
| Schedule (capacity check) | `startChunkFetches` | `startProxyFetches` | shares cap |
| Track in-flight (estimate bytes) | `startSingleFetch` | `startSingleProxyFetch` | identical pattern |
| Fetch | `source.fetch` | `source.fetchProxy` | different request shape |
| Catch + classify | string match → permanent/transient | silently set lastError | proxy never enters failures map |
| Retry | once if transient | never | proxy doesn't retry |
| Reconcile in-flight bytes (estimate→actual) | inline | inline | identical pattern |
| Decode | `decode.decode(...)` | none (proxies arrive decoded) | step-skip |
| Insert into cache + evict | `evictIfNeeded` + `insertEntry` | `evictProxyIfNeeded` + map.set | different cache shape |
| Push ready | `ready.push({kind: "chunk", ...})` | `ready.push({kind: "proxy", ...})` | different delivery shape |
| Notify + recurse | `notifyListeners` + `startChunkFetches` | `notifyListeners` + `startProxyFetches` | identical |

The structural overlap is high enough that an `Asset` abstraction is justified. Sketch:

```ts
type AssetKind = "chunk" | "proxy";

interface AssetTransport<Req, Result> {
  kind: AssetKind;
  fetch(req: Req, signal: AbortSignal): Promise<Result>;
  retryPolicy: RetryPolicy;
  toCacheEntry(req: Req, result: Result): CacheEntry;
  toReadyDelivery(entry: CacheEntry): ReadyDelivery;
}

class Scheduler<Req, Result> {
  constructor(transport: AssetTransport<Req, Result>, store: Store, telemetry: ...);
  submit(reqs: Req[]): void;
  cancelDataset(...): void;
}
```

Two `Scheduler` instances live on `CpuCache`: one for chunks, one for proxies. The lifecycle, telemetry, and store-insert logic become per-asset shared code. The differences (decode step for chunks, header/payload split for proxies, retry yes/no) are policy on the `AssetTransport`.

**Caveat:** abstractions like this are easy to over-engineer. Validate by writing the proposed types and seeing if both chunk and proxy shapes compose cleanly. If the differences leak through (e.g., chunk needs a `decode` step that proxy doesn't), the abstraction is wrong and a simpler "two parallel Schedulers with shared Store" might be the right answer.

This is a Pass 8 sequencing decision. For now: **flag as the highest-impact composability opportunity** but defer the API shape until the simpler extractions (sub-stores) are in place.

## Boolean flags / mode-changing parameters

Looked for these; few exist:
- `cacheType: "main" | "overview"` — passed to `evictIfNeeded`. Already a sign of a missing per-store boundary.
- `retryCount` parameter to `fetchAndDecode` — defaults to 0, used for recursion. Replace with a loop and a `RetryPolicy.attempt` counter.
- `interactionMode` — drives tier order in eviction. Not a bool but a mode; correctly modeled as a small enum, just hard-coded into `getTierOrder`.

No "god flags" that radically change behavior. The codebase isn't suffering from `boolean kwarg disease`. ✅

## Summary: composable units to extract

In rough order of implementation difficulty:

| Unit | Effort | Win |
|---|---|---|
| `extractDataType` move to `manifestTypes.ts` | trivial | tightens module shape |
| Drop `lane: "proxy"` from union | trivial | dead-code removal |
| `ChunkStore` + `OverviewStore` + `ProxyStore` (per-cache state + insert/remove + budget) | moderate | unblocks everything else |
| `InteractionModeDetector` (~25 LOC) | trivial | self-contained warm-up |
| `EvictionPolicy` interface + 3 impls | moderate | makes policies independently testable |
| `TelemetryCounters` collaborator | moderate | ends 16-field scatter |
| `RetryPolicy` + typed `FetchError` | moderate | brittleness fix; opens per-kind retry policy |
| `BurstLogger` collaborator | trivial | ends `cacheLogState` mixed-concern |
| `Scheduler<Req, Result>` parameterized over `AssetTransport` | high | unifies chunk/proxy duplication; consider deferring |
| `ContentSourceFactory` for FetchSource variants | low (today) | premature unless Direct/Local on roadmap |
| `BinaryRouter` (move proxy/ prefix sniff out of bridge) | trivial | minor seam cleanup |
| `wireProtocol.ts` for `parseProxyHeader` + key composers | trivial | one-file move |

## Next pass

Pass 7 (Testability Scan) maps each candidate above to: *what does the test look like, and does the existing harness reach it?*
