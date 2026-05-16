# Pass 7: Testability Scan — render phase

Goal: identify what's protected by tests today, what isn't, and what's needed before structural refactor.

## Existing test inventory

| Test file | LOC | Suites | What it locks down |
|---|---|---|---|
| `descriptorBuffer.test.ts` | 712 | 9 | Member-id construction conventions, canonical iteration order, deterministic entity-index map, pool-index assignment stability, byte layout of `EntityDescriptor`, display state per channel, colormap LUT assignment, well-as-proxy memberId conventions, end-to-end GPU buffer write via mock device |
| `wantedSet.test.ts` | 671 | 2 (top-level + proxy nested) | `computeWantedSet` chunk wanted-set, proxy wanted-set rules across all three modes, dedup across well-as-proxy entries, residency checks |
| `residency.test.ts` | 314 | 5 | `parseChunkKey`, `remapIndirection` (volume), `remapSliceIndirection`, shared-volume-pool remap, `applyViewHotState` |
| `proxyAtlas.test.ts` | 251 | 10 | All proxy atlas primitives + multi-pool independence (LRU, allocation, key derivation, slot origin) |
| `proxyShaderBinding.test.ts` | 134 | 2 | Slot-origin math agreement between proxyAtlas + shader, uniform layout sizes (post-step-9 unified fallback chain) |
| `epochCheck.test.ts` | 61 | 1 | `isStaleDelivery` predicate |
| `dataTypeUtil.test.ts` | 25 | 2 | `asUint16`, `asUint16Slice` coercion |

**Total: 2168 LOC, 31 suites, 133 individual cases.**

Worker-internal coverage is heavy on **pure helpers** and **byte-layout invariants**. This is the inverse of the upload pass's situation — there, the orchestrator was undertested. Here, the orchestrator (`gpu.worker.ts`) is the only major file with no direct tests.

## Coverage map by responsibility

| Responsibility | Test coverage | Risk if untouched |
|---|---|---|
| `parseChunkKey` / `parseCompositeKey` | ✅ residency.test | n/a |
| `remapIndirection` (volume) | ✅ residency.test | n/a |
| `remapSliceIndirection` | ✅ residency.test | n/a |
| `applyViewHotState` | ✅ residency.test | n/a |
| `computeWantedSet` (chunks) | ✅ wantedSet.test | n/a |
| `computeWantedSet` (proxies, all 3 modes) | ✅ wantedSet.test | n/a |
| Proxy atlas LRU + slot allocation | ✅ proxyAtlas.test | n/a |
| Proxy slot origin math ↔ shader | ✅ proxyShaderBinding.test | n/a |
| `EntityDescriptor` byte layout | ✅ descriptorBuffer.test | n/a |
| Member-id convention helpers | ✅ descriptorBuffer.test | n/a |
| Stale-delivery predicate | ✅ epochCheck.test | n/a |
| **Cold-state ingestion (gpu.worker.ts:506-753)** | ❌ none | **HIGH** |
| **Pool grouping (volume + slice branches)** | ❌ none | **HIGH** |
| **Per-entity LOD section computation** | ❌ none | MEDIUM (partially covered by residency.test which assumes pre-built metas) |
| **`handleProxyAssetData` end-to-end** | ❌ none | **HIGH** |
| **Well→fields fan-out** | ❌ none | MEDIUM |
| **Descriptor-buffer rebuild trigger** | ❌ none | MEDIUM |
| **`handleVolumeChunkData` / `handleSliceChunkData`** | ❌ none | **HIGH** (eviction policy, intensity sampling, multi-member demux, postWantedSet trigger) |
| **`findFarthestSlot` interaction with rayHit changes** | partial (residency.test covers applyViewHotState; not the eviction call site) | MEDIUM |
| **`handleVolumeRenderMultiPass` / `handleSliceRenderMultiPass`** | ❌ none | MEDIUM (requires GPU; tests are hard) |
| **`cameraUVPerEntity` write** (slice render → next eviction) | ❌ none | MEDIUM |
| **Slice mode Z-slice retargeting (`staleSliceKeys`, `computeTargetChunkZ`)** | ❌ none | MEDIUM |
| **Member→dataset / member→pool registration on cold-state** | ❌ none | **HIGH** (multi-channel + well-as-proxy interplay) |
| **`removeLayerResources` cleanup** | ❌ none | LOW (correctness checked manually) |
| `RenderClient` transfer-list behavior | ❌ none | LOW |
| Renderer pipeline classes (`SliceRenderer`, `VolumeRenderer`, etc.) | ❌ none | LOW (requires GPU; manual testing suffices) |
| `LayerCompositor` blend modes | ❌ none | LOW (requires GPU) |
| Minimap upload + render | ❌ none | LOW (peripheral, isolated) |

