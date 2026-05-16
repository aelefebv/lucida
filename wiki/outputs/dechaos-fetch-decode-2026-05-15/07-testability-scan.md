# Pass 7 — Testability Scan: fetch/decode subsystem

Goal: determine where current behavior is protected by tests, what gaps exist, and what tests should land before structural changes.

## Existing test surface

| File | LOC | Coverage style |
|---|---|---|
| `cpuCache.test.ts` | 1427 | Integration-style: real CpuCache, mocked ContentSource + DecodePool |
| `decodePool.test.ts` | — | **does not exist** |
| `contentSource.test.ts` | — | **does not exist** |
| `decode.worker.test.ts` | — | **does not exist** (despite re-exports for direct testing) |
| `bridge.test.ts` | — | **does not exist** |

`cpuCache.test.ts` is comprehensive: 68 `it()` blocks across 14 `describe()` groups. Coverage areas:

- `submit/drain lifecycle` (4 tests)
- `in-flight dedup` (2)
- `fetch lifecycle decoupled from plan omission` (5)
- `cancelDataset` (10)
- `cache snapshot` (1)
- `multi-channel` (1)
- `demotion` (1)
- `eviction tiers` (2)
- `adaptive eviction` (4 — interaction-mode detection)
- `minimap lane routing` (3)
- `error handling` (4 — retries, permanent vs transient, failures map, telemetry)
- `budget enforcement` (2)
- `getCached` (4)
- `reset` (1)
- `proxy tier` (10 — submit, drain, dedup, eviction, telemetry, reset)

This is excellent coverage of the existing public surface. **The CpuCache refactor is well-protected at the API boundary.** A refactor that splits internals while preserving the public methods can rely on this test suite as a safety net.

What's *not* covered:
- The four files with no direct tests (decodePool, contentSource, decode.worker, bridge).
- The cancelled-during-decode race (Pass 5 boundary 4 issue: a fetch that completes after cancelDataset still inserts into the cache).
- Backpressure logging (rate-limited debug log).
- Eviction-burst logging (≥16 evicted in one pass).
- The starvation telemetry (`pendingOldestAgeMs`).
- The `pendingEnqueuedAt` lifecycle (preserved across re-submits).
- The `subscribe` listener invocation (any test that asserts a listener was called?).
- Worker-rejection (`markRejected` / `clearRejected`) coupling with `submit`.
- `imageWireFormats` long-session behavior (no test that simulates open/close/open).
- The `lane: "minimap"` survival under pressure is tested ✅.
- Decode-failure handling in `fetchAndDecode` (catch block sets `lastError`).

## Indirect coverage gaps

### `parseProxyHeader`

37-LOC pure function. Re-tested only via the proxy fetch integration in `cpuCache.test.ts`. The test never exercises bad-magic, truncated buffers, unknown dtype codes — those paths throw, but the throws aren't asserted.

**Suggested:** add `wireProtocol.test.ts` (or `contentSource.test.ts`) with:
- Round-trip of a known valid header.
- Bad magic.
- Truncated buffer.
- Unknown dtype code.

~6 unit tests, ~50 LOC. Trivial.

### `proxyResponseKey`

Cross-language contract with the Rust server. **There is no test asserting the exact string format.** A typo here silently breaks proxy delivery for every dataset.

**Suggested:** golden-file test asserting `proxyResponseKey("entity-1", "WellProxy3D", 5, 2) === "proxy/entity-1/WellProxy3D/T00005_C002"`. Plus a fixture comparison against a Rust-generated example string (if one can be exported via a CLI smoke test).

### `extractDataType`

Trivial pure function. Three branches (Raw / Lz4 / Zstd) + default fallback. Currently no test.

**Suggested:** 4-test table. ~15 LOC.

### `decompressLz4`

Hand-rolled LZ4 decoder, ~50 LOC of byte juggling. Tested only via integration in `cpuCache.test.ts` (which uses `Raw` wire format via the mock content source). The actual LZ4 path **is never exercised by tests.**

**Suggested:** `decode.worker.test.ts` with:
- Known-input → known-output round-trip (a small fixture, e.g., 1KB of u8 data compressed by Rust LZ4).
- Edge cases: 4-byte input (just the size header), empty input (currently undefined behavior).

This is high-value because LZ4 decode bugs would manifest as garbled images, which are very expensive to debug.

### `decompressZstd`

Same gap as LZ4. The fzstd library is well-tested upstream, so the integration risk is the lazy-import + buffer-cast pattern, not the decode itself.

**Suggested:** one round-trip test through the `decompress` dispatcher using a Zstd fixture. Asserts both the dispatch (correct codec selected) and the output buffer cast.

### `normalize`

Three branches: uint8 (passthrough), bool (expand to u16), uint16/default (passthrough).

**Suggested:** 3-test table covering each branch. ~15 LOC.

### `DecodePool.decode`

Worker-pool dispatch with least-busy selection. Cannot be tested without either a real Worker or a mock. Today the cache tests mock the entire pool via duck-typing.

