# CPU Cache + Content Source Specification

> **Status:** Not implemented. Spec phase. Replaces `SharedChunkQueue`, `uploadCommon.ts`, `tickCommon.ts`, and the M0 adapter layer in the Orchestrator.

CPU Cache + Content Source is domain 6.2 of the pipeline ([DOMAINS.md](../DOMAINS.md) section 6.2). It sits between Planning (which produces logical asset requests as a `RequestPlan`) and the Worker Protocol (which delivers decoded buffers to the GPU worker). It owns:

- **Content Source** — resolves logical chunk requests to physical bytes via the network
- **Decode Pipeline** — decompresses wire-format and normalizes pixel format
- **Detail Cache** — LRU cache for native chunks of promoted entities
- **Overview Cache** — separate cache for coarse proxy assets
- **Fetch Scheduler** — priority-ordered, bytes-in-flight-budgeted concurrent fetching
- **Telemetry** — cache tab in debug panel for live visibility into internal state

CPU Cache is a pure main-thread TypeScript domain. It does not know about GPU textures, atlas pools, or page tables.

---

## 1. Scope

### In scope (V1)

- `CpuCache` class with `submit(plan)`, `drain(budget)`, `snapshot()` API
- `ContentSource` interface with `ProxiedContentSource` implementation (WebSocket bridge)
- Codec-agnostic decode worker pool (Raw no-op, LZ4, Zstd)
- Separate detail and overview caches with independent budgets
- Three-tier adaptive eviction (runway / demoted-detail / active-detail, reordered by interaction)
- Fetch scheduling: priority-ordered shared pool, bytes-in-flight hard cap
- Epoch-based fetch cancellation (cancel in-flight fetches not in new plan)
- Failure handling: transient retry, permanent fail, failedUntilEpoch exclusion
- Cache debug tab in debug panel
- Unit tests with mock ContentSource and decode workers

### Out of scope

- **Direct/Local content sources** — V1 is Proxied only. Interface accommodates future sources.
- **Shard/batch fetching** — ContentSource interface hides this, but V1 fetches individual chunks.
- **Overview proxy assets** — Asset Catalog (step 6) doesn't exist yet. Overview cache structure is ready but unused until then.
- **Auto-tuning budgets** — V1 has sensible defaults with debug panel tuning. Adaptive budgets based on device capability are future work.
- **Integration tests against real server** — desirable but not V1 blocking.

---

## 2. Data Model

### Input: RequestPlan (from Planning via Orchestrator)

```ts
interface RequestPlan {
  requests: ChunkRequest[];
  activeSet: ActiveSetEntry[];
  epochs: PlanningEpochs;
}

interface ChunkRequest {
  entityId: string;
  imageId: string;
  level: number;
  t: number;
  c: number;
  z: number;
  y: number;
  x: number;
  lane: "overview" | "detail" | "runway";
  representationKind?: string;  // overview lane only (e.g., "wellProxy3D"). Unused until Asset Catalog.
  priority: number;       // lower = more urgent
  chunkKey: string;       // canonical "level/t/c/z/y/x"
}
```

### Output: ReadyDelivery (to Orchestrator, then Worker Protocol)

```ts
interface ReadyDelivery {
  entityId: string;
  imageId: string;
  level: number;
  t: number;
  c: number;
  z: number;
  y: number;
  x: number;
  chunkKey: string;
  data: ArrayBuffer;      // decoded, GPU-ready
  dataType: DataType;
  actualDims: [number, number, number];  // edge chunk handling
  epochs: PlanningEpochs;  // full epoch set for staleness detection at worker
  lane: Lane;             // detail/runway/overview
}
```

### Cache State Snapshot (to Orchestrator, then PlanningSnapshot)

```ts
interface CacheStateSnapshot {
  cached: Map<string, Set<string>>;     // entityId -> decoded chunk keys
  inFlight: Map<string, Set<string>>;   // entityId -> in-flight chunk keys
}
```

Planning treats both sets as "don't re-request." The distinction exists for telemetry (hit rate vs in-flight dedup rate).

