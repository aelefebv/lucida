# Lucida Acceptance Traceability Matrix

Version: 0.1  
Date: 2026-03-01  
Status: Baseline traceability matrix for M0-M6

## 1. Purpose

This matrix turns Lucida requirements into traceable tests that can be executed against milestone gates.

It provides:
- feature-to-test mapping
- feature-to-gate mapping
- milestone exit criteria to test-ID mapping
- fixture requirements for each test

This document is the acceptance-matrix deliverable for `LUC-003`.

## 2. Source Documents

- `docs/spec.md`
- `docs/protocol_and_schemas.md`
- `docs/sequences.md`
- `docs/acceptance.md`
- `docs/lucida_vertical_slices.md`
- `docs/implementation_plan.md`

## 3. Conventions

- Test IDs use `T-Mx-yy` where `x` is the milestone (`0..6`).
- Tests are integration/e2e/perf workflows against real fixtures, not mocks.
- Gates refer to `docs/acceptance.md` Gate A through Gate F.

## 4. Gate-to-Milestone Coverage

| Milestone | Required gate coverage |
|---|---|
| M0 | Gate A (contract compliance baseline) |
| M1 | Gate A + Gate B subset for 2D and generation consistency |
| M2 | Gate A + Gate B + Gate E subset for scene/context artifacts |
| M3 | Gate A + Gate C subset for labels/metadata filtering |
| M4 | Gate A + Gate B full for 3D interaction behavior |
| M5 | Gate A + Gate C full for target/cutout/publish workflows |
| M6 | Gate A-F full (release-hardened behavior) |

## 5. Feature-to-Test-and-Gate Matrix

| Feature area | Primary tests | Milestone | Gate(s) |
|---|---|---|---|
| Contract schemas and message envelopes | T-M0-01, T-M0-02 | M0 | A |
| Repo bootstrap and CI baseline | T-M0-03 | M0 | A |
| Session attach/snapshot/events | T-M1-01 | M1 | A, B |
| Source open and progressive preview/refinement | T-M1-02 | M1 | B |
| 2D navigation (pan/zoom/z/t/channel) | T-M1-03 | M1 | B |
| Reconnect and state recovery | T-M1-04 | M1 | B, F |
| No mixed-generation frame under source updates | T-M1-05 | M1 | B, F |
| Shared targets and cross-client jumps | T-M2-01 | M2 | C, E |
| Scene export/import round-trip | T-M2-02 | M2 | E |
| Context package capture/reopen fidelity | T-M2-03 | M2 | E |
| Warning persistence in artifacts | T-M2-04 | M2 | E |
| Label outlines in 2D | T-M3-01 | M3 | C |
| Dense remap for sparse large IDs | T-M3-02 | M3 | C, F |
| Metadata hot-reload and filter recompute | T-M3-03 | M3 | C |
| Incomplete index/metadata mismatch warnings | T-M3-04 | M3 | C |
| 3D progressive entry and coarse usability | T-M4-01 | M4 | B |
| Orthoslice + slab/MIP + raymarch modes | T-M4-02 | M4 | B |
| 3D camera target semantics | T-M4-03 | M4 | B |
| Brick autotuning and bounds behavior | T-M4-04 | M4 | B, F |
| Deterministic RegionRecipe generation | T-M5-01 | M5 | C |
| LOD-aware cutout with halo rules | T-M5-02 | M5 | C |
| Sparse publish writeback and transparency semantics | T-M5-03 | M5 | C |
| Overwrite vs new-layer publish flows | T-M5-04 | M5 | C |
| Stale-base and computed-at-LOD warnings | T-M5-05 | M5 | C |
| Open-view and token-view exposure modes | T-M6-01 | M6 | D |
| Lease steal path and audit attribution | T-M6-02 | M6 | D |
| Derived-layer ACL enforcement | T-M6-03 | M6 | D |
| Audit query usability | T-M6-04 | M6 | D |
| Source-churn and reconnect robustness | T-M6-05 | M6 | F |
| Observability and telemetry baseline | T-M6-06 | M6 | F |

