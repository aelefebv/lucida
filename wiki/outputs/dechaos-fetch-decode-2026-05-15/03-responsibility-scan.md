# Pass 3 — Responsibility Scan: fetch/decode subsystem

Goal: per-unit cohesion check. Does each file/class/function have one clear reason to exist?

## Files

### `cpuCache.ts` — 1627 LOC, 1 class, ~40 methods

**One-sentence summary attempt:** "Holds decompressed data between network and GPU."

Reality: this file owns at least 12 named responsibilities (see Pass 2 list). The header comment correctly identifies "detail/overview caches with three-tier adaptive eviction, a priority-ordered fetch scheduler, and the submit/drain/snapshot/telemetry API" — that's already four concerns acknowledged in the docstring, and it elides retry, proxies, lifecycle, telemetry windowing, debug dumps, interaction-mode detection, rejection feedback, and burst-log state.

**Diagnosis:** Vague core responsibility. The name is fine in the abstract ("the CPU cache") but the *class* has grown to be a god-object for everything between `submit` and `drain`.

**Suggested split:** see Pass 2 "Visualization: target shape." Concretely:
- `scheduler.ts` — pending queue + in-flight + concurrency caps + dedup-against-{inflight,failed}
- `retry.ts` — failure classification (the brittle string-match), failures map, burst log
- `store.ts` — main + overview cache maps + budgets + insert/remove
- `eviction.ts` — tiered + LRU policies; takes interaction mode as input
- `proxyStore.ts` — proxy cache + LRU eviction (or fold into store via Asset abstraction)
- `interactionMode.ts` — epochHistory + panning/scrubbing/idle detection
- `telemetry.ts` — counters + window + telemetry()/dumps
- `cpuCache.ts` — thin coordinator (target ~200 LOC)

### `contentSource.ts` — 319 LOC

**One-sentence summary attempt:** "Resolve logical chunk requests to physical bytes via the network."

Reality: 
1. The interface (`ContentSource` + `FetchRequest` + `FetchResult` + the proxy variants).
2. Free functions for proxy header parsing (`parseProxyHeader`) and key composition (`proxyResponseKey`).
3. The `ProxiedContentSource` class — wraps the WS bridge, owns pending-promise tables, registers wire formats per image, handles dataset/disconnect cancellation.

**Diagnosis:** Three pieces in one file is reasonable as a transport module, but `parseProxyHeader` is a pure binary-decode function and not transport. It's tested only via `cpuCache.test.ts` indirection. (Verified: no direct test.)

**Suggested split:**
- `wireProtocol.ts` — `parseProxyHeader`, `proxyResponseKey`, the implicit chunk composite-key composer, key-prefix sniffing (`proxy/...`). Sibling to `contentSource.ts`.
- `contentSource.ts` keeps the interface + `ProxiedContentSource` impl.

Risk: low. `parseProxyHeader` is a pure function; `proxyResponseKey` already documents that it must mirror the server. Centralizing both in a `wireProtocol.ts` makes the wire-side contract a single discoverable location.

### `decodePool.ts` — 114 LOC

**One-sentence summary attempt:** "Codec-agnostic decode worker pool."

Reality: 
1. `defaultPoolSize` (sizing heuristic).
2. `DecodePool` class — pool construction, least-busy worker pick, `decode` dispatch, `terminate`.
3. `extractDataType` — wire-format introspection helper, used by `contentSource.ts`.

**Diagnosis:** (3) does not belong here. It's wire-format introspection used by transport, not pool plumbing. Today the pool happens to hold it because the worker request shape needs `dataType`.

**Suggested move:** `extractDataType` → `manifestTypes.ts` (where `WireFormat` lives) or a sibling `wireFormat.ts`.

### `decode.worker.ts` — 140 LOC

**One-sentence summary attempt:** "Codec-agnostic decode worker — decompress + normalize."

Reality: matches the summary. Internally split into `decompress` (Raw / LZ4 inline / Zstd lazy) and `normalize` (uint8 / bool / uint16). Re-exported for direct testing.

**Diagnosis:** Healthy single-responsibility unit. No changes recommended for this file in itself. The only related concern is the worker-protocol shape (`DecodeRequest` carries both `wireFormat` AND a redundant `dataType` — the worker could call `extractDataType(wireFormat)` itself; that would let `decodePool.decode` drop the `dataType` parameter).

