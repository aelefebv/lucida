# Timer resolution: is a 100 µs clock good enough?

Issue [#897](https://github.com/aelefebv/lucida/issues/897), part of the pipeline-performance-monitor
map ([#885](https://github.com/aelefebv/lucida/issues/885)).

Evidence tags, as in [#888](https://github.com/aelefebv/lucida/issues/888) and
[#899](https://github.com/aelefebv/lucida/issues/899):
**[M]** measured here · **[C]** computed from a measurement · **[U]** unmeasured / assumption.

Reproduce with `docs/research/timer-resolution-harness/` (see its README).

---

## Answer

**No — and cross-origin isolation does not fix it, so do not buy it.**

1. The clock floor is **100 µs**, on the main thread *and* inside workers **[M]**.
2. Cross-origin isolation takes that to **5 µs** — a real 20× — and, contrary to this ticket's
   premise, it does **not** break the remote data path: an isolated build opened and rendered the
   216-member remote collection with zero blocked requests **[M]**.
3. But 5 µs still does not measure the stages we care about: at 5 µs, **97.5%** of a fine
   per-chunk operation still times as **zero** **[M]**. Isolation buys a 20× better clock for a
   problem that needs ~2,000× better.
4. Aggregation does measure them: the same operation timed as a **batch** resolves to **35–58 ns
   per op** **[M]** — three orders of magnitude below the clamp, on the clock we already have.
5. Isolation is not free: it **kills both routes to the Perfetto viewer** that
   [#887](https://github.com/aelefebv/lucida/issues/887) recommends — the embedded iframe is
   blocked by COEP, and the `window.open` + `postMessage` handoff is severed by COOP **[M]**.

**Decision: aggregate, do not isolate, and state the floor in the trace.**

**The resolution floor #886 and #894 design against: 100 µs (0.1 ms).** Not 5 µs. That number is
the same on the main thread and in workers, and it does not change under load.

---

## What was measured

Two arms, one fixture, one driver, DPR2 (screenshots verified 3200 × 2000):

- **baseline** — the server sends no COOP/COEP. This is what lucida ships today.
- **isolated** — the server sends `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` (throwaway patch, see
  `timer-resolution-instrumentation.patch`).

Fixture: `gs://calico-ylm-zarr-01/processed_zarrs/20260626_Guk1_BY_DHY.v1319.processed_catchers.zarr`
— the same 216-member, ~22k-tile remote collection #899 used.

### 1. The clock floor

`performance.now()` spun in a tight loop; every distinct non-zero delta collected.

| arm | context | `crossOriginIsolated` | samples | distinct deltas | **smallest non-zero delta** |
|---|---|---|---|---|---|
| baseline | main thread | `false` | 16,130,000 | 0.1 / 0.2 / 0.3 ms | **0.1 ms** |
| baseline | worker | `false` | 12,614,000 | 0.1 ms only | **0.1 ms** |
| isolated | main thread | `true` | 15,332,000 | 0.005 ms and up | **0.005 ms** |
| isolated | worker | `true` | 12,862,000 | 0.005 ms and up | **0.005 ms** |

**[M]** The floor is exactly 100 µs unisolated and exactly 5 µs isolated. This confirms the
correction already recorded on the ticket: 5 µs is the *isolated* figure, and lucida is not
isolated. Re-measuring after the pipeline had done real work changed nothing **[M]** — the clamp is
a fixed property of the page, not a load-dependent one.

**Workers inherit the page's isolation state** **[M]**. That matters more than it sounds: decode
runs in `decodePool` workers and rendering in the render worker, so there is no "measure it on the
worker side instead" escape hatch. One floor, everywhere in the browser.

### 2. Does the floor bite? Yes — and 5 µs does not save it

The probe times 20,000 lookups in a 20,000-entry `Map` — deliberately shaped like the per-chunk
cache lookup #897 named as the case that would hurt. Each is timed individually, then the whole
batch is timed once.

| arm | timed individually → **zero** | non-zero | sum of individual spans | **batch total** | **batch per op** |
|---|---|---|---|---|---|
| baseline (100 µs) | 19,974 / 20,000 (**99.87%**) | 26 | 2.60 ms | 0.70 ms | **35 ns** |
| isolated (5 µs) | 19,498 / 20,000 (**97.49%**) | 502 | 2.54 ms | 0.90 ms | **45 ns** |

Three things fall out of this table.

- **[M] Per-span timing of a fine stage is not rescued by isolation.** 99.87% → 97.49% zeros. Both
  are useless as per-span numbers.
- **[M] Aggregation is 3 orders of magnitude better than either clock.** 35–58 ns/op measured on
  the clock we already ship, versus a 100 µs floor. `[C]` ≈ 2,800× finer than the clamp and ≈ 110–140×
  finer than isolation would be.
- **[M] Quantised *sums* are still usable even though quantised *spans* are not.** The sum of
  individually-timed spans came out at 2.60 ms (baseline) and 2.54 ms (isolated) — agreement to
  2.4% across a 20× change in clock resolution. The clamp behaves as a sampler: over thousands of
  events the total converges even though each individual reading is 0 or one whole clamp tick.
  `[C]` This is the statistical licence for "count N, time the batch": a trace may sum quantised
  spans over a large N and report the total, but must never report one of them.
  (Both sums exceed the 0.7–0.9 ms batch figure because the individually-timed loop pays for 40,000
  `performance.now()` calls — the observer cost is larger than the thing observed. `[C]` A per-span
  instrument on a stage this fine would more than double the stage.)

### 3. What cross-origin isolation would actually cost — the crux

The ticket expected this to be fatal, on the grounds that lucida is remote-first and
`COEP: require-corp` blocks cross-origin subresources. **It is not fatal, because the browser never
talks to object storage.**

**[M]** From the code: the SPA has exactly one transport for pixel data —
`ProxiedContentSource` (`lucida-web/src/pipeline/fetch/contentSource.ts:83`), which sends chunk
requests over the same-origin WebSocket and receives binary frames back. `lucida-server` does the
object-store reads. Every other browser request is same-origin too: `/auth/*`, `/api/*`, `/ws`, and
the bundle itself (`static_serve.rs`, ADR-0020). `index.html` references no CDN, no web font, no
cross-origin script or image, and the app uses no `SharedArrayBuffer`.

**[M]** Confirmed empirically rather than by reading: with `COOP: same-origin` +
`COEP: require-corp` on the document, the isolated arm

- reported `crossOriginIsolated === true`,
- opened the remote collection in **2.86 s** (baseline: **3.22 s**),
- rendered at DPR2, panned, and re-probed ready — **0 console errors, 0 COEP-blocked requests**
  (the single aborted `/api/.../viewer-profiles/default` request appears identically in both arms
  and is an in-flight abort, not a policy block),
- produced a screenshot indistinguishable from the baseline arm's, at 119 FPS.

So the "point it at a bucket and it opens" promise survives isolation, **[C]** because the promise
is served by the server, not the browser. A user pointing at their own bucket configures nothing in
the browser and would need no CORS or CORP on their bucket.

`[U]` Residual, unmeasured: a deployment that puts something cross-origin in front of the SPA
(IAP, an external analytics or font, an embedded third-party widget) would pay the COEP cost that
lucida itself does not. Nothing like that exists in the repo today.

### 4. The Perfetto conflict — isolation loses this one

[#887](https://github.com/aelefebv/lucida/issues/887) recommends "Open in Perfetto" as the secondary
viewer. `ui.perfetto.dev` sends **no** COOP or COEP headers of its own **[M]** (`curl -I`). Both
integration routes were probed directly:

| route | baseline | isolated |
|---|---|---|
| `<iframe src="https://ui.perfetto.dev/">` | loads **[M]** | **blocked** — `net::ERR_BLOCKED_BY_RESPONSE` **[M]** |
| `window.open(...)` then `postMessage` | popup keeps `window.opener` **[M]** | popup reports `window.opener === null` **[M]** |

Both die. The iframe is a cross-origin subresource with no CORP, so `require-corp` rejects it; the
popup lands in a different browsing-context group, so the opener is severed and Perfetto's own
documented handoff (open the UI, then `postMessage` the trace to it) can never complete.

`COOP: same-origin-allow-popups` would keep the popup but does **not** grant
`crossOriginIsolated`, so "isolate *and* pop out to Perfetto" is not a configuration that exists.
**[C]** Cross-origin isolation and the #887 secondary viewer are mutually exclusive. Given that
isolation does not solve the measurement problem anyway, **Perfetto wins and isolation loses**.

### 5. The client/server clock asymmetry

Rust `tracing` on the server records nanosecond-resolution `Instant`s; the browser records
100 µs-quantised ones. A merged cross-process timeline therefore has a clock **4 orders of
magnitude** coarser on one side. Per `intention.md`, a confidently-wrong picture is a failure, so
the trace model must carry the floor rather than let a renderer imply precision that is not there.

---

## What #886 and #894 must design against

1. **Floor = 100 µs, browser side, main thread and workers alike.** Server side = nanoseconds.
   Every span record carries its clock source and that source's resolution; nothing downstream
   compares or renders the two without it.
2. **No single browser span shorter than the floor is ever emitted as a duration.** The trace model
   needs a second record kind — *counted, not timed*: `{stage, count N, batch duration}`. The three
   stages #899 found under the floor (`buildContext` 99.7%, upload dispatch 92%, client decode 65%)
   become counted stages, not timed ones.
3. **A rendered duration needs ≥ 10 clamp ticks (≥ 1 ms) or an aggregate over ≥ 100 events.**
   `[C]` At 1 ms a single quantised span carries ≤ 10% error; below that it is mostly noise. Under
   1 ms, show a count and a batch total, not a duration.
4. **Dynamic range is ~2 × 10⁵** `[C]` — 100 µs floor to the 19.8 s worst queue wait #899 measured
   — and the interesting time is at the *top* of that range (>90% of a chunk's life is our own
   queueing, which a 100 µs clock measures perfectly). A trace model that renders the long waits
   faithfully and marks the short end as quantised is the requirement; one that flattens the waits
   to make the short end look precise is the failure mode.
5. **The instrument must not cost more than what it measures.** Per-span timing of a 35 ns
   operation more than doubles it **[M]**. Batch timing is also the cheap option, not just the
   accurate one.
6. **Do not set COOP/COEP.** Not because it would break remote data — it demonstrably would not —
   but because it buys 20× where 2,800× is needed, and costs the Perfetto viewer. The option stays
   cheap to revisit: it is one header on our own origin, and this document is the evidence that the
   data path survives it.

## Reproducing

```bash
# full-app arm (needs a built SPA + server binary and working ADC for the gs:// fixture)
git apply docs/research/timer-resolution-instrumentation.patch
(cd lucida-core && wasm-pack build --target web --out-dir pkg)
(cd lucida-web && pnpm install --force && pnpm run build)
CARGO_TARGET_DIR=/tmp/tr-target cargo build --release -p lucida-server
python3 docs/research/timer-resolution-harness/tr_run.py /tmp/tr/run-1 \
  gs://calico-ylm-zarr-01/processed_zarrs/20260626_Guk1_BY_DHY.v1319.processed_catchers.zarr both
git checkout -- lucida-server   # put the tree back

# standalone arm (no build, no credentials): worker clock + the Perfetto probes
NODE_PATH=~/.cache/lucida-tryout/playwright/node_modules \
  node docs/research/timer-resolution-harness/tr_probe.cjs /tmp/tr/probe.json
```
