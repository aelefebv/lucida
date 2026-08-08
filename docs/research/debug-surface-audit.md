# Debug surface audit

Research output for [#889](https://github.com/aelefebv/lucida/issues/889), under map
[#885](https://github.com/aelefebv/lucida/issues/885) (Pipeline performance monitor).

**Nothing here is a proposal.** This is an inventory of what exists today, so the later
"fate of the debug menu" decision has a factual starting point. Every dead-ness claim was
verified by grepping for readers and writers, not inferred from naming.

Audited at commit `812658b` (branch `research/debug-surface-audit`, off `main`).

## Headline counts

| Question | Answer |
| --- | --- |
| Tabs in `DebugPanel.tsx` | 10 |
| Tabs that only **observe** | 5 — Render, Scene, Pick, Orch, Catalog |
| Tabs that only **mutate** (control surfaces) | 2 — Config, Logging |
| Tabs that do **both** (the split will hurt here) | 2 — Cache, Health |
| Tabs that observe + fire a side-effecting export | 1 — Planning (console dumps; no state change) |
| `debugStats.ts` fields dead or structurally inert | **31** |
| `localStorage.debug` categories registered | 5 — all 5 wired to live call sites |
| `debug.overlays` overlay toggles registered | 6 — all 6 wired |
| CLI diagnostic commands | 3 — `lucida debug state`, `lucida plan visible-chunks`, `lucida dataset health` |

---

## 1. `lucida-web/src/debug/DebugPanel.tsx` (1954 lines)

### Mounting and lifecycle

- Code-split (`lazy()`) from `App.tsx:74`. Mounted only when `showDebug` is true
  (`App.tsx:1516`), toggled by a "Debug" toolbar button (`App.tsx:1171`,
  `handleDebugToggle` at `:1058`). There is **no `D` keyboard shortcut** — the Orch tab's
  empty-state copy "Enable debug (D key)" (`DebugPanel.tsx:1615`) is stale.
- The toggle also flips the global gate `debugStats.enabled` (`App.tsx:1060`), which is
  what makes the pipeline populate the stats sink at all. Opening the panel therefore
  **changes what the pipeline computes** — instrumentation is off until the panel opens.
- One `setInterval` at `POLL_INTERVAL_MS = 200` polls everything (`:558`–`:636`); the Health
  tab adds a second 5s interval while active (`:638`).
- The panel is present in **production** builds. Two editable areas are dev-gated:
  `CACHE_CONFIG_EDITABLE = import.meta.env.DEV` (`:38`) and `ConfigTab`'s
  `editable = import.meta.env.DEV`.

### Tab by tab

| Tab | Displays / controls | Reads from | Observe / mutate |
| --- | --- | --- | --- |
| **Render** | Mode; FPS + ms-since-last-render; frame/plan/upload ms with sticky maxima; 2 dirty-flag lamps (interactive, residency) with 500 ms afterglow; throttle-skips-pending; render-pass total + per-dataset; LOD level + `eff_zoom`; upload budget used/total + EXHAUSTED; visible/total members, active channels, plan-cache h/m; per-member table (top 12 by needed−sent gap) | `debugStats` (polled copy) + `RenderLoop.getDebugSnapshot()` | **Observe only** |
| **Scene** | Scene epochs (content/layout/view/selection); view-query table of first 12 entities (visible flag, ideal LOD, projected diagonal px, importance) with `+N more` | `WasmScene.epochs()`, `WasmScene.view_query(datasetId)` — parsed JSON, polled every 200 ms | **Observe only** |
| **Pick** | Last ray-pick hit: entity id, world position, distance | `WasmScene.ray_pick(datasetId, x, y)`, driven by `lastClickScreen` prop from the canvas click handler | **Observe only** (query, no state written) |
| **Planning** | Per dataset: lane counts (minimap/detail/coarse/prefetch/overview), proxy + total chunk counts, catalog-degradation warning, groups-by-mode tallies, per-LOD planned/cached/in-flight, frustum-culling funnel with retained %, focal-entity inspector (mode + reason, projected diagonal/area, importance, target LOD, owned range, chunk count, top priority). Two buttons: **Dump plans → console**, **Dump active sets → console** | `debugStats.planning.byDataset`; buttons call `renderLoop.getTickCoordinator().getLastPlans()` | **Observe + export.** The buttons are side-effecting (`console.group`/`console.table`) but change no state. |
| **Cache** | Main/overview budget bars; tier residency + evictions by tier; in-flight reqs/bytes; queue depth + oldest age; deliverable count + backlog warning; detail/coarse coverage vs desired + sparse warning; generated-coarse status counts per dataset; hit rate; interaction mode; eviction tier order; evictions/s; transient/permanent failures + last error; decode rate, worker count, p50/p95/avg. Plus **4 editable number inputs**: main budget MB, overview budget MB, max fetches, max in-flight MB. Plus **Dump cache → console**, **Dump pending → console** | `session.cpuCache.telemetry()`, `session.generatedAvailability.statusCountsByDataset()`; dumps use `getCacheDump()` / `getProxyCacheDump()` / `getPendingDump()` | **BOTH.** Inputs call `cpuCache.updateConfig({...})` — live fetch-pipeline steering, dev-build only. |
| **Health** | Per dataset: overall status + counts summary (healthy/degraded/unavailable), backend, source URL, binding status + message, source-cache bytes/percent/entries/hits/misses/evictions/backend-errors, generated-coarse status + level count + ready/pending/failed/unavailable chunk counts + cache storage/root/evictions + recent failures, free-text messages. Refresh button + `updated HH:MM:SS`. Plus a **Retry binding** button per dataset | `session.bridge.requestDatasetHealth(null)` — a WebSocket round-trip to the server (`DatasetHealth` client message) | **BOTH.** `bridge.sendDatasetRetry(id)` re-binds the dataset **server-side**, then re-polls after 750 ms. This is the only tab whose mutation crosses the process boundary. |
| **Orch** | MIXED LEVELS warning banner; Cold State (pulse glyph, epoch hit/miss, cumulative rebuilds/hits + %, last-1s rebuilds/hits + windowed hit rate, per-epoch cause attribution for the 1s window, last rebuild ms + p50/p95); Upload per-tick (considered c/p, uploaded c/p, skip reasons, bytes vs budget bar, resend row); Proxy Residency (desired proxies, admitted bytes vs budget, bundles admitted/candidate/skipped, missing footprints); Upload rolling 1s (bytes/s, uploads/s, chunk+proxy rates, resend/filter ratios, size p50/p95, exhausted ticks, cumulative totals); Visible Region (xy bounds, z range, zoom); Entity Coords overlap check (position, level-0 shape, cached-key count, OK/NONE verdict computed in the panel); Active Set (mode tallies + first 10 rows); Requests by lane and by level; Members adapter-output rows; Top Requests | `debugStats.orch` and `debugStats.upload` | **Observe only** |
| **Catalog** | Asset epoch; proxy cache bytes vs budget; in-flight + pending proxy counts; per dataset: `GroupProxy3D` count, `TileProxy3D` count, total entries, 5 sample entries with their kinds | `WasmScene.get_asset_catalog(dsId)` (parsed JSON) + `WasmScene.asset_epoch()` + `cpuCache.telemetry()` proxy fields | **Observe only** |
| **Config** | `<ConfigTab />` — see §4 | `configStore` | **Mutate-primary** (reads live config to display it; in prod builds it degrades to read-only except "Reset all") |
| **Logging** | Checkbox per `DEBUG_CATEGORIES` entry (5) with a one-line description; checkbox per `DEBUG_OVERLAYS` entry (6) with a description | `isDebugEnabled` / `isOverlayEnabled` (in-memory caches over `localStorage`) | **Mutate only.** Writes `localStorage.debug` / `localStorage["debug.overlays"]`, which propagates into WASM's copy of the category set. Observes nothing but its own toggles. |

### Observe+mutate hybrids, called out

- **Cache** — a full fetch-pipeline gauge board with four live budget/concurrency knobs
  wired straight into `CpuCache.updateConfig`. Splitting it means the budget numbers you
  are *reading* and the budget inputs you are *turning* end up in different tools.
- **Health** — every row is server-authored read-only state, but "Retry binding" issues a
  real server command. Also note this tab's payload is the *same* `DatasetSourceHealth`
  shape the CLI's `dataset health` returns; the two surfaces already agree.

Two further ambient couplings worth recording, because they are not tab-local:

- Opening the panel sets `debugStats.enabled = true`, which turns instrumentation **on**
  across the pipeline. The panel is not a passive reader of an always-on stream.
- The Planning and Cache "dump → console" buttons are the only way to get the full
  (uncapped) plan, active-set, cache-content, and pending-queue listings; the tables in
  the panel are row-capped at 10–12.

---

## 2. `lucida-web/src/debug/debugStats.ts` (484 lines)

The module is a single mutable global (`export const debugStats`) plus type declarations and
two helpers (`resetFrameStats`, `emptyColdStateDebug`, `emptyUploadTickStats`). Writers are
scattered (`renderLoop.ts`, `slicePath.ts`, `volumePath.ts`, `tickCoordinator.ts`,
`upload/uploader.ts`, `upload/telemetry/upload.ts`); the only production reader is
`DebugPanel.tsx`, which shallow-copies it every 200 ms.

Row-capping rule: `DEBUG_MEMBER_ROW_CAP = 100` bounds every per-member array
(`memberStats`, `orch.members`, `orch.activeSet`), with an uncapped scalar total beside each.

Legend: **R/W** written and displayed · **W-only** written but nothing reads it ·
**inert** the write site is a hardcoded constant, so the displayed value can never vary ·
**never written** only appears in the initializer.

### `MemberStat`

| Field | Writer | Reader | Status |
| --- | --- | --- | --- |
| `id` | `tickCoordinator.ts:1152` | Render tab | R/W |
| `level` | ” | Render tab | R/W |
| `numLevels` | ” | Render tab | R/W |
| `chunksNeeded` | ” | Render tab (gap sort) | R/W |
| `chunksSent` | ” | Render tab | R/W |

### `OrchMemberDebug` — the whole "Members (adapter output)" row is inert

| Field | Writer | Reader | Status |
| --- | --- | --- | --- |
| `imageId` | `tickCoordinator.ts:1223` | Orch tab | R/W |
| `position` | `tickCoordinator.ts:1224` | none | **W-only** |
| `neededCount` | hardcoded `0` (`:1225`) | Orch tab (`n:0`) | **inert** |
| `prefetchCount` | hardcoded `0` (`:1226`) | Orch tab (`p:0`) | **inert** |
| `uploadLevel` | hardcoded `undefined` (`:1227`) | Orch tab (`uploadL?`) | **inert** |
| `chunksByLevel` | hardcoded `{}` (`:1228`) | Orch tab (empty string) | **inert** |
| `mixedLevels` | hardcoded `false` (`:1229`) | Orch tab (row highlight + `MIX`) | **inert** |

The Orch tab's member rows can therefore only ever read `<id> uploadL? n:0 p:0`.

### `PlanningDatasetDebug`

Built by `pipeline/planning/debug.ts::buildPlanningDatasetDebug`, stored at
`tickCoordinator.ts:914`, deleted per dataset at `:1995`.

| Field | Reader | Status |
| --- | --- | --- |
| `datasetId` | Planning tab (key + name lookup) | R/W |
| `lanes` (`minimap`/`detail`/`coarse`/`proxy`/`prefetch`/`overview`) | Planning tab — note `proxy` is *not* rendered; the tab shows M/D/C/P/O where P is `prefetch` | R/W (`lanes.proxy` **W-only**) |
| `proxyCount` | Planning tab | R/W |
| `totalChunks` | Planning tab | R/W |
| `chunksByLevel` | none — used internally to derive `lodBreakdown`, then stored and never read | **W-only** |
| `lodBreakdown[]` (`level`/`planned`/`cached`/`inFlight`) | Planning tab | R/W |
| `culling` (`considered`/`afterXyBounds`/`afterZRange`/`afterFrustum`) | Planning tab | R/W |
| `catalogDegradations` | Planning tab (warning) | R/W |
| `groupsByMode` (3 counts) | Planning tab | R/W |
| `focalEntity` (12 subfields) | Planning tab — all 12 rendered | R/W |

### `OrchDebug`

| Field | Reader | Status |
| --- | --- | --- |
| `activeSet[].entityId` / `.mode` / `.targetLod` / `.detailOwnedLodRange` | Orch tab | R/W |
| `activeSet[].coarsestDetailLod` | none | **W-only** |
| `activeSetTotal` | Orch tab (`+N more`) | R/W |
| `activeSetModeCounts.groupAsProxy` / `.tilesProxyFallback` / `.tilesDetail` | Orch tab header | R/W |
| `activeSetModeCounts.invisible` | none | **W-only** |
| `laneCount` (4) | Orch tab | R/W |
| `chunksByLevel` | Orch tab | R/W |
| `topRequests[].lane` / `.level` / `.chunkKey` / `.priority` | Orch tab | R/W |
| `topRequests[].entityId` / `.t` / `.c` / `.z` / `.y` / `.x` | none | **W-only** (6 fields) |
| `members[]` | Orch tab | R/W (contents inert — see above) |
| `membersTotal` | Orch tab | R/W |
| `hasMixedLevels` | Orch tab (MIXED LEVELS banner) | **inert** — hardcoded `false` at `:1196`; the banner is unreachable |
| `epochCacheHit` | Orch tab (HIT/MISS) | R/W (`false` on rebuild, set `true` at `:1408`) |
| `proxyResidency` | Orch tab | R/W |
| `coldState` | Orch tab | R/W |
| `visibleRegion` | Orch tab | R/W |
| `entityDiag[]` (`entityId`/`position`/`fullShape`/`cachedKeys`) | Orch tab (overlap verdict computed in the panel) | R/W |

### `ProxyResidencyDebug`

| Field | Reader | Status |
| --- | --- | --- |
| `budgetBytes`, `admittedBytes`, `desiredProxyCount`, `candidateBundleCount`, `admittedBundleCount`, `skippedBundleCount`, `skippedProxyCount`, `missingFootprintCount` | Orch tab | R/W (8) |
| `topDecisions[]` (`datasetId`/`groupId`/`representation`/`proxyCount`/`bytes`/`reason`) | none | **W-only** — built at `tickCoordinator.ts:1200` (20 entries per tick) and never displayed |

### `ColdStateDebug` (+ `ColdStateCauseCounts`)

Published by `upload/telemetry/coldState.ts::publish()`.

| Field | Reader | Status |
| --- | --- | --- |
| `rebuilds`, `cacheHits`, `hitRate`, `rebuildsLastSecond`, `hitsLastSecond` | Orch tab | R/W |
| `causeLastSecond` (5 counters) | Orch tab | R/W |
| `causeTotal` (5 counters) | none | **W-only** |
| `lastRebuildMs`, `rebuildP50Ms`, `rebuildP95Ms` | Orch tab | R/W |
| `lastRebuildAt` | Orch tab (pulse afterglow) | R/W |

### `DebugStats` (top level)

| Field | Writer | Reader | Status |
| --- | --- | --- | --- |
| `enabled` | `App.tsx:1060` | ~20 gate sites across the pipeline | R/W (the master gate) |
| `frameTimeMs` | `renderLoop.ts:590` | Render tab | R/W |
| `planTimeMs` | `slicePath.ts:459`, `volumePath.ts:266` | Render tab | R/W |
| `uploadTimeMs` | `slicePath.ts:475`, `volumePath.ts:300` | Render tab | R/W |
| `effectiveZoom` | `volumePath.ts:278` **only** | Render tab (`eff_zoom`) | R/W in 3D; permanently `0` in 2D/slice mode |
| `zoomPerVoxel` | `volumePath.ts:279` | none | **W-only** |
| `selectedLevel` | `tickCoordinator.ts:1162` | Render tab | R/W |
| `numLevels` | `tickCoordinator.ts:1163` | Render tab | R/W |
| `uploadBytesUsed` | `uploader.ts:349` | Render tab | R/W |
| `uploadBudgetTotal` | `uploader.ts:350` | Render tab | R/W |
| `budgetExhausted` | `uploader.ts:351` | Render tab | R/W |
| `renderPasses.total` / `.byDataset` | `slicePath.ts:423`, `volumePath.ts:234` | Render tab | R/W |
| `visibleMembers` / `totalMembers` | `tickCoordinator.ts:1123-1124` | Render tab | R/W |
| `activeChannels` | `volumePath.ts:281` **only** | Render tab | R/W in 3D; stuck at the `1` initializer in 2D |
| `planCacheHits` | **never incremented** — only zeroed in `resetFrameStats` | Render tab (`Cache: 0h / 0m`) | **never written** |
| `planCacheMisses` | same | same | **never written** |
| `memberStats[]` / `memberStatsActiveTotal` | `tickCoordinator.ts:1139-1151` (+ replay at `:1432`) | Render tab | R/W |
| `mode` | `renderLoop.ts:524` | Render tab | R/W |
| `orch` | `tickCoordinator.ts:1335` | Orch tab | R/W |
| `planning.byDataset` | `tickCoordinator.ts:914` | Planning tab | R/W |
| `upload.tick` / `upload.rolling` | `upload/telemetry/upload.ts:210` | Orch tab | R/W |

### `UploadTickStats` — the whole resend block is dead

Written by `upload/telemetry/upload.ts`; the skip counters are accumulated in the delivery pass.

| Field | Reader | Status |
| --- | --- | --- |
| `drainedChunks`, `drainedProxies`, `uploadedChunks`, `uploadedProxies`, `bytesUploaded`, `bytesBudget`, `budgetExhausted` | Orch tab | R/W (7) |
| `skippedPrefetch`, `skippedOverview`, `skippedWrongLod`, `skippedAlreadySent`, `skippedNoMeta` | Orch tab (skip-reason line) + rolling `filterRatio` | R/W (5) |
| `resendChunkUploads`, `resendProxyUploads`, `resendChunksConsidered`, `resendProxiesConsidered` | Orch tab renders them, but nothing ever writes a non-zero value — the only assignment is `emptyUploadTickStats()` | **never written** (4) |
| `resendChunksAlreadySent`, `resendChunksNotCached`, `resendChunksRejected`, `resendProxiesAlreadyDelivered`, `resendProxiesNotCached` | none; also never written | **never written + W-only** (5) |

The comment at `debugStats.ts:375` ("Legacy resend counters retained for telemetry shape
compatibility") is accurate: deliverability collapsed to a single `cpuCache.getDeliverable()`
pass and nothing re-sends. The Orch tab's resend row is gated on
`resendUploads > 0 || resendChunksConsidered > 0 || resendProxiesConsidered > 0`, so it can
never render.

### `UploadRollingStats`

| Field | Reader | Status |
| --- | --- | --- |
| `bytesPerSec`, `uploadsPerSec`, `chunkUploadsPerSec`, `proxyUploadsPerSec`, `filterRatio`, `uploadSizeP50`, `uploadSizeP95`, `totalBytes`, `totalUploads`, `budgetExhaustedTicksLastSecond` | Orch tab | R/W (10) |
| `resendRatio` | Orch tab + the `upload.resend_storm` anomaly detector | **inert** — computed from `isResend`, and the single `recordEvent` call site (`uploader.ts:290`) passes `false` unconditionally, so it is always `0` or `NaN`. The `upload.resend_storm` log can never fire. |

### Adjacent: `RenderLoop.getDebugSnapshot()` (not in `debugStats.ts`)

13 fields, consumed only by the Render tab. Two are computed and returned but never
displayed anywhere: **`sampleWindowMs`** and **`msSinceLastThrottleEmit`**.

---

## 3. `lucida-web/src/debug/DebugOverlays.tsx` (1267 lines)

An absolutely-positioned, `pointer-events: none` layer over the canvas. Code-split; mounted
when `showDebug || anyOverlayEnabled` (`App.tsx:1413`), but renders `null` unless at least one
overlay toggle (or the transient radius preview) is on. Its own `setInterval` at
`POLL_MS = 100` — a second, faster poll loop independent of the panel's 200 ms.

**Observe only.** It writes no pipeline state; every input is a read of scene / plan / cache
state. The one thing it "mutates" is its own React state.

| Overlay (toggle) | Draws | Reads from |
| --- | --- | --- |
| `groupModes` | One badge per group at the projected centroid of its tiles: mode label (WP/FP/FD) recolored by actual coverage, plus detail/coarse available-vs-wanted counts and the target LOD | `tickCoordinator.getLastPlans()` active set, `ws.member_positions(dsId)`, manifest entities/images, `cpuCache.snapshot()`, `renderLoop.workerChunkResidency(...)`, `cpuCache.deliveryState.wasChunkSent(...)` |
| `chunkGrid` | A rect per planned chunk per visible tile (detail + coarse source levels), colored cached (green) / in-flight (yellow) / planned (red). Group-as-proxy entries get one rect for the whole group's projected AABB. Capped at `MAX_CHUNK_RECTS = 600` per tick | `getLastPlans()`, `cpuCache.snapshot()`, `cpuCache.getPendingSnapshot()`, `cpuCache.getPendingProxySnapshot()`, `ws.member_positions`, `ws.member_model_matrix` (3D), `ws.t()`/`ws.c()`, `configStore.get()` |
| `chunkTier` (requires `chunkGrid`) | Recolors each rect by *displayed* render tier — detail green / coarse yellow / missing red | as above, plus the `residency()` resolver (render-radius + worker residency + delivery state) |
| `cachedTier` (requires `chunkGrid`) | Recolors cached rects by eviction tier (active / demoted / prefetch) | `cpuCache.getCachedChunkTier(entityId, key)` |
| `plannedRank` (requires `chunkGrid`) | Recolors planned rects by queue rank — bright orange at the head, dim red at the tail, gray when the chunk is in the plan but absent from the pending queue | rank map built from `getPendingSnapshot()` / `getPendingProxySnapshot()` |
| `renderRadius` | SVG paths for the detail/coarse render-radius boundary. XY circle in 2D; XY + XZ + YZ projected rings in 3D, dashed by plane and tier | `configStore.get()` radii, `renderRadiusLimitVox`, `visibleRegionCenterVox`, `parseVisibleRegion(ws, dsId)`, `ws.project_to_screen` |

Plus a **transient** radius preview that is not a toggle: dragging either render-radius
slider in the Config tab calls `setRenderRadiusPreviewTier(tier)`, which makes this layer
draw that tier's boundary until `pointerup`. This is the one live coupling between the
config surface and the observation surface — a split that separates them breaks it.

Exported helpers (`buildGroupTierCoverage`, `formatTierCoverageLabel`, `tierCoverageMode`,
`formatTierCoverageTitle`, `TierCoverageCounts`, `GroupTierCoverage`) are consumed internally
and by `DebugOverlays.test.ts`. No dead exports found.

`radiusPreview.ts` (21 lines) — `radiusSpecsForOverlay(cfg, previewTier)`; one caller
(`DebugOverlays.tsx:638`). Live.

---

## 4. `lucida-web/src/debug/ConfigTab.tsx` (478 lines)

The Config tab body. Source of truth is `configStore` (`pipeline/planning/configStore.ts`),
read via `useSyncExternalStore`; the orchestrator subscribes to the same store and drops its
epoch cache on change, so an edit replans on the next frame. Values persist to `localStorage`.

**Mutate-primary, with a read-only degradation.** `editable` defaults to `import.meta.env.DEV`.
In production every knob renders disabled — still useful as a live-value inspector — with one
deliberate exception: **"Reset all to defaults" stays enabled in every build**, because knobs
persisted by an earlier dev session keep steering the planner in prod.

| Section | Fields | Control |
| --- | --- | --- |
| Planning Config (header) | — | "Reset all to defaults" (`configStore.reset()`), disabled when already all defaults |
| Mode thresholds | `farThresholdPx` (20–200), `detailThresholdPx` (30–500, dynamic min = `far + 10`), `hysteresisPx` (0–30), `prefetchDepth` (0–5) | slider + number + per-field reset |
| Priority weights | `importanceWeight` (10–2000), `distanceWeight` (1–100), `groupProxyPriorityBump` (0–500) | same |
| Residency budgets | `coarseDetailEnabled` (checkbox), `detailRenderRadiusView` (0–2), `coarseRenderRadiusView` (0–2), `proxyResidencyBudgetBytes` (16–512 MB) | same; the two radius sliders also fire the transient overlay preview on `pointerdown` |
| Lane offsets (collapsed by default) | `minimapLaneOffset`, `detailLaneOffset`, `proxyLaneOffset`, `prefetchLaneOffset`, `coarseLaneOffset`, `overviewLaneOffset` (0–5000 each) | same, behind a Show/Hide toggle and a structural-knob warning |

Two live validators, both warn-but-allow:

- `modeBandWarning` — fires when `detailThresholdPx <= farThresholdPx + 2*hysteresisPx`
  (middle band collapses, `tiles-with-proxy-fallback` unreachable). Surfaced under all three
  contributing fields.
- `laneOrderWarning` — fires when a lane offset inverts the canonical order
  MINIMAP < DETAIL < PROXY < PREFETCH < OVERVIEW.

Deliberate exclusion, documented in the file header: `depthBiasView` is a *user*-facing knob
and lives in `components/FocalDepthControl.tsx`, writable in every build. It binds to the same
`configStore`. No dead code found in this file — every `TunableSpec` entry renders and every
helper has a caller.

---

## 5. CLI diagnostic commands

All three connect a WebSocket to the workspace, wait for the authoritative
`WorkspaceSnapshot`, and derive their answer from **server/scene state**. None of them reach
the browser: no renderer residency, no CPU-cache state, no worker wanted-set, no frame timing.
Each emits JSON (serde) or a human formatter, selected by `output.print_either`.

| Command | Output type | Payload | Transport / how it gets the data |
| --- | --- | --- | --- |
| `lucida debug state` | `DebugStateOutput` (`view.rs:98`), human at `view.rs:1246` | `snapshot_seq`, `own_client_id`, `source` (profile or peer), `diagnostic_kind = "workspace_scene_state"`, `planner_parity = false`, `viewer{camera, view, display, multi_channel, dataset_order}`, `datasets[]{dataset_id, name, visible, member_count, active_layout_id, generated_level_count, generated_chunk_count}`, `peers[]`, `generated_availability[]{level_count, chunk_count, levels[], chunk_status counts}`, `caveats[]` | `ViewerProfileClient::debug_state` → `diagnostic_scene()` (`view.rs:885`): open workspace socket, `wait_for_workspace_snapshot`, then build a `Scene` either from a named viewer profile or from a live peer's presence (`--from-peer`). Pure snapshot derivation — no request/response round-trip. |
| `lucida plan visible-chunks [dataset]` | `PlanVisibleChunksOutput` (`view.rs:89`), human at `view.rs:1191` | `snapshot_seq`, `own_client_id`, `source`, `diagnostic_kind = "lower_level_scene_diagnostic"`, `planner_parity = false`, `datasets[]{dataset_id, name, visible, multi_channel, display, active_layout_id, active_members[]{entity_id, image_id, position, level_indices}, member_plans[]{image_id, position, needed_count, prefetch_count, tiers[]{tier, level_index, count, chunks[ChunkCoord]}}, generated_availability?}`, `caveats[]` | Same `diagnostic_scene()` path, then `lucida_core::Scene::chunk_plan_for(dataset_id)` per visible dataset. **This is a Rust re-implementation, not the web planner.** |
| `lucida dataset health [dataset]` | `DatasetHealthOutput` (`dataset.rs:108`), human at `dataset.rs:492` | `seq` + `datasets[]: DatasetSourceHealth` — per dataset: `workspace_dataset_id`, `name`, `status`, `backend`, `source_url`, `binding{status, message}`, `source_cache{current_bytes, max_bytes, used_percent, entry_count, hits, misses, evictions, backend_errors}`, `generated_coarse{status, level_count, ready/pending/failed/unavailable chunks, message, cache{storage, current_bytes, max_bytes, used_percent, evictions, root}, recent_failures[]}`, `messages[]` | `DatasetWorkspaceClient::health` (`dataset.rs:251`): open socket, await snapshot, **send `ClientMessage::DatasetHealth{request_id, dataset_id}`**, await the matching result. A real server round-trip — the only one of the three. |

Notable for the map's "extend `debug-state`" preference:

- Both `debug state` and `plan visible-chunks` self-declare `planner_parity: false` and ship
  explicit `caveats[]` saying so — `debug_state_caveats()` (`view.rs:2406`) states outright:
  *"does not include browser renderer residency, CPU-cache state, or worker wanted-set state."*
  That is precisely the gap the monitor would fill.
- Everything the CLI returns today is **structural state**, not timing. There is no elapsed
  time, no timestamp, and no per-stage duration anywhere in the three payloads.
- `dataset health` already shares its exact wire type (`DatasetSourceHealth`) with the web
  Health tab. That is the one place where GUI and agent surfaces already read the same bytes.
- Subcommand naming: the enums are `DebugCommand::State` (`main.rs:1156`) and
  `PlanCommand::VisibleChunks` (`main.rs:1147`) — invoked as `lucida debug state` and
  `lucida plan visible-chunks`, not `lucida debug-state` / `lucida plan`.

---

## 6. `localStorage.debug` category registry

`lucida-web/src/debug/logging.ts` (179 lines), per ADR `wiki/decisions/0012-logging-conventions.md`.

Mechanics: `localStorage.debug` is a comma-separated list (or `*` for all), read **once** at
module init into an in-memory `Set` because `isDebugEnabled` sits on hot paths. The cache
refreshes via `setDebugEnabled` (the Logging tab) and the cross-tab `storage` event.
`onDebugCategoriesChanged` listeners exist so WASM — which cannot read `localStorage` — gets
the set pushed to it via `set_debug_categories(csv)` from `hooks/useWasmScene.ts`.

**All 5 categories are wired to live call sites. None are registered-but-unused.**

| Category | Live call sites | Where |
| --- | --- | --- |
| `bridge` | ~25 | `bridge.ts` (`ws.connected`, `ws.bad_message`, `snapshot.*`, `seq.*`, `pending_command.expired`, `dataset_health.*`, `dataset_retry.send`, `open_remote_dataset.*`, `bookmark_changed.listener_threw`) and `sessionController.ts` (`open_remote_dataset.*`, `setup_fetch_pipeline.*`, `apply_command.failed`, `auto_fit_on_open.*`). All route through `bridgeLog`, which injects `wsReadyState`. |
| `wasm` | 3 | `lucida-core/src/command.rs` — `scene.dataset_opened.applied`, `manifest.shape_anomaly`, `viewport_command.non_finite_input_dropped`, via the `wasm_log!` macro (`lucida-core/src/wasm_log.rs`) |
| `render` | 3 | `renderLoop.ts` — `dirty_set` (×2, one per dirty kind) and `residency_throttled` |
| `cache` | 5 | `cpuCache.ts` (`cache.eviction_burst`, `cache.sparse_detail`, plus two `BurstLogger`s: `cache.failure_burst` at `:231` and `cache.backpressure` at `:329`) and `retry.ts` (`cache.untyped_fetch_error`) |
| `orch` | 6 | `upload/delivery/feedback.ts` (`upload.worker_chunk_feedback`, `upload.worker_wanted_set_delta`), `upload/telemetry/upload.ts` (`upload.budget_exhausted_sustained`, `upload.resend_storm`, `upload.drain_waste`), `upload/telemetry/coldState.ts` (`cold_state.churn`). Also read by `upload/telemetry/active.ts:24` as a second enabling gate alongside `debugStats.enabled`. |

One live site inside a wired category is nevertheless unreachable: **`upload.resend_storm`**
fires on `resendRatio > threshold`, and `resendRatio` is structurally always `0`/`NaN` (see §2).

### Overlay registry (parallel system, same file)

`DEBUG_OVERLAYS` under `localStorage["debug.overlays"]` — deliberately kept parallel to the
category system: same toggle+listener shape, different semantics (no console output, no WASM
push-down, no `*` shorthand). All 6 (`groupModes`, `chunkGrid`, `chunkTier`, `renderRadius`,
`cachedTier`, `plannedRank`) are consumed by `DebugOverlays.tsx`; `App.tsx` also reads the
aggregate to decide whether to mount the layer. None unused.

A third, non-persisted signal lives here too: `renderRadiusPreviewTier` — in-memory only,
written by ConfigTab's slider drag, read by DebugOverlays.

---

## Clearly DEAD

Verified by grepping for readers and writers; nothing below is inferred from naming.

**Never written (only appear in an initializer, yet some are displayed):**

1. `DebugStats.planCacheHits` — displayed in the Render tab as `Cache: 0h`; only ever zeroed
2. `DebugStats.planCacheMisses` — displayed as `0m`; only ever zeroed
3. `UploadTickStats.resendChunkUploads`
4. `UploadTickStats.resendProxyUploads`
5. `UploadTickStats.resendChunksConsidered`
6. `UploadTickStats.resendProxiesConsidered`
7. `UploadTickStats.resendChunksAlreadySent`
8. `UploadTickStats.resendChunksNotCached`
9. `UploadTickStats.resendChunksRejected`
10. `UploadTickStats.resendProxiesAlreadyDelivered`
11. `UploadTickStats.resendProxiesNotCached`

**Written but never read (no display, no consumer):**

12. `DebugStats.zoomPerVoxel`
13. `PlanningDatasetDebug.chunksByLevel`
14. `PlanningDatasetDebug.lanes.proxy`
15. `OrchMemberDebug.position`
16. `OrchDebug.activeSet[].coarsestDetailLod`
17. `OrchDebug.activeSetModeCounts.invisible`
18. `OrchDebug.topRequests[].entityId`
19. `OrchDebug.topRequests[].t`
20. `OrchDebug.topRequests[].c`
21. `OrchDebug.topRequests[].z`
22. `OrchDebug.topRequests[].y`
23. `OrchDebug.topRequests[].x`
24. `ProxyResidencyDebug.topDecisions[]` (6 subfields, built 20-deep every tick)
25. `ColdStateDebug.causeTotal`
26. `RenderLoop.getDebugSnapshot().sampleWindowMs`
27. `RenderLoop.getDebugSnapshot().msSinceLastThrottleEmit`

**Structurally inert — written from a hardcoded constant, so the UI can never vary:**

28. `OrchMemberDebug.neededCount` / `.prefetchCount` / `.uploadLevel` / `.chunksByLevel` /
    `.mixedLevels` — 5 fields; the entire "Members (adapter output)" table in the Orch tab
    can only ever read `<id> uploadL? n:0 p:0`
29. `OrchDebug.hasMixedLevels` — hardcoded `false`; the MIXED LEVELS banner is unreachable
30. `UploadRollingStats.resendRatio` — `isResend` is `false` at its only call site, so the
    ratio is always `0`/`NaN` and the `upload.resend_storm` anomaly log can never fire
31. The Orch tab's entire **resend** row — its render gate is a sum of items 3–6

**Dead-adjacent (not a field, but stale):** the Orch tab's empty state says
"Enable debug (D key)"; no `D` shortcut exists — the panel opens from a toolbar button.

**Partially dead (mode-dependent, worth knowing before anything is reused):**
`DebugStats.effectiveZoom` and `DebugStats.activeChannels` are written only on the volume/3D
path, so both read as their initializers in 2D/slice mode while still being displayed.

**Count: 31 fields dead or structurally inert** (counting each `topRequests` subfield
individually and `topDecisions` as one, per the tables above).

## Observe + mutate hybrids

The tabs a clean observe/mutate split has to cut through:

1. **Cache** — a complete fetch-pipeline gauge board *plus* 4 live knobs
   (`mainBudgetBytes`, `overviewBudgetBytes`, `maxConcurrentFetches`, `maxBytesInFlight`)
   writing straight into `CpuCache.updateConfig`. Dev-build only for the writes; the
   read-out is unconditional. The knobs and the numbers they move are the same rows.
2. **Health** — read-only server-authored status for every dataset *plus* a per-dataset
   **Retry binding** button that issues a real server command and then re-polls. The only
   mutation in the panel that crosses the process boundary.

Adjacent couplings that are not tab-local but behave like hybrids:

3. **Opening the panel is itself a mutation.** `handleDebugToggle` sets
   `debugStats.enabled = true`, which is the gate the whole pipeline checks before computing
   any of this. There is no always-on stream to observe.
4. **Config ↔ Overlays.** Dragging a render-radius slider in the (mutate) Config tab drives a
   transient boundary drawn by the (observe) overlay layer, via
   `setRenderRadiusPreviewTier`. Splitting the two surfaces breaks this preview.
5. **Config in production is a read-only observer.** Every knob disables outside dev builds
   and the tab degrades into a live planner-value inspector — except "Reset all to defaults",
   which stays enabled everywhere as a safety valve against stale persisted knobs.
