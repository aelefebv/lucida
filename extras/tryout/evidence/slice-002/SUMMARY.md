# Slice 2 evidence — CLI + Python surface drive + capture

**What shipped:** `python3 extras/tryout/tryout.py drive --surface cli|python|all` — brings
lucida up (reusing slice 1), then exercises the requested surface(s) against the real
opened dataset and captures everything:
- **CLI**: a realistic tour (status, workspace/dataset/viewer reads in human *and*
  `--json`, plus real mutations) — each command saved to `OUT/cli/NN-<name>.log` with
  argv + stdout + exit code, recorded in `OUT/drive.json`.
- **Python**: a genuine `LucidaClient` session (connect → workspace → datasets
  list/info/health → view/layer ops) captured to `OUT/python/session.log`.

A failing CLI command is **captured, not fatal** (recorded with its exit code; the tour
continues). Hermetic + always-reaped, like slice 1.

## User stories satisfied
1. *Agent tours the CLI* → one command, real CLI session, each output + exit code handed back.
2. *Agent tours Python* → a real LucidaClient session, captured.
3. *Maintainer verifies* → `cli/*.log`, `python/session.log`, `drive.json` reconstruct the run.
4. *Robust* → failing command recorded-not-fatal; clean teardown.

## How it was selected
- 3 black-box makers (faithful-extension, capture-centric, broad-coverage), each extending
  slice 1's package in a train worktree.
- **Objective** (`fitness`, run for real): all viable; c2 & c3 tied at acceptance 1.0 /
  heldout 1.0 (c1 1.0/0.75 — its `drive` summary omitted `db_path`).
- **Subjective** (blind judge panel, Bradley-Terry; calibration recovered weak<strong on
  every dim): the winner is the **sole Pareto-dominant** point — coverage_realism 0.98,
  verifiability 0.98, robustness 0.91 (16 CLI commands + a 12-step Python session, with
  per-command argv+exit+log+duration).
- **Review (independent):** verdict **SHIP**, with live reproduction of the three
  load-bearing guarantees (captured-not-fatal, always-reap incl. SIGINT, throwaway
  DB/config that never touches the repo or `~/.config/lucida`). One minor hygiene finding
  fixed before ship: `cli/` is cleared on `--out` reuse so stale logs can't accumulate.

## Verification artifacts (this run, real lucida)
- `sample-drive.json` — the machine-readable result of an actual `drive --surface all`
  (16/16 CLI commands captured, Python session ran). Paths sanitized.
- `cli-commands.txt` — the captured CLI log filenames (the tour).
- `python-session-head.txt` — head of the real LucidaClient session transcript.
- `usage-session.md` — the judge-facing usage session.
- Full unsanitized artifacts: gitignored `.tmp/tryout/slice-002/`.
