# Source-read concurrency: where the knee is (issue #901)

Sizing evidence for the concurrent-source-read cap (`DEFAULT_SOURCE_READ_CONCURRENCY`,
`lucida-store/src/cache.rs`) and for the decision recorded in
[ADR 0053](../../wiki/decisions/0053-fair-share-source-read-admission.md).

Successor to [#899] (`docs/research/remote-rates.md`), which measured what the cap *costs*
(permit wait 166–467 ms p50, in-flight pinned at 12/12 in every interactive phase) but not
what a different cap would buy. [#900] closed by naming this cap as the ~82 reads/s ceiling
and #901 as "the lever that actually changes tile arrival times". **That turns out to be
only a little bit true, and the reason is worth reading.**

Every figure is tagged **[M]** measured / **[C]** read from code / **[U]** unknown.

[#899]: https://github.com/aelefebv/lucida/issues/899
[#900]: https://github.com/aelefebv/lucida/issues/900
[#901]: https://github.com/aelefebv/lucida/issues/901

---

## 0. Conditions

| | |
| --- | --- |
| Machine | Apple M5 Max, 128 GiB, macOS 26.5.2 [M] |
| Server → object store | home Wi-Fi → public internet → GCS **US-WEST1** regional bucket [M] |
| Credentials | operator ADC; `GOOGLE_APPLICATION_CREDENTIALS` stripped so ADC wins [C] |
| Wall-clock | 2026-08-10, ~17:20–18:40 PDT [M] |
| Fixture | `gs://calico-ylm-zarr-01/processed_zarrs/20260626_Guk1_BY_DHY.v1319.processed_catchers.zarr` — the same 21,371-image / 216-member collection #899 used [M] |

Same link, same bucket, same fixture as #899 — but **not** the same session, and #899's own
conclusion is that run-to-run remote latency varies by ~2×. Nothing here compares a number
taken today against a number taken on 2026-08-08.

---

## 1. The sweep

`docs/research/source-read-concurrency-harness/` — a standalone Rust binary that reads real
objects through the same `object_store` version, the same credential discovery and the same
transport lucida uses, at a range of fixed concurrency levels.

Three properties make its output trustworthy, and each one exists because the naive version
of this measurement lies:

* **Every object is read exactly once per run.** No level is ever served from an edge cache
  that an earlier level warmed.
* **Levels are interleaved across passes, in a rotated order**, and each level's throughput is
  the *median across passes*. Network drift is larger than the effect being measured, so
  running level 8 to completion and then level 64 would measure the weather, not the cap.
* **Objects are sampled across members, and size-banded to the interactive profile.** Reading
  straight down one key prefix measures one storage shard; and the base-level chunks in this
  bucket are ~5 MB, which would turn a concurrency sweep into a bandwidth test. The sample
  lands at **size p50 325 KiB** [M] against the **326 KiB** #899 measured for real interactive
  source reads — the same read, by size.

Two sweeps: **A** (11 levels × 120 objects × 4 passes) and **B** (6 levels × 120 objects × 6
passes), 10,560 distinct objects read in total, zero errors [M].

### Throughput

Completed reads per second, pooled over all cells at each level from both sweeps (10 cells per
level for 8–48, 4 for the rest) [M]:

| level | reads/s (median) | range across cells | MiB/s (median) |
| --- | --- | --- | --- |
| 1 | 5.6 | 4.6 – 6.1 | 1.8 |
| 4 | 20.4 | 19.6 – 21.4 | 6.2 |
| 8 | 35.7 | 29.4 – 40.4 | 11.1 |
| 12 | 50.8 | 31.1 – 56.3 | 15.6 |
| **16** | **57.0** | 49.7 – 64.6 | **17.8** |
| 24 | 57.1 | 50.7 – 63.3 | 18.6 |
| 32 | 59.2 | 53.9 – 74.0 | 18.9 |
| 48 | 53.7 | 40.8 – 60.5 | 17.1 |
| 64 | 49.0 | 37.9 – 53.5 | 15.8 |
| 96 | 43.7 | 24.6 – 47.6 | 14.3 |
| 128 | 42.8 | 38.2 – 45.4 | 13.4 |

### Latency, split into handshake and payload

Mean of the two sweeps' pooled percentiles, milliseconds [M]:

| level | TTFB p50 | TTFB p95 | body p50 | body p95 |
| --- | --- | --- | --- | --- |
| 1 | 111.8 | 153.9 | 62.6 | 121.9 |
| 8 | 109.2 | 175.8 | 91.6 | 188.4 |
| 12 | 114.2 | 177.9 | 98.5 | 267.8 |
| **16** | **116.3** | 195.7 | **118.5** | 343.9 |
| 24 | 121.4 | 235.9 | 194.4 | 610.0 |
| 32 | 128.8 | 272.2 | 268.2 | 755.2 |
| 48 | 138.4 | 310.2 | 443.1 | 1343.9 |
| 64 | 133.8 | 310.1 | 723.0 | 1928.6 |
| 96 | 124.5 | 348.8 | 1395.2 | 2173.4 |
| 128 | 127.4 | 332.8 | 1658.1 | 2327.4 |

---

## 2. What the sweep says

**1. There is a knee, and it is at 16.** Throughput climbs steeply to 16 and then stops: 16,
24 and 32 are 57.0 / 57.1 / 59.2 reads per second, a spread well inside the cell-to-cell
range of any one of them. Past 32 it declines, and by 128 it is *below the value at 12*.

**2. The ceiling is the link, not the cap.** Aggregate bandwidth flattens at the same place
throughput does — 17.8 MiB/s at 16, 18.9 at 32, never higher at any level [M]. That is the
signature of a saturated pipe, not of a store refusing work.

**3. The store never pushes back.** TTFB moves from 109 ms at level 8 to 129 ms at 32 —
20 ms, across a 4× change in concurrency — and there were **zero errors in 10,560 reads** [M].
No throttling, no 429s, no connection refusals. Whatever limits us, GCS is not rationing it.

**4. Everything past the knee is paid for in the payload.** Body-transfer p50 goes 98 ms at
12 → 119 at 16 → 194 at 24 → 268 at 32 → 1,658 at 128, for objects of the same size. The
extra streams share one link, so each one runs slower by almost exactly the factor by which
they are oversubscribed. **This is #901's warning, measured:** past the knee, added
concurrency does not deliver a chunk sooner, it moves the wait out of our queue — where it is
visible and attributable — and into the transfer, where it is neither.

**5. So the honest headline contradicts #900's closing note.** #900 said the ~82 reads/s rate
was "our own 12-permit source-read semaphore, not the network". The first half is right in the
narrow sense that 12 does bind — 12 sits just below the plateau, worth about 12 % of
throughput. The second half is wrong: raising the cap past 16 makes things *worse*, because
the network is exactly what the ceiling is. **The cap was never the lever #900 hoped it was.**

**6. The knee belongs to the link, not to lucida.** These numbers describe one Wi-Fi
connection to a US-WEST1 bucket. A server sitting in the same region as its bucket will have a
much higher knee. That is the argument for keeping `LUCIDA_SOURCE_READ_CONCURRENCY` and for
shipping the sweep harness alongside the constant, rather than for picking a bigger number and
hoping.

**Chosen: 16** — the smallest cap that reaches the plateau. Taking 24 or 32 instead would buy
throughput indistinguishable from noise and cost 1.6–2.3× the per-read body latency.

---

## 3. Before and after, on the #899 harness

Re-measured with `docs/research/remote-rates-harness/` at devicePixelRatio 2, as #901 asks.

**What is and is not varied.** The two arms run the *same binary* against the *same fixture*,
differing only in `LUCIDA_SOURCE_READ_CONCURRENCY` (12, the old default → 16, the new one).
The fair-share admission change is deliberately not a variable here, because **it cannot be
one**: this harness drives a single browser, hence a single reader, and the limiter is
work-conserving — one reader alone is admitted exactly as FIFO would admit it. Fair sharing is
a claim about *two* clients, and it is tested where it can actually be observed, in
`handler.rs`'s `one_clients_backlog_does_not_delay_another_clients_chunk`. Holding the binary
fixed also removes build variance from the arm that *is* being measured.

Runs are **alternated** (12, 16, 12, 16) because #899 measured ~2× session-to-session drift on
this link and #902 found GCS latency swinging ~3× between sessions; two consecutive runs would
report the weather.

Four runs, 12,525 backend reads, DPR2 verified, cameras restored past the 3 s last-view
debounce [M].

### Permit wait — the number #901 asks for

Milliseconds. Each arm is the mean of its two runs; the direction is the same in every
individual pairing, not just in the mean [M].

| phase | metric | cap 12 (a / b) | cap 16 (a / b) | cap 12 | cap 16 | change |
| --- | --- | --- | --- | --- | --- | --- |
| all | **p50** | 202.0 / 178.2 | 110.4 / 92.0 | **190.1** | **101.2** | **−47 %** |
| all | p95 | 347.3 / 322.2 | 291.7 / 259.1 | 334.8 | 275.4 | −18 % |
| pan | **p50** | 266.7 / 245.6 | 196.0 / 141.2 | **256.1** | **168.6** | **−34 %** |
| pan | p95 | 636.4 / 480.4 | 504.5 / 364.3 | 558.4 | 434.4 | −22 % |
| zoom | **p50** | 220.2 / 205.5 | 135.7 / 107.5 | **212.8** | **121.6** | **−43 %** |
| zoom | p95 | 274.8 / 283.4 | 296.6 / 216.7 | 279.1 | 256.6 | −8 % |
| warm re-open | **p50** | 202.0 / 176.1 | 116.7 / 104.3 | **189.1** | **110.5** | **−42 %** |
| warm re-open | p95 | 290.3 / 267.3 | 277.6 / 250.3 | 278.8 | 264.0 | −5 % |

**Permit wait at p50 roughly halves in every interactive phase.** In-flight reads sit pinned
at the cap in both arms (p50 = max = 12 and 16 respectively) [M] — the limiter is saturated
either way, which is why the wait tracks the cap so directly.

### And the part that cuts the other way

Reporting only the row above would be dishonest. Per-read latency, same runs [M]:

| phase | metric | cap 12 | cap 16 | change |
| --- | --- | --- | --- | --- |
| pan | TTFB p50 | 106.0 | 105.1 | −1 % |
| pan | body p50 | 111.0 | 155.6 | **+40 %** |
| pan | full read p50 | 224.6 | 267.9 | +19 % |
| zoom | TTFB p50 | 102.9 | 101.1 | −2 % |
| zoom | body p50 | 99.8 | 141.7 | **+42 %** |
| zoom | full read p50 | 209.3 | 253.6 | +21 % |
| warm | body p50 | 83.4 | 149.7 | **+79 %** |
| warm | full read p50 | 186.5 | 259.5 | +39 % |

**TTFB is flat to within 2 % in every phase** — the store is doing exactly what it did before,
which is the same thing the sweep found and is the reason to believe the rest. What moves is
body transfer, up 40–79 %: four more streams share one link, so each runs slower. **The saved
permit wait is not saved outright; part of it reappears inside the transfer.** This is the
sweep's finding reproduced on the live path, and it is why the cap is 16 and not 32 — at 32
the relocation swallows the gain entirely.

The net is still positive because in-flight × (1 / per-read latency) is throughput: 16 reads
at a 268 ms median beats 12 reads at a 225 ms median by ~12 %, which is what the sweep
measured for 12 → 16. What a chunk waits for on an oversubscribed collection is the *queue*,
and a queue drains at the throughput, not at the per-read latency.

### Throughput on the live path — weaker evidence than the sweep, reported anyway

Backend reads per second, per phase and run [M]:

| phase | cap 12 (a / b) | cap 16 (a / b) |
| --- | --- | --- |
| pan | 40.8 / 46.1 | 42.7 / 51.6 |
| zoom | 52.8 / 56.5 | 53.0 / 67.0 |
| warm re-open | 56.0 / 58.9 | 57.0 / **39.3** |

Pan and zoom improve by ~9 %, consistent with the sweep. Warm re-open does not, and the reason
is that its `cap16-b` run issued 797 backend reads where the others issued 1,138–1,196: a
different amount of work, not the same work done slower. Phase-scoped reads/s on the live path
is confounded by how much the viewer happened to demand and how much the cache happened to
serve — which is precisely why §1 exists as a controlled measurement, and why the throughput
claim rests on §1 rather than on this table.

---

## 4. Reproducing

```bash
# the concurrency sweep (§1) — needs only ADC and network
cd docs/research/source-read-concurrency-harness
cargo run --release -- gs://bucket/prefix.zarr --levels 8,12,16,24,32,48 --per-cell 120 --passes 6

# the before/after (§3) — see docs/research/remote-rates-harness/README.md for the
# instrumentation patch, the DPR2 requirement and the 3 s last-view debounce trap
LUCIDA_SOURCE_READ_CONCURRENCY=12 python3 docs/research/remote-rates-harness/rr_run.py /tmp/rr/cap12 gs://...
LUCIDA_SOURCE_READ_CONCURRENCY=16 python3 docs/research/remote-rates-harness/rr_run.py /tmp/rr/cap16 gs://...
```

### Stated unknown rather than estimated

* The knee on any link other than this one — **[U]**, and it is not extrapolable from here:
  §2.6 is the whole point.
* Behaviour against a store that *does* throttle — **[U]**. GCS returned zero errors across
  10,560 reads at up to 128 concurrent, so the throttled path is unexercised.
* Whether the knee moves with object size — **[U]**. The sweep is banded to the interactive
  profile (325 KiB p50). Cold-open reads are ~5 MB and would saturate the link at a lower
  concurrency; that case is bandwidth-bound rather than round-trip-bound and was not swept.
* Multi-client throughput under fair sharing — **[U]** at the network level. The fairness
  property is proven as an ordering guarantee in tests, not as a throughput measurement
  against the real store; the harness cannot drive two browsers.
