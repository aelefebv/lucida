---
type: Status
title: "Now — Lucida Current State"
description: "Snapshot of what's active."
tags: [lucida, status]
source_path: wiki/now.md
created: 2026-04-18
modified: 2026-06-25
---

# Now — Lucida Current State

Snapshot of what's active. Refresh via the `/repo-wiki` now pass after significant shifts.

## In flight

No major refactor in flight. The four-PRD chunk-pipeline structural-cleanup arc (plan / fetch-decode / upload / render) is fully landed, and the dataset ingestion/store reliability PRD (#762) has shipped — see [Flow: Dataset Diagnostics](flows/dataset-diagnostics.md). Recent work is feature- and hardening-sized rather than structural.

## Designed, on hold

(none)

## Recently shipped

- **Workspaces:** create a workspace directly from a dataset (#697), duplicate without transferring permissions (#698), and editable dataset display names via a collaborative rename command (#701).
- **Annotation author-view arc (#830):** annotations capture the author's view on creation, restore it on navigate, and are shareable by deep-link (never-leak). Mentions/threads surface in the web client (`MentionsOfMe`).
- **Minimap fixes:** render the overview with the active channel's contrast (#835), frame to visible datasets only (#836), and 2D colormap + live annotation draw + 3D annotation context (#837). Testable logic lives in `minimap.rs` (the `wasm.rs` path is wasm32-gated).
- **CLI `dataset montage` (#838):** agent-facing dataset overview (contact sheet + JSON).
- **Collaboration:** peer name + avatar on cursors in peer mode (#540).
- **Saved views:** server-enforced visibility-transition allow-list (#817) and a reachable Undo for every pending saved-view reject + stale active-row highlight fix (#818). Dead `BookmarkSidebar` component removed (#819) — the live component is `WorkspaceSavedViewsSidebar` (see [Topic: Collaboration](topics/collaboration.md)).
- **Dependency + supply-chain sweep:** auth/crate/web bumps clearing soundness/CVE alerts (jsonwebtoken, pyo3, lru, vite 8, js-yaml/@babel) plus a lucida-py CI job (#822–#828, #832), and a Docker rust-builder pinned to bookworm so the binary's glibc matches the runtime (#832).
- **Blosc decoder fixes (#839):** non-filter-aligned and raw-stored blocks now decode correctly; see [Blosc support is a deliberately narrow subset](gotchas/blosc-support.md) for the intentionally narrow Blosc1 + zstd subset.
- **Dataset ingestion / store reliability (PRD #762):** dataset open/restore/cache/failure behavior is now diagnosable across browser, CLI, Python, and server logs (structured open diagnostics, `dataset_health`, CLI `dataset health`, Python `datasets.health(...)`, cache counters, DebugPanel Health tab, explicit binding retry). Flow: [Flow: Dataset Diagnostics](flows/dataset-diagnostics.md).

### Landed refactor arcs (durable shape; per-commit detail is in git)

- **Render-pipeline refactor (PRD #622):** `gpu.worker.ts` + volume/slice handlers split into focused modules under `lucida-web/src/renderer/`, de-globalized behind a `RendererState` DI object; descriptor byte layout is SSoT with a WGSL↔TS lock test. ADRs [`gpu.worker.ts` split into `renderer/` subdirectories](decisions/0035-gpu-worker-split-into-renderer-subdirectories.md), [Descriptor byte-layout single source of truth + WGSL ↔ TS lock test](decisions/0036-descriptor-byte-layout-ssot-and-wgsl-lock-test.md). Closes the chunk-pipeline cleanup arc (PRDs #545/#592/#607/#622).
- **Upload-pipeline refactor (PRD #607):** `tickCoordinator.ts` split into a planner-only `TickCoordinator` plus a new `Uploader` backed by `lucida-web/src/pipeline/upload/`. ADR [`orchestrator.ts` split into `pipeline/upload/` modules](decisions/0034-orchestrator-split-into-pipeline-upload.md); subsystem article [Upload Pipeline](systems/subsystems/upload-pipeline.md).
- **Fetch/decode refactor (PRD #592):** `cpuCache.ts` split into `pipeline/fetch/` modules behind a thin coordinator, with typed fetch errors. ADRs [`cpuCache.ts` split into `pipeline/fetch/` modules](decisions/0032-cpucache-split-into-pipeline-fetch.md), [Typed `FetchError` + injectable `RetryPolicy` at the fetch boundary](decisions/0033-typed-fetch-error.md); subsystem article [CPU Cache](systems/subsystems/cpu-cache.md).
- **Planning refactor (PRDs #545/#563/#578):** `pipeline/planning/` split into per-concern files with discriminated entity/active-set types, coordinate-frame naming discipline, and DEV-mode input validation; all cite [Principles — Planning Domain](principles/planning.md). ADRs [Discriminated Active-Set and Entity Types](decisions/0026-discriminated-active-set-and-entity-types.md) through [`validatePlanningInputs` as the Dev-Mode Boundary Check](decisions/0031-validate-planning-inputs-dev-mode-boundary-check.md).
- **Delivery-state consolidation (PRD #640):** `CpuCache` owns optimistic chunk/proxy sent state. ADR [Delivery state as a CpuCache sidecar](decisions/0037-delivery-state-as-cpucache-sidecar.md).
- **Chunk-only coarse/detail residency (PRD #672):** default fallback moved from proxy assets to explicit `detail`/`coarse` chunk tiers; legacy proxy fallback is opt-in. ADRs [Chunk-only coarse/detail residency](decisions/0039-chunk-only-coarse-detail-residency.md) through [Clean two-source chunk-tier renderer](decisions/0041-clean-two-source-chunk-tier-renderer.md).
- **Windows local-path support (PRD #703):** cross-platform local-path open via URL bar and FileBrowser, with a canonical dataset-URL form. ADR [Canonical dataset URL form](decisions/0042-canonical-dataset-url-form.md) (Windows CI still deferred — see [Queue — Open Questions](queue.md)).
- **Auth + saved views (PRDs #455/#454):** Google OAuth with SQLite-stored sessions, and URL-as-app-state plus server-stored bookmarks. Subsystem articles [Authentication](systems/subsystems/auth.md), [Saved Views](systems/subsystems/saved-views.md).

## Open questions

See [Queue — Open Questions](queue.md). Key ones: PRDs to fold into `wiki/inputs/`, planning threshold rationale, proxy-generation priority, [GPU-Side Temporal Lookahead — Won't Implement](decisions/0010-temporal-runway-not-implemented.md) still holding, Windows CI, and whether delivery-state ownership should become a broader pipeline principle.

## Source material

- Project memory at `~/.claude/projects/-Users-austin-code-lucida/memory/MEMORY.md` carries pointers to recent project-state docs.
