# Slice 5 evidence — refactor: unify the surface contract (behavior-preserving)

**Why:** the cross-slice coherence panel (after slice 4) found the harness worked but
read as *four maker styles* at the seams — no shared surface contract, `drive`/`report`
special-casing each surface, a JSON-scan helper copied 3×, and (a real bug) the CLI and
Python surfaces spawning via plain `subprocess.run` — an orphan risk on timeout that slice
3 had only fixed for the *web* surface. It enqueued a refactor slice.

**What shipped (behavior-identical, internals unified):**
- A shared **`SurfaceResult`** contract in `surfaces/__init__.py` that cli/python/web
  results subclass (uniform `name`/`ran`/`ok`/`passed`/`total`/`error` + an extra/artifacts
  bag) — every existing `to_dict()` JSON key preserved.
- A surface **registry** so `drive` and `report` iterate generically — no per-surface
  if-ladders.
- **One** shared subprocess helper `surfaces/_subproc.py` (`run_group` with
  process-group reaping on timeout/signal, `scan_json_line`, `shquote`) used by **all
  three surfaces** — closing the CLI/Python orphan risk.
- One record/artifact writer via `capture`; promoted cross-module APIs to public; a
  Makefile `report` target; accurate README.

## Verification
- **Behavior preserved (regression gate, run for real):** `up`, `drive --surface all`,
  and `report` all pass at acceptance 1.0 / heldout 1.0; both candidates self-verified
  their stdout JSON is **byte-identical to the pre-refactor baseline**, the web
  screenshot stays non-blank, default-out + report-on-failure unchanged, no orphans.
  (The current train baseline was confirmed to pass this same net before the refactor.)
- **Coherence (independent architect re-audit):** the winner scored **5/5 — COHERENT**:
  a real subclassed contract, a populated registry that `drive`/`report`/`cli` all
  iterate (no result-handling if-ladders), a single `run_group` adopted by every
  child-spawning tour incl. the previously-orphan-prone cli/python, single-sourced
  scanner/writer, no underscore-private cross-module imports, accurate docs. (The
  runner-up reached 4/5 with a residual if-ladder; this candidate won on coherence with
  identical behavior.)
- **Post-refactor smoke (this run):** `report --surface all` → ok, all surfaces, fresh
  `report-after-refactor.html`, no orphans.

## Artifacts
- `report-after-refactor.md` — the text mirror of a full verification report produced by
  the **refactored** harness (proves behavior end-to-end), sanitized. (The self-contained
  HTML version, ~270KB of base64, is produced live into the gitignored `.tmp/tryout/` —
  run `report` to see it.)