## Pre-refactor test work needed

Before splitting `gpu.worker.ts` or moving cold-state ingestion out, the following characterization + unit tests should land. Each is in the "no-GPU vitest" style that the existing suite uses (mock device, exported pure helpers).

### Suite A — Cold-state ingestion characterization (~250 LOC)

Goal: lock current pool-grouping, entity-metas, indirection-resize, descriptor-rebuild behavior so the refactor can't regress it.

Tests:

1. Single-channel volume cold state → expected pool groups, entityMetas per entry, indirection sizes.
2. Multi-channel volume cold state → expected pool groups with channel keys, member-id construction.
3. Mixed `fields-with-detail` + `well-as-proxy` cold state → expected pool registrations (note: `well-as-proxy` has no chunks, so it shouldn't register a chunk pool — verify the cold-state handler skips correctly).
4. Cold state with fields that share chunk dims → single pool.
5. Cold state with fields that have different chunk dims → multiple pools per dataset.
6. Slice cold state with mixed LODs and Z retargeting → expected entityMetas + entityZInfo.
7. Cold state churn (replace) → memberToDataset cleared/repopulated correctly; descriptor buffer destroyed + replaced.
8. Empty active-set cold state → no panics; previous state cleared.

These require either (a) extracting the cold-state body into a pure function first (chicken-and-egg) OR (b) running the dispatch via a mocked `WorkerCtx`. Option (a) is preferred and is *itself* the first slice.

### Suite B — `handleProxyAssetData` unit tests (~150 LOC)

Goal: lock pool resolve/create, slot allocation (+LRU eviction), descriptor update + fan-out, descriptor rebuild trigger.

Tests:

1. First proxy upload for an entity → pool created, slot 0 allocated, descriptor populated.
2. Same proxy upload again (same key) → no new allocation, slot returned, LRU touched.
3. Pool fills, new upload arrives → LRU evict + reuse slot + descriptor update.
4. `WellProxy3D` upload for a well with two child fields → both child descriptors get `wellProxyHandle` set.
5. `FieldProxy3D` upload → only the field descriptor gets `fieldProxyHandle`; no fan-out.
6. Stale upload (epochs.selection lower than current) → dropped, no slot allocated, `proxyStats.dropped` incremented.
7. Short-buffer upload (byteLength < expected) → dropped with warning.
8. Upload triggers descriptor buffer rebuild only when dataset matches current cold state.
9. Upload triggers `postWantedSet`.

Requires mocking `device.queue.writeTexture` (a no-op) and `device.createBuffer` (returns fake object). Mostly pure once those are stubbed.

### Suite C — Chunk-upload eviction + demux (~120 LOC)

Goal: lock `findFarthestSlot` interaction with `rayHitPerEntity` and multi-member eviction reporting.

Tests:

1. Upload chunks for member A, pool full → eviction picks farthest from rayHit, reports `chunksEvicted` for A.
2. Upload chunks for member B in a pool that contains member A's chunks → eviction can pick from A, but `chunksEvicted` is reported keyed by **A's memberId** not B's (verify multi-member demux in the handler).
3. Incoming chunk is itself farther than the farthest cached → rejected; reported as `skipped`.
4. Upload with stale epochs → entire batch reported as `skipped`.
5. Empty `chunks` array → no posts, no work.
6. Z-slice retargeting (slice only): upload arrives for Z=0 when current Z=1 → chunks with `z !== targetChunkZ` are skipped.

### Suite D — Member registry invariants (~80 LOC)

Goal: lock the well-as-proxy + multi-channel matrix of member-id construction.

Tests:

1. Single-channel, well-as-proxy entry → memberToDataset gets `entityId → dsId`.
2. Multi-channel, well-as-proxy entry → memberToDataset gets `entityId:chN → dsId` for each visible channel.
3. Single-channel field entry → memberToDataset gets `imageId → dsId`.
4. Multi-channel field entry → memberToDataset gets `imageId:chN → dsId` for each channel.
5. Mixed → all of the above coexist.
6. `removeLayerResources` for a dataset → memberToDataset entries for that dataset's members are cleared (currently they aren't — see related lifecycle gap).

