---
created: 2026-04-18
modified: 2026-05-19
---

ADRs cite [[principles/index|principles]] as their justification when applicable. Principles never cite back — they remain agnostic to which decisions exist today.

# Decisions

ADR-style records of architectural choices. Numbered sequentially in the order they were captured. Each ADR records *that* a decision was made and *why* — not a fully-templated breakdown. Optional `Status` / `Considered Options` / `Consequences` sections appear only when they add genuine value.

Most articles below were originally seeded by reading the code (rationale reconstructed). Where a decision has subsequently been confirmed, refined, or extended via authoritative source material or a maintainer interview, the article notes that.

## Articles

- [[decisions/0001-document-vs-viewport-split]] — disjoint `DocumentCommand` / `ViewportCommand` enums separate shared/sequenced from local/ephemeral
- [[decisions/0002-peer-to-peer-follow-mode]] — anyone can follow anyone; server flattens chains into stars
- [[decisions/0003-gpu-on-dedicated-worker]] — all WebGPU runs in `gpu.worker.ts` via `OffscreenCanvas` transfer
- [[decisions/0004-multi-pool-atlases]] — historical proxy atlases keyed by `(dataset, kind, slotDims, channel)` for plate FPS; superseded for the coarse/detail path by ADR 0039
- [[decisions/0005-three-output-import-model]] — `ImportResult` splits manifest, fetch, binding seed by audience
- [[decisions/0006-content-source-vs-fetch-source]] — JS-side `ContentSource` wraps wire-side `FetchSource`
- [[decisions/0007-wasm-scene-as-source-of-truth]] — Scene state lives in WASM; JS is a thin orchestration layer
- [[decisions/0008-cpu-cache-as-sole-fetch-path]] — `SharedChunkQueue` deleted in S5; `CpuCache` is the only path
- [[decisions/0009-pull-based-raf-with-typed-dirty]] — RAF loop with `interactiveDirty` (immediate) and `residencyDirty` (33ms throttle)
- [[decisions/0010-temporal-runway-not-implemented]] — GPU-side runway not pursued; CPU-side runway + scrubbing eviction is sufficient (2026-04-17)
- [[decisions/0011-dual-handoff-on-dataset-opened]] — `DatasetOpened` event splits into WASM `apply_command` and JS `setupFetchPipeline`
- [[decisions/0012-logging-conventions]] — `tracing` spans on the server, `bridgeLog` helper on the client, `dot.scope` event names (2026-04-20)
- [[decisions/0013-url-as-app-state-for-saved-views]] — saved views are debounced URL-hash writes (Google-Maps-style); refresh preserves view; sharing = copy URL (2026-05-07; accepted 2026-05-08)
- [[decisions/0014-local-file-datasets-personal-only-in-saved-views]] — local-file paths in saved views work for sender refresh but warn on share; no auto-conversion to served URLs (2026-05-07; accepted 2026-05-08)
- [[decisions/0015-server-stored-bookmarks-and-auth-seam]] — SQLite-backed bookmarks; `AuthPrincipal` trait abstracts the auth provider; side-table over JSON1 for any-overlap query (2026-05-07; accepted 2026-05-08)
- [[decisions/0016-backend-mediated-oauth-with-session-cookies]] — Google OAuth flow runs server-side; httpOnly session cookie; no JWT in JS; SameSite=Lax + REST discipline for CSRF (2026-05-08, proposed)
- [[decisions/0017-configurable-from-day-one-for-oss-release]] — every Calico-specific value lives in env vars; `PrincipalExtractor` trait is the OSS provider extension point (2026-05-08, proposed)
- [[decisions/0018-auth-mode-auto-detect-by-bind-address]] — `LUCIDA_AUTH` defaults derived from bind address; loopback → disabled, non-loopback → google; `LUCIDA_INSECURE=1` overrides (2026-05-08, proposed)
- [[decisions/0019-post-logout-marker-cookie-and-prompt-select-account]] — `lucida_signed_out` marker cookie set by `/auth/logout`; middleware serves a static landing instead of auto-bouncing; `/auth/start` adds `prompt=select_account` and clears the marker (2026-05-08)
- [[decisions/0020-single-image-with-servedir]] — `lucida-server` serves the SPA via `tower-http::ServeDir`; production deploy unit is a single container image bundling API + SPA (PRD #486; 2026-05-13, proposed)
- [[decisions/0021-deployment-artifacts-as-reference-templates]] — `extras/deploy/` ships raw YAML with `<PLACEHOLDER>` values; no Helm chart, no Kustomize overlay, no provider-specific resources upstream (PRD #486; 2026-05-13, proposed)
- [[decisions/0022-manual-merge-release-please-on-main]] — trunk-based releases via `release-please` on `main` with manual-merge of the release PR; tag push triggers multi-arch image build to ghcr.io (PRD #486; 2026-05-13, proposed)
- [[decisions/0023-minimap-lane-with-highest-priority]] — minimap is its own lane at offset 0 (highest priority); other lanes renumbered upward; minimap fetches first and evicts last (PRD #545; 2026-05-14)
- [[decisions/0024-catalog-degrade-one-tier-at-a-time]] — catalog-aware mode degradation steps exactly one tier; tier-skipping forbidden; ratification of an existing invariant (PRD #545; 2026-05-14)
- [[decisions/0025-wells-as-planning-unit]] — on plates, all fields of one well agree on a single mode; per-field divergence within a well is out of scope; ratification of an existing invariant (PRD #545; 2026-05-14)
- [[decisions/0026-discriminated-active-set-and-entity-types]] — `ActiveSetEntry` and `EntitySnapshot` become discriminated unions with top-level `kind`; per-variant invariants compile-time enforced (PRD #563; 2026-05-15)
- [[decisions/0027-planning-state-as-the-carry-forward-seam]] — `PlanningState` separates across-tick state from per-tick snapshot; planner returns `nextState` opaquely (PRD #563; 2026-05-15)
- [[decisions/0028-scene-epochs-rename-and-relocation]] — `PlanningEpochs` → `SceneEpochs` in `pipeline/epochs.ts`; `VisibleRegion` → `pipeline/viewport.ts`; no compat shim (PRD #563; 2026-05-15)
- [[decisions/0029-planning-index-split-into-per-concern-files]] — `pipeline/planning/index.ts` (1695 lines) splits into `types.ts` / `modes.ts` / `chunks.ts` / `emit.ts` / `plan.ts`; `index.ts` becomes a barrel; 5 files (not 6 — constants already in `config.ts`); `emit.ts` (not `priority.ts`) since the bulk is the four lane emitters (PRD #578; 2026-05-15)
- [[decisions/0030-coordinate-frame-naming-discipline]] — trailing-suffix discipline (`Vox` / `World` / `Px`) on planning contract fields + `Axis.{T,C,Z,Y,X}` namespace constants for the TCZYX 5D layout; JS-side at the snapshot boundary only (PRD #578; 2026-05-15)
- [[decisions/0031-validate-planning-inputs-dev-mode-boundary-check]] — `validatePlanningInputs(snapshot, state)` runs seven semantic-invariant checks at `plan()` entry; gated by `import.meta.env.DEV`; throws on violation (no degrade); originally nine, checks 6 and 7 withdrawn post-ship for producer-vs-snapshot scope mismatch (PRD #578; 2026-05-15)
- [[decisions/0032-cpucache-split-into-pipeline-fetch]] — `cpuCache.ts` (1627 lines) splits into a `pipeline/fetch/` directory of focused modules with `cpuCache.ts` as a ~250 LOC coordinator; mirrors [[decisions/0029-planning-index-split-into-per-concern-files]] in shape; integration test suite stays monolithic; two latent bugs ride along inside the slices that surface them; chunk/proxy `Scheduler` unification deferred (PRD #592; 2026-05-15)
- [[decisions/0033-typed-fetch-error]] — `ContentSource` raises typed `FetchError(kind: "permanent" | "transient" | "pending" | "abort")` at every rejection site; `CpuCache.fetchAndDecode` dispatches via `classifyFetchError` + injected `RetryPolicy` (`OnceTransientRetry` / `NeverRetry`); fixes the "no wire format registered" misclassification surfaced by dechaos pass 5 and lets generated coarse pending statuses avoid failure tracking (PRD #592, issue #602; 2026-05-15)
- [[decisions/0034-orchestrator-split-into-pipeline-upload]] — `orchestrator.ts` (2027 lines) splits into a planner-only `Orchestrator` (~400 LOC) plus a new `Uploader` coordinator (~250 LOC) backed by `pipeline/upload/` — mirrors [[decisions/0032-cpucache-split-into-pipeline-fetch]] in shape; integration test suite stays monolithic through Slice 9; two latent bugs ride along (`workerWantedSet` dead state, multi-dataset resend under-resend); chunk/proxy asset-abstraction explicitly NOT pursued (PRD #607; 2026-05-16)
- [[decisions/0035-gpu-worker-split-into-renderer-subdirectories]] — `gpu.worker.ts` (815 lines) + `volumeHandlers.ts` (646 lines) + `sliceHandlers.ts` (554 lines) split into a tree of focused modules under `lucida-web/src/renderer/` (subdirs `coldState/`, `proxy/`, `volume/`, `slice/`, `worker/`, `descriptor/`); eleven incremental slices; mirrors [[decisions/0034-orchestrator-split-into-pipeline-upload]] in cadence and shape; two latent bugs ride along (well-as-proxy memberId in pool registry, `removeLayerResources` Map cleanup leak); wire-protocol renames `chunksEvicted.datasetId` → `memberId` + `ColdStateActiveEntry` discriminated union; no `RenderClient` interface split (no second renderer on the horizon); does NOT cite a principle (`principles/render-pipeline.md` deferred to post-refactor INTERVIEW, same as `cpu-cache.md` / `upload-pipeline.md`) (PRD #622; 2026-05-16)
- [[decisions/0036-descriptor-byte-layout-ssot-and-wgsl-lock-test]] — `EntityDescriptor` byte layout owned by a single TS file (`renderer/descriptor/layout.ts`) as named offset constants; companion `layout.test.ts` parses the `EntityDescriptor` struct from both `slice.wgsl` and `volume.wgsl` and asserts agreement, failing CI on drift; WGSL codegen explicitly deferred (only two shaders; build cost not justified); generalizable seam for future cross-language byte-shape contracts (PRD #622, Slice 3; 2026-05-16)
- [[decisions/0037-delivery-state-as-cpucache-sidecar]] — `CpuCache` owns optimistic chunk/proxy sent state via `DeliveryState`; `getDeliverable()` replaces `ready[]` drain plus chunk/proxy resend passes; uploader planner-staging hooks disappear; send order becomes strict priority across deliverables (PRD #640; 2026-05-17)
- [[decisions/0038-budgeted-proxy-gpu-residency]] — historical proxy-path decision superseded for the default coarse/detail path by ADR 0039; proxy GPU residency becomes a planning-owned, worker-global budgeted desired set over coherent well bundles (PRD #664; 2026-05-18)
- [[decisions/0039-chunk-only-coarse-detail-residency]] — fallback/residency becomes two canonical chunk tiers (`coarse` and `detail`); detail defaults to source level 0; proxy fallback and well-as-residency-unit behavior are superseded for the new path (PRD #672; 2026-05-18)
- [[decisions/0040-generated-coarse-as-derived-pyramid-levels]] — coarse points at an existing source level when possible, otherwise at an append-only server-managed derived level served through the normal chunk path with metadata/readiness deltas (PRD #672; 2026-05-18)
- [[decisions/0041-clean-two-source-chunk-tier-renderer]] — the renderer binds two explicit chunk tier sources (`detail`, `coarse`) in one draw path, with clean tier descriptors instead of proxy binding reuse (PRD #672; 2026-05-18)

## Deferred — considered but not built yet

Design ideas we explored and decided to hold for later live in
[[deferred]]. Each entry inline-sketches the idea and links to the
ADR that establishes the relevant context.
