# timer-resolution harness (issue #897)

Measurement tooling for `docs/research/timer-resolution.md`. Not part of the product and not wired
into CI. Derived from `docs/research/remote-rates-harness/` (#899) — read that README on branch
`research/remote-rates` first; its gotchas still apply (ADC not a service account, DPR2 verified
from real screenshot pixels, private `CARGO_TARGET_DIR`, no `timeout(1)` on macOS).

Three files:

- `tr_clock.js` — the probe **source strings**, shared by both runners. They live in one place
  because the first version copied them into both files and the copies drifted; see the gotchas.
- `tr_run.py` + `tr_driver.cjs` — the full-app arm.
- `tr_probe.cjs` — the standalone arm.

Raw output from the run written up in `docs/research/timer-resolution.md` is committed under
`docs/research/timer-resolution-results/`.

## `tr_run.py` — the full-app arm

Boots `lucida-server`, opens a dataset, drives the real SPA at DPR2, and runs the clock probe in
the live page. Runs twice against the same fixture:

- **baseline** — no COOP/COEP (what lucida ships).
- **isolated** — `LUCIDA_COI=1`, which makes the throwaway patch send `COOP: same-origin` +
  `COEP: require-corp` from `static_serve.rs`.

The isolated arm is the crux experiment, and it does double duty. If `COEP: require-corp` cost
lucida anything it would show up as a blocked request or a dataset that never renders (it does
neither) — and because the arm also runs at 5 µs, it is the **ground truth** the 100 µs arm's
aggregates are checked against.

The instrumentation patch times three real stages — `buildContext` (`renderLoop`),
`tryDispatchDelivery` (uploader) and decompress+normalize (decode worker, reported to the main
thread on the decode response) — recording the **raw quantised delta histogram**, never a mean.

```bash
git apply docs/research/timer-resolution-instrumentation.patch
(cd lucida-core && wasm-pack build --target web --out-dir pkg)
(cd lucida-web && pnpm install --force && pnpm run build)
CARGO_TARGET_DIR=/tmp/tr-target cargo build --release -p lucida-server

python3 docs/research/timer-resolution-harness/tr_run.py /tmp/tr/run-1 \
  gs://calico-ylm-zarr-01/processed_zarrs/20260626_Guk1_BY_DHY.v1319.processed_catchers.zarr both

# put the tree back (the patch adds a file, so removing it is part of the revert)
git checkout -- lucida-server lucida-web/src && rm -f lucida-web/src/trStageProbe.ts
```

Writes `<arm>/<arm>-summary.json`, `<arm>-console.log` and DPR2 screenshots per arm.

## `tr_probe.cjs` — the standalone arm

No build, no credentials, ~40 s. Serves a minimal page from a local node server twice (plain and
with COOP/COEP) and answers what the full-app run cannot reach:

- **worker-thread clock granularity** — decode and render run in workers, so the floor there is the
  one that binds;
- whether `ui.perfetto.dev` can be **iframed** on an isolated page (#887's recommendation);
- whether the **`window.open` + `postMessage`** handoff survives `COOP: same-origin`.

```bash
NODE_PATH=~/.cache/lucida-tryout/playwright/node_modules \
  node docs/research/timer-resolution-harness/tr_probe.cjs /tmp/tr/probe.json
```

## Gotchas this run paid for

- **`page.evaluate("(() => …)")` silently returns `undefined`.** A string that evaluates to a
  *function* is not called, and Playwright cannot serialise it, so the result key just vanishes
  from the JSON instead of erroring. Every probe string must end in `()`. Two probes were quietly
  missing from a whole run before this was caught — check that every expected key is present, not
  just that the run said `ok`.
- **`about:blank` cannot detect COOP.** A same-origin or `about:blank` popup inherits its opener
  regardless of policy. The opener-severing probe must open a genuinely **cross-origin** URL.
- **Count distinct deltas and keep the histogram; never a mean.** The clamp shows up as *exactly
  one* distinct non-zero delta across millions of samples, and "average 0.004 ms" reads like a 4 µs
  stage when the truth is 96% zeros and 4% one whole 100 µs tick. Different fact.
- **A synthetic stand-in is not the stage.** The first pass measured a 35 ns `Map` lookup and
  concluded a 5 µs clock would not help either. Real upload dispatch is 5–30 µs, where a 5 µs clock
  helps a great deal. Instrument the real stage before drawing a conclusion about it.
- **Measure the clock before waiting for the dataset**, so a failed open still yields a clock
  answer — in the isolated arm, a failed open would have *been* the answer.
