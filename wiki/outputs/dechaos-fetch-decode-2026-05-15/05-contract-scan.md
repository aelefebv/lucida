# Pass 5 — Contract Scan: fetch/decode subsystem

Goal: are the data contracts at module boundaries explicit enough to safely change the code?

## Boundary inventory

The fetch/decode subsystem has four boundaries to scrutinize:

1. **Bridge ⟷ ContentSource** — binary frame routing.
2. **ContentSource ⟷ CpuCache** — `ContentSource` interface (chunk + proxy fetch).
3. **CpuCache ⟷ DecodePool** — `decode(bytes, wireFormat, dataType)` call.
4. **CpuCache ⟷ Orchestrator** — `submit / drain / snapshot / telemetry / markRejected / clearRejected / getCachedChunk / getCachedProxy / cancelDataset / subscribe`.

## Boundary 1 — Bridge ⟷ ContentSource

### Current contract

```ts
BridgeHandlers {
  onChunkData?: (key: string, data: ArrayBuffer) => void;
  onProxyData?: (key: string, data: ArrayBuffer) => void;
}
```

The bridge parses the WS envelope and dispatches by `key.startsWith("proxy/")`.

### Issues

- **Bridge knows the application taxonomy.** The "proxy/" prefix decision belongs in the application layer, not the wire layer. Today this is a single line, but it's a leaky abstraction: any new asset kind requires editing `bridge.ts`.
- **The `key` payload format is implicit.** Chunk key is `"<datasetId>/<imageId>/<chunkKey>"` (composed in `ContentSource.fetch`); proxy key is `"proxy/<entityId>/<kind>/T<t>_C<c>"` (composed in `proxyResponseKey`). Bridge doesn't validate or even know these formats — it just hands the string to a handler. **Format-level correctness is enforced by sender/receiver agreement only.**
- **`onChunkData?` and `onProxyData?` are optional.** If unwired, frames silently drop. There's no warning. (Verified: no log on unhandled binary frame in `handleBinary`.)

### Suggested contract

Two options:

```ts
// Option A — single binary handler, application-level routing
BridgeHandlers {
  onBinary: (key: string, data: ArrayBuffer) => void;
}
```

Then a `BinaryRouter` collaborator in the pipeline layer dispatches on prefix, with a "no handler matched" warning path.

```ts
// Option B — typed envelope from the start
type BinaryFrame =
  | { kind: "chunk"; datasetId: string; imageId: string; chunkKey: string; data: ArrayBuffer }
  | { kind: "proxy"; entityId: string; proxyKind: ProxyKind; t: number; c: number; data: ArrayBuffer }
  | { kind: "unknown"; key: string; data: ArrayBuffer };

BridgeHandlers {
  onBinary: (frame: BinaryFrame) => void;
}
```

Option B is more invasive but eliminates the string parsing duplication between bridge (sniffs prefix) and ContentSource (parses the rest). Option A is the minimal cleanup. Probably do A first; defer B until a third asset kind appears.

## Boundary 2 — ContentSource ⟷ CpuCache

### Current contract

```ts
interface ContentSource {
  fetch(request: FetchRequest, signal: AbortSignal): Promise<FetchResult>;
  fetchProxy(request: FetchProxyRequest, signal: AbortSignal): Promise<FetchProxyResult>;
}

interface FetchResult {
  bytes: ArrayBuffer;
  wireFormat: WireFormat;
  dataType: string;          // ← derived from wireFormat by the source
}

interface FetchProxyResult {
  header: ProxyHeaderJs;
  data: ArrayBuffer;
  wireFormat: WireFormat;    // always { Raw: { data_type: "uint16" } }
}
```

### Issues

#### A. `dataType` in `FetchResult` is redundant with `wireFormat`

`extractDataType(wireFormat)` deterministically computes `dataType`. The cache uses `dataType` to populate `ReadyChunkDelivery.dataType` for the GPU upload path (which decides uint8→uint16 conversion). The decode worker also receives `dataType` separately and uses it for `normalize`.

**Suggested contract:** drop `dataType` from `FetchResult`. Callers compute it on demand from `wireFormat`. (Or move `extractDataType` to `manifestTypes.ts` and let everyone use it directly — see Pass 4.)

#### B. `WireFormat` in `FetchProxyResult` is always the same constant

`{ Raw: { data_type: "uint16" } }` — proxies are never compressed, never any other dtype. The field is "for parity with chunk fetches" per the comment.

**Suggested contract:** drop `wireFormat` from `FetchProxyResult`. Or, if proxy compression is on a roadmap, keep it but document that.

