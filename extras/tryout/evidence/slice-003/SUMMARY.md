# Slice 3 evidence — web client surface (screenshots)

**What shipped:** `python3 extras/tryout/tryout.py drive --surface web` (and `web` is
now part of `--surface all`). It serves the SPA (reusing a prebuilt
`LUCIDA_TRYOUT_WEB_DIST` or building it), opens the dataset, and captures the web
client — **layered**:
- **Floor:** a **non-blank** screenshot of the real rendered viewer via lucida's own
  headless-Chrome path (`viewer screenshot`/`overview`) → `web/viewer.png`, with the
  workspace URL recorded.
- **Ceiling:** drives the **real SPA** in a browser (Playwright via the system Chrome),
  waiting for the product's own render-ready signal, capturing a full-page
  `web/spa.png` + the browser `web/console.log`.

## Key shots (committed — look at these)
- `shots/viewer.png` — the real lucida viewer rendering the dataset (headless capture).
- `shots/spa.png` — the full SPA page driven in a real browser.

## User stories satisfied
1. *Agent sees the UI* → one command renders the real web client and saves a non-blank PNG.
2. *Maintainer verifies visually* → open `shots/viewer.png` / `shots/spa.png`.
3. *All surfaces* → `drive --surface all` now captures CLI + Python + web together.
4. *Robust* → headless/browser hiccups captured-not-fatal; bad fixture graceful.

## How it was selected
- 3 black-box makers (CLI-floor + Playwright, Playwright-via-system-Chrome, raw-CDP
  no-Playwright); **all three delivered both the floor and the real-SPA ceiling**.
- **Objective** (`fitness`, real headless screenshots): all viable, acceptance 1.0 /
  heldout 1.0 — `png_nonblank` passed for every candidate (real, content-bearing renders).
- **Subjective** (blind judge panel, Bradley-Terry; calibration recovered weak<strong on
  every dim): Pareto front {winner, runner-up}; the winner leads the intent-aligned axes
  (screenshot_quality 0.98, verifiability 0.98) — its result carries per-artifact
  non-blank proof + a structured render-ready block (canvas 800×600, frame_count,
  dataset_count, page_errors:0) that confirms the real viewer painted the data.
- **Review (independent):** initial verdict **BOUNCE** — a real hermeticity gap (browser
  subprocesses not group-reaped on signal/hard-timeout → orphaned Chrome). **Fixed and
  re-verified**: all browser/CLI/npm spawns now run in their own process group and are
  group-SIGKILLed on timeout/signal (mirrors the server spine). Reproduced the orphan
  scenario — a grandchild is now reaped; the normal path still produces a non-blank
  render with zero orphans.

## Verification artifacts (this run, real lucida)
- `shots/viewer.png`, `shots/spa.png` — the committed key screenshots.
- `sample-drive.json` — the machine-readable web-surface result (sanitized).
- `usage-session.md` — the judge-facing session. Full artifacts: gitignored `.tmp/tryout/slice-003/`.
