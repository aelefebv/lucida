# Pass 5: Contract Scan — render phase

Goal: identify where data shapes, types, dimensions, or units are assumed without being made explicit, and where the same contract is restated in multiple places.

## High-impact contract issues

### Contract issue 1 — `EntityDescriptor` byte layout mirrored in 4 sites

The 736-byte struct is declared in:

1. **`descriptorBuffer.ts:38-78`** — TS doc comment with offset table (lines 38–74) AND named constants (`DESCRIPTOR_LODS_OFFSET = 224`, `DESCRIPTOR_ENTRY_SIZE = 224 + 8 × 64`).
2. **`descriptorBuffer.ts:310-400`** — `serializeEntityDescriptor` writes via **hardcoded u32 indices**: `u32[32] = channelMask`, `u32[33] = fieldPoolIdx`, `u32[37,38,39] = 0` (proxy pad), `u32[40,41,42,43] = fieldDims+pad`, `f32[48] = contrastMin`, etc. The named constants are declared but the body uses magic numbers.
3. **`volumeRenderer.ts:260-309`** — `setTransientDescriptor` writes the same descriptor with its own hardcoded u32 indices (`u32[33] = SENTINEL`, `u32[40] = 1`, `u32[44] = 1`, `f32[48] = contrastMin`, etc.). Independent code path, same layout, hand-maintained.
4. **`volume.wgsl:36-60` AND `slice.wgsl:28-52`** — WGSL `struct EntityDescriptor` declarations. Two files; **identical text in both shaders** must stay in sync with the TS layout.

**Test coverage:** `descriptorBuffer.test.ts` locks the TS byte layout. `proxyShaderBinding.test.ts` locks the uniform sizes. **Nothing locks WGSL struct ↔ TS layout agreement.**

**Risk:** the *transient* descriptor (minimap path, volumeRenderer.ts:260) was the most likely source of drift; today it's correct only because someone hand-mirrored the offsets when descriptors changed.

**Suggested fix:**
- Replace hardcoded indices in both serializers with named offsets from a `renderer/descriptor/layout.ts`.
- Add a test that parses both `.wgsl` files' struct declarations and asserts the offsets match a TS-side schema.

### Contract issue 2 — Axis order inconsistency inside one descriptor

For LOD info, TS uses `[Z, Y, X]` but the WGSL `LodInfo` stores `vec3<u32>` with `.x=X, .y=Y, .z=Z`. The serializer (descriptorBuffer.ts:391–393) does the swap:

```ts
u32[slotBase + 4] = gX; u32[slotBase + 5] = gY; u32[slotBase + 6] = gZ;
```

For proxy dims (`fieldProxyDims`, `wellProxyDims`), TS uses `[Z, Y, X]` AND the WGSL writes `dims.x = Z, dims.y = Y, dims.z = X` (descriptorBuffer.ts:361–362; sampling shader uses `slotZ = dims.x`).

So in the **same descriptor**, two adjacent `vec3<u32>` fields use **opposite** axis conventions. Documented inline in slice.wgsl:88-98 and volume.wgsl:112-117, but easy to miss.

**Risk:** future struct changes adding a new `vec3<u32>` will default to the wrong convention.