#### C. Failure shape is "anything thrown"

```ts
fetchAndDecode catches err: unknown
isPermanent = message.includes("404") || message.includes("malformed")
```

This is brittle:

- The error message of "No wire format registered for image X" matches neither `404` nor `malformed`, so it's treated as transient → retried once → fails permanently after the retry → enters the failures map until the next content epoch advances. Almost certainly not the intended behavior — a missing wire format is a setup bug, not a transient network blip.
- A future server change that returns a different error message could silently flip permanent-vs-transient classification.
- The `recordFailureForBurstDetection` call passes `isPermanent` to logging based on the same string match.

**Suggested contract:** make `ContentSource.fetch` reject with a typed error:

```ts
class FetchError extends Error {
  constructor(public kind: "transient" | "permanent" | "abort", message: string) { super(message); }
}
```

`ProxiedContentSource` then knows to throw `kind: "permanent"` for "no wire format" and 404; `kind: "transient"` for timeout, network error, or 5xx. The cache reads `err.kind` instead of pattern-matching.

This single change tightens 3 places in cpuCache (`isPermanent` derivation, retry decision, failure classification) and removes a hidden cross-language coupling on error message text.

#### D. Proxy fetch has no failure tracking

`fetchProxy` catches errors and silently deletes the in-flight entry. Unlike `fetchAndDecode`, there's no `failures` map, no retry, no burst log, no `lastError` update. Comment says "No retry / failure tracking in S5 — orchestrator can resubmit on the next plan if it still wants this proxy."

**Suggested contract:** unified failure handling once Seam A (chunk/proxy unification) lands. The retry-vs-no-retry policy should be per-kind config, not "this code path forgot." Until then, document `lastError` is *only* populated by chunk failures.

#### E. `signal: AbortSignal` is honored, but post-decode cancellation isn't

If the orchestrator cancels via `cpuCache.cancelDataset` after `source.fetch` resolved but before `decode.decode` completes, the decode runs to completion and the result is silently dropped. Comment: "We still cache it since the work is done." That's a deliberate choice, but the contract should say so.

**Suggested contract:** `fetchAndDecode` documents that "AbortController.abort() during decode is a no-op for that decode, but the result will not be added to `ready[]` if the in-flight entry was cleared." Today it's actually inserted into the cache anyway (the comment + code disagree slightly — verify).

Looking again at `cpuCache.ts:1158-1188`: the code inserts into the cache, builds `ReadyDelivery`, pushes to `ready[]`, **regardless of whether `inFlight.has(key)`**. The "guard" is only on `inFlightBytes` accounting. So the comment "we still cache it since the work is done" is accurate, but `ready[]` also gets it — meaning a cancelled-during-decode chunk lands in BOTH the cache AND the ready queue. The orchestrator's drain will then forward it to a worker that may have just been told the dataset is gone.

**Possible bug or possible fine.** Verify in Pass 7 with a test. The orchestrator should be defensive against a delivery for a removed dataset — and is, but only by virtue of the entityId no longer being in `memberToDataset`. Worth a contract assertion: "ready[] entries may belong to cancelled datasets; consumers must filter."

### Suggested better contract

```ts
interface ContentSource {
  /**
   * Fetch raw wire-format bytes for a chunk.
   *
   * @throws FetchError(kind: "permanent")  — 404, malformed, or no wire format registered
   * @throws FetchError(kind: "transient")  — timeout, network, 5xx
   * @throws DOMException("AbortError")     — signal aborted before resolution
   */
  fetch(request: FetchRequest, signal: AbortSignal): Promise<FetchResult>;
}

interface FetchResult {
  bytes: ArrayBuffer;
  wireFormat: WireFormat;
  // dataType derived by caller from wireFormat
}
```

## Boundary 3 — CpuCache ⟷ DecodePool

### Current contract

```ts
class DecodePool {
  decode(bytes: ArrayBuffer, wireFormat: WireFormat, dataType: string): Promise<ArrayBuffer>;
  activeCount(): number;
  size: number;
  terminate(): void;
}
```

### Issues

#### A. `dataType` parameter is redundant with `wireFormat`

Same as above (Boundary 2 issue A). Drop the parameter; let the worker derive it.

#### B. The returned `ArrayBuffer` shape is implicit

The decode worker returns:
- For `dataType: "uint8"`: pass-through `Uint8Array` (interpreted by GPU upload as raw uint8, converted to uint16 on upload)
- For `dataType: "bool"`: expanded `Uint16Array` (255 or 0)
- For `dataType: "uint16"` (default): pass-through `Uint16Array`

