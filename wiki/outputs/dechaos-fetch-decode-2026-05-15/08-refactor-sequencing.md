# Pass 8 — Refactor Sequencing: fetch/decode subsystem

Goal: turn the previous seven passes into an ordered, low-risk plan. What ships first, what waits, where the test investment goes.

## Guiding principles

- **Mirror the planning refactor's shape.** That refactor moved `planning.ts` from a 1500-LOC file into a `planning/` directory of 100–500 LOC files: `types.ts`, `modes.ts`, `chunks.ts`, `emit.ts`, `plan.ts`, `config.ts`, `synthetic.ts`, `index.ts` (barrel), plus tests per concern. Same shape works here: `pipeline/fetch/` directory.
- **Smallest credible step per slice.** No slice should both rename + change behavior + extract a module. Pick one axis per slice. (This is exactly the rule that produced the planning refactor's clean diff history.)
- **Tests first, then structure.** Pre-write the characterization tests for the gaps Pass 7 identified. They become the safety net for everything after.
- **Defer abstractions until they earn it.** The `AssetTransport` / unified `Scheduler<Req, Result>` is high-payoff but it has the highest semantic-divergence risk. Do it last, and only if structure-without-it still feels duplicative.
- **Keep `cpuCache.test.ts` green at every step.** It's the integration safety net. New per-module tests live alongside the new modules; the integration tests stay put.

## The shape of the destination

```
lucida-web/src/pipeline/
  fetch/                              ← new directory
    index.ts                          barrel — public surface
    types.ts                          CacheEntry, ReadyDelivery union, internal types
    cpuCache.ts                       thin coordinator (~250 LOC)
    chunkStore.ts                     main + (overview reuses?) cache + budgets + insert/remove
    proxyStore.ts                     proxy cache + LRU eviction
    eviction.ts                       LRUPolicy + TieredPolicy + active-detail tiebreaker
    interactionMode.ts                epochHistory + panning/scrubbing/idle
    scheduler.ts                      pendingQueue + inFlight + concurrency caps + dedup
    retry.ts                          typed FetchError + RetryPolicy + classifyError
    telemetry.ts                      counters + window + snapshot/dumps + BurstLogger
    rejection.ts                      rejectedKeys + markRejected/clearRejected
    contentSource.ts                  unchanged interface; impl loses parseProxyHeader
    decodePool.ts                     unchanged class; loses extractDataType
    decode.worker.ts                  unchanged
    wireProtocol.ts                   parseProxyHeader + key composers + prefix sniff
    cpuCache.test.ts                  unchanged at the public boundary
    chunkStore.test.ts                new
    eviction.test.ts                  new
    interactionMode.test.ts           new (lifted from cpuCache.test.ts)
    scheduler.test.ts                 new
    retry.test.ts                     new
    telemetry.test.ts                 new
    wireProtocol.test.ts              new
    contentSource.test.ts             new (pre-refactor characterization)
    decode.worker.test.ts             new (pre-refactor characterization)
```

Compare to today: 1 god file at 1627 LOC + 4 helpers + no per-helper tests.

## Slices

Each slice is one PR, one focused diff. Roughly ordered by precondition: items higher in the list unblock items lower.

### Slice 0 — Establish output shape, no behavior change

Move the four files into a new `fetch/` directory.

- Create `lucida-web/src/pipeline/fetch/`.
- Move `cpuCache.ts`, `cpuCache.test.ts`, `contentSource.ts`, `decodePool.ts`, `decode.worker.ts` into it.
- Update imports across the codebase.
- Add `pipeline/fetch/index.ts` that re-exports the existing public surface.
- External callers update to import from `pipeline/fetch/index.ts`.

**Risk:** very low (mechanical move + import updates).

**Why first:** establishes the directory contract used by every subsequent slice. Mirrors the `planning/` move that started the planning refactor (commit f6ab886).

### Slice 1 — Wire-protocol pre-refactor tests

**Tests only, no production change.**

- `fetch/wireProtocol.test.ts` — `parseProxyHeader` happy + 4 error paths; `proxyResponseKey` golden string; `extractDataType` 4-row table.
- `fetch/decode.worker.test.ts` — `decompressLz4` round-trip fixture, `decompressZstd` round-trip fixture, `normalize` 3-row table.
- `fetch/contentSource.test.ts` — 10 integration tests (happy fetch, unregistered image, timeout, abort, rejectDataset/rejectAll, parallel for fetchProxy).
- New cases in `fetch/cpuCache.test.ts`:
  - cancelled-during-decode characterization (pin behavior either way).
  - `pendingOldestAgeMs` starvation telemetry.
  - backpressure log fires once per second under sustained queue depth.
  - eviction-burst log fires for ≥16 evictions in one pass.
  - `imageWireFormats` cleared on dataset removal (this requires implementing the cleanup in Slice 4 — schedule the test to be added there, or land the test as `.todo` here).

**Risk:** zero (tests don't change behavior). May surface a small bug in cancelled-during-decode that becomes a small Slice 1.5.

**Why second:** safety net for everything after. ~250 LOC of new test code.

### Slice 2 — Mechanical placements

Five small, independent moves. Either bundle into one slice or split into two.

- Move `extractDataType` from `decodePool.ts` to `manifestTypes.ts`. Update `contentSource.ts` import.
- Move `parseProxyHeader` and `proxyResponseKey` from `contentSource.ts` to a new `fetch/wireProtocol.ts`. Update imports.
- Drop `lane: "proxy"` from `ChunkRequest.lane` union (verified unused in Pass 6). Update narrowing in cache (`laneToTier` becomes 4-branch instead of 5).
- Drop redundant `dataType` parameter from `DecodePool.decode` and from `DecodeRequest`; worker calls `extractDataType` itself.
- Drop redundant `wireFormat` from `FetchProxyResult` (constant `Raw u16`).
- Make `ReadyChunkDelivery.kind` required (drop the `?`).

**Risk:** very low (each move is a few-line diff). Tests from Slice 1 protect.

**Why third:** clears the type/import noise so subsequent extractions are clean diffs.

### Slice 3 — Extract `InteractionModeDetector`

`interactionMode.ts` ~30 LOC: holds `epochHistory`, exposes `push(epochs)` and `current(): "panning" | "scrubbing" | "idle"`.

- `CpuCache` constructs and owns one.
- `evictTiered` reads from it via `getTierOrder(detector.current())`.
- `telemetry()` reads from it.
- The 4 existing `adaptive eviction` tests move to `interactionMode.test.ts` (they become pure — no cache needed).

**Risk:** low. Smallest standalone extraction.

**Why fourth:** warm-up extraction; proves the directory shape and the test-migration pattern that later slices reuse.

### Slice 4 — Extract `TelemetryCounters` + `BurstLogger`

`telemetry.ts`:
- `class TelemetryCounters` with `recordRequest / recordHit / recordEviction(tier) / recordDecode(ms) / recordFetchFailure(isPermanent, message)`. Owns the 16 scattered counter fields.
- `snapshot(): CacheTelemetry` (the old `telemetry()` body, minus the per-call walk that's pulled to its own method on the store).
- `class BurstLogger` for the rate-limited debug logs (`backpressureLastAt + skipped`, `failureLastAt + burstCount`).

CpuCache constructs both, calls verbs instead of mutating fields.

Also in this slice:
- Fix `imageWireFormats` leak: `ProxiedContentSource.unregisterDataset(datasetId)` called from `cpuCache.cancelDataset` (or from `useBridge.removeDataset`). Land the corresponding test from Slice 1.

**Risk:** medium. Lots of mutation sites to update. Tests are good but counter scatter is exactly what makes verification tedious.

**Why fifth:** unblocks every subsequent slice (no more "where does this counter live?" question).

### Slice 5 — Extract eviction policies

`eviction.ts`:
- `interface EvictionPolicy { selectVictims(entries, bytesNeeded): CacheEntry[] }`.
- `class LRUPolicy implements EvictionPolicy` — used by overview cache + proxy cache.
- `class TieredPolicy(modeProvider) implements EvictionPolicy` — used by main cache. Active-detail tiebreaker is its private method.

CpuCache wires policies to caches at construction.

`cpuCache.test.ts:eviction tiers` describe-block: keep as integration coverage. `eviction.test.ts` adds focused per-policy unit tests with synthetic `CacheEntry[]` input.

**Risk:** medium. Active-detail sort is subtle and integration-tested today; ensure parity.

### Slice 6 — Extract per-cache stores

Three stores:
- `class ChunkStore` — wraps `mainCache` Map + `mainBytes` + insert/remove + iterate-by-tier + budget. Owns its `EvictionPolicy` (Tiered).
- `class OverviewStore` — wraps `overviewCache` + `overviewBytes` + insert/remove + budget. Owns LRU policy.
  - **Design Q:** is OverviewStore meaningfully different from ChunkStore? If only the policy differs, parameterize ChunkStore with a policy and drop OverviewStore. Decide during the slice.
- `class ProxyStore` — wraps `proxyCache` two-level Map + `proxyBytes` + insert/remove + budget. Owns LRU-across-datasets policy.

Each exposes:
- `insert(entry)`, `remove(entry)`, `get(entityId, chunkKey)`.
- `cancelDataset(datasetId, entityIds)`.
- `reset()`.
- `dump()` (replaces `getCacheDump` / `getProxyCacheDump`).
- `tierResidency()` (replaces the per-tier walk in `telemetry()`).

`CpuCache.cancelDataset` and `reset` become fan-out (`[chunkStore, overviewStore, proxyStore, scheduler, ...].forEach(s => s.cancelDataset(...))`).

**Risk:** medium-high. State migration is risky — every counter update has to be moved, every Map access has to be routed. Existing tests are good but integration only.

**Why now:** with telemetry already extracted (Slice 4) and eviction already extracted (Slice 5), the stores become thin wrappers around their Maps + their policies. The previous slices have de-risked this one.

### Slice 7 — Extract `Scheduler`

`scheduler.ts`:
- `class Scheduler` — owns `pendingRequests`, `inFlight`, `inFlightBytes`, `pendingEnqueuedAt`. Concurrency cap + bytes cap. Backpressure log via injected `BurstLogger`.
- `enqueue(req)`, `cancelDataset(datasetId, entityIds)`, `start()` (drain to capacity), `markInFlightDone(key, actualBytes)`, `dump()`.
- The dedup ladder (rejected / cached / in-flight / failed) — see Slice 9 for unification.

Initially: two `Scheduler` instances on `CpuCache` (`chunkScheduler`, `proxyScheduler`). They share caps via a config but otherwise are independent. **Don't try to unify chunk/proxy here.**

**Risk:** medium. The fetch+decode happy path crosses scheduler ↔ store boundaries; need to thread callbacks carefully.

### Slice 8 — Extract `RetryPolicy` + typed `FetchError`

`retry.ts`:
- `class FetchError extends Error { kind: "permanent" | "transient" | "abort" }`.
- `function classifyFetchError(err: unknown): FetchError`.
- `interface RetryPolicy { shouldRetry(err, attempt): boolean; delayMs(attempt): number }`.
- `class OnceTransientRetry implements RetryPolicy` (current chunk behavior).
- `class NeverRetry implements RetryPolicy` (current proxy behavior).

`ProxiedContentSource.fetch / fetchProxy` reject with `FetchError` instead of plain `Error`.

`fetchAndDecode`'s catch block becomes:
```
} catch (err) {
  const fe = classifyFetchError(err);
  if (fe.kind === "abort") return cleanup;
  if (chunkRetryPolicy.shouldRetry(fe, attempt)) return retry-after(delayMs);
  failures.set(...); telemetry.recordFetchFailure(fe.kind, fe.message);
}
```

Fixes the "no wire format → transient" misclassification (it becomes `permanent` because `ProxiedContentSource.fetch` raises a `FetchError({kind:"permanent"})` for the unregistered case).

**Risk:** medium. Touches every fetch error site.

### Slice 9 — Extract `RejectionTracker`

`rejection.ts`:
- `class RejectionTracker` — wraps `rejectedKeys` Map. Methods: `mark(entityId, chunkKey): boolean` (returns whether it was newly added), `has(entityId, chunkKey)`, `clear()`.

`CpuCache.markRejected` delegates: marks + aborts in-flight (calls `chunkScheduler.cancelOne(key)` if the rejection tracker reports it was newly added). `CpuCache.clearRejected` delegates.

**Risk:** very low. ~30 LOC class; one consumer.

### Slice 10 — `cpuCache.ts` becomes the thin coordinator

After Slices 3-9, `CpuCache` is mostly fan-out:

```
class CpuCache {
  constructor(source, decode, config) { ... wire collaborators ... }

  submit(plan) {
    this.interactionMode.push(plan.epochs);
    this.chunkStore.applyActiveSet(new Set(plan.activeSet.map(e => e.entityId)));
    this.chunkScheduler.submit(plan.requests, dedupSources);
    this.proxyScheduler.submit(plan.proxyRequests ?? [], proxyDedupSources);
  }

  drain(budgetBytes) { return this.readyQueue.drain(budgetBytes); }
  snapshot() { return aggregate(this.chunkStore, this.overviewStore, this.chunkScheduler); }
  telemetry() { return this.telemetry.snapshot(/* with store residency */); }
  cancelDataset(datasetId, entityIds) { for s of [...] s.cancelDataset(...); }
  reset() { for s of [...] s.reset(); }
  // ... etc
}
```

Final size estimate: ~250 LOC (down from 1627).

**Risk:** low if Slices 3-9 went clean — this is just trimming. **High if anything bled across boundaries** — the slice catches that.

### Slice 11 (optional) — Bridge binary router cleanup

Move proxy/ prefix sniff out of `bridge.ts` into a `BinaryRouter` (or just into `ContentSource.handleBinary(key, payload)`).

`Bridge.BridgeHandlers` collapses `onChunkData? + onProxyData?` into `onBinary(key, payload)`. Application layer (probably `useBridge.ts` setup) wires this to a router.

**Risk:** low. ~5-line cross-file change.

**Why optional:** real but small coupling; do alongside this refactor or save for the next time bridge gets touched.

### Slice 12 (deferred) — `Scheduler<Req, Result>` unification

Only if Slice 7's two parallel Schedulers genuinely look duplicative after the dust settles. May not — chunks have decode + retry + failure-map; proxies don't. Two schedulers may simply be the right shape.

If pursued: `interface AssetTransport<Req, Result>` per Pass 6. One generic `Scheduler<Req, Result>` instantiated twice.

**Risk:** high. Subtle semantic divergence in chunk vs proxy. Don't bundle with anything else.

**Defer indication:** until a *third* asset kind appears, OR the chunk/proxy duplication actively bites (e.g., adding a feature requires touching both copies).

### Slice 13 (deferred) — `ContentSourceFactory`

Add `DirectContentSource` / `LocalContentSource` impls when Direct/Local fetch source variants land. Until then, `setupFetchPipeline`'s "unsupported variant" log is fine.

**Risk:** none today (no work).

## Estimated effort

Generous estimates per slice, in PR-day units:

| Slice | Estimate | Notes |
|---|---|---|
| 0 — directory move | 0.5 | Mechanical |
| 1 — pre-refactor tests | 1.5 | Mostly net-new tests |
| 2 — mechanical placements | 0.5 | Bundleable |
| 3 — InteractionModeDetector | 0.5 | Warm-up |
| 4 — Telemetry + BurstLogger + wireFormats leak fix | 1.5 | Counter scatter is tedious |
| 5 — EvictionPolicy | 1.0 | Active-detail tiebreaker care |
| 6 — Stores | 2.0 | State migration risk |
| 7 — Scheduler | 1.5 | Cross-boundary callbacks |
| 8 — RetryPolicy + FetchError | 1.5 | Touches every error site |
| 9 — RejectionTracker | 0.5 | Trivial |
| 10 — CpuCache thin coordinator | 1.0 | Cleanup pass |
| 11 — Bridge binary router (optional) | 0.5 | |
| 12, 13 — deferred | — | |

Total core slices (0-10): ~11 PR-days. Comparable to the planning refactor cadence.

## Categorized actions

### Clarify
- Drop `lane: "proxy"` from union (Slice 2).
- Drop redundant `dataType` parameters (Slice 2).
- Drop optional discriminator on `ReadyChunkDelivery.kind` (Slice 2).
- Rename `mainCache` → `detailStore` once stores extract (Slice 6).
- Rename `telemetry()` → `consumeTelemetry()` to make side effect visible (Slice 4).
- Document priority sort assumption in `submit()` JSDoc (Slice 2 or wherever).

### Protect
- Pre-refactor tests for wire protocol, decoders, content source, characterization gaps (Slice 1).
- Keep `cpuCache.test.ts` integration-green throughout.
- Per-module tests added with each extraction (Slices 3-10).

### Separate
- Move pure helpers to wireProtocol.ts (Slice 2).
- Extract InteractionModeDetector (Slice 3).
- Extract Telemetry / BurstLogger (Slice 4).
- Extract EvictionPolicy (Slice 5).
- Extract Stores (Slice 6).
- Extract Scheduler (Slice 7).
- Extract RetryPolicy / FetchError (Slice 8).
- Extract RejectionTracker (Slice 9).
- Move binary-router decision out of bridge (Slice 11, optional).

### Stabilize
- Type `FetchError` (Slice 8).
- Optionally introduce `interface DecodePool` + `class WorkerDecodePool` (could fold into Slice 2 cleanups).
- `EvictionPolicy` interface (Slice 5).
- Eventually `AssetTransport<Req, Result>` if Slice 12 happens.

## Risk concentrations

| Risk | Mitigation |
|---|---|
| Counter migration loses telemetry parity | Slice 4 keeps the integration tests; add a "telemetry shape regression" test that snapshots a known sequence |
| Active-detail eviction sort changes behavior | Slice 5 replicates the sort exactly in `TieredPolicy`; new unit test for the tiebreaker |
| Cancelled-during-decode race (Pass 5 finding) | Slice 1 pins behavior; if it's a bug, fix in a small Slice 1.5 |
| Chunk/proxy semantic divergence creeps in | Don't unify in Slice 7; revisit only in Slice 12 if needed |
| `imageWireFormats` leak fix interacts with proxy lifetime | Slice 4 small enough to land cleanly; integration test from Slice 1 |
| `submit()` re-builds `pendingRequests` from scratch each tick — drops anything not in current plan | Document; existing behavior, keep |

## What this is NOT

- Not a behavior change (with the explicit exceptions of: failure classification fix in Slice 8, and `imageWireFormats` cleanup in Slice 4). Both are bugs that the refactor naturally resolves.
- Not a perf optimization. The shape is preserved; if anything, telemetry's per-call cache walk gets cheaper because it lives in the stores.
- Not an extension of the public API. The orchestrator's view of the cache is identical.

## Suggested next step

Hand this output to `/code` to convert each slice into a PRD or ticket-level work item. Or treat each slice as its own `/code` invocation if that fits the project cadence better.

The planning refactor's PR sequence (visible in `git log`) used a "PRD per slice" model with `validatePlanningInputs` checks gated independently. Same model applies here.