## 6. Milestone Exit Criteria to Test Mapping

### M0

| Exit criterion (`implementation_plan.md`) | Linked tests |
|---|---|
| Schema and sequence docs accepted as implementation contracts | T-M0-01, T-M0-02 |
| Repository structure, CI, formatting, and package boundaries exist | T-M0-03 |
| Dependency graph stable enough for parallelization | T-M0-02, T-M0-03 |

### M1

| Exit criterion (`implementation_plan.md`) | Linked tests |
|---|---|
| A source can be opened | T-M1-02 |
| A client can attach and receive snapshot/events | T-M1-01 |
| 2D preview and refinement render correctly | T-M1-02 |
| Pan/zoom/z/t/channel interaction works | T-M1-03 |
| Generation consistency invariant holds in 2D | T-M1-05 |

### M2

| Exit criterion (`implementation_plan.md`) | Linked tests |
|---|---|
| Scene files export/import correctly | T-M2-02 |
| Context packages capture and reopen correctly | T-M2-03 |
| Shared Targets can be created and jumped to | T-M2-01 |
| Warnings are surfaced in UI and artifacts | T-M2-04 |

### M3

| Exit criterion (`implementation_plan.md`) | Linked tests |
|---|---|
| Labels render with outlines | T-M3-01 |
| SQLite sidecars load and hot-reload | T-M3-03 |
| Filter DSL drives visibility masks | T-M3-03 |
| Million-scale sparse IDs handled via dense remap | T-M3-02 |

### M4

| Exit criterion (`implementation_plan.md`) | Linked tests |
|---|---|
| Lazy brick build works | T-M4-01 |
| Orthoslices, slab/MIP, and raymarch render from bricks | T-M4-02 |
| 3D camera target semantics are stable | T-M4-03 |
| 3D entry is progressive and predictable | T-M4-01, T-M4-04 |

### M5

| Exit criterion (`implementation_plan.md`) | Linked tests |
|---|---|
| RegionRecipe generation is stable | T-M5-01 |
| Chunked cutouts materialize at chosen LODs | T-M5-02 |
| Sparse derived layer publish works | T-M5-03 |
| Overwrite/new derived layer flows work | T-M5-04 |
| Stale-base warnings and LOD provenance visible | T-M5-05 |

### M6

| Exit criterion (`implementation_plan.md`) | Linked tests |
|---|---|
| Open-view LAN mode and token modes work | T-M6-01 |
| Lease stealing and audit log work | T-M6-02, T-M6-04 |
| Derived-layer ACLs work | T-M6-03 |
| Perf, observability, and source-churn tests pass | T-M6-05, T-M6-06 |

## 7. Test Catalog