### `bridge.ts` — 350 LOC

**One-sentence summary attempt:** "WebSocket bridge — inbound/outbound JSON + binary frames + presence/cursor throttling."

Reality:
1. WS lifecycle (connect / reconnect / destroy).
2. Inbound JSON message dispatch (~10 message types into `BridgeHandlers` callbacks).
3. Inbound binary envelope parsing (`handleBinary`) + chunk/proxy routing by `key.startsWith("proxy/")`.
4. Outbound throttled senders (presence ~50ms, datasetPresence ~200ms, cursor ~50ms).
5. Bookmark-changed listener fan-out (subscribe API).
6. JSON command/open-dataset/follow plumbing.

**Diagnosis:** This file is fine for the size, but the binary-routing decision (item 3) is a single line of awkward coupling — bridge knows the application taxonomy ("chunk vs proxy"). Worth flagging as a candidate boundary cleanup but it's a 5-line change, not a refactor.

**Out of scope for this pass:** items 4–6 belong to other dechaos passes (presence/bookmarks).

## Classes & functions inside `CpuCache` worth calling out

### `CpuCache.submit` (lines 406-494, ~88 LOC)

**Phases:**
1. Bump `submitTick`, push `epochHistory`, set `currentEpochs`. *(state recording)*
2. Diff `activeEntityIds` vs `plan.activeSet`, demote removed entities. *(active-set tier promotion)*
3. Build new `pendingRequests`: per-request 4-step dedup ladder (rejected / cached-refresh / in-flight / failed), updating `pendingEnqueuedAt` and counter `totalRequests`/`totalHits` along the way. *(dedup pass)*
4. Mirror dedup pass for `pendingProxyRequests` (3-step variant — proxy has no rejection or failure tracking). *(parallel proxy dedup)*
5. Kick off `startChunkFetches` + `startProxyFetches`. *(scheduler triggers)*

**Diagnosis:** This is a "do five things in order" function. Each phase is independently testable but they're glued together by shared state. A target shape:

```
submit(plan):
  recordEpochs(plan.epochs)
  promoteActiveSet(plan.activeSet)         # (was: demoteEntity loop)
  this.pendingRequests   = scheduler.dedup(plan.requests, store, failures, rejections)
  this.pendingProxyRequests = proxyScheduler.dedup(plan.proxyRequests, proxyStore, ...)
  scheduler.start(); proxyScheduler.start()
```

Phase 3's inner ladder is a great candidate to extract into `scheduler.dedup(req)` returning `Skip | Refresh(entry, req) | Enqueue(req, enqueuedAt)`.

### `CpuCache.fetchAndDecode` (lines 1083-1230, ~148 LOC)

**Phases:**
1. `source.fetch` (catch handles abort / classify / retry / fail + log).
2. Adjust in-flight byte estimate from estimate→actual; update running average.
3. `decode.decode` (catch handles abort / fail).
4. Remove from in-flight (with a guard against `submit` having cancelled mid-decode — duplicated guard).
5. Build the `cacheEntry` literal, route to mainCache or overviewCache, evict if needed, insert.
6. Push to `ready[]`, notifyListeners.
7. Recursively `startChunkFetches` to fill the freed slot.

**Diagnosis:** Probably the single longest method in the file. The retry control flow (recursive call with `retryCount + 1`) is interleaved with byte-accounting and failure-map logic. The fact that there are *two* in-flight cleanup branches (one in the catch, one after decode) hints at a state-machine that wants to be a state-machine.

**Suggested target:**
- `tryFetch(req, signal): Promise<{bytes, dataType, wireFormat} | FailureKind>` — handles retry + classification.
- `tryDecode(bytes, wireFormat, dataType): Promise<ArrayBuffer | DecodeFailure>` — wraps the timing window + decode.
- `cacheAndDeliver(req, decoded, ...)` — builds entry, routes to store, pushes ready.
- `fetchAndDecode` becomes ~30 LOC: `await tryFetch → await tryDecode → cacheAndDeliver → drain queue`.