**Suggested:** unit test with a mock Worker class (or use `comlink-mock` if available). Verify:
- Round-robin / least-busy selection: 3 workers, 5 sequential decodes → distribution.
- Termination: `terminate()` calls `worker.terminate()` on every pool entry.
- Error propagation: worker's `error` response → promise rejects.

Medium difficulty. Probably skip until pool is non-trivially extended.

### `Bridge.handleBinary`

Envelope parsing logic. No test. Easy to add since the input is just an `ArrayBuffer`.

**Suggested:** ~5 tests:
- Valid chunk frame → calls `onChunkData(key, payload)`.
- Valid proxy frame (key starts with `proxy/`) → calls `onProxyData`.
- Truncated frame (< 6 bytes) → no callback fires.
- Truncated key (less than declared keyLen) → no callback fires.
- Empty payload → callback receives empty buffer.

~50 LOC. Trivial. Worth doing before any chunk/proxy router refactor.

### `ProxiedContentSource`

The most complex untested piece. Current behavior:
- `fetch` registers pending → sends JSON → awaits binary.
- `handleChunkData` resolves a pending entry by key.
- Timeout, abort, dataset-reject, disconnect-reject paths.

**Suggested integration test set** (~10 tests, ~150 LOC):
- Happy path: `fetch` → `handleChunkData` → resolves with `FetchResult`.
- Unregistered image → rejects with "No wire format registered".
- Timeout: 10s passes without `handleChunkData` → rejects with "timed out".
- Abort: `signal.abort()` mid-flight → rejects with `AbortError`.
- `rejectDataset` aborts pending fetches under that dataset prefix.
- `rejectAll` aborts every pending entry.
- Proxy parallel: same five tests on `fetchProxy`.

These would lock in behavior that today is implicit. Pre-refactor, they're the highest-priority new tests.

## Tests that should land BEFORE the refactor

In dependency order:

### 1. `wireProtocol.test.ts` (or sibling tests)

- `parseProxyHeader` — happy + 4 error paths.
- `proxyResponseKey` — golden string.
- `extractDataType` — 4-row table.

**Why first:** these are pure functions, zero infrastructure, ~80 LOC total. They lock down the wire-protocol contract before it gets moved out of `contentSource.ts`.

### 2. `decode.worker.test.ts`

- `decompressLz4` — round-trip fixture.
- `decompressZstd` — round-trip fixture.
- `normalize` — 3-row table.

**Why second:** lock in decoder correctness before `decodePool` API changes (e.g., dropping the redundant `dataType` parameter).

### 3. `contentSource.test.ts`

- The 10-test set above.

**Why third:** locks in transport behavior before any `BinaryRouter` extraction or `ContentSourceFactory` introduction.

### 4. New `cpuCache.test.ts` cases targeting gaps

- Cancelled-during-decode race: assert that a fetch resolved after `cancelDataset` does NOT land in the cache, OR explicitly document and test that it does (current behavior).
- `pendingOldestAgeMs` starvation telemetry: enqueue, wait, drain partial, assert reported age.
- Backpressure log fires once per second under sustained queue depth.
- Eviction-burst log fires for ≥16 evictions in one pass.
- `imageWireFormats` cleared on dataset removal (after the leak fix).

These are **characterization tests** — they pin current behavior so the refactor doesn't silently change it.

## Tests that the refactor will need

For each candidate sub-module from Pass 6:

### `ChunkStore` / `ProxyStore`

Per-store unit tests covering:
- Insert + size accounting.
- Look up by key.
- Remove + size accounting.
- Iterate by tier (for ChunkStore).
- `cancelDataset` per store.
- `reset` per store.

Synthetic entries (no real network), pure logic. ~30 LOC per store.

### `EvictionPolicy` impls

Per-policy table-driven tests:
- `LRUPolicy` — given N entries with insertion order, pick K victims for B bytes needed.
- `TieredPolicy` — given N entries with mixed tiers, pick victims by tier order.
- `TieredPolicy` active-detail tiebreaker — given lastSeenTick + priority, pick correctly.
- `LRUAcrossDatasetsPolicy` — given multi-dataset entries, sort across all.

Pure logic, no plumbing. The active-detail sort case is currently only tested via integration in `cpuCache.test.ts:744-868`; pulling it into a policy unit test makes the contract explicit.

### `InteractionModeDetector`

Already covered by `adaptive eviction` describe-block (4 tests). After extraction those tests can move to `interactionMode.test.ts` and become pure (no cache plumbing).

### `Scheduler` (chunk + proxy)

If unified into `Scheduler<Req, Result>` (Pass 6 highest-payoff but most ambitious extraction):

- Concurrency cap honored.
- Bytes-in-flight cap honored.
- Backpressure log fires.
- `cancelDataset` aborts in-flight matching the cancellation criterion.
- Re-enqueue after limit relief.
- Priority order preserved (assumes plan is sorted, which it is).

Per-asset specifics (retry policy, decode step) tested in their respective transport classes.

### `RetryPolicy` + typed `FetchError`