### Configuration

```ts
interface CpuCacheConfig {
  detailBudgetBytes: number;        // default 512MB
  overviewBudgetBytes: number;      // default 64MB
  maxConcurrentFetches: number;     // default: decodePoolSize * 3
  maxBytesInFlight: number;         // default 32MB
  decodePoolSize: number;           // default: max(2, floor(hardwareConcurrency/2) - 1)
}
```

All values are exposed in the debug panel for runtime tuning.

### Telemetry

```ts
interface CacheTelemetry {
  detailBytes: number;
  detailBudget: number;
  overviewBytes: number;
  overviewBudget: number;
  inFlightCount: number;
  inFlightBytes: number;
  queueDepth: number;
  hitRate: number;
  evictionsPerSec: number;
  interactionMode: "panning" | "scrubbing" | "idle";
  evictionTierOrder: string[];
  failedChunks: { transient: number; permanent: number };
  lastError: string | null;
  decodeWorkersBusy: number;
  decodeWorkersTotal: number;
  avgDecodeMs: number;
}
```

---

## 3. Content Source

### Interface

```ts
interface ContentSource {
  fetch(request: FetchRequest, signal: AbortSignal): Promise<ArrayBuffer>;
}

interface FetchRequest {
  datasetId: string;
  imageId: string;
  chunkKey: string;       // canonical "level/t/c/z/y/x"
  wireFormat: WireFormat;  // from ClientFetchDescriptor
}
```

The content source is transport only. It returns raw wire-format bytes. It does not decode, normalize, or cache.

### ProxiedContentSource (V1)

Wraps the existing WebSocket bridge. Sends chunk request messages, receives binary responses. Returns raw wire-format bytes.

```ts
class ProxiedContentSource implements ContentSource {
  constructor(private bridge: BridgeConnection) {}

  async fetch(request: FetchRequest, signal: AbortSignal): Promise<ArrayBuffer> {
    // Send chunk_request via bridge WebSocket
    // Wait for binary response
    // Return raw wire-format bytes (no decompression)
  }
}
```

Future content sources (`DirectContentSource`, `LocalContentSource`) implement the same interface with different transport. The content source abstraction hides whether bytes come from individual OME-Zarr chunks, a shard, a batched response, or a cached overview product.

---

## 4. Decode Pipeline

### Codec-Agnostic Worker Pool

A pool of Web Workers that handle decompression and pixel-format normalization. Each worker receives `(bytes, wireFormat, dataType)` and returns a GPU-ready typed array.

Pool sizing:

```ts
const decodePoolSize = Math.max(2, Math.floor(navigator.hardwareConcurrency / 2) - 1);
// M1 MacBook (8 cores) → 3 workers
// M3 Pro (12 cores) → 5 workers
// Floor: always at least 2
```

This leaves headroom for the main thread, GPU worker, and browser.

### Worker Message Protocol

```ts
// Main → Decode Worker
interface DecodeRequest {
  id: number;
  bytes: ArrayBuffer;       // transferred
  wireFormat: WireFormat;
  dataType: DataType;
}

// Decode Worker → Main
interface DecodeResponse {
  id: number;
  data: ArrayBuffer;        // transferred, GPU-ready
}
```

### Decode Steps

1. **Decompress** — dispatch on `wireFormat`:
   - `Raw` → no-op (pass through)
   - `Lz4` → LZ4 block decode
   - `Zstd` → fzstd decode
2. **Normalize** — interpret as `dataType`, produce GPU-ready buffer (e.g., `Uint16Array`)

The cache stores the decoded result. Cache hits never re-decode.

In V1 (Proxied mode), the server decompresses storage codecs and sends `WireFormat::Raw`. The decode pipeline is structured so that adding LZ4/Zstd wire-format support means adding a branch in the worker, not changing the pipeline architecture.

---

## 5. Cache Architecture

### Two Caches

