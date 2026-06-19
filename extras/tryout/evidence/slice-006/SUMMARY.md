# Slice 6 evidence — scenario layer (verify a feature like a user → screenshot → email)

**What shipped:** a reusable **scenario layer** — `python3 extras/tryout/tryout.py drive
--scenario <name>` — that turns "exercise a specific feature the way a user would, capture
named screenshots, optionally email them" into **one repeatable command**, plus the first
real scenario, **`mentions`**.

- A **scenario registry** (`extras/tryout/tryout/scenarios/`, mirroring slice-5's surface
  registry): each scenario is a small module; a shared runner hands it a booted env + a
  **WS-seed helper** + a **Playwright page** (slice-3 launch config) + a **`shot()` capture
  helper**. `drive --scenario list` lists them; an unknown name errors cleanly.
- **`mentions` scenario:** pins the browser identity, seeds a pin + mention comments over
  the WebSocket protocol (handle computed via a verified `deriveHandle` port), drives the
  real @-mention UI **by `data-testid`** (badge → panel → thread chips → autocomplete), and
  captures four non-blank shots.
- **`--email`:** bundles the shots + a summary and hands them to **courier** — **dry-run by
  default** (previews, sends nothing); only `--email-send` actually sends; a missing courier
  is recorded, never fatal, never a send.

So the whole "verify @-mentions and email me the shots" exercise is now:
`tryout drive --scenario mentions --email-send`.

## Key shots (committed)
- `shots/mentions-badge.png` — the "@ Mentions" indicator lit by a seeded mention.
- `shots/thread-chips.png` — the thread with rendered `@…` mention chips.
- `mentions-scenario.json` — the scenario result (4 non-blank shots; email dry-run) sanitized.

## How it was selected
- 2 black-box makers (registry, declarative). Objective fitness ran the **mentions scenario
  for real** against a mentions-bearing build: winner **1.0 / 1.0 viable** (all four shots
  non-blank, `--email` dry-run with `sent:false`, `--scenario list` + unknown-name clean,
  slices 1–5 regressions intact). The runner-up scored 0.75 — its `--scenario list` exited
  2 (independent verification caught what self-report missed).
- **Review (independent):** verdict **SHIP**, with the two load-bearing properties verified
  by code-trace + live argv capture: **`--email` never surprise-sends** (dry-run unless
  `--email-send`; courier-absent graceful) and **no orphan server/browser** on
  success/error/signal; `deriveHandle` exact (incl. surrogate-pair inputs); real
  testid-driven non-blank shots. Three minor/info findings logged (not blocking): unknown
  scenario without `--out` exits 2 rather than 1; the registry keeps a vestigial
  `Scenario.run` alongside the `SPEC` it actually drives; some timeout-decode duplication.

Note: the `mentions` scenario needs a mentions-bearing build (it drives whatever
`LUCIDA_TRYOUT_*` points at). Full unsanitized run: gitignored `.tmp/tryout/slice-006/`.