- `classifyFetchError(err)` — table of error inputs → kind output.
- `RetryPolicy.shouldRetry(verdict, attemptCount)` — table.

Pure. ~30 LOC.

### `TelemetryCounters`

- Each `record*` verb increments correctly.
- `snapshot()` / `consumeTelemetry()` resets window counters.
- `peek()` does not reset (if implemented).

Pure. ~30 LOC.

### `BurstLogger`

- First failure inside window — no log.
- Threshold crossed — one log.
- Window rolls — counters reset.

Pure (with injected clock). ~20 LOC.

## Test infrastructure observations

### Mocking content source

`createMockContentSource()` in `cpuCache.test.ts:43-119` is a hand-built mock that implements both `fetch` and `fetchProxy`. It's substantial (~80 LOC) and recreated per `beforeEach`. Works well today; a future refactor could:

1. Move it to `contentSource.testHelper.ts` so other tests (decoder pool? bridge router?) can reuse it.
2. Add an `auto-resolve-after(N ms)` mode to test interleaving more easily.

Not blocking the refactor; quality-of-life.

### Mocking decode pool

The cache test almost certainly mocks the decode pool similarly. Worth a look at how — if it duck-types to `DecodePool`, introducing an `interface DecodePool` (Pass 4 / Pass 5) would replace the duck-type with a typed seam.

### Time mocking

Only one test uses `vi.useFakeTimers` (the retry test). After the refactor, several more places will need fake timers (backpressure log timing, telemetry window, burst log). A `Clock` injection (Pass 4) makes this easier than `vi.useFakeTimers` everywhere.

### Worker mocking

No tests construct a real Worker. Decode tests would need either:
- jsdom/happy-dom Worker shim.
- A direct import of `decode.worker.ts` and call its exported `decompressLz4 / normalize` functions (these are already re-exported "for direct testing" — see line 138-140).

The second approach is cleaner and is what `decode.worker.test.ts` should use. **Worker construction itself doesn't need testing**; pool dispatch logic does.

## Risk-coverage matrix

| Refactor | Coverage today | Risk if refactored without new tests |
|---|---|---|
| Move `extractDataType` to `manifestTypes.ts` | None directly; integration only | Low — caller imports change |
| Move `parseProxyHeader` to `wireProtocol.ts` | None directly | Low — pure function, but worth a test pre-move |
| Drop `lane: "proxy"` from union | Unused in production | Low — type narrowing change |
| Drop redundant `dataType` from `decode()` | None directly; integration only | Medium — every chunk decode runs through this |
| Extract `ChunkStore` / `ProxyStore` | High (via cpuCache.test) | Low — public API preserved |
| Extract `EvictionPolicy` strategies | High (via cpuCache.test eviction tier tests) | Low |
| Extract `InteractionModeDetector` | High (4 dedicated tests) | Low |
| Extract `TelemetryCounters` | High (telemetry asserted in many tests) | Low |
| Extract `Scheduler<Req, Result>` (chunk + proxy unification) | High | **Medium-high** — chunk/proxy semantic differences may be subtle (retry, failure tracking) |
| Typed `FetchError` + `RetryPolicy` | One test for transient retry | Medium — error classification is currently string-matched in tests too (see assertion shape); changes to error shape may break test assertions |
| Move proxy/ prefix sniff out of bridge | None | Low — integration-only effect |
| `ContentSourceFactory` for FetchSource variants | None | Low if Direct/Local stay unsupported |

## Recommendation

**Before any refactor:** add the four `wireProtocol`, `decode.worker`, `contentSource`, and characterization-gap tests above (~250 LOC total). They cover the largest blind spots and are cheap.

**During the refactor:** the existing `cpuCache.test.ts` is the safety net for the public surface. Don't change it during structural moves; add new per-module tests for extracted units. Once the structure stabilizes, optionally migrate some `cpuCache.test.ts` cases down into the per-module tests they now belong to.

**Defer:** `DecodePool` direct testing, `Bridge.handleBinary` direct testing — both nice-to-have but not blocking the refactor.

## Severity ranking

| Test gap | Severity | Why |
|---|---|---|
| `decompressLz4` / `decompressZstd` round-trip | High | Decoder bugs → garbled images → expensive to debug |
| `proxyResponseKey` golden test | High | Cross-language contract; typo silently breaks proxies |
| `parseProxyHeader` error paths | Medium-high | Header parser; bad data → cache pollution |
| Cancelled-during-decode race characterization | Medium-high | Possible bug; test pins behavior either way |
| `ProxiedContentSource` integration tests | Medium | Pre-refactor lockdown |
| `extractDataType` table | Low | Pure function, easy |
| `normalize` table | Low | Pure function, easy |
| `Bridge.handleBinary` envelope tests | Low | Useful when binary router moves; not blocking now |
| `imageWireFormats` leak char-test | Low | Document current behavior; fix in same PR |

## Next pass

Pass 8 (Refactor Sequencing) turns all of the above into an ordered plan: which extractions to do first, what tests must precede each, and which can be deferred indefinitely.
