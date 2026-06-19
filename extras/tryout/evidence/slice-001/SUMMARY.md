# Slice 1 evidence — one-command environment bring-up

**What shipped:** `python3 extras/tryout/tryout.py up` — boots a real `lucida-server`
from the current working tree on a free port + throwaway temp DB (`LUCIDA_AUTH=disabled`),
waits on `/healthz`, creates a workspace, opens a fixture read-only, captures
`server.log` + `up.json`, prints one machine-readable JSON object, and tears the
server down cleanly. The spine every later surface (CLI / Python / web) builds on.

**Why:** an AI agent (or a human) can now stand up lucida and get a usable handle
(`base_url`, `ws_url`, `workspace_id`, `dataset_id`) with one command, leaving behind
artifacts a human can open to verify the run — without touching the real `lucida.db`.

## User stories satisfied
1. *Agent, one command* → one invocation returns complete, directly-usable JSON.
2. *Maintainer, verifiable* → `server.log` (real server tracing) + `up.json` saved.
3. *Contributor, my changes* → builds from the working tree (or reuses a pointed-at
   binary via `LUCIDA_TRYOUT_SERVER_BIN`), reflecting uncommitted code.
4. *Safe by default* → ephemeral port, throwaway temp DB, read-only fixture, always
   reaped (verified: no orphans).

## How it was selected (hybrid tournament)
- 4 black-box makers built distinct implementations (single-file CLI, modular package,
  Python-client, ergonomics-first), each in an isolated worktree.
- **Objective axis** (`adapter fitness`, run for real against lucida): all 4 viable,
  acceptance = 1.0 / heldout = 1.0 — a saturated tie.
- **Subjective axis** (blind judge panel, Bradley-Terry; calibration recovered the
  weak<strong anchor order on all dims): the winner is the **sole Pareto-dominant**
  point — ergonomics 0.98, verifiability 0.75, robustness 0.99. Judges cited its real
  timestamped `server.log` tracing, fail-fast bad-path handling, and rich JSON.
- **Review (independent):** verdict **SHIP**. Hermeticity verified by reproduction
  (real `lucida.db` md5 unchanged, fixture byte-identical, child always reaped). Two
  minor findings fixed before ship: graceful failure on a non-directory `--out`, and a
  real `server_log` pointer in the failure record (so the log is findable exactly when
  boot fails — the moment it matters most).

## Verification artifacts (this run, real lucida)
- `sample-up.json` — the machine-readable result of an actual bring-up (lif fixture;
  booted on an ephemeral port, healthz in ~0.12s, clean teardown). Paths sanitized.
- `sample-server-log-head.txt` — the real server's startup trace header.
- `usage-session.md` — the judge-facing usage session (up with fixture / no fixture /
  bad fixture / --help).
- Full, unsanitized run artifacts are written to the gitignored `.tmp/tryout/` for
  local verification.