The "guard: submit may have cancelled" is suspicious. Verify in Pass 5 (Contract Scan): can decode complete after the in-flight entry was deleted? If yes, the cache enters the just-decoded buffer anyway ("we still cache it since the work is done") — that's a deliberate design choice but only documented in a comment. Should be hardened.

### `CpuCache.fetchProxy` (lines 1264-1340, ~77 LOC)

**Phases:** mirrors `fetchAndDecode` minus retry/failure classification, plus a different cache-insert path (separate `proxyCache` Map of Maps and `evictProxyIfNeeded`). 

**Diagnosis:** ~70% structural duplication of `fetchAndDecode`. Resolving Seam A (the chunk/proxy unification) is what shrinks this most.

### `CpuCache.evictTiered` (lines 1497-1540)

**Three sort orders inside one function:**
1. The tier-order list (by interaction mode).
2. Within `active-detail`: `lastSeenTick` asc, then `priority` desc, then `insertedAt` asc.
3. Within all other tiers: `insertedAt` asc.
4. Plus a "burst log" trigger if ≥16 evicted in one pass.

**Diagnosis:** Mixing tier iteration, sort policy, and burst-detection. The active-detail sort is a documented design (avoids "evict the focal point first") and the documentation is good. Suggest pulling the sort into a named function `sortForActiveDetail(entries)` so the contract is loud.

### `CpuCache.cancelDataset` (lines 513-593, 7 numbered steps)

**Diagnosis:** This function exists *because* state is fragmented across many fields. It's a leaf consequence of the missing sub-store boundaries. Once each sub-store owns its own state, `cancelDataset` becomes a fan-out: `[scheduler, proxyScheduler, store, proxyStore, failures, rejections, ready].forEach(s => s.cancelDataset(...))`.

The comment block correctly enumerates "what state must be cleared." Today new state additions risk being missed.

### `CpuCache.reset` (lines 979-1029, 8 zeroed-field groups)

**Diagnosis:** Same shape as `cancelDataset`. Same fix (fan-out across sub-stores). Today only the test suite calls `reset`; it's load-bearing but easy to forget when adding state.

### `CpuCache.telemetry` (lines 684-784, ~100 LOC)

**Phases:**
1. Compute window-scoped rates (evictions/sec, decodes/sec) and reset window counters.
2. Detect interaction mode.
3. Walk every cached entry to bin tier residency. *(O(N) over the whole cache)*
4. Compute pending-oldest-age from `pendingEnqueuedAt`.
5. Compute decode percentiles.
6. Assemble the 30-field `CacheTelemetry` object.

**Diagnosis:** One method, one responsibility ("produce telemetry"), but the tier-residency walk is O(N) per call. Run frequency: every panel refresh (~1 Hz). Likely fine in practice, but worth checking — main cache can hold thousands of chunks under load.

The window reset inside `telemetry()` is a side effect masquerading as a getter; it means the function is not idempotent. Two consumers calling `telemetry()` get different numbers. Today there's only one consumer (DebugPanel), so this hasn't bitten — but it's a contract surprise. Note for Pass 5.

### `CpuCache.detectInteractionMode` (lines 1593-1606)

Tiny pure-ish function (depends on `epochHistory` field). Extracts cleanly.

### `CpuCache.recordFailureForBurstDetection` (lines 1382-1399)

A 17-line helper that owns its own state (`cacheLogState.failureLastAt / failureBurstCount`). Could live in `retry.ts` as a small `BurstLogger` collaborator. Mechanical.

## Functions inside `contentSource.ts` worth calling out

### `parseProxyHeader` (free function, lines 83-119)

Pure. ~37 LOC. Currently lives in the same file as the transport, but it is a binary-decode utility, not transport. Move to `wireProtocol.ts` as suggested above.

### `proxyResponseKey` (free function, lines 126-133)

8 LOC. Wire-key composer. **Must stay in lockstep with the Rust server.** This is a cross-language contract in the comment. Move to `wireProtocol.ts` and the contract becomes more visible.

### `ProxiedContentSource.fetch` and `fetchProxy`

Both are short and structurally parallel: register a pending entry → set timeout → send JSON → register abort handler. Could deduplicate via a `awaitBinaryByKey(key, timeoutMs, sendJson, signal)` helper, but the gain is small (~30 LOC saved) and the code is clear today. Probably not worth the abstraction.