**Suggested fix:** unify on one convention (probably WGSL's `[X, Y, Z]`) at the TS boundary so the descriptor serializer doesn't carry conventions through. Or wrap every `vec3<u32>` field with a constructor (`packZYX(z,y,x)` vs `packXYZ(x,y,z)`) so the convention is named at the call site.

### Contract issue 3 — `chunksEvicted.datasetId` field is named wrong

Wire-protocol misnomer documented in workerProtocol.ts via doc comments and **acknowledged inline**: `// protocol still names it datasetId; orchestrator sends memberId here` (gpu.worker.ts:449).

The field carries a **memberId** at every site:
- `volumeHandlers.ts:457` posts `{ datasetId: evMember, keys: evKeys }`.
- `volumeHandlers.ts:461` posts `{ datasetId: memberId, keys: [], skipped }`.
- `sliceHandlers.ts:398` same pattern.
- `pipeline/upload/delivery/feedback.ts` reads the field as a member id.

Same for `volumeChunkData.datasetId` and `sliceChunkData.datasetId` (gpu.worker.ts:428, 449).

**Risk:** future maintainer reads "datasetId" and writes code assuming dataset-level state when actually keyed per member. Type system doesn't help.

**Suggested fix:** pure rename to `memberId` across `workerProtocol.ts`, `RenderClient.onChunksEvicted`, `UploadClient`, and `pipeline/upload/delivery/feedback.ts`. No behavior change.

### Contract issue 4 — Two pool-key encoding schemes

Chunk pool keys (built inline in gpu.worker.ts cold-state):
- Single-channel: `${datasetId}:${chunkX}x${chunkY}x${chunkZ}` (volume) or `${datasetId}:${chunkX}x${chunkY}` (slice).
- Multi-channel: `${datasetId}:ch${channel}:${chunkX}x${chunkY}x${chunkZ}`.

Proxy pool keys (proxyAtlas.ts:73-81):
- `${datasetId}|proxy|${kind}|${x}x${y}x${z}|ch${channel}`.

Different separators (`:` vs `|`), different orderings, no shared helper.

**Risk:** new key types added with a third convention. Pool registry leaks if a key is mis-built.

**Suggested fix:** `renderer/poolKeys.ts` with `chunkPoolKey(...)` + re-export `proxyPoolKey`. Use the same separator family.

### Contract issue 5 — Member-id construction restated in 4+ places

The convention is:
- Single-channel field: `entry.imageId`
- Multi-channel field: `${entry.imageId}:ch${channel}`
- well-as-proxy single: `entry.entityId` (because `imageId === ""`)
- well-as-proxy multi: `${entry.entityId}:ch${channel}`

**Canonical helper:** `memberIdForColdEntry(entry, channel, multiChannel)` exists in `descriptorBuffer.ts:118-125`.

**Sites that bypass it:**

1. `gpu.worker.ts:533-551` — inline conditional construction (member-to-dataset registration).
2. `gpu.worker.ts:583, 668` — `const memberId = isMultiCh ? \`${entry.imageId}:ch${channel}\` : entry.imageId;` (member-to-pool registration). Doesn't handle the well-as-proxy `imageId === ""` case the same way as the canonical helper.
3. `wantedSet.ts:191-197` — same inline shape.
4. `pipeline/upload/coldState/build.ts` — probably (not re-read here).

**Risk:** when `well-as-proxy` mode was introduced, the cold-state handler's `imageId === ""` branch was added separately to **memberToDataset** (lines 539, 547) but not the **memberToPool** loop (lines 583, 668). The pool loop's `memberId = isMultiCh ? \`${entry.imageId}:ch${channel}\` : entry.imageId` would produce `:ch5` (empty imageId + suffix) for well-as-proxy in multi-channel mode — and is silently rescued only because `targetLevel` lookup happens first and `well-as-proxy` entries have no `levels[]`. This is fragile.

**Suggested fix:** force every site through `memberIdForColdEntry`. Delete inline reconstructions.

### Contract issue 6 — `Chunk.dataType` is a string union without an enum

`Chunk.dataType: string` (workerProtocol.ts:38). Handlers branch on:

- `"uint8"`, `"Uint8"` (sliceHandlers.ts:325) — accepts both case forms.
- `"uint16"` (renderClient.ts:269, minimapHandlers.ts).
- (implicit `"uint16"` default in volumeHandlers via `asUint16`).

`asUint16` (dataTypeUtil.ts) accepts strings.

**Risk:** typo at the wire boundary is a runtime branch; no type narrowing.

**Suggested fix:** narrow the field to `"uint16" | "uint8"` and normalize at the boundary.

### Contract issue 7 — `ColdStateActiveEntry.imageId === ""` is a sentinel for `well-as-proxy`

`workerProtocol.ts:233-236` declares `imageId: string` for `ColdStateActiveEntry`. The convention is that `well-as-proxy` entries have `imageId === ""`. This is documented at descriptorBuffer.ts:118-125 but not at the type declaration. Multiple call sites must remember to special-case empty strings.

**Risk:** future code that assumes `imageId` is non-empty (e.g., a regex match) breaks silently.

**Suggested fix:** model the variant explicitly:

```ts
type ColdStateActiveEntry =
  | { kind: "field"; imageId: string; entityId: string; parentWellId: string | null; ... }
  | { kind: "well-as-proxy"; entityId: string; imageId?: never; parentWellId: null; ... }
```

Discriminated union surfaces the well-as-proxy case in the type system.

### Contract issue 8 — `LodIndirectionMeta` and `AtlasLodMeta` are near-duplicates

- `LodIndirectionMeta` (volumeHandlers.ts:15-21): `level, gridDims: [Z,Y,X], chunkDims: [Z,Y,X], levelDims: [Z,Y,X], offset`.
- `AtlasLodMeta` (wantedSet.ts:21-26): `level, gridDims, chunkDims, offset` (no levelDims).

`wantedSet.ts` is the pure module that wanted to avoid GPU coupling; it re-declared the type minus the field it doesn't need.

**Risk:** when `levelDims` changes shape, both need updating.

**Suggested fix:** keep them separate but make the relationship explicit — `AtlasLodMeta = Omit<LodIndirectionMeta, 'levelDims'>` or similar. Or move the shared type to `renderer/types.ts`.

### Contract issue 9 — `displayStateByChannel` is `Record<number, ...>` with no completeness guarantee

`ColdStateActiveEntry.displayStateByChannel: Record<number, ColdStateDisplayState>`. The doc says "the worker indexes this map by `cold.visibleChannels[ch]` for each yielded combination" and "single-channel mode populates the lone active channel; multi-channel composite populates each visible channel."

If the orchestrator forgets to populate a channel, `descriptorBuffer.displayStateForChannel` falls back to default values (contrastMin: 0, contrastMax: 65535, gamma: 1, opacity: 1, colormap: "gray"). The fallback is silent.

**Risk:** display-state regression renders with default values, looks slightly wrong but doesn't crash.

**Suggested fix:** narrow to `Map<number, ColdStateDisplayState>` + assert completeness in dev. Or make the descriptor build throw in dev mode when a channel is missing.

### Contract issue 10 — `WantedSetDeltaMessage.missing` discriminated union doesn't carry pool key

`MissingProxy` (workerProtocol.ts:405-412) carries `(entityId, proxyKind, t, c)` — enough to identify the proxy but not the pool. The orchestrator's `DeliveryTracker` does the pool lookup via `proxyKeys.ts:proxyAssetKey`.

The `datasetId` was added to `MissingProxy` (annotated comment at line 402) so the orchestrator can clear its proxy-delivered entry by composite key without scanning. Good.

**Slight gap:** `MissingChunk` doesn't carry datasetId (just `entityId, chunkKey`). The handlers' `chunksEvicted` does carry the misnamed `datasetId: memberId`. Asymmetric.

**Suggested fix:** add `datasetId` to `MissingChunk` symmetrically, or remove from `MissingProxy` if the orchestrator can derive it. Pick one shape.

### Contract issue 11 — `Chunk[]` array on volume/slice messages always carries a single chunk

In practice — every call site (`pipeline/upload/delivery/dispatch.ts`) sends `chunks: [singleChunk]`. The array shape exists because there were historical `Chunk[]` callers (per the `Chunk` interface doc at workerProtocol.ts:30 — "The `chunks: Chunk[]` array shape on the envelope messages is unchanged — that's a wire-protocol contract change tracked separately"). Today no caller batches.

**Risk:** mild — the array enables future batching but currently adds a tiny iteration overhead.

**Suggested fix:** track in issue #620 (already referenced). Decide whether to flatten or keep open for batching.

### Contract issue 12 — `intensityRange` posts a per-pool, per-batch min/max, but `datasetId` carries memberId

`volumeHandlers.handleVolumeChunkData:467` posts `{ type: "intensityRange", datasetId: memberId, min, max }` whenever the pool's running `intensityMin/Max` changed. The downstream consumer (`useIntensityBatcher`) coalesces by `datasetId` (which is actually memberId).

Two cohabitating issues: (a) name misnomer (Contract issue 3), (b) the running min/max is per-pool but reported per-member — if two members share a pool, an intensity update from one member could carry the *other* member's prior contribution.

**Risk:** intensity ranges drift across members of the same pool. Probably benign because they're usually similar, but it's incorrect.

**Suggested fix:** track intensity per-member rather than per-pool. Side-channel concern; not blocking.

### Contract issue 13 — `volumeChunkData.epochs` and `sliceChunkData.epochs` always passed; `proxyAssetData.epochs` always passed; render messages don't carry epochs

Renders are stale-tolerant — the worker draws with whatever it has. Chunk/proxy deliveries are stale-checked against `currentEpochs`. The asymmetry is intentional but unstated in the protocol.

**Suggested fix:** doc-comment on the render messages explaining the stale-tolerance, and on chunk/proxy messages explaining the stale-rejection.

### Contract issue 14 — `slice.wgsl` and `volume.wgsl` declare `EntityDescriptor` separately

Identical struct text duplicated. Any drift between them is a silent shader compilation success that produces wrong reads.

**Risk:** moderate. The test `descriptorBuffer.test.ts` checks byte offsets in TS but doesn't compile WGSL.

**Suggested fix:** generate the WGSL struct from a single source-of-truth schema, or share via a `.wgsl` include if the build pipeline supports it (Vite raw imports do not).

### Contract issue 15 — `renderClient.proxyAssetData(...)` always slices the buffer with `.slice(0)`

`renderClient.ts:175`: `const buf = data.slice(0);` then transfers `buf`. This copies the buffer before transferring it — losing the zero-copy guarantee the comment claims ("Take ownership of the buffer for transfer").

Same pattern for `volumeChunkData` (line 91) and `sliceChunkData` (line 128) — each chunk's `data.slice(0)`.

**Risk:** every chunk + proxy delivery does a heap copy on the main thread before posting. For a 256³ u16 chunk that's 32 MB of copy per delivery — a hot path.

**Investigation needed:** check whether the caller's source buffer is reused (in which case the copy is necessary) or already a fresh allocation (in which case the copy is wasteful). If the source is reused, the copy is correct and the comment should be updated; if not, removing `.slice(0)` saves a copy. Verify via grep of `volumeChunkData` callers.

**Suggested fix:** investigate. Either remove the copies or document why they're needed.

## Things that are well-typed

- `MainToWorkerMessage` / `WorkerToMainMessage` as discriminated unions on `type` — correct shape.
- `MissingChunk | MissingProxy` as a discriminated union on `kind` — correct.
- `ProxyKind = "WellProxy3D" | "FieldProxy3D"` — exhaustive.
- `ColdStateMessage.viewMode = "slice" | "volume"` — exhaustive.
- `BlendMode = "alpha" | "additive" | "max"` — exhaustive.
- `ColdStateActiveEntry.mode` discriminator — almost exhaustive (gap: imageId-empty sentinel, see Issue 7).
- `LodIndirectionMeta` carries axis-tagged comments.

## Summary

The biggest contract risks are **structural duplication**:

1. `EntityDescriptor` byte layout mirrored in 4 sites with two writers using magic indices (Issue 1).
2. Member-id and pool-key construction restated inline at 4–6 sites (Issues 4, 5).
3. The WGSL struct duplicated across two shader files with no cross-validation (Issue 14).

The biggest contract-clarity wins are:

- **Rename `datasetId` → `memberId`** on chunksEvicted / volumeChunkData / sliceChunkData (Issue 3). Pure rename, no behavior change.
- **Model `well-as-proxy` as a real variant** rather than `imageId === ""` sentinel (Issue 7).
- **Make every site call `memberIdForColdEntry`** instead of re-deriving (Issue 5).

These three changes together would eliminate a class of "did I update the well-as-proxy branch too?" bugs.
