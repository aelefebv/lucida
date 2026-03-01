# S1 Canonical Demo Runbook

## Purpose

Run a repeatable local S1 verification pass and emit a machine-readable report for milestone checks.

## Prerequisites

- Rust toolchain (`cargo`)
- Node.js + npm
- Python 3

## Run

From repo root:

```bash
./scripts/s1_demo.sh
```

## Success markers

The run is considered successful when output includes:

- `S1_DEMO_PASS`
- `T-M1-01: passed`
- `T-M1-02: passed`
- `T-M1-03: passed`
- `T-M1-04: passed`
- `T-M1-05: passed`

The JSON report is written to:

- `qa/reports/s1_demo_report.json`

`T-M1-02` is runtime-backed: it opens a real TIFF source, waits for generation readiness, and verifies that `/v1/data` preview/tile payloads decode to source-derived pixels.

For a stage-by-stage workflow (source open, canonical cache, preview/refine, stable interactive 2D), see:

- [docs/s1_2d_viewing_workflow.md](./s1_2d_viewing_workflow.md)
