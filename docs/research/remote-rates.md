# Remote object-storage rates and latency (issue #899)

Research note for the **pipeline performance monitor** map ([#885]). Successor to
[#888] (`docs/research/trace-volumes.md`), which answered the volumes question but could only
serve fixtures **from local disk** — its own conclusion flags the resulting rates as a *ceiling*.
This note re-runs the same harness against **real remote object storage** and adds what #888
structurally could not give: **latency distributions**.

Every figure is tagged **[M]** measured / **[C]** read from code / **[U]** unknown. Nothing here
is estimated: where a number could not be measured it says **[U]** and why.

[#885]: https://github.com/aelefebv/lucida/issues/885
[#888]: https://github.com/aelefebv/lucida/issues/888

---

## 0. Conditions

Remote numbers are meaningless without these.

| | |
| --- | --- |
| Machine | Apple M5 Max, 128 GiB, macOS 26.5.2 [M] |
| Client → server | loopback (`127.0.0.1`); the browser never talks to the object store [C] |
| Server → object store | home Wi-Fi (`en0`, 192.168.68.x) → public internet → GCS **US-WEST1** regional bucket [M] |
| Credentials | operator ADC (`gcloud auth application-default`); the harness strips `GOOGLE_APPLICATION_CREDENTIALS` so ADC wins [C] |
| Wall-clock | 2026-08-08, ~12:58–13:12 PDT (19:58–20:12 UTC), Saturday [M] |
| Cache state | fresh server process per run (empty `CachedStore` LRU, empty browser profile); the object store's own edge state is **[U]** |
| DPR | **devicePixelRatio 2** on every run — verified by screenshot backing store **3200 × 2000** for a 1600 × 1000 viewport [M] |
| Rendered? | yes — cold/pan/zoom/warm screenshots show real content, not a blank canvas [M] |

**Two runs of the primary fixture** were taken (`run1`, `run2`). They differ only in one driver
detail (§5) but landed in visibly different network weather: `run2` saw roughly **half** the
per-request latency of `run1`. Both are reported. Treat single-run remote latency as a *sample*,
not a constant — the run-to-run spread here is larger than most of the within-run spread.

### Fixtures

**Primary** — `gs://calico-ylm-zarr-01/processed_zarrs/20260626_Guk1_BY_DHY.v1319.processed_catchers.zarr`
(OME 0.5, 24-row × 9-column grid collection). Server reports **21,371 images / 21,587 entities**
[M]. Dataset open (metadata only, before any viewer navigation): **7.7 s** (`run1`) / **2.8 s**
(`run2`) wall [M].

**Secondary** — `gs://calico-ylm-zarr-01/20260626_Guk1_BY_DHY.ome.zarr` — **could not be opened**
[M]: `metadata error: no ome.multiscales in root zarr.json`. Its root `zarr.json` carries
`attributes.multiscales` (v0.4 layout) with **seven** axes, not `attributes.ome.multiscales`, so
lucida's OME 0.5 reader rejects it. Not a finding about performance; recorded so the next ticket
does not spend the same twenty minutes on it. Its rates are **[U]**.

### Harness

`docs/research/remote-rates-harness/` — `rr_run.py` (boots the server, opens the remote dataset via
the Python client, drives Chrome at DPR2), `rr_driver.cjs` (phases), `rr_show.py` (joins client
counters to server log lines). Derived from #888's `trace-volumes-harness/`; see its README for the
gotchas that still apply. Instrumentation is **quarantined as
`docs/research/remote-rates-instrumentation.patch`**, not left live — see §9.

---

## 1. Headline: the latency distributions

This is the part #888 could not produce. Three separable waits per chunk, measured on the **server**
(`lucida-store`), where the object-store I/O actually happens:

* **permit wait** — time queued on lucida's own process-global source-read semaphore
  (`CachedStore.source_read`, default **12** [C], `LUCIDA_SOURCE_READ_CONCURRENCY`);
* **TTFB** — `ObjectStore::get()` returning, i.e. response headers back from GCS;
* **body** — `GetResult::bytes()`, i.e. the payload finishing.

All values in **milliseconds**, primary fixture, all phases pooled. [M]

| | n | min | p50 | p90 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **run1** permit wait | 494 | 0.0 | **467.1** | 610.8 | 694.7 | 887.9 | 916.1 |
| **run1** TTFB | 494 | 168.6 | **198.6** | 238.8 | 258.0 | 297.0 | 354.0 |
| **run1** body | 494 | 135.2 | **265.3** | 292.9 | 374.5 | 876.4 | 1484.9 |
| **run1** TTFB+body | 494 | 314.5 | **463.9** | 530.4 | 604.1 | 1107.2 | 1754.3 |
| **run1** permit+TTFB+body | 494 | 448.8 | **943.4** | 1121.6 | 1208.4 | 1407.5 | 2258.2 |
| **run2** permit wait | 3287 | 0.0 | **165.6** | 204.0 | 223.6 | 306.5 | 426.2 |
| **run2** TTFB | 3287 | 40.2 | **97.5** | 150.4 | 169.2 | 212.6 | 321.0 |
| **run2** body | 3287 | 0.0 | **51.6** | 94.8 | 106.7 | 293.0 | 928.4 |
| **run2** TTFB+body | 3287 | 44.3 | **169.3** | 213.5 | 234.6 | 414.2 | 1063.7 |
| **run2** permit+TTFB+body | 3287 | 98.2 | **335.0** | 406.0 | 438.7 | 580.6 | 1202.9 |

And the same wait as the **client** sees it — request sent over the WebSocket to bytes in hand,
per phase, milliseconds [M]:

| Phase | run1 p50 | run1 p95 | run1 p99 | run1 max | run2 p50 | run2 p95 | run2 max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| cold open | 1040 | 1218 | 1219 | 1219 | 680 | 1210 | 1211 |
| pan | 933 | 1230 | 1364 | 1414 | 369 | 469 | 618 |
| zoom | 950 | 1060 | 1106 | 1138 | 341 | 437 | 531 |
| warm re-open | 107 | 119 | 119 | 119 | 324 | 421 | 900 |

Reading these together:

1. **TTFB is the tightest thing in the whole pipeline.** p50 97–199 ms, p95 150–258 ms, worst
   observed **354 ms** over 3,781 reads across both runs. The spread from p50 to worst is under
   4×. A stall threshold on *network first byte* is a well-behaved thing to set.
2. **Body transfer is not tight.** p50 52–265 ms but p99 293–876 ms and worst **1,485 ms** —
   the long tail lives in the payload, not the handshake. Per-stream throughput at the p50 is
   ≈ 326 KiB / 265 ms ≈ **1.2 MB/s** (`run1`) and ≈ 326 KiB / 52 ms ≈ **6.3 MB/s** (`run2`);
   × 12 concurrent ≈ 15–75 MB/s aggregate.
3. **Our own permit wait is comparable to, and in `run1` larger than, the network first byte.**
   p50 permit wait 166–467 ms vs p50 TTFB 98–199 ms. **Roughly half of a chunk's remote latency
   is lucida queueing behind its own concurrency cap, not the network.** This is the single most
   consequential number in this note for #885: the monitor cannot just show "network wait".
4. **Client-observed round trip ≈ server permit+TTFB+body**, within ~10 ms (e.g. `run1` pan: 933 ms
   client vs 943 ms server). The WebSocket relay, frame encode and decode add nothing measurable.
   Cross-process correlation will therefore be *attributing* an already-known total, not
   discovering a hidden one.
5. **Client-side TTFB is not measurable and cannot be made so cheaply [C/U].** The transport
   delivers one whole binary frame per chunk (`ProxiedContentSource.handleChunkData`); there is no
   partial-arrival event, so "time to first byte" exists **only on the server**. Any monitor that
   promises a client-side TTFB is promising something the wire shape does not carry.

---

## 2. Rate table: remote vs #888's local disk

Same counters, same driver, same key names as #888 §2 (`plan.chunk_emitted` = planner output;
`cache.request` = submitted to the CPU cache, a superset; `fetch.issued` = reached the network;
`upload.posted` = payloads posted to the render worker).

**Totals per phase** [M]:

| Phase | dur (s) | planned | cache.req | cache.hit | fetch.issued | decoded | uploaded | evicted |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cold open (run1) | 20.2 | 36 | 36 | 0 | 36 | 36 | 18 | 0 |
| cold open (run2) | 20.2 | 36 | 36 | 0 | 36 | 36 | 18 | 0 |
| idle (both) | 5.0 | **0** | **0** | **0** | **0** | **0** | **0** | **0** |
| pan (run1) | 10.0 | 1,548 | **899,130** | 6,383 | 310 | 259 | 766 | 0 |
| pan (run2) | 10.0 | 1,488 | **899,070** | 13,844 | 688 | 636 | 745 | 0 |
| zoom (run1) | 8.1 | 1,544 | 728,158 | 13,170 | 219 | 209 | 765 | 0 |
| zoom (run2) | 8.0 | 1,300 | 706,543 | 30,883 | 570 | 549 | 649 | 0 |
| warm re-open (run1, camera not restored — see §5) | 20.1 | 36 | 36 | 0 | 36 | 36 | 18 | 0 |
| **warm re-open (run2, camera restored)** | 20.1 | 60 | **21,431** | 14 | **1,500** | 1,470 | 18 | 0 |

**Peak per second** (1 s buckets) [M]:

| Phase | planned/s | cache.req/s | fetch/s | decode/s | upload/s | evict/s | MB/s decoded |
| --- | --- | --- | --- | --- | --- | --- | --- |
| cold open (run1) | 36 | 36 | 30 | 29 | 12 | 0 | 10.2 |
| pan (run1) | 196 | **107,055** | 40 | 33 | 100 | 0 | 4.8 |
| pan (run2) | 180 | **107,055** | 82 | 74 | 101 | 0 | 6.3 |
| zoom (run1) | 300 | 107,051 | 34 | 32 | 144 | 0 | 1.7 |
| zoom (run2) | 284 | 107,023 | 74 | 74 | 142 | 0 | 3.5 |
| warm re-open (run2) | 60 | 21,431 | 96 | 96 | 17 | 0 | 6.0 |

### Side by side with #888's local-disk ceiling

#888's collection fixture ("C") was **384 members / 20,377 chunks**, local disk. This one is
**21,371 members / ~22k tiles**, remote. Different member counts, so read the *shape*, not just
the magnitude.

| Peak/s | #888 local (C, 384 members) | #899 remote (21,371 members) | direction |
| --- | --- | --- | --- |
| planned/s | **2,559** (3D orbit) | 300 (zoom) | remote **8× lower** |
| cache.req/s | **2,943** | **107,055** | remote **36× higher** |
| fetch/s | **894** | 82 | remote **11× lower** |
| decode/s | 881 | 74 | remote **12× lower** |
| upload/s | 398 | 144 | remote 2.8× lower |
| evict/s | 653 | **0** | remote **zero** |
| MB/s decoded | ~400 | 10.7 | remote **37× lower** |
| chunks, cold open | 20–37 | **36** | unchanged |
| chunks, warm re-open | 2,559 | **21,431 requested / 1,500 fetched in 20 s (still going)** | remote far worse |

What the gap means:

* **The ceiling was a real ceiling.** Every *network-bound* rate collapses by an order of
  magnitude: 894 fetch/s local → 82/s remote; ~400 MB/s decoded local → 6.3 MB/s remote. Any
  budget or threshold derived from #888's fetch/decode/upload rates is **≈10× too generous** for
  the case lucida is actually built for.
* **The one rate that goes *up* is the one that never touches the network.** `cache.request`
  peaks at **107,055/s** — 36× #888's figure — because plan submission is O(members) and this
  fixture has 56× the members. `plan.requests_per_submit` p50 = **21,400** [M]: *every member,
  every rebuild*, ~5 rebuilds/s. This is the pipeline talking to itself at 100k events/s while
  the network delivers 82.
* **Evictions vanish remotely (0 in every phase, both runs) [M].** Locally the cache churned
  653/s. Remotely so few chunks ever arrive that no budget is ever pressured. An eviction-rate
  gauge will read a flat zero on the remote path — do not let the monitor present that as health.
* **#888's minimap extrapolation is confirmed exactly.** It predicted "~214k probes/s at 21k
  tiles" from a 384-probe measurement. Measured here: `minimap.probes_per_scan` = **21,370**
  (= member count, uncapped), peak **213,710 probes/s** [M]. The seed-scan really is the
  highest-frequency thing in the system, and it is 2,600× the remote fetch rate.

---

## 3. Starved or saturated? — **saturated, on our own side**

The question #899 poses as "should the monitor highlight network wait, or our own queueing". The
answer is *our own queueing*, at two separate chokepoints, and the evidence is not close:

**Chokepoint 1 — the server's source-read semaphore (cap 12) [C].** In-flight backend reads:
`p50 = p90 = p95 = p99 = max = 12` in every interactive phase, both runs [M]. The limiter is pinned
at its ceiling for the entire run. Consequently permit wait p50 = 166–467 ms — a wait that exists
*only* because we chose 12.

**Chokepoint 2 — the browser scheduler's pending queue.** `Scheduler.drain` observations [M]:

| Phase | pending at drain (p50) | in-flight at start (p50/max) | cap-blocked drains | queue wait p50 | queue wait max |
| --- | --- | --- | --- | --- | --- |
| cold open | 0 | 19 / 24 | 12 | 0.1 ms | 558 ms |
| pan (run2) | **20,730** | 24 / 24 | 678 | **4.6 s** | 9.9 s |
| zoom (run2) | **20,190** | 24 / 24 | 582 | **13.6 s** | **18.1 s** |
| warm re-open (run2) | 20,620 (when blocked) | 24 / 24 | 1,472 | **8.8 s** | 19.8 s |

Twenty thousand requests queued, twenty-four in flight, and the median request that *does* get
issued waited **4.6–13.6 seconds** for a slot. During zoom the max queue wait (18.1 s) exceeds the
whole phase (8.0 s) — those are requests carried over from the pan.

So the budget for one chunk on a busy remote collection is roughly:

```
  queue in the browser scheduler   4,600 – 13,600 ms   ← ours
  queue on the server semaphore      166 –    467 ms   ← ours
  network first byte                  98 –    199 ms   ← theirs
  network body                        52 –    265 ms   ← theirs
  decode (client, off-thread)          0.1 –    0.5 ms
```

**Over 90 % of a chunk's wall-clock life on a remote collection open is spent in one of our own
queues.** Network wait is real but it is the *smallest* term. A monitor that only surfaces
"network wait" would point at ~5 % of the problem.

Two corollaries for #885:

* **Queue depth and queue age are first-class monitor signals**, at least as important as stage
  durations. `Scheduler.oldestPendingAgeMs` already exists [C] and is exactly the right shape; it
  is not currently surfaced anywhere with timing.
* **The stall threshold cannot be a single number.** p50 network first byte is 98 ms; p50 queue
  wait is 4,600 ms. One threshold cannot serve both.

### A related amplification worth recording

During interaction the server reads **p50 326 KiB** from the object store to deliver **p50 6,144 B**
to the client [M] — a **≈54×** read amplification, because `slice_range` picks one (t, c) slice out
of a t/c-bundled on-disk chunk (`ChunkByteLayout.slice_range`, `handler.rs`) [C]. On the cold open
the same ratio is ≈13× (5,218 KiB read → 384 KiB delivered). This is not a monitor requirement, but
it does mean **the bytes the monitor shows on the client side understate the bytes we paid for by
one to two orders of magnitude**; the trace should carry both.

---

## 4. Where the time goes on a cold remote open

Cold open of a 21,371-member remote collection: **36 chunks planned, 36 fetched, 18 uploaded, first
render 468–483 ms** [M]. #888's "cold open is cheap — 20–37 chunks" holds exactly, remotely, at
56× the member count.

The 20 s settle after first render adds **nothing**: totals at end of settle equal totals at first
render. The cold open is done in under half a second and then the viewer is quiet.

**Dataset open itself is invisible to this instrumentation [U].** Metadata resolution for 21,371
members took 2.8–7.7 s wall [M] but produced **zero** `CachedStore` reads [M] — that path does not
go through the chunk cache. So the object reads behind dataset-open (how many, how long, how
concurrent) are unmeasured. Given open is 6–16× longer than first render, **this is the largest
unmeasured stretch of a remote open** and #885's "one trace across the full path" cannot claim
coverage without it.

---

## 5. Is warm re-open still the expensive case? — **yes, and more so**

#888 found warm re-open (2,559 chunks) more expensive than cold open (20–37) because *the reload
lands on the camera you left*. That reproduces remotely, and it took a correction to see it:

* **`run1` (reload 150 ms after the last interaction): 36 chunks — same as cold.** The camera was
  *not* restored.
* **`run2` (reload 8 s after the last interaction): 21,431 cache requests, 1,500 fetches issued,
  1,470 completed in 20 s — and still climbing when the phase ended.**

The difference is not remote-vs-local, it is a **3-second debounce** on the per-user last-view
capture (`useSavedViewSync.ts`, `lastViewDebounceMs = 3000`) [C]. Reload inside the debounce and
the moved camera was never persisted. Any harness or trace that reloads promptly after an
interaction will silently measure the *cheap* case. Worth stating loudly: **#888's warm-re-open
finding is reproducible only if you wait out the debounce.**

With the camera restored, warm re-open remotely is the **worst** phase in the run:

| | cold open | warm re-open (`run2`) |
| --- | --- | --- |
| chunks planned | 36 | 60 |
| cache requests | 36 | **21,431** |
| fetches issued in 20 s | 36 | **1,500** |
| backend reads in 20 s | 18 | **1,483** |
| cap-blocked drains | 12 | **1,472** |
| scheduler queue wait p50 | 0.1 ms | **8.8 s** |
| finished within the phase? | yes, in < 0.5 s | **no** |

Locally, #888's warm re-open completed its 2,559 chunks inside a 9.7 s phase. Remotely the
equivalent case had **not finished after 20 s** and was issuing at 96 fetches/s against a
20,000-deep queue. **Warm re-open is the run worth recording** — #885's note to that effect stands,
and remote makes it stronger, not weaker.

---

## 6. Concurrency and failure behaviour

#888 saw none of this on local disk. Over 3,781 backend reads and 4,001 chunk serves across both
runs [M]:

| | run1 | run2 |
| --- | --- | --- |
| `CachedStore` outcomes | 494 miss / 47 coalesce / 66 hit | 3,287 miss / 65 coalesce / 42 hit |
| backend errors | **0** | **2** |
| client fetch retries scheduled | **0** | **0** |
| client transient failures | **0** | **0** |
| client permanent failures | **0** | **0** |
| client aborts (re-plan cancellations) | 37 | 55 |
| backend in-flight (p50 / max) | 12 / 12 | 12 / 12 |
| client in-flight at issue (p50 / max) | 24 / 24 | 24 / 24 |

* **Zero retries and zero real failures.** The `retry.ts` / `rejection.ts` paths did not execute.
  `OnceTransientRetry` never fired [M]. Over a well-connected link to a regional bucket the retry
  machinery is dormant — so a monitor that only lights up on failures will look permanently green
  while the pipeline is 20,000 requests behind.
* **The 2 "errors" in `run2` are `NotFound`, i.e. sparse data**, not faults: TTFB 44 ms and 75 ms,
  0-byte body, no `failed to read chunk` log line, so they took the zero-fill path
  (`is_not_found` in `handler.rs`) [C/M]. Sparse-region reads cost a **full remote round trip**
  each and are indistinguishable from success in every existing counter — worth a distinct trace
  outcome.
* **The only cancellation traffic is aborts from re-planning** — 37/55 per run, each having
  already burned 141–230 ms of remote wait (median) before being thrown away [M] (`fetch.error_ms` p50).
  Wasted remote work is a monitor-worthy category that no current gauge names.
* **Both concurrency caps sit pinned at their limit** for every interactive phase, in both runs.
  Neither is ever the *slack* resource.

---

## 7. Sub-100 microsecond spans — **yes, many** (feeds #897)

#899 asks explicitly. Answer: **remote waits are long, but the local bookkeeping around them is
routinely sub-100 µs**, so a trace format that cannot represent a 100 µs span will lose real work.
Counts of observations below 0.1 ms [M]:

| Span | where | n | under 100 µs | share |
| --- | --- | --- | --- | --- |
| `buildContext` per tick | client | 2,240 | 2,234 | **99.7 %** |
| upload dispatch per delivery | client | 766 | 702 | **91.6 %** |
| decode per chunk (6 KiB payloads) | client | 1,470 | 957 | **65 %** |
| `CachedStore` LRU hit | server | 42 | 42 | **100 %** (p50 **0 µs**, p90 28 µs) |
| server chunk decode | server | 3,394 | 2 | 0.06 % (p50 0.6 ms) |
| plan rebuild | client | 42 | 0 | 0 % (p50 38 ms) |
| client fetch round trip | client | 1,470 | 0 | 0 % (p50 324 ms) |

Notes that matter for #897:

* The server-side sub-100 µs spans are measured with `Instant` at **microsecond** resolution and
  several read **0 µs** — the true duration is below the timer, not zero. **[C]** `emit_get` reports
  whole microseconds.
* Client-side spans use `performance.now()`, which Chrome clamps to **5 µs** without cross-origin
  isolation [C]. So "under 0.1 ms" is trustworthy on the client, but the *value* of a 20 µs span is
  not; a client trace cannot resolve finer than ~5 µs no matter what the format allows.
* The two ends of the range in one run are `CachedStore` LRU hit (**0–75 µs**) and scheduler queue
  wait (**up to 19.8 s**). That is a **~10^6** dynamic range in one trace. Whatever #886 picks has
  to hold both without either losing the small spans or overflowing on the large ones.

---

## 8. What this changes for #885

1. **Re-derive every network-side budget.** #888's fetch/decode/upload peaks are ~10× optimistic
   against the remote case. Use §2's remote column.
2. **The monitor's primary callout should be queue age, not stage duration.** >90 % of a chunk's
   life is in our own two queues; the network is the smallest term.
3. **Two thresholds, not one** — sub-second for network-side spans, multi-second for queue waits.
   A single "stall" number derived from either will be useless for the other.
4. **Server-side is where the interesting timing is, and it is uninstrumented.** All of §1 and §3
   came from throwaway `Instant` timers added for this note. #890/#891 remain the load-bearing
   tickets; #888's "the server is not instrumented" finding is re-confirmed.
5. **Dataset-open object reads are outside the chunk path and outside this measurement** — and are
   6–16× longer than first render. #885's "one trace over the full path" needs them.
6. **Recording is still free at rest.** Idle emitted 0 ticks / 0 events / 0 reads over 5 s on the
   remote fixture too [M].
7. **Sub-100 µs spans exist and are the majority of several client stages** (#897).
8. **A green failure panel means nothing.** Zero retries, zero failures, zero evictions — while the
   pipeline ran 20,000 requests behind. Health-by-absence-of-errors is not a usable signal here.

---

## 9. Reproducing, and what was left behind

```bash
git checkout research/remote-rates
git apply docs/research/remote-rates-instrumentation.patch     # includes #888's counters
(cd lucida-core && wasm-pack build --target web --out-dir pkg)
(cd lucida-web && pnpm install --force && pnpm run build)
CARGO_TARGET_DIR=/tmp/rr-target cargo build --release -p lucida-server
python3 docs/research/remote-rates-harness/rr_run.py /tmp/rr/run-1 \
  gs://calico-ylm-zarr-01/processed_zarrs/20260626_Guk1_BY_DHY.v1319.processed_catchers.zarr
python3 docs/research/remote-rates-harness/rr_show.py /tmp/rr/run-1
git checkout -- . && git clean -fd lucida-web/src lucida-store/src   # put the tree back
```

The patch is a superset of `trace-volumes-instrumentation.patch`: #888's client counters, plus
per-request latency/retry/failure observations in `cpuCache.ts`, queue-depth and queue-wait
observations in `scheduler.ts`, tick/rebuild/dispatch durations for the sub-100 µs question, and a
new throwaway `lucida-store/src/rrtrace.rs` (+ call sites in `cache.rs` and `handler.rs`) that emits
one `RRGET` / `RRBAK` / `RRSRV` line per source read behind `LUCIDA_RR_TRACE=1`. **None of it is
live on the branch** — the working tree is clean and the product code is unchanged.

Gotchas that cost time, on top of #888's:

* The driver must **wait out the 3 s last-view debounce** before reloading, or the warm re-open
  silently measures the cheap case (§5).
* `readyProbe`'s `document.querySelector('canvas')` reports a 300 × 150 canvas — it finds an
  auxiliary canvas, not the main one. **Verify DPR2 from the screenshot's pixel dimensions**
  (3200 × 2000), not from that probe.
* Dataset-open reads bypass `CachedStore`, so store-level instrumentation captures nothing before
  the viewer navigates.

### Stated unknown rather than estimated

* Client-side time-to-first-byte — **[U]**, structurally: one whole frame per chunk on the wire.
* Object reads behind dataset open (count, latency, concurrency) — **[U]**, not on the
  `CachedStore` path.
* Worker-thread volumes (`computeWantedSet`, aggregate-quad resolution) — **[U]**, unchanged from
  #888: the counters live on `window`.
* The secondary fixture's rates — **[U]**, it does not open (§0).
* Object-store edge/cache state and any GCS-side variance — **[U]**; the 2× run-to-run latency
  difference is unexplained and is the reason two runs are reported instead of one.
* Behaviour on a genuinely lossy link (retries, transient failures) — **[U]**: this link produced
  none, so `retry.ts` remains unexercised at real latency.