The cache stores it as `ArrayBuffer` and forwards to the worker; the worker decides what type to interpret it as based on `delivery.dataType`. **The dataType field on `ReadyChunkDelivery` is load-bearing — without it the GPU upload doesn't know whether to convert.**

**Suggested contract:** the returned buffer should be self-describing or the contract should be explicit. Either:
- Return `{ data: ArrayBuffer; dataType: "uint8" | "bool" | "uint16" }` from `decode`. This makes the type flow visible.
- Or accept that `dataType` is a side channel and keep it on `FetchResult` / `ReadyChunkDelivery` (current design).

The current design is OK; making it explicit would help readers but isn't strictly necessary. Low priority.

#### C. The decode worker can return `error: string`

`PoolWorker.onmessage` rejects with `new Error(error)`. The error message is opaque — fzstd errors get wrapped, LZ4 errors get raw `message` strings.

**Impact:** `fetchAndDecode`'s decode-failure branch sets `lastError` to the message but doesn't classify (no permanent/transient distinction). Decode failures are silent in telemetry. Probably OK because decode failures are rare and almost always permanent (corrupt data).

### Suggested change

Drop `dataType` parameter from `decode()` and from the `DecodeRequest` shape. Worker computes via `extractDataType(wireFormat)`. Also add an `interface` for `DecodePool` so the cache can type its dependency without importing the concrete class.

## Boundary 4 — CpuCache ⟷ Orchestrator

This is the biggest surface. Each method is its own contract.

### `submit(plan: RequestPlan): void`

**Documented:** "Purely additive — does NOT cancel in-flight fetches that aren't in the new plan. Use `cancelDataset()` for explicit removal." ✅

**Side effects:**
- Bumps `submitTick`.
- Demotes entities removed from active set.
- Refreshes `priority` and `lastSeenTick` on cached entries appearing in the new plan.
- Skips rejected, in-flight, failed-not-cleared, cached entries.
- Enqueues survivors.
- Kicks off `startChunkFetches()` and `startProxyFetches()`.

**Implicit contract:** `plan.requests` may contain chunks already cached or in-flight; cache de-dups silently. ✅ documented.

**Implicit contract:** `plan.activeSet` defines which entities are "active" — anything in the cache for an entity NOT in this set gets tier-demoted. **If the orchestrator fails to include an entity in `activeSet` (bug), the cache demotes everything for that entity.** Fragile. Document this on `RequestPlan.activeSet`.

**Implicit contract:** `plan.proxyRequests ?? []` — proxies are optional on the plan shape. Consistent with planning's behavior (only present when promotion produced them). ✅

### `drain(budgetBytes: number): ReadyDelivery[]`

**Documented:** "Pull decoded buffers up to budget. Returns new deliveries only." ✅

**Implicit contract:** "up to budget" means *first delivery always returned even if it exceeds budget*. Looking at code:
```
for (const delivery of this.ready) {
  if (remaining > 0) { result.push(delivery); remaining -= delivery.data.byteLength; }
  else { kept.push(delivery); }
}
```
So a single 100MB delivery on a 16MB budget *will* be returned (exhausting budget into negative). Then no further deliveries. **This is the right behavior** but it's not in the docstring.

**Suggested contract:** "Drains deliveries until cumulative bytes >= budgetBytes (overshoot allowed by one delivery)." Update docstring.

**Order:** Implicitly FIFO over `ready[]` — ordered by decode-completion time, which is determined by both fetch completion order and decode worker contention. **Not** by priority. If fetch A (priority 0, 100KB) and fetch B (priority 1000, 1MB) both started at tick T, B might complete decoding first if its decode is simpler, and B is delivered first. Currently doesn't matter because the budget is per-frame and all deliveries are eventually consumed.

### `snapshot(): CacheStateSnapshot`

**Returns:** `{ cached: Map<entityId, Set<chunkKey>>, inFlight: Map<entityId, Set<chunkKey>> }`.

**Issue:** The returned Maps are **fresh copies** (rebuilt every call). The Sets inside are also fresh copies of the keys. Callers can safely iterate. ✅

**Cost:** O(N) per call where N = total cached chunks. Called from orchestrator on every visible-dataset visit (up to many times per tick, depending on resend pass). Could become hot — verify in Pass 7.

### `telemetry(): CacheTelemetry`

**Side-effecting getter** — resets window counters. As noted in Pass 3 / Pass 4: calling `telemetry()` twice in a row gives different values. The second call sees zero evictions/decodes since the first call.

