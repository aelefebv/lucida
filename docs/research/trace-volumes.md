# Trace volumes: real event rates and volumes per pipeline stage

Research for issue [#888](https://github.com/aelefebv/lucida/issues/888), under map
[#885](https://github.com/aelefebv/lucida/issues/885) (pipeline performance monitor).

**Question.** What are the real event rates and volumes per pipeline stage during a large
dataset open? This is the fact base for the always-on recording overhead budget, so every
figure below is tagged:

| Tag | Meaning |
| --- | --- |
| **[M]** | **Measured** on a live run. Fixture and conditions named. |
| **[C]** | **Read from code.** Arithmetic or a loop bound, not an observation. |
| **[U]** | **Unknown.** Not measured, not derivable. Stated as unknown rather than guessed. |

Nothing here is an estimate dressed as a measurement. Where a number would have been a
guess it is marked **[U]**.

---

## 1. Method and conditions

### Fixtures

`CLAUDE.md` forbids toy fixtures. The intended remote fixture (a private object-storage
collection used by earlier perf work) was **not reachable**: the user ADC token had expired
(`Reauthentication failed. cannot prompt during non-interactive execution`) and reauth is an
operator gate. So two real large fixtures were **generated locally** and served from disk:

| Id | Shape | Level-0 bytes | On disk | Chunk files | Notes |
| --- | --- | --- | --- | --- | --- |
| **V** — `volume-timeseries.zarr` | single image, `t=8, c=3, z=48, y=1536, x=1536`, uint16, 4 LODs, chunk `(1,1,16,256,256)` | 5,435,817,984 (5.44 GB) | 6.1 GB | 3,605 | multi-GB 3D multichannel timeseries |
| **C** — `wide-collection.zarr` | OME-Zarr plate-layout collection, **384 members** (24×16), each `t=4, c=2, z=8, y=512, x=512`, uint16, 3 LODs, chunk `(1,1,8,256,256)` | 12,884,901,888 (12.9 GB) | 15 GB | 20,377 | collection of hundreds of members |

Both are OME-Zarr 0.5 / zarr v3, `bytes` + `zstd(level 1)`, structured-plus-noise data so
compression ratios are realistic rather than the ~100× a constant array would give.
Generator: `docs/research/trace-volumes-harness/gen_fixtures.py`.

**Caveat on rates [C].** Both fixtures are served from local NVMe through a local
`lucida-server`. Wire latency is near zero, so the **per-second rates below are a ceiling**:
the same run against object storage produces the same totals but lower peaks. For an overhead
budget a ceiling is the number you want; for "how fast does a remote open feel" it is not.

### Harness

`docs/research/trace-volumes-harness/` — a runner (`tv_run.py`) that boots
`lucida-server` from the working tree over the tryout spine, opens the fixture read-only via
the Python client, then drives the real SPA in system Chrome via a Playwright driver
(`tv_driver.cjs`).

- **devicePixelRatio 2**, viewport 1600×1000 CSS. Canvas backing store measured at
  **1600×1200** device pixels (800×600 CSS × 2) — DPR2 confirmed on every run, per the
  standing repo rule that DPR1-only verification has hidden whole defect classes.
- Drag targets are chosen by `document.elementFromPoint` so a pan lands on the canvas and
  not on a floating panel. (First attempt panned into an overlay and recorded zero events —
  worth knowing if you reuse this harness.)
- Phases: `cold` (first navigation → first render → 8 s settle), `idle` (5 s quiescent),
  `pan` (10 s drag), `zoom` (8 s wheel), `pan_debug_panel` (10 s drag with the debug panel
  open), `volume3d_settle` / `volume3d_orbit` (3D mode), `warm` (full reload in the same
  browser context → 8 s settle).

### Instrumentation

A throwaway counter module (`tvAdd` / `tvObs`, 1-second bucketing, exposed as `window.__tv`)
was inserted at each per-item site, the build was made, the runs were taken, and the
instrumentation was then **reverted**. The exact diff is quarantined at
`docs/research/trace-volumes-instrumentation.patch` — it is a patch file, not live code.
Apply it, rebuild `lucida-web`, and the runs reproduce.

Counter cost is not distorting the result [M]: instrumented pan on fixture V ran at
**1,148 rendered frames / 10.0 s ≈ 115 fps**, consistent with the ~105–120 fps this repo
measured post-#868 on the same class of interaction.

Raw run outputs: `/tmp/tv/run-volume2/` and `/tmp/tv/run-collection4/` (`tv-summary.json`
plus per-phase DPR2 screenshots). Not committed — they are large and machine-local.

---

## 2. Chunk-level volumes [M]

`plan.chunk_emitted` = chunk requests produced by the planner. `cache.request` = requests
submitted to the CPU cache (a superset — re-submissions of already-cached chunks count).
`fetch.issued` = requests that reached the network. `upload.posted` = chunk payloads posted
to the render worker.

### Fixture V — 5.44 GB 3D multichannel timeseries

| Phase | dur (s) | planned | cache.req | cache.hit | fetch.issued | decoded | uploaded | evicted |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cold open | 8.3 | 37 | 37 | 0 | 37 | 37 | 13 | 0 |
| idle | 5.0 | **0** | **0** | 0 | **0** | **0** | **0** | 0 |
| pan (2D) | 10.0 | 1,555 | 1,557 | 1,531 | 26 | 26 | 551 | 0 |
| zoom (2D) | 8.0 | 847 | 847 | 835 | 12 | 12 | 287 | 0 |
| 3D orbit | 10.8 | 8,502 | 8,502 | 6,734 | 1,378 | 1,378 | 2,728 | 1,378 |
| warm re-open | 8.4 | 327 | 327 | 0 | 327 | 327 | 111 | 68 |

Peak per-second (1 s buckets):

| Phase | planned/s | cache.req/s | fetch/s | decode/s | upload/s | evict/s | MB/s decoded |
| --- | --- | --- | --- | --- | --- | --- | --- |
| cold open | 37 | 37 | 37 | 37 | 13 | 0 | 73 |
| pan | 176 | 176 | 23 | 23 | 62 | 0 | 44 |
| zoom | 182 | 182 | 9 | 9 | 64 | 0 | 18 |
| **3D orbit** | **981** | **981** | **151** | **144** | **297** | **144** | **288** |
| warm re-open | 327 | 327 | 221 | 205 | 77 | 68 | 405 |

### Fixture C — 384-member collection

| Phase | dur (s) | planned | cache.req | cache.hit | fetch.issued | decoded | uploaded | evicted |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cold open | 8.1 | 20 | 20 | 0 | 20 | 20 | 8 | 0 |
| idle | 5.0 | **0** | **0** | 0 | **0** | **0** | **0** | 0 |
| pan (2D) | 10.0 | 1,165 | **19,597** | 13,142 | 6,416 | 6,416 | 465 | 6,144 |
| zoom (2D) | 8.1 | 594 | 15,570 | 10,540 | 5,010 | 5,010 | 238 | 4,992 |
| 3D orbit | 11.6 | 4,332 | 5,484 | 1,684 | 3,057 | 3,057 | 2,981 | 2,608 |
| warm re-open | 9.7 | 2,559 | 2,559 | 0 | 2,559 | 2,559 | 880 | 1,843 |

Peak per-second:

| Phase | planned/s | cache.req/s | fetch/s | decode/s | upload/s | evict/s | MB/s decoded |
| --- | --- | --- | --- | --- | --- | --- | --- |
| cold open | 20 | 20 | 20 | 20 | 8 | 0 | 18 |
| **pan** | 163 | **2,083** | **894** | **881** | 65 | 653 | 220 |
| zoom | 137 | 2,057 | 649 | 649 | 57 | 640 | 169 |
| 3D orbit | 2,559 | **2,943** | 545 | 521 | **398** | 483 | 396 |
| warm re-open | 2,559 | 2,559 | 582 | 558 | 311 | 394 | 405 |

### What the totals say

- **Cold open of either fixture is cheap.** 20–37 chunks. Chunk-lazy loading means a
  multi-GB open touches tens of chunks, not thousands. First render at DPR2: **240 ms**
  (C) / **378 ms** (V) from navigation.
- **Warm re-open is not cheaper in chunk count [M].** Fixture C: 2,559 planned/fetched on
  reload vs 20 on the cold first paint, because the reload lands on the camera the previous
  session left (zoomed in after pan/zoom/3D), not the default framing. Browser HTTP requests
  were 22 cold / 20 warm — the SPA shell is cached, and chunk traffic rides the WebSocket, so
  the HTTP request count says nothing about chunk volume. **A trace keyed on "open" must
  distinguish "cold open" from "the camera you re-open into" — they are different workloads.**
- **The single largest per-item burst is one plan submit, not a per-second rate [M].**
  Fixture C, 3D orbit: `plan.requests_per_submit` max = **2,943 requests in a single
  `cpuCache.submit()` call`**, i.e. inside one frame. Fixture C warm: 2,559 in one submit.
  Fixture V 3D: 327 per submit (p50 and max).
- **Evictions track fetches once the budget is saturated.** Fixture C pan: 6,144 evictions
  against 6,416 fetches — steady-state churn at the 512 MiB main budget.
- **Uploaded bytes vastly exceed fetched bytes on repeat traversal.** Fixture V pan:
  1.11 GB posted to the worker from 52 MB fetched (cache hits re-posted).

### Server side [M/C]

Chunk delivery runs over the WebSocket, not HTTP, so browser-visible HTTP requests were 20–22
per phase [M]. **Server chunk-serve events therefore equal `fetch.issued`** [C]: 6,416 in a
10 s pan of fixture C, peak 894/s. The server's own `tracing` output at `RUST_LOG=info`
carried 42 lines for a whole run — there is no per-chunk span at info level today [M], so
correlating a browser fetch to a server serve needs new server-side emission, not a filter
over what exists.

---

## 3. Frame-level volumes [M]

| Fixture / phase | ticks | ticks/s peak | rendered frames | frames/s peak | full plan rebuilds | cached-plan ticks |
| --- | --- | --- | --- | --- | --- | --- |
| V idle | **0** | **0** | **0** | 0 | 0 | 0 |
| V pan | 1,201 | 121 | 1,148 | 117 | 49 | 1,152 |
| V zoom | 935 | 120 | 864 | 111 | 40 | 895 |
| V 3D orbit | 887 | 90 | 295 | 35 | 26 | 861 |
| C idle | **0** | **0** | **0** | 0 | 0 | 0 |
| C pan | 1,199 | 120 | 916 | 101 | 48 | 1,151 |
| C zoom | 968 | 120 | 820 | 106 | 39 | 929 |
| C 3D orbit | 549 | 58 | 181 | 24 | 3 | 546 |

Three facts that shape the recording policy:

1. **A quiescent viewer emits literally nothing [M].** Five seconds of stillness on both
   fixtures: 0 ticks, 0 frames, 0 events. The render loop is dirty-driven — `scheduleIfNeeded`
   arms a single rAF only while `interactiveDirty || residencyDirty` [C]. An always-on
   recorder therefore costs zero while idle, and a trace's timeline is naturally sparse.
2. **The tick ceiling is ~120/s, not 60/s [M].** The test display runs the rAF loop at
   120 Hz. Budget per tick, not per 16.7 ms.
3. **Full plan rebuilds are already coalesced to ~5/s [M]** (`VIEW_REPLAN_INTERVAL_MS = 200`,
   `SELECTION_COALESCE_INTERVAL_MS = 150` [C]). ~95 % of ticks serve a cached plan. The
   expensive stage fires 5×/s; the cheap stages fire 120×/s.

### How many per-frame aggregate values a monitor would sample [C]

Counting leaf fields on the existing gauge surfaces:

| Surface | Leaf fields | Multiplicity |
| --- | --- | --- |
| `DebugStats` (top level) | 28 | ×1 |
| `UploadTickStats` | 21 | ×1 |
| `UploadRollingStats` | 11 | ×1 |
| `ColdStateDebug` (+2× `ColdStateCauseCounts`, 5 each) | 11 + 10 | ×1 |
| `CacheTelemetry` (incl. `TelemetrySnapshot` 16, `TierDemandTelemetry` 10, `TierQueueTelemetry` 3, `TierCounters` 5) | 41 | ×1 |
| `OrchDebug` | 33 | ×1 |
| `ProxyResidencyDebug` | 15 | ×1 |
| `PlanningDatasetDebug` | 39 | **× datasets** |
| `MemberStat` | 5 | **× ≤100** (`DEBUG_MEMBER_ROW_CAP`) |
| `OrchMemberDebug` | 7 | **× ≤100** |
| activeSet rows | 4 | **× ≤100** |

**Scalar floor ≈ 170 values per sample**, plus ~39 per open dataset, plus up to **1,600
per-member row values** at the existing 100-row cap. A monitor that samples every scalar
gauge once per tick at 120 Hz is emitting **~20,400 values/s**; once per second it is
**~170 values/s**. The per-member rows are the part that scales with the dataset, and they
are already capped — that cap is the prior art for the granularity decision.

---

## 4. Where the counts explode

### Measured five-figure sites

**None on these fixtures per *frame*.** The largest single-frame per-item count observed was
**2,943** (one plan submit, fixture C 3D orbit) [M]. Per *phase* the counts do reach five
figures — 19,597 cache submissions across a 10 s pan of fixture C [M] — but those are spread
over ~1,200 ticks (p50 ≈ 410 per submit).

So: **at 384 members, a per-item record is a low-four-figure per-frame burst, not a five-figure
one.** The five-figure regime is real but needs an order of magnitude more members. Below is
where it comes from, with the measured per-member constant that makes the extrapolation
arithmetic rather than a guess.

### 4.1 Minimap overview seed-scan — `minimapPath.ts` `tickMinimapOverview`

The loop is literally `for dataset → for member → for iz → for iy → for ix`, one
`cpuCache.getCachedChunk` map lookup and one template-literal key per innermost cell, skipping
only members already fully seeded [C]. Throttled to one scan per
`MINIMAP_OVERVIEW_SCAN_INTERVAL_MS = 100` (10 scans/s) [C] — the throttle added by the
minimap-seed-scan fix; before it, this ran every rAF.

Measured [M]:

| Fixture | probes per scan | scans/s | probes/s |
| --- | --- | --- | --- |
| V (1 member, 3 coarse chunks) | 3 | 10 | 30 |
| **C (384 members, 1 coarse chunk each)** | **384** (min = p50 = max) | 10 | **3,840** |

The measured constant is **exactly `members × nz·ny·nx`** — 384 probes for 384 unseeded
members with a 1-chunk coarse grid, on every scan, for as long as any member stays unseeded.
Extrapolating that identity [C]: a 21,371-tile collection (the size this repo has already
shipped fixes for) yields **21,371 probes per scan = 213,710 probes/s** with a 1-chunk coarse
grid, and multiples of that with a larger one. **This is the site that decides the granularity
question.** A per-item record here is a six-figure-per-second write.

Note the asymmetry: the byte budget (`MINIMAP_UPLOAD_BUDGET_BYTES = 2 MiB/frame`) only bounds
chunks that are *cached*; a scan over uncached members costs its full `O(members × chunks)`
while consuming zero budget [C].

### 4.2 Planning chunk enumeration — `planning/chunks.ts` `iterateGridCells`

`for iz × for row × for col × for channel`, one object allocation + one template-literal
`chunkKey` per surviving cell, once per lane (detail / prefetch×2 / coarse / overview /
minimap), per rebuild [C]. **No cap anywhere in the loop**; the radius filter is disabled by
default (`RENDER_RADIUS_DISABLED_VIEW = 2` for both detail and coarse) [C].

Measured peak emission: **2,943 in one submit / 2,559 per second** (fixture C 3D orbit) [M].
This is the highest-volume *allocation* site in the browser pipeline [C], and it fires at
rebuild cadence (~5/s), not tick cadence.

Its sibling `clipGridCellsToRegion` computes `stats.culling.considered` in O(1) arithmetic
(`maxCol*maxRow*maxZ*channelCount`) [C] — so the *considered* counter can legitimately report
tens of millions at zero cost. **A monitor must not turn an O(1) aggregate into O(N) records.**

### 4.3 Worker-side wanted-set — `renderer/wantedSet.ts` `computeWantedSet`

Same triple-loop shape as 4.2 (per active entry × member/channel × chunk source × level ×
z,y,x cell, with a per-cell radius check and two string keys), running on the **worker
thread**, re-fired on `coldState`, `coldStateSelection`, `coldStateDelta`, and on a proxy
upload that changes the wanted set [C].

**[U] — not measured.** The instrumentation lives on `window`, which does not exist in the
worker, so no counter reached it. Given it mirrors 4.2's bound, expect the same order; but it
is genuinely unmeasured here and should not be budgeted from this document.

### 4.4 Render passes — bounded, and the bound holds [M]

| Fixture / phase | passes per frame (p50 / max) |
| --- | --- |
| V (single image), all phases | 1 / 1 |
| C 2D pan | 2 / 4 |
| C 2D zoom | 1 / 6 |
| **C 3D orbit / warm** | **204 / 204** |

384 members render as **2 passes** in 2D — the screen-bounded instanced aggregation
(`MEMBER_AGGREGATE_MAX_DIAG_PX = 32`, `MAX_INDIVIDUAL_MEMBER_PASSES = 256` per dataset×channel
[C]) is doing its job. The 204 in 3D is the individual-pass path under its 256 cap. Render
passes are **not** an explosion site on the main thread. The aggregate-quad resolution loop on
the *worker* is still O(all batched members) per frame [C] — **[U]** for the same
worker-visibility reason as 4.3.

### 4.5 Delivery consideration — `uploader.deliverToWorker`

`upload.considered_per_call` runs on every tick (120/s). Measured [M]:

| Fixture / phase | p50 | p95 | max | peak considered/s |
| --- | --- | --- | --- | --- |
| V pan | 0 | 9 | 20 | 152 |
| V 3D orbit | 42 | 106 | 111 | 4,577 |
| C 3D orbit | 8 | 182 | **557** | 12,111 |
| C warm | 1 | 5 | 178 | 1,681 |

`getDeliverable()` materialises and sorts this candidate list on every tick **and again on
every `telemetry()` read** [C] — so a monitor that calls `telemetry()` per tick doubles this
scan.

### Summary: the granularity verdict from the numbers

| Stage | Per-frame per-item count at 384 members [M] | Scaling law [C] |
| --- | --- | --- |
| Plan chunk emission | ≤ 2,943 (rebuild frames only, ~5/s) | O(visible chunks × channels × lanes) |
| Cache submit | ≤ 2,943 | same |
| Fetch / decode / upload | ≤ 60 per frame (894/s ÷ ~120 ticks) | bounded by concurrency + 8 MiB/frame budget |
| Render passes | ≤ 204 | capped at 256 per dataset×channel |
| Delivery consideration | ≤ 557 | O(deliverable candidates) |
| **Minimap seed probes** | **384 per scan, 10 scans/s** | **O(members × coarse chunks) — no cap, only a 100 ms throttle** |

Per-item records are affordable for **fetch, decode, upload and render** at any size measured.
They are affordable for **plan emission** only if the record is cheap enough to absorb a
~3,000-item burst inside one frame. They are **not** affordable for the **minimap seed-scan**
at production collection sizes, and that stage should be recorded as an aggregate
(`probes`, `hits`, `bytes`, `duration` per scan — 4 values per 100 ms) rather than per item.

---

## 5. What the existing telemetry already costs — the baseline floor

Measured with a microbenchmark against the real classes (`TelemetryCounters`,
`UploadTelemetry`, `ColdStateTelemetry`) under Node 24 / vitest on the same machine. Source:
the `tvTelemetryFloor.test.ts` hunk of `trace-volumes-instrumentation.patch`.

### Write-path cost per event [M]

| Call | ns/op |
| --- | --- |
| `TelemetryCounters.recordRequest` | **0.8** |
| `TelemetryCounters.recordHit` | **2.4** |
| `TelemetryCounters.recordEviction` | **8.7** |
| `TelemetryCounters.recordDecode` (100-sample window, push + shift) | **12.7** |
| `UploadTelemetry.recordEvent` (ring push + 120-sample FIFO) | **49.6** |
| `ColdStateTelemetry.recordHit` (walks the 1 s ring on every call) | **158.6** |
| `ColdStateTelemetry.recordRebuild` (ring walk + churn check + snapshot refresh) | **968.2** |
| `ColdStateTelemetry.publish` (O(1) — snapshot precomputed) | **2.3** |
| bare `arr.push({t, stage, key, bytes})` — a naive trace record | **10.3** |

### Read-path cost per call [M]

| Call | ns/op |
| --- | --- |
| `TelemetryCounters.snapshot` (copies + sorts the 100-sample decode window) | **1,079** |
| `UploadTelemetry.publish`, 1 event/tick (ring ≈ 120) | **1,361** |
| `UploadTelemetry.publish`, 8 events/tick (ring ≈ 960) | **2,901** |
| `UploadTelemetry.publish`, 64 events/tick (ring ≈ 7,680) | **16,573** |
| `UploadTelemetry.publish`, 128 events/tick (ring ≈ 15,360) | **1,133,388** |

**That last row is a real finding, not an artifact.** `UploadTelemetry` prunes its 1 s event
ring with `Array.shift()` in a loop [C], which is O(n) per removal, so `publish()` degrades
**quadratically** in events-per-window. At the measured peak upload rate (398/s ≈ 3.3 per
tick) it sits in the ~1.4–2.9 µs band and is invisible. Cross into the tens-of-events-per-tick
regime — which fixture C's 3D orbit already brushes at 12,111 considered/s — and it becomes
the most expensive thing in the tick. **Any monitor reusing this ring pattern inherits the
same curve.**

### Retained memory [M]

| Structure | Bytes retained |
| --- | --- |
| `TelemetryCounters` ×1, saturated 100-sample decode window | **6,712** |
| `UploadTelemetry` ×1, saturated 1 s ring at 8 uploads/tick @120 Hz (≈960 events) | **507,640** |
| `UploadTelemetry` ×1, saturated 1 s ring at 128 uploads/tick @120 Hz (≈15,360 events) | **2,328,936** |
| `ColdStateTelemetry` ×1, saturated 1 s ring @120 Hz + 60 durations | **537,856** |
| 100,000 plain `{t, stage: string, key: string, bytes}` records | **18,940,464** (≈189 B/record) |
| 100,000 columnar records (`Float64Array` + `Uint8Array` + `Uint32Array`) | 109,760 measured — **discard**, see below |

The columnar row's measured value (109,760 B) is **below the arithmetic minimum** for those
three typed arrays (800,000 + 100,000 + 400,000 = 1,300,000 B), so the `process.memoryUsage`
delta is unreliable for off-heap-backed typed arrays. Use the arithmetic instead:
**13 bytes/record columnar** (8 B timestamp + 1 B stage + 4 B payload) [C], against the
**≈189 bytes/record measured for plain objects** [M].

**The standing floor is ≈1.05 MB of live rolling-window state** (`TelemetryCounters` +
`UploadTelemetry` + `ColdStateTelemetry` at realistic saturation), refreshed continuously
while interacting, plus a `renderLoop` frame ring of 120 samples and a `MAX_TRACKED_FAILURES`
cap of 8,192 records per chunk store (two stores) [C]. The monitor's marginal cost should be
judged against ~1 MB and ~1–3 µs/tick, not against zero.

The columnar-vs-object row is the single most useful number for the recording-policy ticket:
**object records cost ≈189 bytes each [M]; the same data columnar costs ≈13 bytes each [C] —
a 14× difference.** At the measured worst-case sustained rate (fixture C pan: ~2,000 cache
submissions/s + 894 fetches/s + 881 decodes/s ≈ 3,800 events/s), one minute of per-item
object records is **≈43 MB**; columnar it is **≈3 MB**.

### Cost of the existing gauges when actually observed [M, partial]

Fixture V, identical 10 s pan, panel closed vs. `DebugPanel` open (which sets
`debugStats.enabled` and polls at `POLL_INTERVAL_MS = 200`, i.e. 5 Hz [C]):

| | ticks | rendered frames | full rebuilds | cached-plan ticks |
| --- | --- | --- | --- | --- |
| pan, panel closed | 1,201 | 1,148 | 49 | 1,152 |
| pan, **panel open** | 1,200 | 1,148 | 49 | 1,151 |

**Zero measurable frame-throughput cost** on a single-image dataset, even though each poll
runs `{...debugStats}`, a 120-sample frame-ring pass, **two** `cpuCache.telemetry()` calls
(each re-running `getDeliverable()` + a full residency walk + a 100-sample sort), a
`get_asset_catalog` parse per dataset, and a `view_query` parse [C].

**[U] — the same comparison on the 384-member collection was not obtained.** With the panel
open the canvas narrows and the driver's drag landed on a member (registering a pick, not a
camera move), so that phase recorded zero events. The per-member debug paths that the
100-row cap exists to bound are therefore **unmeasured under load**. This is the one gap a
follow-up should close before the overhead budget is finalised.

### Heap across a session [M]

| | fixture V | fixture C |
| --- | --- | --- |
| after cold open + settle | 86 MB | 31 MB |
| after 2D pan + zoom | 173 MB | 174 MB |
| after 3D mode | **595 MB** | **641 MB** |
| after warm reload | 611 MB | 646 MB |

3D mode is a ~4× step in JS heap on both fixtures. Any per-item recording buffer is competing
for headroom in a process that is already at 600 MB in the mode that also produces the largest
per-submit bursts.

---

## 6. Answers to the ticket, condensed

- **Chunk volumes.** Cold open of a 5.4 GB volume or a 384-member collection: **20–37
  chunks**. Interaction, not opening, is what produces volume — peak **2,943 planned/s**,
  **894 fetched/s**, **881 decoded/s**, **398 uploaded/s**, **653 evicted/s**. Warm re-open
  is *not* the cheap case; it re-opens into the previous camera (2,559 chunks on fixture C).
- **Frame volumes.** 0 ticks idle; ~120 ticks/s and up to ~117 rendered frames/s while
  interacting; ~5 full plan rebuilds/s with ~95 % of ticks on the cached plan. A monitor
  sampling every existing scalar gauge sees **~170 values per sample** plus ~39 per dataset
  plus up to 1,600 capped per-member row values.
- **Where it explodes.** Not the render path (capped at 256 passes), not fetch/decode/upload
  (concurrency- and budget-bounded). It is (1) **plan chunk emission** — up to 2,943 items in
  one frame, uncapped, and (2) the **minimap overview seed-scan** — `members × coarse chunks`
  per scan, 10 scans/s, measured at exactly 384/scan for 384 members and therefore ~214k/s at
  the 21k-tile scale this repo has already had to fix twice. Those two decide record
  granularity. The worker-side `computeWantedSet` is the same shape and is **[U]**.
- **Existing floor.** ≈**1.05 MB** of live rolling-window state and **≈1–3 µs/tick** of
  publish work, with the existing gauges costing **no measurable frame throughput** at 5 Hz
  polling on a single image. `UploadTelemetry.publish` is **quadratic** in events-per-window
  (1.4 µs at 1/tick → 1.13 ms at 128/tick) — do not copy that pruning pattern.

## 7. Open items for whoever budgets the monitor

1. **[U]** Worker-thread per-item volumes (`computeWantedSet`, the aggregate-quad resolution
   loop). Needs a counter reachable from a worker (`self`, not `window`).
2. **[U]** DebugPanel-open cost on a wide collection — the per-member paths under load.
3. **[U]** Remote object-storage rates. Everything here is local-disk-served and therefore a
   rate ceiling. Blocked on the operator reauthenticating ADC.
4. **[C]** Nothing in the server emits a per-chunk span at `info`. Cross-process correlation
   is new emission, not a filter.
