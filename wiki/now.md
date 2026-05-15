---
created: 2026-04-18
modified: 2026-05-15
---

# Now — Lucida Current State

Snapshot of what's active. Refresh via the `/repo-wiki` now pass after significant shifts.

## In flight

- **OME-Zarr expansion** — non-standard input handling (CZI 6D mosaics, `chunk_shape>1` on canonical-indexed `t`/`c`, non-canonical axes). Most recent work targets PRD #451. See [[lucida-store]]; touches [[gotchas/non-canonical-axes]] and [[gotchas/blosc-support]] (both may need refresh — see [[queue]]).
- **`lucida-store` redesign** — PRD #148, server-side chunk serving + storage abstraction.
- **Deployment artifacts and release pipeline (PRD #486)** — single-image Dockerfile + reference k8s manifests + `RUNBOOK.md` + CI/release-please/release workflows + `static_serve` and health endpoints in [[lucida-server]] + `LUCIDA_LOG_FORMAT`/`LUCIDA_WEB_DIST` env vars + env-backing of `--data-dir`/`--proxy-cache-dir`/`--proxy-concurrency` CLI flags + clearing the three pre-existing TS errors in [[gotchas/preexisting-ts-build-errors]]. ADRs [[decisions/0020-single-image-with-servedir]] / [[decisions/0021-deployment-artifacts-as-reference-templates]] / [[decisions/0022-manual-merge-release-please-on-main]] proposed.

## Designed, on hold

(none)

## Recently shipped (since 2026-04-18)

- **Planning module refactor + realtime config panel (PRD #545):** Six slices (PRs #553, #555, #557, #558, #559, #560) plus a docs-prep PR (#552) and a release-please config tweak (#554). Restructured `pipeline/planning.ts` into `pipeline/planning/` (`index.ts`, `config.ts`, `snapshot.ts`, `debug.ts`, `synthetic.ts`, `configStore.ts`) with named primitives composed by a slim `plan()`. Extracted ~120 lines of WASM-snapshot translation out of the orchestrator into `buildPlanningSnapshot`. Introduced `PlanningConfig` typed parameter threaded through `plan()` and a singleton `configStore` with localStorage persistence. New top-level "Config" tab in DebugPanel with sliders for every tunable. Promoted minimap to its own MINIMAP lane at offset 0 so it loads first on dataset open (only intentional behavioural change in the PRD). Dropped the dead +2 LOD buffer + the orchestrator's matching filter step. Added the [[principles/planning|planning principles]] doc as the framework future ADRs cite. ADRs [[decisions/0023-minimap-lane-with-highest-priority]] / [[decisions/0024-catalog-degrade-one-tier-at-a-time]] (ratification) / [[decisions/0025-wells-as-planning-unit]] (ratification). Future-work idea captured at #561 (three-tier residency model).
- **Disabled-auth restoration (PRD #527):** Restored `StubPrincipalExtractor` so `LUCIDA_AUTH=disabled` actually disables auth (matches what [[decisions/0018-auth-mode-auto-detect-by-bind-address|ADR-0018]] promised but slice-2 of PRD #455 silently retired). Removed the dead `/auth/dev/login` machinery, baked `LUCIDA_BIND=0.0.0.0:9876` as a Dockerfile default, and restructured the README Quick Start into four explicit scenarios (local-only / LAN-shared / with sign-in / develop). Per-browser anon identity in disabled mode captured as deferred work in [[decisions/deferred]].
- **Saved views (PRD #454):** URL-as-app-state (`#view=…`) + server-stored named bookmarks (`#b=<id>`) with live cross-peer sidebar updates. Four slices (PRs #478–#481): Slice 1 web-side encoder/applier/urlSync + Copy URL toolbar + loading banner; Slice 2 SQLite `BookmarkStore` + REST API under `/api/bookmarks`; Slice 3 `BookmarkSidebar` + `#b=<id>` open-by-id + `selectedDatasetId` auto-select wrinkle resolved (option c); Slice 4 `ServerMessage::BookmarkChanged` broadcast (first unsequenced ServerMessage variant). Bookmarks are the second persistent state in [[lucida-server]] (after auth's `login_sessions` and `pending_auth`). See [[saved-views]] subsystem article, [[flows/saved-view-recipient-apply]] flow trace, [[gotchas/saved-view-credentials-in-urls]] / [[gotchas/axum-query-multivalue]], ADRs [[decisions/0013-url-as-app-state-for-saved-views]] / [[decisions/0014-local-file-datasets-personal-only-in-saved-views]] / [[decisions/0015-server-stored-bookmarks-and-auth-seam]].
- **Authentication (PRD #455):** Google OAuth via backend-mediated Authorization Code flow, httpOnly session cookies, SQLite-stored sessions, OSS-configurable env-var contract, bind-address auto-detect. Eight slices (PRs #464–#471) plus a Vite-proxy dev workflow fix (PR #472). First persistent state in [[lucida-server]]. Unblocks PRD #454. See [[auth]] subsystem article, [[flows/auth-signin]] flow trace, [[gotchas/oss-config-defaults]] for env-var pitfalls, ADRs [[decisions/0016-backend-mediated-oauth-with-session-cookies]] / [[decisions/0017-configurable-from-day-one-for-oss-release]] / [[decisions/0018-auth-mode-auto-detect-by-bind-address]].
- **OME-Zarr stack:** Blosc decoder + pinned-axis prefix slice for CZI 6D (`90a3dbc`); `lucida-store::codec` extraction with structured per-level binding seed and strict import validation (`b995ae6`); canonical-indexed `t`/`c` `chunk_shape>1` support (`c4be26c`); non-canonical axis handling (`185c429`); 1c manifest shape facts + anomaly check (`ef01e16`).
- **Instrumentation sweep:** planning ([[planning-domain]]) and CPU cache ([[cpu-cache]]) telemetry; debug overlays for chunkGrid + planning, now in 3D (`6b66140`); render-loop + upload-to-GPU telemetry; cold-state hit rate / cause attribution / churn log. Multiple DebugPanel tab rewrites ("Render", "Planning", "Logging").
- **Atlas-rejection resend storm fix** + `drain_waste` filterRatio redefinition (`8bd1c29`).
- **Y-flip in 3D voxel→world** + smarter active-detail eviction (`d8c11fd`).
- **27 pre-existing TS errors cleared** in `lucida-web` (`593eb8d`).
- **Logging conventions** doc refreshed (`cf074d6`); see [[decisions/0012-logging-conventions]] — still violates article guardrails ([[queue]]).
- **Wiki structural refactor** — numbered ADRs (`0001-…` through `0012-…`), `systems/{crates,subsystems}/` split, `topics/` layer added, glossary stub removed.

## Open questions

See [[queue]]. Key ones: PRDs to fold into `wiki/inputs/`, planning threshold rationale, [[decisions/0010-temporal-runway-not-implemented]] still holding, several gotchas may need refresh after recent OME-Zarr work and TS cleanup.

## Source material

- `CHUNK_PIPELINE.md` at repo root — long-form chunk-lifecycle authoritative trace; [[chunk-pipeline]] points at it.
- Project memory at `~/.claude/projects/-Users-austin-code-lucida/memory/MEMORY.md` carries pointers to recent project-state docs.