**Suggested contract:** rename to `consumeTelemetry()` to make the side effect visible. Or split into `peekTelemetry()` (no reset) + `flushWindow()`.

### `getCachedChunk(entityId, chunkKey): ReadyChunkDelivery | null`

**Returns:** a fresh `ReadyChunkDelivery` or null. The returned object reuses the cached `ArrayBuffer` (no copy). ✅

**Implicit contract:** safe to call from any tick. Doesn't update LRU. Caller doesn't mutate the buffer. **Mention that the buffer is shared with the cache** — if the caller transfers it to a worker via `postMessage`, ownership transfers and the cache loses its data. (In practice this likely doesn't happen — verify.)

### `getCachedProxy(...): ReadyProxyDelivery | null`

Same shape, same caveat about buffer aliasing.

### `markRejected / clearRejected`

`markRejected(entityId, chunkKey)`: idempotent (set add); aborts in-flight for the same key.

`clearRejected()`: clears all rejections for all entities.

**Implicit contract:** clear cadence is owned by orchestrator. Cache doesn't time-out rejections. Documented in field comment. ✅

### `cancelDataset(datasetId, entityIds)`

**Documented:** "The orchestrator owns the dataset → entityIds mapping; this method does not maintain its own. Pass the full set of entity ids that belonged to the removed dataset." ✅

**Implicit contract:** if `entityIds` is incomplete, the leftover entries persist forever (until next dataset opens with the same entityId, which is unlikely). Worth a "no-op-safe" guarantee — i.e., what happens if you pass an entityId that was never in the cache? Today it just no-ops (Map.get returns undefined; iteration skips). ✅ safe.

**Race:** `cancelDataset` aborts in-flight fetches but doesn't cancel decodes-in-progress (the decode promise has no signal). A decode that started before cancellation completes; the result is silently dropped (in-flight entry is gone, so `inFlight.has(key)` returns false, the byte-accounting branch skips, but the cache insert + `ready.push` still happen, as noted above). Wait — that's the same race as Boundary 2 issue E. **Actually `cancelDataset` itself deletes the in-flight entry in step 1, so the post-decode `if (this.inFlight.has(key))` check fails — but the cache insert and `ready.push` happen regardless.** So a cancelled-then-decoded chunk lands in the cache (which was just emptied) and in `ready[]`.

**Bug-ish:** the decode result re-populates `mainCache` for an entityId that was just `cancelDataset`'d. Then `cancelDataset` returns. Then on next `submit()` the entry exists and is treated as a cache hit. The data is for a (probably) re-loaded dataset; the entityId might collide. Needs a test.

**Suggested fix:** check `activeEntityIds.has(req.entityId)` (or any dataset-membership check) before inserting in `fetchAndDecode`. Or pass an `AbortSignal` through the entire `fetchAndDecode` so the post-decode insert path can early-return.

### `subscribe(listener): () => void`

**Returns:** unsubscribe function. ✅

**Implicit contract:** listeners run synchronously after `notifyListeners` is called from `fetchAndDecode` and `fetchProxy`. **Listener exceptions propagate** (no try/catch). Today only one listener (RenderLoop) which doesn't throw. Future subscribers should be defensive or the cache should swallow exceptions in `notifyListeners`.

## Type contracts at boundaries

### `ReadyDelivery` discriminated union

```ts
type ReadyDelivery = ReadyChunkDelivery | ReadyProxyDelivery;

interface ReadyChunkDelivery {
  kind?: "chunk";   // ← optional for backward-compat
  ...
}

interface ReadyProxyDelivery {
  kind: "proxy";
  ...
}
```

**The `kind?: "chunk"` makes the discriminator optional on one variant.** Call sites narrow with `if (d.kind === "proxy") ... else ...` — TypeScript correctly narrows the absent-discriminator case to `ReadyChunkDelivery`. But this is a footgun: if a future variant `kind: "minimap"` is added, the code path that does `if (d.kind === "proxy") else /* assumed chunk */` silently treats minimap as chunk.

**Suggested contract:** make `kind` required on both variants:

```ts
interface ReadyChunkDelivery { kind: "chunk"; ... }
```

The "backward-compat" comment suggests this was added cautiously; it's safe to require now. One test file change required.

### `ChunkRequest.lane` is a string union of 5

```ts
lane: "minimap" | "detail" | "proxy" | "prefetch" | "overview";
```

CPU cache narrows to:
- "overview" or "minimap" → overviewCache
- "prefetch" → prefetch tier
- everything else → active-detail tier

**Implicit:** "proxy" lane chunks are never produced for chunks today (proxies are `ProxyRequest`, not `ChunkRequest`). The `proxy` lane in `ChunkRequest.lane` exists but is unused. Verify with a `git grep` — if true, simplify the union.

```sh
$ git grep "lane: \"proxy\"" lucida-web/src
```

If no production sites, drop "proxy" from `ChunkRequest.lane`. Removes a dead branch in cache routing.

### `WireFormat` discriminated union

```ts
type WireFormat = { Raw: { data_type: string } } | { Lz4: { data_type: string } } | { Zstd: { data_type: string } };
```

**`data_type` is `string`** — should be a string union of supported types: `"uint8" | "uint16" | "bool"` (anything else either errors or falls through to default `"uint16"` in `normalize`).

**Suggested contract:** narrow `data_type` to the supported union, or document that unknown types are treated as `uint16`.

### `ProxyHeaderJs.dtype: "u16"`

A literal type. Today only one proxy dtype exists. ✅

## Implicit invariants worth surfacing

Run-by-run, things that are true today but unenforced:

1. **`pendingRequests` is sorted by priority before scheduler dequeues** — actually, no: looking at `submit()`, requests are pushed in plan order. The plan is *itself* sorted by priority during emit (`emit.ts` does priority assignment but not necessarily sorting). And `startChunkFetches` does `pendingRequests.shift()` — not by priority. Wait, let me check planning…

Actually, looking back: the inline doc on `getPendingSnapshot` says "(sorted by priority — the order they will be dequeued)". So priority sort happens *somewhere*. Verify in `plan.ts`. If the plan emits unsorted, the cache's `pendingRequests` is unsorted; `startChunkFetches` shifts FIFO; priorities are ignored. **High-impact bug if true.**

Quick check needed.

2. **`inFlightProxy` keys are unique across datasets** — assumption noted in `rejectDataset` comment. Verify by inspecting plate proxy ID composition.

3. **`failures` keys (`${entityId}/${chunkKey}`) are unique across datasets** — same kind of assumption. EntityIds embed dataset prefix? Check.

4. **`avgDecodedBytes` running average is initialized to 0**, so the first fetch books 0 estimated bytes. Means `inFlightBytes` is briefly inaccurate during cold start. Negligible.

5. **`pendingEnqueuedAt` is rebuilt on every submit**, preserving the original enqueue time only for entries that are still pending. If a request is taken in-flight and then the next submit re-emits it (post-cancellation?), it gets a fresh enqueue time. Today this can't happen because in-flight entries are skipped. ✅

6. **`subscribe` listeners are called inside `fetchAndDecode` and `fetchProxy`** — synchronous. If the listener triggers another submit cycle, the cache could re-enter recursively. Today the listener only flips a dirty flag (no re-entry). Document: listeners must not trigger synchronous submit.

## Severity ranking

| Contract issue | Severity | Why |
|---|---|---|
| Failure shape is "anything thrown" + string-matched classification | High | "No wire format" misclassified; cross-language brittleness |
| `submit` priority-sort assumption (verify) | **Critical if broken** | Would mean priorities are ignored end-to-end |
| Cancelled-during-decode chunk lands in cache + ready (verify) | High | Could pollute next dataset; needs test |
| `ReadyDelivery.kind?: "chunk"` optional discriminator | Medium | Future-variant footgun |
| `telemetry()` is a side-effecting getter | Medium | Surprising semantics; rename or split |
| `dataType` redundant in `FetchResult` and `decode` parameter | Low | Cleanup |
| `WireFormat.data_type: string` should narrow | Low | Cleanup |
| `ChunkRequest.lane: "proxy"` may be unused | Low | Cleanup |
| `imageWireFormats` never cleared | Medium-high | Long-session leak (already in Pass 4) |
| `markRejected` clear cadence implicit contract | Low | Documented in field comment |
| `subscribe` listener exception handling | Low | Today only one listener |

## Verifications to run before refactor

- Confirm `ChunkRequest.priority` sort: where does the cache see sorted vs unsorted?
- Confirm `lane: "proxy"` isn't produced by planning.
- Confirm the cancelled-during-decode race actually lands data in cache.
- Confirm `entityId`s embed dataset identity (or document the cross-dataset assumption).

These should be a single hour of grep/test work, not blocking the refactor planning, but worth resolving before sequencing.

## Next pass

Pass 6 (Composability Scan) looks for logic trapped inside large workflows that could be lifted out as small reusable pieces — and which sub-modules should expose what verbs in their public API to be composable.