| Test ID | Description | Sequence refs | Fixtures | Environment |
|---|---|---|---|---|
| T-M0-01 | Validate protocol/schema envelope and revision contract conformance across command, ack, snapshot, event, and error payload classes. | Seq 01 baseline envelopes | D1 | E1 |
| T-M0-02 | Validate contract freeze integrity: command families and sequence operation references remain consistent with protocol and no unresolved blocking contract items exist. | Seq 01-05 command paths | D1 | E1 |
| T-M0-03 | Validate CI baseline runs lint/typecheck/unit tests/build for engine and client on each PR/push. | N/A (build/test infrastructure) | N/A | E1 |
| T-M1-01 | Attach client, receive snapshot, apply event stream, and confirm authoritative reconciliation semantics. | Seq 01 | D1 | E1, E2 |
| T-M1-02 | Add source and verify preview-first paint followed by quantitative 2D refinement for same generation. | Seq 02 | D1, D2 | E1, E2 |
| T-M1-03 | Validate pan/zoom/z/t/channel interaction loop with cancellation and replacement behavior. | Seq 05 | D2 | E1, E2 |
| T-M1-04 | Disconnect/reconnect and verify snapshot + subsequent events fully recover state. | Seq 01 | D1, D2 | E2, E3 |
| T-M1-05 | Trigger source mutation and verify no rendered frame mixes generations per layer. | Seq 04 | D4 | E4 |
| T-M2-01 | Create shared target from one client and jump from another client to same location/context. | Seq 07 | D2, D6 | E3 |
| T-M2-02 | Export/import scene and verify shared scene structure and generation references restore coherently. | Seq 13 | D2, D6 | E2, E3 |
| T-M2-03 | Capture and reopen context package and verify viewport, minimap, and provenance fidelity. | Seq 12 | D1, D2 | E1, E2 |
| T-M2-04 | Verify warnings survive scene/context artifact export and reopen. | Seq 12, Seq 13 | D2, D4 | E2 |
| T-M3-01 | Render labels with outlines in 2D with interactive usability. | Seq 10 | D5 | E1, E2 |
| T-M3-02 | Validate dense-ID remap supports million-scale sparse IDs with acceptable memory/perf profile. | Seq 10 | D5 | E1, E2 |
| T-M3-03 | Change metadata sidecar and verify active filter recomputes and visibility updates without restart. | Seq 10 | D5 | E2 |
| T-M3-04 | Validate warning behavior for incomplete label index and metadata/raster mismatches. | Seq 10, Seq 14 | D5 | E1, E2 |
| T-M4-01 | Enter 3D mode and verify progressive coarse-to-fine usability while bricks are built lazily. | Seq 03 | D3 | E1, E2 |
| T-M4-02 | Validate orthoslice, slab/MIP, and raymarch render paths from brick representation. | Seq 06 | D3 | E1, E2 |
| T-M4-03 | Verify stable 3D camera target semantics under navigation updates and reconciliation. | Seq 06 | D3 | E1, E2 |
| T-M4-04 | Validate brick autotuning and quality/perf fallback behavior under realistic device/network budgets. | Seq 06 | D3 | E1, E2 |
| T-M5-01 | Generate RegionRecipe repeatedly for stable inputs and verify deterministic output. | Seq 08 | D7 | E1, E2 |
| T-M5-02 | Materialize cutout at `full`, `match_view`, and explicit LOD with halo semantics enforced. | Seq 08 | D7 | E1, E2 |
| T-M5-03 | Publish sparse derived chunks and verify missing chunks render transparent. | Seq 09 | D7 | E1, E2 |
| T-M5-04 | Validate both overwrite and new-layer publish workflows, including chunk-aligned writes. | Seq 09 | D7 | E1, E2 |
| T-M5-05 | Verify stale dependency and computed-at-LOD warnings/provenance are surfaced consistently. | Seq 09 | D7 | E1, E2 |
| T-M6-01 | Validate open-view and token-view attach/auth behavior across multi-client LAN sessions. | Seq 01, Seq 15 | D6 | E3 |
| T-M6-02 | Validate lease request/steal semantics with passive notifications and attribution. | Seq 11 | D6 | E3 |
| T-M6-03 | Validate derived-layer publish ACL enforcement for allowed and denied actors. | Seq 09, Seq 11 | D6, D7 | E3 |
| T-M6-04 | Validate audit query surface returns lease events, scene edits, and derived publish writes with actor labels. | Seq 11 | D6, D7 | E3 |
| T-M6-05 | Validate robustness under source churn + reconnect + concurrent clients. | Seq 01, Seq 04, Seq 15 | D4, D6 | E3, E4 |
| T-M6-06 | Validate operational telemetry and observability baseline for debugging generation and collaboration churn. | Cross-sequence operational path | D4, D6 | E3, E4 |

## 8. Execution Rules

- A milestone is considered accepted only when all linked test IDs in Section 6 pass.
- Failing release-blocking invariants in `docs/acceptance.md` is stop-ship regardless of milestone progress.
- Additive feature work must update this matrix in the same change as test additions.