| Cache | Keys | Default Budget | Eviction |
|-------|------|----------------|----------|
| **Detail** | `(entityId, level, T, C, z, y, x)` | 512 MB | Three-tier adaptive LRU |
| **Overview** | `(entityId, representationKind, proxyLevel, T, C)` | 64 MB | Simple LRU |

Detail and overview have independent budgets and eviction policies. A chunk in the detail cache is not competing with a proxy in the overview cache. Varying chunk shape across LODs does not affect cache key semantics — keys are logical grid coordinates, not physical byte addresses.

### Three-Tier Adaptive Eviction (Detail Cache)

The detail cache evicts in tier order. The tier order adapts based on what the user is doing, detected via epoch velocity (a rolling window of recent epoch changes over `EPOCH_VELOCITY_WINDOW` frames).

**Default / Panning** (`viewEpoch` bumping):

```
evict first:  runway entries (oldest first)
then:         demoted-detail entries (oldest first)
evict last:   active-detail entries (oldest first)
```

**Scrubbing** (`selectionEpoch` bumping):

```
evict first:  demoted-detail entries (oldest first)
then:         active-detail far from view (oldest first)
evict last:   runway entries (oldest first)
```

**Idle** (no epochs bumping): standard LRU across all tiers.

### Demotion

When an entity leaves the active set (demoted by Planning), its entries move from the active-detail tier to the demoted-detail tier. They are kept at lower priority — not evicted immediately — in case the user zooms back in.

### Entry Metadata

Each cache entry carries:

```ts
interface CacheEntry {
  data: ArrayBuffer;
  dataType: DataType;
  actualDims: [number, number, number];
  sizeBytes: number;
  lane: Lane;              // detail | runway | overview → eviction tier
  entityId: string;        // for demotion detection
  insertedAt: number;      // monotonic counter for LRU within tier
  epochs: PlanningEpochs;   // epochs when this was fetched
}
```

---

## 6. Fetch Scheduler

### Concurrency Model

Two limits work together — whichever is hit first throttles new fetches:

```ts
maxConcurrentFetches: decodePoolSize * 3  // ~12 on 8-core, ~18 on 12-core
maxBytesInFlight: 32 * 1024 * 1024        // ~32MB — ~4 frames of upload budget
```

The fetch concurrency is sized to keep the decode pipeline saturated (2-3x overfetch). The bytes-in-flight budget is the real throttle — it prevents accumulating more data than the upload loop can drain.

Since chunks are multiplexed over a single WebSocket, there is no browser-imposed concurrency limit. The limits above are about client-side processing capacity, not network constraints.

### Priority-Ordered Draining

The fetch scheduler maintains a priority queue of pending requests. When a fetch slot opens, the highest-priority (lowest number) pending request starts next. Planning's lane offsets guarantee ordering:

- Detail requests (priority 0–999) always start before runway (1000–1999)
- Runway always starts before overview (2000+)

In-flight fetches are never aborted to make room for higher-priority arrivals — the bytes already transferred would be wasted. The next available slot simply goes to the highest-priority pending request.

### Epoch-Based Cancellation

On each `submit(plan)` call:

1. Diff new plan's `requests` against in-flight fetches (by `chunkKey`)
2. Abort any in-flight fetch whose `chunkKey` doesn't appear in the new plan
3. Remove cancelled chunks from pending queue
4. Add new requests to pending queue in priority order
5. Start new fetches up to concurrency limits

No time-based staleness detection. If a chunk isn't in the current `RequestPlan`, it's no longer needed — cancel it. Epochs replace the legacy 15-second timeout heuristic.

### Error Handling

| Failure Type | Examples | Action |
|-------------|----------|--------|
| **Transient** | Network error, timeout, 5xx | Retry once after 500ms, then mark failed |
| **Permanent** | 404, malformed response | Mark failed immediately, no retry |

Failed chunks get a `failedUntilEpoch` marker — they are excluded from future `submit()` cycles until the relevant epoch changes:

- `contentEpoch` bump clears failures for that dataset (metadata may have changed — the chunk might now exist or be served differently)
- `selectionEpoch` and `viewEpoch` bumps do **not** clear failures (same chunk, same problem)