This suite would surface the well-as-proxy `imageId === ""` issue (Contract Issue 7) and the lifecycle gap (entries are added but never explicitly removed).

### Suite E — Descriptor-rebuild trigger characterization (~60 LOC)

Goal: lock when the descriptor buffer is rebuilt vs not.

Tests:

1. Cold state arrives → rebuild for the message's dataset.
2. Proxy upload for current cold-state dataset → rebuild.
3. Proxy upload for a *different* dataset → no rebuild (verify the guard at gpu.worker.ts:347).
4. `removeLayerResources` → descriptor buffer destroyed + removed.
5. `destroy` → all descriptor buffers destroyed.

## Tests that already exist and should be extended (not rewritten)

- `descriptorBuffer.test.ts` already covers serialization; extend to cover the **transient descriptor** in `volumeRenderer.setTransientDescriptor` (Contract Issue 1 — second writer with hardcoded indices). A 3-test suite that compares transient-write bytes to canonical write bytes would catch drift.
- `wantedSet.test.ts` already covers `computeWantedSet` heavily; no new tests needed.
- `proxyShaderBinding.test.ts` already covers uniform sizes; could be extended to assert the WGSL struct ↔ TS layout agreement (Contract Issue 14) by parsing struct text from the .wgsl files.

## Tests deferred / not worth writing

- `RenderClient` transfer-list behavior — low risk, hard-to-mock `postMessage`.
- Pipeline construction (bind-group layouts, render-pipeline descriptors) — requires GPU; manually verified.
- Compositor blend math — requires GPU.
- Cursor renderer — peripheral, manually verified.
- Minimap upload + render — peripheral, manually verified.

## GPU-required vs non-GPU tests

| Category | Vitest-runnable today | Needs GPU |
|---|---|---|
| Pure helpers (parsing, math, key derivation) | ✅ all | – |
| Wanted-set computation | ✅ | – |
| Descriptor byte layout | ✅ (mocked device for createBuffer) | – |
| Proxy atlas LRU | ✅ (mocked device for createTexture) | – |
| Indirection remap | ✅ (writes into plain arrays) | – |
| Cold-state ingestion | ✅ (with extraction) | – |
| `handleProxyAssetData` body | ✅ (with mocked writeTexture/createBuffer) | – |
| Chunk upload body | ✅ (with mocked writeTexture/createBuffer) | – |
| Renderer pipeline classes | – | ✅ |
| Compositor blend math | – | ✅ |
| End-to-end render → canvas | – | ✅ |
| Slice/volume shader correctness | – | ✅ (or a WGSL test harness) |

The render code is **more testable than it looks**. The non-GPU portion includes essentially all dispatching and state management; only the actual draw + uniform-write step needs the device. With the proposed test investment (~660 LOC across suites A–E), the refactor would have characterization coverage comparable to what the upload pass produced.

## Pre-refactor test investment summary

- Suite A (cold-state) — ~250 LOC, requires extraction-first or mocked dispatch
- Suite B (handleProxyAssetData) — ~150 LOC
- Suite C (chunk upload eviction + demux) — ~120 LOC
- Suite D (member registry) — ~80 LOC
- Suite E (descriptor-rebuild trigger) — ~60 LOC

**Total: ~660 LOC across 5 suites.** Comparable to upload's ~525 LOC investment. Smaller because the algorithmic pieces are already tested.

The right-order is: **extract first → land characterization tests against the extracted seams → restructure freely.** The pure helpers' existing tests already protect the algorithmic invariants; the missing tests are about *orchestration* — which can only land after the orchestration is extractable.

This is a different cadence from upload: there the test investment was 100% pre-refactor; here, ~60% is post-extraction. Suite A is the chicken-and-egg slice that bootstraps the rest.
