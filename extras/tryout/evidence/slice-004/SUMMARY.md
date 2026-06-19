# Slice 4 evidence — unified cross-surface verification report (capstone)

**What shipped:** `python3 extras/tryout/tryout.py report` — the capstone. One command
runs every surface (`drive --surface all`: CLI + Python + web) and writes a **single,
self-contained `report.html`** (plus a `report.md` mirror) that a human opens to verify
lucida works end-to-end — **without re-running anything**. With no `--out`, evidence
lands in a gitignored, timestamped `.tmp/tryout/<ts>/`.

## The headline artifact (open this)
- **`report.html`** — self-contained: the web screenshots are **embedded as base64**, so
  the file opens/shares standalone. It shows a PASS/FAIL banner, the CLI command table
  (with exit codes), the Python steps, the inline viewer/SPA screenshots, run metadata
  (commit, base_url, workspace, dataset), and a `server.log` excerpt. (Committed here as
  the slice's key shot; paths sanitized.)
- `sample-report.json` — the machine-readable `report` result (sanitized).

## User stories satisfied
1. *One command, full verification* → `report` exercises CLI+Python+web → `report.html`.
2. *Knows where things go* → default gitignored `.tmp/tryout/<ts>/`, `out_dir` reported.
3. *Report-on-failure* → a bad fixture still writes a report showing the failure (exit ≠ 0).
4. *Discoverable* → `extras/tryout/README.md` + an `AGENTS.md` pointer for the next agent.

## How it was selected
- 3 black-box makers (faithful-package, **portable-html** = base64-embedded standalone,
  robustness-first defensive render); all viable, acceptance 1.0 / heldout 1.0.
- **Subjective** (blind judge panel, Bradley-Terry; calibration recovered weak<strong on
  every dim): Pareto front {winner, runner-up}; the winner leads report_quality (0.98) +
  ergonomics (0.95) — a truly self-contained single-file report, ideal for "one report a
  human opens to verify."
- **Review (independent):** verdict **SHIP** — verified the embedded screenshots decode
  byte-for-byte to the real on-disk PNGs (a genuine content-bearing viewer render),
  honest PASS/FAIL, report-on-failure, gitignored default output (git stays clean), full
  hermeticity / no orphans across happy/failure/interrupt paths (inherits slice-3's
  group-reaping by reusing `drive`). One minor wording gap fixed (the "always written"
  claim now notes that an operator Ctrl-C may skip the report write).

Full unsanitized artifacts: gitignored `.tmp/tryout/slice-004/`.