Failed chunks are reported in telemetry for the debug panel.

---

## 7. Orchestrator Integration

### API

```ts
class CpuCache {
  constructor(source: ContentSource, config?: Partial<CpuCacheConfig>)

  /** Diff against in-flight, cancel stale, update eviction tiers, start new fetches. */
  submit(plan: RequestPlan): void

  /** Pull decoded buffers up to budget. Returns new deliveries only. */
  drain(budgetBytes: number): ReadyDelivery[]

  /** Immutable snapshot of cached + in-flight keys for PlanningSnapshot. */
  snapshot(): CacheStateSnapshot

  /** Current stats for debug panel. */
  telemetry(): CacheTelemetry

  /** Clear all caches, cancel all fetches. */
  reset(): void
}
```

### Why Two Methods (submit + drain)

`submit()` is about fetch scheduling — what to fetch, what to cancel, which eviction tiers to update (from `plan.activeSet`). `drain()` is about delivery — what's ready, how much budget remains. They happen at different points in the frame and serve different consumers. Combining them would re-create the entanglement the refactor eliminates. The Orchestrator's job is to sequence domain calls — the separation should be visible in its code.

This also enables future evolution: M3 could insert worker wanted-set reconciliation between `submit()` and `drain()` without changing either method's signature.

### Frame Flow

```
Orchestrator.planAndFetch():
  1. Check epochs → decide if replanning needed
  2. cacheState = cpuCache.snapshot()     → into PlanningSnapshot
  3. plan(snapshot) → RequestPlan
  4. cpuCache.submit(plan)               → active set update + fetch scheduling

Orchestrator upload phase:
  5. deliveries = cpuCache.drain(uploadBudget)
  6. sendToWorker(deliveries)            → via Worker Protocol

Debug panel:
  7. telemetry = cpuCache.telemetry()
```

### Drain Budget

The `uploadBudget` passed to `drain()` is the per-frame upload budget — how many bytes the Orchestrator is willing to deliver to the worker this frame. This is distinct from `maxBytesInFlight` (a fetch-side throttle on concurrent network requests). The Orchestrator owns the drain budget and may vary it by context (e.g., larger budget for the main view, smaller for minimap).

### What Dies at M2

When CPU Cache is wired into the Orchestrator:

| Deleted | Replaced by |
|---------|-------------|
| `SharedChunkQueue` (chunkStore.ts) | `CpuCache` |
| `uploadChunksForMembers()` (uploadCommon.ts) | `CpuCache.drain()` + direct worker delivery |
| `UploadState`, `MemberUploadActions` (uploadCommon.ts) | `CpuCache` internal state |
| `compositeKey()`, `parseChannel()`, `stripChannelSuffix()` (tickCommon.ts) | Canonical chunk identity (C is a key dimension) |
| `translateRequestPlan()` (orchestrator.ts M0 adapter) | `CpuCache.submit()` takes `RequestPlan` directly |
| `sentToWorker` tracking (uploadCommon.ts) | `CpuCache.drain()` returns only new deliveries |
| `MemberChunkPlan` type | `RequestPlan` flows directly |
| LZ4-specific worker pool (lz4Client.ts, lz4.worker.ts) | Codec-agnostic decode pool |

---

## 8. Debug Panel: Cache Tab

The cache tab in the existing debug panel shows live state, updated each planning cycle via `cpuCache.telemetry()`. Follows the same pattern as the existing Planning tab.

| Section | Content |
|---------|---------|
| **Budget** | Detail: bar chart (used / total bytes), Overview: bar chart |
| **Fetch** | In-flight count and bytes, queue depth, fetches/sec |
| **Hit Rate** | This cycle: hits / misses. Cumulative hit rate % |
| **Eviction** | Current interaction mode (panning / scrubbing / idle), tier order, evictions/sec |
| **Errors** | Failed chunk count (transient / permanent), last error reason |
| **Decode** | Workers: busy / total, avg decode time ms, codec breakdown (Raw / LZ4 / Zstd) |

All `CpuCacheConfig` values are editable via the debug panel for runtime tuning.

