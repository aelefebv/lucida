---
created: 2026-04-18
modified: 2026-05-13
---

# Decisions

ADR-style records of architectural choices. Numbered sequentially in the order they were captured. Each ADR records *that* a decision was made and *why* — not a fully-templated breakdown. Optional `Status` / `Considered Options` / `Consequences` sections appear only when they add genuine value.

Most articles below were originally seeded by reading the code (rationale reconstructed). Where a decision has subsequently been confirmed, refined, or extended via authoritative source material or a maintainer interview, the article notes that.

## Articles

- [[decisions/0001-document-vs-viewport-split]] — disjoint `DocumentCommand` / `ViewportCommand` enums separate shared/sequenced from local/ephemeral
- [[decisions/0002-peer-to-peer-follow-mode]] — anyone can follow anyone; server flattens chains into stars
- [[decisions/0003-gpu-on-dedicated-worker]] — all WebGPU runs in `gpu.worker.ts` via `OffscreenCanvas` transfer
- [[decisions/0004-multi-pool-atlases]] — proxy atlases keyed by `(dataset, kind, slotDims, channel)` for plate FPS
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
