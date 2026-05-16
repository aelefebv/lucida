# Pass 4 — Dependency Scan: fetch/decode subsystem

Goal: find code that's hard to change because it depends on too much. Hidden globals, hard-coded implementations, hidden coupling.

## Direct environmental dependencies

### `performance.now()` — called from 7 sites in `cpuCache.ts`, 0 in others

Sites: `lastTelemetryTime`, `submit` (enqueue stamp), `telemetry` (window age), `getPendingDump`, `reset`, `startChunkFetches` (rate-limit log), `fetchAndDecode` (decode timing), `recordFailureForBurstDetection`. There's no clock abstraction; tests rely on `vi.useFakeTimers()` patching `performance.now` (only one test does this — the retry test). Any future timing-dependent test has to do the same dance.

**Impact:** mild today; one test exists. Will become a friction point when adding tests for backpressure logging, telemetry windows, or burst-failure detection.

**Suggested change:** an injectable `Clock` interface (`now(): number`) that defaults to `performance.now`. Tests inject `FakeClock`. Mechanical, decoupling win.

### `setTimeout` — `cpuCache.ts:1108` (retry sleep), `contentSource.ts:241,277` (fetch timeouts)

Same story. Tests use `vi.useFakeTimers` to manipulate. The retry test `cpuCache.test.ts:1003-1013` uses both fake timers and `vi.advanceTimersByTimeAsync`.

**Suggested change:** if Clock gets added, also expose `setTimeout` through it (`scheduleAfter(ms, cb)`). Optional — Vitest fake timers handle this well today.

### `new AbortController()` — `cpuCache.ts:1072,1250`

Modern browser API; trivially available. No issue.

### `navigator.hardwareConcurrency` — `decodePool.ts:18`

Used by `defaultPoolSize()`. Already guarded with `typeof navigator !== "undefined"` and a fallback of 4 cores. No issue. Pool size is overridable via constructor argument.

### `new Worker(new URL("./decode.worker.ts", import.meta.url))` — `decodePool.ts:48`

Build-time URL resolution. The pool depends on Vite knowing how to bundle the worker. Tests for `DecodePool` would need a Worker mock or `jsdom`'s lack-of-Worker handled. Today only `extractDataType` and `decompressLz4`/`normalize` (re-exported from the worker file) are tested directly; the pool itself has no unit test.

**Note:** when Pass 7 (testability) decides on a `DecodePool` test strategy, this is the constraint.

### Lazy `import("fzstd")` — `decode.worker.ts:87`

Per-worker singleton, lazy-loaded. Cheap startup, fine. Re-importing in N workers is wasteful but cached by the browser.

## Hard-coded constants

### Defaults exported from `cpuCache.ts`

```
DEFAULT_MAIN_BUDGET           = 512 MB
DEFAULT_OVERVIEW_BUDGET       = 64 MB
DEFAULT_PROXY_BUDGET          = 256 MB
DEFAULT_MAX_BYTES_IN_FLIGHT   = 32 MB
FETCH_CONCURRENCY_MULTIPLIER  = 3   (× decodePool.size)
TRANSIENT_RETRY_DELAY_MS      = 500
MAX_TRANSIENT_RETRIES         = 1
INTERACTION_MODE_WINDOW       = 10
```

All are exported and overridable via `CpuCacheConfig`. The DebugPanel's "Cache" tab edits `mainBudgetBytes / overviewBudgetBytes / proxyBudgetBytes / maxConcurrentFetches / maxBytesInFlight` at runtime. The other four (retry delay, max retries, interaction window, fetch multiplier) are not editable and not part of `CpuCacheConfig`. **Mild inconsistency**: some constants are tunable, others are baked in.

### `DEFAULT_TIMEOUT_MS = 10_000` and `DEFAULT_PROXY_TIMEOUT_MS = 60_000` in `contentSource.ts`

Exposed as constructor arguments to `ProxiedContentSource`, but `useBridge.ts` constructs it with no args — uses defaults always. No way to override per-dataset (e.g., for slow cold cache).

### Proxy header magic `LPRX` (4 bytes), header size `64`, dtype code `0` → `u16`

Hard-coded in `parseProxyHeader`. **Cross-language contract** with `lucida_proxy::header`. Comment explicitly notes this. Magic strings/numbers in code are appropriate here because the contract is fixed. ✅

### Eviction tier orders by interaction mode

Hard-coded in `getTierOrder`. Three modes × two tier orderings (panning + idle share). No way to change this from outside. Acceptable today; mention as a candidate strategy plug-in (see Pass 2 Seam F).