## Functions inside `decodePool.ts` worth calling out

### `extractDataType` (free function, lines 109-114)

5 LOC. Wire-format introspection. **Wrong home** — see file diagnosis above.

### `DecodePool.decode` (lines 71-83)

Pool dispatch with least-busy worker pick. Tiny and focused. The redundancy is that it forwards `dataType` separately when the worker can re-derive from `wireFormat`. Mechanical cleanup: drop `dataType` from `DecodeRequest`.

## Functions inside `decode.worker.ts` worth calling out

All small and well-named. No issues. The lazy import of `fzstd` inside `decompressZstd` keeps the worker startup cheap — keep that.

## Naming review

Most names are good. The few that might want to change after a refactor:

- `mainCache` is bad — "main" doesn't say what kind. After a split, `detailCache` (or simply: the Store handles tiers internally and "main" goes away).
- `overviewCache` is correct.
- `proxyCache` is correct.
- `inFlightKey(req)` returns `${entityId}/${chunkKey}` — fine, but `inFlightProxyKey(req)` returns `${datasetId}|${innerKey}` (different separator) — sibling functions, divergent conventions. Pick one (`|` is safer because entity IDs may contain `/` — see plate IDs `plateId:A/1/0`).
- `lastSeenTick` is good. `submitTick` is good.
- `cacheLogState` is vague. Call it `burstLogState` or move it to a `BurstLogger` collaborator.
- `currentEpochs` doubles as both "the latest plan epochs" and "what failure-clear logic compares against." Two concerns under one name; small but real.
- `CacheStateSnapshot` (in planning types, but consumed by orchestrator/DebugOverlays via `snapshot()`) — name is fine, but the type now lives in planning despite being produced by the cache. After the refactor it should move out of `planning/types.ts`.

## Cross-cutting smell: 16 fields of state on one class

Counted from the field declarations: `mainCache, mainBytes, overviewCache, overviewBytes, proxyCache, proxyBytes, pendingRequests, inFlight, inFlightBytes, pendingProxyRequests, inFlightProxy, inFlightProxyBytes, ready, activeEntityIds, epochHistory, failures, lruCounter, submitTick, rejectedKeys, listeners, totalHits, totalRequests, evictionsSinceSnapshot, evictionsByTierSinceSnapshot, lastTelemetryTime, lastError, decodeTimes, transientFailures, permanentFailures, pendingEnqueuedAt, avgDecodedBytes, completedFetches, decodesSinceSnapshot, cacheLogState, currentEpochs`.

That's actually 35 fields. Some pair up (`mainCache + mainBytes`, `overviewCache + overviewBytes`, `proxyCache + proxyBytes`, `inFlight + inFlightBytes`, `inFlightProxy + inFlightProxyBytes`) — but even after pairing it's >25 distinct state slots. This is the strongest single quantitative argument for the split.

## Severity ranking

| Unit | Severity | Rationale |
|---|---|---|
| `cpuCache.ts` (whole file) | **High** | God object; 35 fields; 12 concerns; 1627 LOC |
| `CpuCache.submit` | High | Five phases glued by shared state |
| `CpuCache.fetchAndDecode` | High | Retry / accounting / state-machine all interleaved |
| `CpuCache.fetchProxy` | High | Resolves automatically via Seam A |
| `CpuCache.cancelDataset` + `reset` | Medium | Symptom of structure; resolves via sub-store extraction |
| `CpuCache.telemetry` | Medium | Side-effecting getter; 30-field literal |
| `extractDataType` placement | Low | One-line move |
| `parseProxyHeader` placement | Low | File move |
| `bridge.ts` chunk/proxy routing | Low | 5-line cleanup, do alongside Seam A |
| `decode.worker.ts` | None | Healthy |
| `contentSource.ts` (impl) | None | Healthy after `parseProxyHeader` moves out |
| `decodePool.ts` (impl) | None | Healthy after `extractDataType` moves out |

## Next pass

Pass 4 (Dependency Scan) checks: hidden globals, hard-coded constants, hidden coupling between modules, and whether the proposed sub-stores can actually be constructed/tested in isolation.
