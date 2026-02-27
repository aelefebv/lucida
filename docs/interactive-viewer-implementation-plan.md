# Interactive Viewer Implementation Plan

## Goal

Build a lightweight, napari-like interactive viewer under `/ui/viewer` that operates against Lucida's existing daemon APIs (`/view/*`, `/render/image`, `/view/events/stream`) with deterministic view-state updates and live rendering.

## Branch + Delivery Model

- Branch: `codex/lightweight-interactive-viewer`
- Delivery: phased, atomic commits
- PR model: one draft PR on this branch, updated at each gate
- Merge policy: do not merge until user confirms local testing is complete

## Scope

- In scope:
  - New viewer UI route (`/ui/viewer`) + static assets
  - Interactive navigation in 2D mode:
    - pan (drag)
    - zoom (wheel)
    - orthogonal slice stepping (Shift+wheel and keyboard)
    - plane switching (`xy`, `xz`, `yz`)
  - Axis selector controls for index-based selectors (for `t/c/z/...`)
  - Render pipeline with draft/final behavior (`raw_rgba` during interaction, `png` settle)
  - State/version-aware updates using optimistic concurrency (`expected_state_version`)
  - Route + asset tests and interaction logic tests
  - Documentation updates in README
- Out of scope:
  - 3D rendering/editing UI
  - plugin architecture
  - annotation authoring tools

## Constraints

- Reuse existing daemon routes; avoid introducing a parallel API surface.
- Keep frontend minimal: vanilla HTML/CSS/JS.
- Preserve current `/ui`, `/ui/live`, `/ui/replay` behavior.
- No mock tests.

## Phase Plan

## Phase 1: Viewer Surface + Routing

### Tasks
- [x] Add `viewer.html`, `viewer.css`, `viewer.js` under `crates/lucida-daemon/ui/`.
- [x] Add route handlers:
  - [x] `/ui/viewer`
  - [x] `/ui/viewer.css`
  - [x] `/ui/viewer.js`
- [x] Wire navigation links from existing UI pages to `/ui/viewer`.
- [x] Implement basic viewer shell:
  - [x] session/view target selectors
  - [x] connect/disconnect
  - [x] manual render button
  - [x] viewport output panel
  - [x] status/state hash/version panel
- [x] Implement first render flow (`/render/image`, inline delivery) with error handling.

### Phase 1 Gate (PR Gate A)
- [x] `cargo test -p lucida-daemon --test usage_telemetry`
- [x] viewer route/asset tests pass
- [x] branch committed atomically for phase 1
- [x] pushed to origin
- [x] draft PR created/updated with phase summary + test evidence

## Phase 2: Interactive Camera + Slicing

### Tasks
- [x] Implement view-state bootstrap (`GET /view/{id}`) on connect.
- [x] Add optimistic update helper for `/view/update`:
  - [x] sends `expected_state_version`
  - [x] handles conflict by refetch + single retry
- [x] Implement pan interaction:
  - [x] pointer drag on viewport
  - [x] world-delta math from camera zoom/pixel ratio/rotation
- [x] Implement zoom interaction:
  - [x] wheel zoom
  - [x] cursor-anchored zoom center preservation
- [x] Implement slice stepping:
  - [x] Shift+wheel
  - [x] `[` / `]` keyboard
  - [x] clamps via backend normalization
- [x] Plane switching controls:
  - [x] UI select + keyboard `1/2/3`

### Phase 2 Gate (PR Gate B)
- [x] `cargo test -p lucida-daemon --test usage_telemetry`
- [x] interaction logic tests pass
- [x] branch committed atomically for phase 2
- [x] pushed to origin
- [x] draft PR updated with phase summary + test evidence

## Phase 3: Axis Controls + Draft/Final Render Loop

### Tasks
- [x] Add selector controls for index selectors:
  - [x] auto-build controls from `view_state.selectors`
  - [x] update selector index via `/view/update`
- [x] Add render strategy:
  - [x] draft `raw_rgba` while interacting
  - [x] debounce settle render in `png`
  - [x] cancel in-flight renders on superseding requests
- [x] Subscribe to `/view/events/stream`:
  - [x] refresh state metadata
  - [x] rerender/refresh on external commits
- [x] Improve UI feedback:
  - [x] in-progress indicator
  - [x] clear error states
  - [x] render timing/backend metadata display

### Phase 3 Gate (PR Gate C)
- [x] `cargo test -p lucida-daemon --test usage_telemetry`
- [x] interaction/render tests pass
- [x] branch committed atomically for phase 3
- [x] pushed to origin
- [x] draft PR updated with phase summary + test evidence

## Phase 4: Hardening + Docs

### Tasks
- [x] Add/update daemon tests for viewer routing and assets.
- [x] Add/update frontend behavior tests (pure logic helpers where feasible).
- [x] Update README runtime model section with `/ui/viewer`.
- [x] Add a short operator usage section for the viewer workflow.
- [x] Validate no regressions in existing UIs.

### Phase 4 Gate (PR Gate D, Final)
- [ ] `cargo test -p lucida-daemon`
- [ ] `uv run pytest` for Python surface
- [x] branch committed atomically for phase 4
- [x] pushed to origin
- [x] draft PR updated with final summary + test evidence
- [x] implementation marked complete and awaiting user validation

Known environment failures while running full-suite gates:
- `cargo test -p lucida-daemon` currently fails in `tests/render_cache.rs` assertions for CPU cache budget defaults vs per-view override (`268435456` observed vs `4096/8192` expected).
- `uv run pytest` currently fails in `tests/python/skills/test_skill_tooling.py` because `skills/lucida-orchestrator` is missing in this checkout.

## Completion Definition

Implementation is complete when all phase gates are checked and the branch includes:
- functional `/ui/viewer` interactive 2D controls,
- deterministic view-state mutation flow with concurrency handling,
- validated test coverage for new behavior,
- updated docs for discoverability and usage.