### `if (this.cacheLogState.failureBurstCount === 4)` — `cpuCache.ts:1391`

Magic number 4 (failures within a 1-second window before logging the burst). Not a constant. **Should be promoted to `BURST_LOG_THRESHOLD = 4` if extracted.**

### `if (removed >= 16)` — `cpuCache.ts:1531`

Magic number 16 (eviction-burst log threshold). Same story.

### `if (this.decodeTimes.length > 100)` — `cpuCache.ts:1146`

100-sample rolling window for decode latency. Not a constant. `DECODE_LATENCY_WINDOW = 100` if extracted.

### Bridge envelope offsets — `bridge.ts:213-231`

Magic byte offsets (4-byte client_id, 2-byte keyLen LE, key bytes, payload). This is the WS protocol; magic numbers are appropriate. ✅

## Hard-coded implementations / single-impl interfaces

### `ContentSource` has one production impl: `ProxiedContentSource`

The `FetchSource` wire type is `Proxied | Direct | Local`. `setupFetchPipeline` (`useBridge.ts:475`) explicitly handles only `Proxied`; the other two log an "unsupported" event and silently do nothing for `registerImage`. There's no `DirectContentSource` (HTTP fetch directly) or `LocalContentSource` (file-system / opfs).

**Implication:** the `FetchSource` discriminated union exists on the wire but isn't honored. Either:
1. Drop `Direct` and `Local` from the type until they're needed (deceptive shape today), or
2. Add `DirectContentSource` / `LocalContentSource` impls behind the same `ContentSource` interface.

This isn't a fetch/decode bug per se but the dependency direction matters: `cpuCache.ts` already programs against the interface, so route (2) is cheap.

### `DecodePool` has one impl, no interface

`CpuCache` types its constructor parameter as `DecodePool` (concrete class). Tests mock by constructing a partial-object cast — the test factory `createMockDecodePool` (in `cpuCache.test.ts`, not yet read) returns a duck-typed object cast to `DecodePool`.

**Suggestion:** introduce an `interface DecodePool { decode(...): Promise<ArrayBuffer>; size: number; activeCount(): number; terminate(): void; }` so the concrete class is `WorkerDecodePool` and tests have a typed seam without casts. Mechanical.

## Implicit ordering / call-order dependencies

### `contentSource.registerImage` MUST precede `cpuCache.submit`

If a chunk request arrives for an image whose wire format is unregistered, the fetch promise rejects with `"No wire format registered for image …"`. This becomes a "permanent" failure (string match catches "format" in the message? Actually no — let me check).

Looking again: `isPermanent = message.includes("404") || message.includes("malformed")`. The "No wire format registered" error matches neither. So it would be classified as **transient**, retry once, then fail-with-failure-map and be cleared on the next content epoch. Likely benign in practice but worth noting.

**Hidden ordering contract:** all images in a manifest must be registered before any submit referencing them. Today `setupFetchPipeline` does this synchronously before loop ingestion. If anyone adds a code path that submits before `registerImage`, it's a silent retry-storm.

**Suggested change:** make ContentSource fail loudly (or short-circuit before wasting a fetch slot) on an unregistered image. Or fold image registration into a setup-context that the cache knows about.

### `markRejected` must be cleared by `clearRejected` on cold-state-rebuild

The cache trusts the orchestrator to call `clearRejected` whenever camera/active-set shifts. The cache has no internal mechanism to expire rejection markings. If the orchestrator forgets to clear, the cache permanently refuses those chunks.

**Suggested change:** make `clearRejected` time-bound (entries expire after N submits) or pass the rebuild signal as a typed event the cache subscribes to. Today this works because exactly one caller exists in exactly one place; not bug-prone, just a fragile invariant.

### `failures` map cleared by content-epoch advance

The failures map clears entries when `currentEpochs.content >= entry.failedUntilContentEpoch`. But the comparison is `<`, so the entry sticks until content epoch strictly advances. If a server never bumps the content epoch, failures are permanent.

**Suggested change:** consider exposing a TTL on failure entries (e.g., 60s). Today the content-epoch model is the only clear.

### `decode.worker.ts` lazy fzstd module needs first-call latency

First Zstd chunk decode pays the `import("fzstd")` cost. Subsequent calls are cached. This is fine — but a pool of N workers each pays this cost the first time it sees a Zstd chunk. **Not a bug; document it as a startup characteristic.**

## Shared mutable state / hidden coupling

### `submitTick` is incremented in `submit()` and read in eviction sort