---

## 9. Testing Strategy

### Unit Tests (mandatory, V1)

Follow the Planning test pattern: factory helpers for synthetic inputs, no WASM/worker/browser required.

```ts
// Test factories
function createMockContentSource(responses?: Map<string, ArrayBuffer>): ContentSource
function createTestCache(config?: Partial<CpuCacheConfig>): CpuCache
```

Test categories:

| Category | What's tested |
|----------|---------------|
| **Submit/drain lifecycle** | Submit a plan, mock source resolves, drain returns deliveries |
| **Eviction tiers** | Fill cache to budget, verify tier ordering (runway → demoted → active) |
| **Adaptive eviction** | Simulate epoch velocity, verify tier reordering |
| **In-flight dedup** | Submit overlapping plans, verify no duplicate fetches |
| **Fetch cancellation** | Submit plan A then plan B, verify stale fetches aborted |
| **Error handling** | Mock source rejects, verify retry logic and failedUntilEpoch |
| **Cache snapshot** | Verify `snapshot()` returns both cached and in-flight keys |
| **Multi-channel** | Submit plan with multiple channels, verify independent cache entries |
| **Demotion** | Entity leaves active set, verify entries move to demoted tier |
| **Budget enforcement** | Exceed budget, verify eviction fires before insertion |

Decode pool is replaced with a synchronous mock in tests — decode correctness is tested separately in the worker.

### Integration Tests (V1 nice-to-have)

Open a dataset, pan/zoom, verify chunks arrive and render. Formalizing as Playwright test is desirable but not blocking — manual visual testing covers this during M2 wiring.

---

## 10. Constants

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `DEFAULT_DETAIL_BUDGET` | `512 * 1024 * 1024` | `cpuCache.ts` | Detail cache size limit |
| `DEFAULT_OVERVIEW_BUDGET` | `64 * 1024 * 1024` | `cpuCache.ts` | Overview cache size limit |
| `DEFAULT_MAX_BYTES_IN_FLIGHT` | `32 * 1024 * 1024` | `cpuCache.ts` | Fetch throttle by total bytes in transit |
| `FETCH_CONCURRENCY_MULTIPLIER` | `3` | `cpuCache.ts` | `maxFetches = decodePoolSize * 3` |
| `DECODE_POOL_HEADROOM` | `1` | `decodePool.ts` | Cores reserved: `floor(cores/2) - 1` |
| `MIN_DECODE_WORKERS` | `2` | `decodePool.ts` | Floor for small machines |
| `TRANSIENT_RETRY_DELAY_MS` | `500` | `cpuCache.ts` | Delay before retrying transient failure |
| `MAX_TRANSIENT_RETRIES` | `1` | `cpuCache.ts` | Retry count for network/server errors |
| `EPOCH_VELOCITY_WINDOW` | `10` | `cpuCache.ts` | Frames to track for interaction detection |

---

## 11. File Map

| File | Role |
|------|------|
| `lucida-web/src/pipeline/cpuCache.ts` | Cache domain: `CpuCache` class, detail/overview caches, eviction, submit/drain/snapshot/telemetry, fetch scheduler |
| `lucida-web/src/pipeline/cpuCache.test.ts` | Unit tests: eviction tiers, fetch lifecycle, error handling, snapshots, adaptive eviction, multi-channel |
| `lucida-web/src/pipeline/contentSource.ts` | `ContentSource` interface, `FetchRequest` type, `ProxiedContentSource` (WebSocket bridge wrapper) |
| `lucida-web/src/pipeline/decodePool.ts` | Decode worker pool: sizing, load balancing, request dispatch, codec routing |
| `lucida-web/src/pipeline/decode.worker.ts` | Web Worker script: decompression (Raw/LZ4/Zstd) + pixel-format normalization |

---

## 12. What This Does NOT Cover

This spec covers the CPU Cache + Content Source domain — from "Orchestrator submits a RequestPlan" to "Orchestrator drains ReadyDeliveries." It does not cover:

