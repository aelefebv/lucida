# timer-resolution harness (issue #897)

Measurement tooling for `docs/research/timer-resolution.md`. Not part of the product and not wired
into CI. Derived from `docs/research/remote-rates-harness/` (#899) — read that README on branch
`research/remote-rates` first; its gotchas still apply (ADC not a service account, DPR2 verified
from real screenshot pixels, private `CARGO_TARGET_DIR`, no `timeout(1)` on macOS).

Two pieces, because the questions split cleanly:

## `tr_run.py` — the full-app arm

Boots `lucida-server`, opens a dataset, drives the real SPA at DPR2, and runs the clock probe in
the live page. Runs twice against the same fixture:

- **baseline** — no COOP/COEP (what lucida ships).
- **isolated** — `LUCIDA_COI=1`, which makes the throwaway patch send `COOP: same-origin` +
  `COEP: require-corp` from `static_serve.rs`.

The isolated arm is the crux experiment: if `COEP: require-corp` cost lucida anything, it would
show up as a blocked request or a dataset that never renders. It does neither.

```bash
git apply docs/research/timer-resolution-instrumentation.patch
(cd lucida-core && wasm-pack build --target web --out-dir pkg)
(cd lucida-web && pnpm install --force && pnpm run build)
CARGO_TARGET_DIR=/tmp/tr-target cargo build --release -p lucida-server

python3 docs/research/timer-resolution-harness/tr_run.py /tmp/tr/run-1 \
  gs://calico-ylm-zarr-01/processed_zarrs/20260626_Guk1_BY_DHY.v1319.processed_catchers.zarr both

git checkout -- lucida-server   # put the tree back
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
- **The clock probe must count distinct deltas, not a mean.** The clamp is visible as *exactly one*
  distinct non-zero delta across millions of samples; an average hides it completely.
- **Measure the clock before waiting for the dataset**, so a failed open still yields a clock
  answer — in the isolated arm, a failed open would have *been* the answer.