The link is documented in the field comment, but it's a textbook example of **two methods communicating via a counter field**. The proposed extraction puts `submitTick` on the scheduler and exposes a getter the eviction policy reads. Or eviction policy receives `submitTick` as an argument from the coordinator at evict-time.

### `currentEpochs` is set in `submit()` and read in `fetchAndDecode` (failure recording) and `fetchProxy` (cache entry stamping)

Mostly OK — there's only one writer and the readers don't mutate. But the field name says "current," which means "whatever the last submit installed" — if you read it during a fetch that started under an older plan, the failure entry is stamped with the *new* epoch. (Verify in Pass 5.)

### `lruCounter` is used as both insertion order *and* a primitive timestamp for eviction LRU

It's monotonically incremented on every cache insert. Two consumers read it: `evictLRU` (overview) and `evictTiered` (tiebreaker). Both correctly. The name `lruCounter` is fine. Note: it's reset to 0 in `reset()` but not in `cancelDataset()`, so cross-dataset cache state could in principle have non-monotonic timestamps after `cancelDataset` — although since `cancelDataset` doesn't add new entries with old timestamps, this is harmless. Mention in Pass 5.

### Telemetry counter writes are scattered

`evictionsSinceSnapshot` is written from `removeEntry` (8 sites in the same function via tier branches) and `evictProxyIfNeeded` (1 site). `evictionsByTierSinceSnapshot.activeDetail / .demotedDetail / .prefetch / .overview / .proxy` are written from the same five places. `decodesSinceSnapshot` from `fetchAndDecode`. `transientFailures / permanentFailures` from `fetchAndDecode` catch. All mutated directly via field access; no encapsulating method.

A `Telemetry` collaborator with `recordEviction(tier)`, `recordDecode(ms)`, `recordHit()`, `recordRequest()`, `recordFailure(isPermanent, message)` would tighten this.

## Cross-module hidden coupling

### `contentSource.ts` imports `extractDataType` from `decodePool.ts`

```ts
import { extractDataType } from "./decodePool.ts";
```

This is the wrong import direction. ContentSource needs wire-format introspection, not decode-pool internals. Pass 3 already flagged the move; this is the dependency reason.

### `cpuCache.ts` imports `RequestPlan, ChunkRequest, CacheStateSnapshot, ProxyRequest` from `planning/index.ts`

`CacheStateSnapshot` is **produced by** the cache and **consumed by** the orchestrator (and DebugOverlays). It being defined in planning is a residue of an older shape. After the fetch refactor it should live next to the cache.

Severity: low; it's a one-line move + barrel update.

### `cpuCache.ts` imports `SceneEpochs` from `epochs.ts`

Correct location. ✅

### `cpuCache.ts` imports `debugLog` from `debug/logging.ts`

Acceptable cross-cutting dep (logging). Could be injected for testability ("did we log this event?"), but not necessary.

### `bridge.ts` `BridgeHandlers.onChunkData` and `onProxyData` callbacks

The bridge knows it has two binary-frame consumers. Pass 2 Seam C suggested collapsing to a single `onBinary(key, payload)` and pushing the prefix sniff into the application layer. That's a cross-module coupling reduction.

## Internal-knowledge violations

### Orchestrator reaches into cache internals

`orchestrator.handleChunksEvicted` calls `cpuCache.markRejected(entityId, key)` for each skipped chunk. The orchestrator owns `widToEntityId`; it derives entityId from the worker member id and forwards to the cache. This is an explicit method, not a private-field reach — ✅ on the boundary.

But `cpuCache.snapshot()` exposes a fairly raw view (`Map<string, Set<string>>`). Orchestrator and DebugOverlays consume it. If sub-stores get extracted, this method needs to aggregate from sub-stores rather than reach into a private field. Mechanical.

### DebugOverlays reads `getCachedChunkTier`, `getPendingSnapshot`, `getPendingProxySnapshot`, `isProxyInFlight`, `snapshot`

All explicit methods. The `getPendingSnapshot` returns a copy of the array. ✅ Encapsulation respected.

### DebugPanel reads `telemetry`, `getCacheDump`, `getProxyCacheDump`, `getPendingDump`, `updateConfig`

Same — explicit methods. ✅

## State ownership map

