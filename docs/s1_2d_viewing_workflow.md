# S1 2D Workflow: Source -> Cache -> Preview/Refine -> Stable Interaction

## Purpose

This runbook shows how to execute and verify the full S1 integrated 2D flow:

1. open a source
2. build canonical cache artifacts
3. get first preview then refinement
4. maintain stable interactive 2D behavior (including reconnect)

## Prerequisites

- Rust toolchain (`cargo`)
- Node.js + npm
- Python 3

From repo root, install client dependencies once:

```bash
cd client-web
npm ci
cd ..
```

## Fast Path (Recommended)

Run the canonical S1 script:

```bash
./scripts/s1_demo.sh
```

Expected success markers:

- `S1_DEMO_PASS`
- `T-M1-01: passed`
- `T-M1-02: passed`
- `T-M1-03: passed`
- `T-M1-04: passed`
- `T-M1-05: passed`

Report output:

- `qa/reports/s1_demo_report.json`

## Stage-by-Stage Workflow

Use this path when you want to validate each stage independently.

### 1) Open Source + Build Canonical Cache

```bash
cd engine
cargo test --test session_manager_integration session_manager_builds_canonical_cache_for_generation_and_records_location -- --exact
```

This exercises source registration, generation lifecycle, and canonical cache layout creation.

### 2) First Preview + Refinement

Engine-side preview/tile artifact build:

```bash
cd engine
cargo test --test session_manager_integration session_manager_builds_preview_and_tile_manifest_for_generation -- --exact
```

Browser-side preview-first/refinement behavior:

```bash
cd client-web
npm run test -- test/app-shell-routing.test.ts -t "renders preview-first then tile refinement with coherent minimap and warnings"
```

### 3) Stable Interactive 2D Viewing

Interaction isolation across clients:

```bash
cd client-web
npm run test -- test/viewer-runtime-interaction.test.ts -t "keeps interactions scoped to the initiating client"
```

Reconnect recovery with authoritative rehydration:

```bash
cd client-web
npm run test -- test/viewer-runtime-interaction.test.ts -t "reconnects and rehydrates authoritative state after transport drop"
```

### 4) Full M1 Acceptance Matrix

```bash
python3 qa/harness/run_s1_acceptance.py --report-path qa/reports/s1_acceptance_report.json
```

The report contains explicit per-case status for `T-M1-01` through `T-M1-05`.

## Optional Manual Runtime Bring-up

This path is useful for transport/viewer debugging.

If local startup fails with `address already in use`, clear current sessions/processes first:

```bash
./scripts/close_sessions.sh
```

Start engine runtime:

```bash
cd engine
cargo run --bin lucida-engine -- --bind 127.0.0.1:8787 --cache-root ../.tmp/cache
```

Start web app:

```bash
cd client-web
npm run dev -- --host 127.0.0.1 --port 5173
```

Create session:

```bash
curl -sS -X POST http://127.0.0.1:8787/v1/sessions \
  -H 'content-type: application/json' \
  -d '{"name":"manual-s1"}'
```

Open viewer in browser:

```text
http://127.0.0.1:5173/viewer?session=<SESSION_ID>&wsBase=ws://127.0.0.1:8787&dataBase=http://127.0.0.1:8787
```

Current manual controls in app shell:

- Arrow keys: pan left/right
- `+` / `-`: zoom in/out
- `]`: set z index
- `t`: set t index
- `c`: set channels

Note: the authoritative source/cache/preview refinement validation path is the acceptance harness and targeted tests above.
