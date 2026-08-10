# Timer resolution: is a 100 µs clock good enough?

Issue [#897](https://github.com/aelefebv/lucida/issues/897), part of the pipeline-performance-monitor
map ([#885](https://github.com/aelefebv/lucida/issues/885)).

Evidence tags, as on `research/remote-rates` (#899): **[M]** measured in this run · **[C]** read
from the code or computed from a measurement · **[U]** unmeasured.

Harness: `docs/research/timer-resolution-harness/`. Raw output as committed:
`docs/research/timer-resolution-results/`. Every number below is traceable to one of those three
JSON files.

---

## 0. Conditions

Remote numbers are meaningless without these.

| | |
|---|---|
| Date | 2026-08-09 |
| Machine | Apple M5 Max (Mac17,6), 18 cores, macOS 26.5.2 |
| Browser | Google Chrome 151.0.7922.76, headless, system binary |
| Viewport / DPR | 1600 × 1000 at deviceScaleFactor 2 — **verified by the harness**, which reads the PNG header: 3200 × 2000 **[M]** |
| Fixture | `gs://calico-ylm-zarr-01/processed_zarrs/20260626_Guk1_BY_DHY.v1319.processed_catchers.zarr` — the 216-member, ~22k-tile remote collection #899 used |
| Credentials | operator ADC (not a service account) |
| Network | residential uplink to the bucket's region; not characterised |
| Repetitions | **n = 1 per arm.** Ratios between arms are the claim; absolute wall-clock figures are not. |

Two arms, identical except for two response headers on the SPA document:

- **baseline** — no COOP/COEP. What lucida ships today.
- **isolated** — `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
  require-corp`, via `LUCIDA_COI=1` and the throwaway patch in
  `timer-resolution-instrumentation.patch`.

The same patch instruments three real stages (`buildContext` in `renderLoop`, `tryDispatchDelivery`
in the uploader, and decompress+normalize inside the decode worker) to record the **raw quantised
delta**, never a mean — the clamp is only visible as a set of discrete multiples, and an average
launders it away.

---

## 1. Answer

**The floor is 100 µs, it bites hard, and the fix is aggregation — not cross-origin isolation.**

**Resolution floor for #886 and #894: 100 µs (0.1 ms).** Main thread and worker alike **[M]**.
Not 5 µs — that is the cross-origin-isolated figure and lucida is not isolated.

Four findings, in the order they should be read:

1. **The clamp bites.** In a 6-second pan, **82–100%** of real lucida stage spans record as
   **exactly zero** **[M]**. Per-span timing of these stages is not merely imprecise today; it is
   absent.
2. **Cross-origin isolation genuinely fixes the per-span problem** — more than expected. At 5 µs,
   upload dispatch goes from 82% zero to **17%** zero, and decode from 95% to 48% **[M]**. These
   stages really are 5–30 µs: invisible at 100 µs, well resolved at 5 µs.
3. **But aggregation already recovers what the monitor needs, on the clock we have.** Summing the
   quantised spans over one phase reproduces the 5 µs arm's per-event figures to **15% and 24%** on
   the two stages with enough samples, and 52% on the one with only twelve non-zero readings
   **[M]** — which is exactly the sampling behaviour §3 predicts. The clamp acts as a sampler:
   individual readings are 0 or one whole tick, and the sum still converges.
4. **And the stages isolation would illuminate are not where the time is.** All three together
   account for **~10.6 ms out of a 6,000 ms pan — 0.18%** **[C]**. #899 established that >90% of a
   chunk's life is queue wait, measured in seconds. Isolation buys per-span precision about a
   rounding error.

Against that, isolation costs the whole Perfetto integration #887 recommends: the embedded iframe
is blocked and the pop-out `postMessage` handoff is severed **[M]**. It does **not** cost the
remote data path — the ticket's "hard no" premise is false, and that is worth recording because it
makes the option cheap to revisit.

**Decision: aggregate, do not isolate, and state the 100 µs floor in the trace.** The dissent worth
keeping on the record: if a later question is specifically "how long does upload dispatch take, per
call", isolation is the lever that answers it, it works, and the price is Perfetto.

---

## 2. The clock floor

`performance.now()` spun in a tight loop; every distinct non-zero delta collected.

| arm | context | `crossOriginIsolated` | samples | distinct deltas seen | **smallest non-zero delta** |
|---|---|---|---|---|---|
| baseline | main thread | `false` | 16.1 M | 0.1 / 0.2 / 0.3 ms | **0.1 ms** |
| baseline | worker | `false` | 12.6 M | 0.1 ms only | **0.1 ms** |
| isolated | main thread | `true` | 15.3 M | 0.005 ms and up | **0.005 ms** |
| isolated | worker | `true` | 12.9 M | 0.005 ms and up | **0.005 ms** |

**[M]** Exactly 100 µs unisolated, exactly 5 µs isolated, confirming the correction already recorded
on the ticket. Re-measuring after the pipeline had done real work changed nothing **[M]** — the
clamp is a property of the page, not of load.

**Workers inherit the page's isolation state** **[M]**. Decode runs in `decodePool` workers and
rendering in the render worker, so there is no "measure it on the worker side instead" escape
hatch. One floor, everywhere in the browser.

## 3. Does the floor bite? Real stages, both clocks

Pan phase, 6 s of continuous drag, DPR2. `zero` = spans that recorded as exactly 0.

| stage | arm | n | zero | **zero %** | quantised sum | **per event** |
|---|---|---|---|---|---|---|
| `buildContext` | baseline | 859 | 855 | **99.5%** | 0.40 ms | 0.47 µs |
| `buildContext` | isolated | 840 | 751 | **89.4%** | 0.45 ms | 0.54 µs |
| `uploadDispatch` | baseline | 480 | 393 | **81.9%** | 9.00 ms | 18.8 µs |
| `uploadDispatch` | isolated | 435 | 73 | **16.8%** | 6.57 ms | 15.1 µs |
| `decodeWorker` | baseline | 220 | 208 | **94.6%** | 1.20 ms | 5.5 µs |
| `decodeWorker` | isolated | 208 | 100 | **48.1%** | 0.75 ms | 3.6 µs |

The isolated arm's histograms give the true shape, which the baseline arm cannot see at all:
upload dispatch is spread across 5–30 µs, decode and `buildContext` cluster at one or two 5 µs
ticks **[M]**.

Read the table twice, because it answers two different questions.

- **Per span, the clamp is fatal and isolation is the cure.** 82% → 17% zero on upload dispatch is
  not a marginal improvement. Any claim that "5 µs would not help either" is wrong, and an earlier
  draft of this note made it on the strength of a synthetic 35 ns operation. A real 5–30 µs stage
  is precisely the case a 5 µs clock resolves and a 100 µs clock cannot.
- **In aggregate, the clamp is survivable and isolation is unnecessary.** The two arms' per-event
  figures agree to 15% (`buildContext`), 24% (`uploadDispatch`) and 52% (`decodeWorker`) **[M]** —
  and the disagreement tracks sample size exactly as sampling theory predicts (below). The monitor
  asks "where did the time go", which is an aggregate question.

### Why the aggregate converges, and the rule that follows

A span shorter than the clamp registers as one whole tick with probability ≈ *duration / clamp*,
and zero otherwise. So over *N* events the sum is a scaled binomial: unbiased, with relative error
≈ 1/√k where **k is the number of non-zero readings actually observed** **[C]**.

| stage (baseline) | k (non-zero readings) | predicted error 1/√k | observed gap vs 5 µs arm |
|---|---|---|---|
| `uploadDispatch` | 87 | 11% | 24% |
| `decodeWorker` | 12 | 29% | 52% |
| `buildContext` | 4 | 50% | 15% (fortunate) |

**[C] Design rule: an aggregate is reportable once k ≥ 25 non-zero readings** — a ±20% band. Below
that, report the count and withhold the duration. This is a far better rule than a fixed event
count, because it adapts: a slow stage reaches k = 25 in a handful of events, a 0.5 µs stage needs
thousands, and both are handled by the same test.

The synthetic probe in `tr_clock.js` bounds the other end: a 35–60 ns operation timed individually
reads zero 99.87% of the time at 100 µs and **still 97.3% at 5 µs**, while the same work timed as
one batch resolves to **49–60 ns per op** **[M]**. Note the caveat the probe now measures directly:
the sum of the individually-timed spans (2.60 ms) is a reading of the **instrumented** loop, whose
wall time is 3.90 ms — not of the bare work, which is 1.20 ms **[M]**. Per-span instrumentation of
a stage that fine more than triples it, and the quantised sum then reports mostly instrument. Aggregation is the cheap option as well as
the accurate one.

## 4. What cross-origin isolation would actually cost — the crux

The ticket expected this to be fatal: lucida is remote-first, and `COEP: require-corp` blocks
cross-origin subresources that do not opt in. **It is not fatal, because the browser never talks to
object storage.**

**[C]** From the code: the SPA has exactly one transport for pixel data — `ProxiedContentSource`
(`lucida-web/src/pipeline/fetch/contentSource.ts:83`), which sends chunk requests over the
same-origin WebSocket and receives binary frames back; `lucida-server` performs the object-store
reads. WebSockets are outside COEP's scope entirely. Every other browser request is same-origin:
`/auth/*`, `/api/*`, `/ws`, and the bundle itself (`static_serve.rs`, ADR-0020). `index.html`
references no CDN, no web font, no cross-origin script or image, and the app uses no
`SharedArrayBuffer`. (`lucida-proxy`, which the ticket also names, serves no HTTP at all — it is
the crate that generates proxy volumes, so it has no headers to set **[C]**.)

**[M]** Confirmed by running it, not by reading it. With COOP + COEP on the document, the isolated
arm:

- reported `crossOriginIsolated === true` and the 5 µs clock;
- opened the remote collection (Python-client open call: 2.86 s isolated vs 3.22 s baseline —
  n = 1 each, so this is "no gross regression", not a speed claim);
- rendered at DPR2, panned, and stayed ready;
- logged **0 console errors and 0 COEP-blocked requests** in both arms. The single
  `net::ERR_ABORTED` on `/api/.../viewer-profiles/default` appears **identically in both arms** and
  is an in-flight abort, not a policy block.

So "point it at a bucket and it opens" survives isolation, **[C]** because that promise is served
by the server, not the browser. A user pointing at their own bucket would configure no CORS and no
CORP; nothing about their bucket reaches the browser.

`[U]` Residual: a deployment that puts something cross-origin in front of or inside the SPA (an
identity-aware proxy serving cross-origin assets, external analytics, a web font, an embedded
third-party widget) would pay a COEP cost that lucida itself does not. Nothing like that exists in
the repo today.

## 5. The Perfetto conflict — isolation loses this one

`ui.perfetto.dev` sends **no** COOP, COEP or CORP header of its own **[M]** (fetched by the
harness; recorded in `probe.json`). Both integration routes were probed directly:

| route | baseline | isolated |
|---|---|---|
| `<iframe src="https://ui.perfetto.dev/">` | loads **[M]** | **blocked** — `net::ERR_BLOCKED_BY_RESPONSE` **[M]** |
| `window.open(...)` then `postMessage` | popup keeps `window.opener` **[M]** | popup reports `window.opener === null` **[M]** |

Both die. The iframe is a cross-origin subresource with no CORP, so `require-corp` rejects it; the
popup lands in a different browsing-context group, so the opener is severed and Perfetto's own
documented handoff — open the UI, then `postMessage` the trace into it — can never complete.
(The iframe fires `load` even when blocked, because the frame becomes an error page; the verdict
comes from the network layer, which is what the harness records.)

`COOP: same-origin-allow-popups` keeps the popup but does **not** grant `crossOriginIsolated`, so
"isolate *and* pop out to Perfetto" is not a configuration that exists **[C]**. Cross-origin
isolation and the #887 secondary viewer are mutually exclusive, and **Perfetto wins**.

## 6. The options, in cost order

| # | option | cost | what it buys | evidence |
|---|---|---|---|---|
| 1 | **Aggregate**: count N, sum the quantised spans, report per-phase totals | none — works today | the aggregate answer, within 15–20% **[M]** | §3 |
| 2 | **Publish the floor**: every span carries its clock source and resolution | none | stops the trace implying precision it lacks | §7 |
| 3 | **Server-side timing** for server work | already there — Rust `Instant` is ns | nothing for browser stages | §7 |
| 4 | **A better in-browser clock source** | — | — | see below |
| 5 | **Cross-origin isolation** | one header pair on our own origin; **costs Perfetto entirely** | 20× floor; real per-span visibility on the 5–30 µs stages | §3, §5 |

On option 4, the ticket's "move the hot spans to a source with a better clock": there is no such
source in the browser. Wasm/`lucida-core` reads the same clamped clock — wasm has no privileged
timer **[C]**, and the classic workaround (a counter thread over `SharedArrayBuffer`) requires
cross-origin isolation anyway, so it collapses into option 5. `[U]` WebGPU `timestamp-query` is the
one unexamined candidate: it would cover GPU passes only, Chrome applies its own quantisation to
the results, and neither the quantum nor the coverage was measured here. Worth a look only if GPU
pass timing turns out to matter to #886.

## 7. What #886 and #894 must design against

1. **Floor = 100 µs in the browser, main thread and workers alike; nanoseconds on the server.**
   Every span record carries its clock source and that source's resolution. The merged timeline is
   **5 orders of magnitude** coarser on one side (1 ns vs 100 µs) **[C]**, and per `intention.md` a
   confidently-wrong picture is a failure — so the trace must not let a renderer imply browser-side
   precision that does not exist.
2. **Never emit a single browser span shorter than the floor as a duration.** The model needs a
   second record kind — *counted, not timed*: `{stage, count N, non-zero readings k, summed
   duration}`. `buildContext`, upload dispatch and client decode are all counted stages.
3. **Report an aggregate once k ≥ 25 non-zero readings (±20%); below that, show the count only**
   **[C]**. A fixed "≥ 100 events" rule would be wrong in both directions.
4. **Dynamic range is ~2 × 10⁵** **[C]** — 100 µs floor to #899's 19.8 s worst queue wait — and the
   interesting time is at the *top* of it: >90% of a chunk's life is our own queueing, which a
   100 µs clock measures perfectly. A model that renders the long waits faithfully and marks the
   short end as quantised is the requirement; flattening the waits to make the short end look
   precise is the failure mode.
5. **The instrument must not cost more than what it measures** — per-span timing of the finest
   stages more than triples them **[M]**.
6. **Do not set COOP/COEP** — not because it would break remote data (it demonstrably does not),
   but because the per-span visibility it buys covers 0.18% of a pan while costing the Perfetto
   viewer outright. Revisiting is cheap: one header pair on our own origin, and §4 is the evidence
   that the data path survives.

## 8. Reproducing

```bash
# full-app arm (needs a built SPA + server binary and working ADC for the gs:// fixture)
git apply docs/research/timer-resolution-instrumentation.patch
(cd lucida-core && wasm-pack build --target web --out-dir pkg)
(cd lucida-web && pnpm install --force && pnpm run build)
CARGO_TARGET_DIR=/tmp/tr-target cargo build --release -p lucida-server
python3 docs/research/timer-resolution-harness/tr_run.py /tmp/tr/run-1 \
  gs://calico-ylm-zarr-01/processed_zarrs/20260626_Guk1_BY_DHY.v1319.processed_catchers.zarr both
git checkout -- lucida-server lucida-web && rm -f lucida-web/src/trStageProbe.ts

# standalone arm (no build, no credentials, ~40 s): worker clock + the Perfetto probes
NODE_PATH=~/.cache/lucida-tryout/playwright/node_modules \
  node docs/research/timer-resolution-harness/tr_probe.cjs /tmp/tr/probe.json
```