| State | Owner | Mutators |
|---|---|---|
| `mainCache + mainBytes` | CpuCache | `fetchAndDecode (insert)`, `removeEntry (mainBytes -=)`, `cancelDataset` (delete + bytes -=), `reset` |
| `overviewCache + overviewBytes` | CpuCache | same shape |
| `proxyCache + proxyBytes` | CpuCache | `fetchProxy`, `evictProxyIfNeeded`, `cancelDataset`, `reset` |
| `pendingRequests` | CpuCache | `submit` (rebuild), `startChunkFetches` (shift), `cancelDataset` (filter) |
| `inFlight + inFlightBytes` | CpuCache | `startSingleFetch` (set + bytes +=), `fetchAndDecode` (delete + bytes -=), `cancelDataset`, `markRejected`, `reset` |
| `pendingProxyRequests, inFlightProxy + bytes` | CpuCache | parallel structure |
| `failures` | CpuCache | `fetchAndDecode` (set on error), implicit clear via epoch comparison in `submit`, `cancelDataset`, `reset` |
| `rejectedKeys` | CpuCache | `markRejected`, `clearRejected`, `reset` |
| `activeEntityIds` | CpuCache | `submit` (rebuild), `cancelDataset` (delete) |
| `epochHistory + currentEpochs` | CpuCache | `submit` (push + set), `reset` |
| `submitTick + lruCounter` | CpuCache | `submit` (`++`), insert sites (`++`) |
| Telemetry counters | CpuCache (~16 fields) | scattered across many methods |
| `cacheLogState` | CpuCache | `startChunkFetches`, `recordFailureForBurstDetection` |
| `imageWireFormats` | ProxiedContentSource | `registerImage` (add); never removed |
| `pending + pendingProxy` | ProxiedContentSource | `fetch / fetchProxy` (add), `handleChunkData / handleProxyData` (resolve), `rejectAll / rejectDataset` |
| Pool `pending` map (per worker) | DecodePool worker entry | `decode` (add), `worker.onmessage` (delete) |

The CpuCache row dominates. After extraction, every "owner" cell becomes a sub-store name; mutators stay inside their owner.

## Hidden assumptions worth surfacing

1. **`imageWireFormats` is never cleared.** When a dataset is removed, the wire formats for its images stay in the map forever. Memory leak in long-running sessions with many open/close cycles. *(Verified: `cancelDataset` doesn't reach into ContentSource and `ContentSource.rejectDataset` only clears pending fetches.)*

2. **`avgDecodedBytes` running average never resets.** It tracks lifetime average across all chunks ever fetched. If chunk size distribution shifts dramatically (different dataset), the in-flight byte estimate is biased toward the historical average. Not a bug, but a non-obvious metric behavior.

3. **`cacheLogState.failureBurstCount === 4` triggers exactly once per window.** If the burst keeps growing past 4, no further log fires until the window rolls. Documented behavior; verify Pass 5.

4. **`pending` map in ProxiedContentSource keyed by `${datasetId}/${imageId}/${chunkKey}` but `pendingProxy` keyed by `proxyResponseKey(...)` (which doesn't include datasetId).** Means `rejectDataset` only clears chunks; comment notes "Proxy keys aren't dataset-scoped (entity IDs are unique enough)" — this is an assumption about uniqueness across datasets. If two datasets have the same entity ID, proxies could collide. *(Plate IDs include the plate URL hash, so this is probably safe in practice. Worth a Pass 5 check.)*

5. **Decode worker's `dataType` parameter is redundant with `wireFormat`.** Sending both means the worker could disagree with the main thread (low risk; same code path computes both). Drop on cleanup.

## Severity ranking

| Issue | Severity | Why |
|---|---|---|
| Wrong-direction `extractDataType` import | High | Distorts module shape; one-line fix unblocks decodePool isolation |
| Telemetry counters scattered | High | 16 fields mutated from many sites; blocks any movement of state |
| `imageWireFormats` not cleared on dataset removal | Medium-high | Real long-session leak, even if small |
| `Clock` injection | Medium | Unblocks easier testing of time-dependent paths |
| `DecodePool` interface | Medium | Removes test casts; small surface |
| `CacheStateSnapshot` lives in planning/types.ts | Medium | One-line type move with refactor |
| Magic numbers (4, 16, 100) → constants | Low | Mechanical |
| Proxy key cross-dataset uniqueness | Low | Confirm in Pass 5 |
| `ContentSource` single impl despite multi-variant FetchSource | Medium-low | Architectural debt; only matters if/when Direct/Local lands |
| `markRejected` clear ownership in orchestrator | Low | Implicit but small surface |

## Next pass

Pass 5 (Contract Scan) verifies the assumptions flagged above (proxy key uniqueness, decode-during-cancel races, wire-format-not-registered classification, telemetry side-effecting getter) and inspects the type contracts at module boundaries.