- **Planning** — how the RequestPlan is produced. See [Planning Specification](planning-spec.md).
- **Orchestrator lifecycle** — how submit/drain are sequenced in the frame loop. See [Orchestrator Integration Spec](orchestrator-integration-spec.md).
- **Worker Protocol** — how ReadyDelivery is translated to `postMessage`. That is domain 6.3.
- **GPU Residency** — how delivered buffers are placed in atlas slots. That is domain 6.4.
- **Asset Catalog** — what overview/proxy products exist. That is step 6. Overview cache structure is ready but unused until then.
- **Direct/Local content sources** — V1 is Proxied only. The `ContentSource` interface accommodates future sources without changes to the cache.

---

## 13. Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Separate detail and overview caches with independent budgets | DOMAINS.md requires separate eviction policies. Overview assets have different lifetimes (rarely evicted) vs detail chunks (frequently churned during navigation). |
| D2 | Three-tier eviction: runway, demoted-detail, active-detail | Runway is speculative and should be sacrificed first. Demoted entities kept at low priority for zoom-back. Active detail is most valuable. |
| D3 | Adaptive eviction via epoch velocity | When scrubbing T, runway is valuable (protect it). When panning, spatial detail is valuable (protect it). Epoch velocity detects interaction mode without explicit UI state tracking. |
| D4 | Shared detail+runway budget, not separate pools | Separate pools waste memory when not scrubbing (most of the time). Shared pool with tiered eviction gives full budget to whichever use case is active. |
| D5 | ContentSource returns wire-format bytes, not decoded bytes | Keeps content source purely about transport. Decode is a cache subdomain (DOMAINS.md 6.2: "fetch + decode pipeline"). Shared decode pool works across all future source types. |
| D6 | Cache stores decoded (GPU-ready) buffers, not wire-format bytes | Never re-decode on cache hit. Decode cost paid once at insertion. Memory footprint is similar (chunk sizes we use don't compress dramatically). |
| D7 | Codec-agnostic decode worker pool replaces LZ4-specific pool | Single pool handles Raw/LZ4/Zstd. Adding a codec means adding a branch in the worker, not a new pool or infrastructure change. |
| D8 | Decode pool sized to `max(2, floor(cores/2) - 1)` | Leave headroom for main thread, GPU worker, browser. Floor of 2 ensures minimum parallelism on low-core devices. |
| D9 | Fetch concurrency = `decodePoolSize * 3`, with bytes-in-flight hard cap | Keep decode pipeline 2-3x saturated. Bytes-in-flight (32MB) is the real throttle since WebSocket has no browser-imposed concurrency limit. |
| D10 | In-flight fetches never aborted for higher-priority arrivals | Aborting wastes already-transferred bytes. Let in-flight finish; next slot goes to highest priority. Epoch-based cancellation handles genuinely stale fetches. |
| D11 | Epoch-based cancellation replaces 15s timeout heuristic | Planning's RequestPlan is the source of truth. If a chunk isn't in the plan, cancel it. No magic numbers, no time-based guessing. |
| D12 | Two-method API: `submit()` + `drain()` | Separates fetch scheduling from delivery. They happen at different frame phases. Enables M3 insertion (wanted-set reconciliation) between them without signature changes. |
| D13 | Cache snapshot includes both cached and in-flight keys | Prevents Planning from re-requesting chunks already being fetched. Distinction preserved for telemetry (hit rate vs dedup rate). |
| D14 | Multi-channel via canonical chunk identity, no composite keys | C is already a dimension in the cache key `(entity, level, T, C, z, y, x)`. Composite key hacking (`${id}:ch${c}`) was a legacy workaround that dies with uploadCommon. |
| D15 | Two failure categories: transient (retry once) vs permanent (fail immediately) | 404 is deterministic — retrying won't help. Network/server errors are transient — one retry is reasonable. More risks thundering herd on server recovery. |
| D16 | `failedUntilEpoch` exclusion keyed to `contentEpoch` | Failed chunks stay excluded until metadata changes (`contentEpoch` bump). Camera or selection changes don't fix a missing chunk. |
| D17 | Cache debug tab as first-class subdomain | Cache has complex internal state (budgets, tiers, interaction mode, errors, decode stats). Invisible state causes invisible bugs. Debug panel visibility is essential. |
| D18 | Configurable budgets via `CpuCacheConfig` + debug panel | Sensible defaults for V1. Debug panel for runtime tuning during development. No auto-tuning — premature without profiling data. |
| D19 | Unit tests mandatory with mock ContentSource and sync decode | CPU Cache logic is testable without network, workers, or browser. Same bar as Planning (27+ tests). Integration tests deferred to M2. |
| D20 | Demoted entities kept in cache at lower eviction priority | Immediate eviction on demotion wastes fetched data. Users frequently zoom in/out of the same area. Lower priority means they'll be evicted eventually if budget pressure hits. |
| D21 | `submit()` handles active set update internally (no separate `updateActiveSet()`) | `RequestPlan` already contains `activeSet`. A separate method adds API surface and ordering risk for no benefit — they were always called in sequence. |
| D22 | `ReadyDelivery` carries `PlanningEpochs` (all 6 epochs), not just `SceneEpochs` | DOMAINS.md requires data deliveries carry enough epochs for staleness detection. `requestEpoch` and `assetEpoch` are needed so the worker can detect stale planning-cycle data. CPU Cache receives full epochs via `RequestPlan` and propagates them. |
| D23 | `ChunkRequest` carries optional `representationKind` for forward compatibility | Overview cache keys include `representationKind` per DOMAINS.md. Unused until Asset Catalog, but the field is present so overview requests have a place to express representation kind without a type change later. |

---

## 14. Rules

1. **CPU Cache does not know about GPU textures, atlas pools, or page tables.** It delivers decoded buffers. What happens after delivery is Worker Protocol / GPU Residency.

2. **Cache keys are canonical content identity.** Detail: `(entity, level, T, C, z, y, x)`. Overview: `(entity, representationKind, proxyLevel, T, C)`. Never layout-dependent or GPU-handle-dependent. Varying chunk shape across LODs does not affect key semantics.

3. **Content Source is transport only.** It returns raw wire-format bytes. It does not decode, normalize, or cache.

4. **Decode happens once, at cache insertion.** Cache stores GPU-ready buffers. Cache hits are zero-cost (no re-decode).

5. **Eviction tiers adapt to interaction.** Epoch velocity determines whether runway or spatial detail is protected. No hardcoded eviction order.

6. **Fetch scheduling uses bytes-in-flight as the primary throttle.** Connection count is a safety cap. Priority ordering ensures detail loads before runway before overview.

7. **Stale fetches are cancelled by epoch, not by timeout.** If a chunk isn't in the current `RequestPlan`, cancel it. No magic timeout numbers.

8. **Failed chunks are excluded until the relevant epoch changes.** `contentEpoch` clears failures. `selectionEpoch` and `viewEpoch` do not.

9. **The snapshot is immutable.** `snapshot()` returns a frozen view of cached + in-flight state. Planning reads it but never mutates it.

10. **Multi-channel is not special.** C is a dimension in the cache key, same as T or Z. No composite key schemes.

---

## 15. Implementation Plan

Five steps, each independently verifiable before moving on. Dependency chain: **S1 → S2 → S3 → S4/S5** (S4 and S5 are independent of each other).

### S1: Decode Pool ✅

**Files:** `decodePool.ts`, `decode.worker.ts`

Codec-agnostic worker pool: Raw/LZ4/Zstd decompression + pixel-format normalization. Zero dependencies on the rest of the CPU Cache.

**Verify:**
- Unit tests for each codec path (Raw passthrough, LZ4 block decode, Zstd decode)
- Swap into existing pipeline by replacing `decompressLz4` / `fzstd.decompress` calls in `useBridge.ts` — chunks render identically
- Proves decode infrastructure before anything else changes

**Replaces:** `lz4Client.ts`, `lz4.worker.ts`, `lz4.ts`, inline decode logic in `useBridge.ts`

---

### S2: Content Source

**Files:** `contentSource.ts`

`ContentSource` interface + `ProxiedContentSource` wrapping the bridge WebSocket. Thin adapter — extracts the chunk request/response pattern from `useBridge.ts` into the clean interface defined in Section 3.

**Verify:**
- Unit test with mock ContentSource
- Optionally wire `ProxiedContentSource` alongside the existing fetcher and confirm same bytes return

---

### S3: Cache + Fetch Scheduler

**Files:** `cpuCache.ts`, `cpuCache.test.ts`

The core logic, built in three sub-steps within the same file:

**S3a — Cache structures:** Detail/overview LRU caches, insertion, lookup, budget enforcement, three-tier eviction (runway → demoted → active), demotion on active set change, adaptive eviction via epoch velocity. Pure data structures, no I/O.

**S3b — Fetch scheduler:** Priority queue, concurrency limits (`maxConcurrentFetches`), bytes-in-flight budget (`maxBytesInFlight`), epoch-based cancellation (diff new plan against in-flight), error handling with transient retry and `failedUntilEpoch` exclusion.

**S3c — CpuCache facade:** Wire cache + scheduler + decode pool into the `submit` / `drain` / `snapshot` / `telemetry` API defined in Section 7.

**Verify:** Full unit test suite (Section 9) with mock ContentSource and synchronous decode mock. No browser, no WASM, no workers required. Test categories:
- Submit/drain lifecycle
- Eviction tiers and adaptive eviction
- In-flight dedup and fetch cancellation
- Error handling and `failedUntilEpoch`
- Cache snapshot (cached + in-flight keys)
- Multi-channel, demotion, budget enforcement

---

### S4: Debug Panel Cache Tab

**Files:** Extend existing debug panel

Add cache tab reading from `cpuCache.telemetry()`, following the pattern of the existing Planning tab (Section 8).

**Verify:** Visual — live stats visible. Can wire up before the full integration by creating a `CpuCache` instance alongside the old pipeline and feeding it the same `RequestPlan`.

---

### S5: Orchestrator Integration (M2 Swap)

**Files:** Modify `orchestrator.ts`, delete legacy files

Wire `CpuCache` into the Orchestrator's frame loop:
- `cpuCache.snapshot()` replaces `getCachedKeys()` in `PlanningSnapshot` assembly
- `cpuCache.submit(plan)` replaces `translateRequestPlan()` + `ensureFetched()`
- `cpuCache.drain(budget)` replaces `uploadChunksForMembers()` — deliveries go directly to the worker

**Delete:**
- `SharedChunkQueue` (`chunkStore.ts`)
- `uploadChunksForMembers()`, `UploadState`, `MemberUploadActions` (`uploadCommon.ts`)
- `compositeKey()`, `parseChannel()`, `stripChannelSuffix()` (`tickCommon.ts`)
- `translateRequestPlan()` adapter (`orchestrator.ts`)
- `sentToWorker` tracking (`uploadCommon.ts`)
- `MemberChunkPlan` type
- LZ4-specific worker pool (`lz4Client.ts`, `lz4.worker.ts`, `lz4.ts`) — if not already deleted at S1

**Verify:** M2 visual verification from the [Orchestrator Integration Spec](orchestrator-integration-spec.md):
- Same fetch behavior: concurrent requests, abort-on-view-change, LRU eviction
- Cache state queryable by Planning directly (no `getCachedKeys` adapter)
- Fetch concurrency and spatial priority preserved
- All rendering unchanged

---

## 16. Related

- Domain model: [DOMAINS.md](../DOMAINS.md) section 6.2
- Planning: [docs/planning-spec.md](planning-spec.md)
- Orchestrator: [docs/orchestrator-integration-spec.md](orchestrator-integration-spec.md)
- Import pipeline: [docs/import-pipeline-spec.md](import-pipeline-spec.md)
- Content graph: [docs/canonical-content-graph.md](canonical-content-graph.md)
- Glossary: [GLOSSARY.md](../GLOSSARY.md)
