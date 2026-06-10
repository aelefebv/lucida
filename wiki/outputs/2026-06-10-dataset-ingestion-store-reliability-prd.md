---
created: 2026-06-10
modified: 2026-06-10
---

# PRD: Dataset Ingestion and Store Reliability

Parent issue: #762.

## Problem Statement

Lucida's browser, CLI, and Python surfaces can now drive the same workspace and
open real datasets, but the dataset ingestion and storage path is still too hard
to reason about when something goes wrong. A user can ask Lucida to open a local,
HTTP, S3, or GCS OME-Zarr; the server then normalizes the source, opens an
object-store backend, imports metadata, builds server-private chunk bindings,
sets up source and generated-coarse caches, persists workspace membership, and
broadcasts the result. If any part of that chain is slow, partially restored,
resource constrained, unsupported, or misconfigured, the failure is often only a
string error or a log line.

This creates three practical problems:

1. Users cannot tell whether a dataset is still importing, blocked on remote
   storage, missing a codec, failing generated-coarse restore, or loaded but
   waiting for first chunks.
2. CLI and Python workflows cannot reliably branch on dataset-open and
   dataset-health outcomes beyond broad success/failure.
3. Developers lack a repeatable acceptance matrix tying real OME-Zarr fixtures,
   storage backends, cache behavior, restore behavior, and user-facing surfaces
   together.

The old answer would have been "try the browser and inspect logs." That is no
longer enough. Lucida now has first-class headless surfaces, and those surfaces
need the same dataset/store truth the web GUI implicitly depends on.

## Solution

Add a reliability layer around the existing dataset ingestion and store path.
The layer should not replace the current `lucida-store` abstraction or reopen
legacy proxy compatibility. It should make the existing server-mediated path
observable, testable, and recoverable.

The user-facing outcome:

- Opening a dataset reports structured progress and a final structured result.
- A loaded workspace can report source health for each workspace dataset:
  backend, import, binding, source cache, generated-coarse cache, restore state,
  and recent chunk-serving failures.
- Browser, CLI, and Python can ask the same questions and get consistent
  answers, with human-readable output and machine-readable JSON/object forms.
- Restarting the server and reopening a workspace surfaces whether bindings were
  restored, skipped, failed, or need a retry.
- Real fixture datasets cover the high-value OME-Zarr shapes Lucida currently
  supports: plate, 3D volume, bundled channels, non-canonical axes, Blosc subset,
  and generated coarse behavior.
- Storage and cache limits are visible enough that resource pressure is a
  diagnosable state rather than a mystery.

The implementation should preserve the current architecture: imports still
produce the three-output model, chunk bytes still flow through server-mediated
fetch for the web viewer, generated coarse remains a derived-cache concern, and
CLI/Python continue to talk to the same server APIs rather than inventing a
second direct-reader product surface.

## User Stories

1. As a biologist, I want dataset open to tell me whether Lucida is importing or
   has failed, so that I do not wait on a blank workspace without feedback.
2. As a biologist, I want unsupported dataset errors to name the unsupported
   thing, so that I can decide whether to re-export, choose another dataset, or
   file a bug.
3. As a biologist, I want a loaded dataset to report whether first chunks are
   being served, so that I can distinguish "loaded but still rendering" from
   "broken."
4. As a biologist, I want channel-bundled and time-bundled datasets to remain
   covered by acceptance tests, so that contrast/channel workflows do not
   regress on Bioformats exports.
5. As a biologist, I want non-canonical-axis datasets to explain pinned axes, so
   that I know when I am only looking at index 0 of a dropped axis.
6. As a plate-screening user, I want plate datasets to open with field/well
   structure and source health intact, so that layout navigation stays reliable.
7. As a plate-screening user, I want slow plate import to surface progress by
   stage, so that a large plate does not look like a frozen server.
8. As an image analyst, I want dataset metadata, layouts, channel count, pyramid
   levels, codec summary, and source URL to be inspectable from CLI and Python,
   so that scripts can validate they are looking at the expected data.
9. As an image analyst, I want generated coarse readiness and failures exposed,
   so that overview/fallback behavior can be diagnosed without reading logs.
10. As a collaborator joining an existing workspace, I want Lucida to report
    whether every persisted dataset binding restored successfully, so that I
    know if the shared workspace is fully usable.
11. As a collaborator, I want a failed restore to be visible in the browser and
    CLI, so that stale dataset membership is not silently mistaken for working
    data.
12. As a CLI user, I want `dataset open` to return structured stage/failure
    information, so that shell scripts can branch on missing path vs unsupported
    codec vs auth/config vs timeout.
13. As a CLI user, I want `dataset health` or equivalent diagnostics for loaded
    datasets, so that I can verify a remote/headless operation affected the
    server state I intended.
14. As a CLI user, I want human output to suggest the next useful action, so
    that common mistakes do not require knowing internal module names.
15. As a Python user, I want dataset-open and dataset-health results as stable
    dictionaries/objects, so that notebook and automation code can assert
    expected states.
16. As a Python user, I want failures to preserve categories and retryability,
    so that notebooks can recover from transient storage issues differently from
    permanent unsupported input.
17. As an operator, I want source-cache size, hit/miss counts, and eviction
    pressure visible per dataset and globally, so that memory problems can be
    debugged before they become server instability.
18. As an operator, I want generated-coarse cache state visible, so that disk
    usage, reuse, failure, and eviction are understandable.
19. As an operator, I want cloud credential/config errors classified separately
    from missing objects and unsupported metadata, so that deployment fixes are
    obvious.
20. As an operator, I want HTTP/S3/GCS/local backend diagnostics to share a
    common shape, so that monitoring and support scripts do not special-case
    every backend.
21. As a developer, I want dataset-open progress represented as stages, so that
    browser, CLI, Python, and logs do not drift.
22. As a developer, I want server binding restore to use the same diagnostic
    model as initial dataset open, so that restart bugs are tested through the
    same contract.
23. As a developer, I want structured store/import errors instead of loosely
    formatted strings, so that tests can assert behavior without brittle text
    matching.
24. As a developer, I want the existing three-output import model preserved, so
    that server-private binding details do not leak into client document state.
25. As a developer, I want fixture-backed acceptance tests for CPPX, LIF,
    yeast, CZI, and synthetic edge cases, so that real-world regressions are
    caught near the owning layer.
26. As a developer, I want the smoke matrix to record which surface validated
    each dataset reliability behavior, so that future product changes do not
    accidentally narrow coverage.
27. As a maintainer, I want no legacy CLI compatibility commands added for this
    work, so that the clean workspace-first product model remains intact.
28. As a maintainer, I want direct Python/native-store access to be a deliberate
    later design if needed, so that this PRD does not create a second divergent
    dataset access product.

## Implementation Decisions

- Treat this as a reliability/observability layer over the current
  server-mediated dataset path, not a second storage architecture.
- Preserve the three-output import model: client-visible manifest,
  client-visible fetch source, and server-private binding seed remain separate.
  This honors [[decisions/0005-three-output-import-model]].
- Keep the wire `FetchSource` and browser `ContentSource` distinction intact.
  Diagnostics may describe the active route, but they must not merge those
  concepts. This honors [[decisions/0006-content-source-vs-fetch-source]].
- Keep canonical dataset URL normalization as the identity boundary for source
  dedupe and display. This honors [[decisions/0042-canonical-dataset-url-form]].
- Introduce one shared dataset-source health model rather than separate browser,
  CLI, and Python diagnostics. The model should be server-authored and projected
  to each surface.
- Health should describe observed runtime state, not become a competing source
  of truth for document membership or manifests.
- Dataset-open progress should use coarse stages that map to the real pipeline:
  source normalization, backend open, metadata import, binding build, persistence,
  broadcast, generated-coarse planning, and first chunk-serving observations.
- Dataset-open failures should carry a category, stage, retryability, source
  identifier, concise message, and optional backend/import detail.
- Backend/open errors should distinguish unsupported scheme, local path failure,
  missing object, permission/auth, cloud configuration, HTTP response, and
  generic backend failure where the underlying store permits it.
- Import errors should distinguish unsupported metadata shape, unsupported codec,
  unsupported chunk layout, malformed metadata, missing multiscales, and internal
  importer failure.
- Binding restore failures should be persisted or otherwise recoverable enough
  to show in workspace diagnostics after the open attempt that discovered them.
- A failed binding restore should not silently remove the dataset from the
  workspace document. The workspace should stay truthful about persisted
  membership while clearly reporting that operational serving is unhealthy.
- Add an explicit retry path for failed source/binding restore rather than
  requiring users to remove and re-add the dataset.
- Cache telemetry should start with simple counters and budgets: configured
  budget, current cached bytes, entry count, hits, misses, evictions, and recent
  backend errors. Do not overfit to a full metrics system in the first slice.
- The default source cache budget may remain per dataset initially, but the PRD
  should make global pressure visible and keep room for a later global cap.
- Generated-coarse health should summarize cache root, known generated levels,
  ready/pending/failed/unavailable counts, recent failures, and whether the
  generator is enabled.
- CLI and Python should expose both human-friendly and structured output paths
  for new diagnostics. Existing `--json` conventions should be followed for CLI.
- Browser UI should surface only actionable summaries by default, with detail
  available through debug/status affordances rather than crowding the normal
  viewer.
- Logs should include the same stage/category identifiers used by API results so
  a user-facing failure can be correlated with server logs.
- The reusable smoke scripts should be extended only when the behavior can be
  verified against a real local server. Pure unit tests should own parser and
  classifier behavior below that.
- Do not add legacy or compatibility commands. New CLI commands must fit the
  current workspace-first noun model.
- Do not revive legacy proxy fallback as a normal product path. Historical proxy
  cache administration can remain where it already exists, but new reliability
  work should target source chunks and generated coarse.
- Do not make Python direct-store access a requirement for this PRD. If direct
  Python access becomes product-critical, write a separate design that resolves
  how it coexists with server-authored workspace state.

## Testing Decisions

- Test behavior through public contracts: structured error categories, progress
  events/results, workspace health APIs, CLI human/JSON output, Python objects,
  and browser-visible summaries. Avoid tests that assert private helper
  sequencing unless the helper is the actual public seam.
- Keep storage classifier tests close to the storage backend and URL identity
  helpers, especially for local path forms, unsupported schemes, HTTP/S3/GCS
  route classification, and cloud configuration errors that can be triggered
  without real credentials.
- Keep import classifier tests close to the importer using synthetic Zarr
  metadata fixtures for unsupported codec/layout/axis cases.
- Keep binding restore tests at the server/workspace layer: create or seed a
  workspace dataset source, restart or rebuild runtime state, and assert
  restored/failed/retryable health without requiring a browser.
- Add cache unit tests around stats and eviction accounting without depending on
  exact LRU internals beyond externally visible counts.
- Add integration smoke coverage for at least these real fixtures when available
  on the developer machine: CPPX plate, yeast 3D mitochondria, LIF bundled
  channels, and CZI/non-canonical-axis data.
- Treat local fixture smokes as developer-run at first. Promote to CI only after
  fixture availability, runtime cost, and licensing/data-size constraints are
  settled.
- Extend the existing CLI smoke to cover dataset health, bad dataset path,
  unsupported or malformed fixture, and JSON output for diagnostics.
- Extend the Python smoke to cover dataset open result and dataset health result
  from the documented project environment.
- Use browser or headless screenshot smoke only for behaviors where visual
  evidence matters. Storage health itself should be assertable without pixel
  capture.
- Update the use-case smoke matrix whenever implementation adds or changes a
  user-facing dataset reliability workflow.

## Out of Scope

- No new renderer, no native CLI renderer, and no replacement for the web
  renderer used by headless capture.
- No broad OME-Zarr spec-completeness project beyond fixture-driven gaps that
  block current Lucida users.
- No legacy CLI aliases, flat command compatibility layer, or compatibility
  behavior for removed command families.
- No general metrics/observability platform. The first implementation should
  expose structured diagnostics and enough counters to support users and tests.
- No cloud credential management UI. The server should classify and explain
  credential/config errors, not become a credential vault.
- No content-hash dataset identity. Canonical source URL remains the v0 source
  identity boundary.
- No automatic mutation of source Zarrs. Generated data remains in Lucida's
  derived cache.
- No direct Python/native-store product surface unless a later PRD explicitly
  designs it.
- No removal of persisted dataset membership solely because an operational
  binding restore failed.

## Further Notes

Implementation progress:

- 2026-06-10: First slice implemented on `codex/dataset-store-reliability-prd`.
  Dataset-open failure messages now carry structured diagnostics
  (`stage`, `kind`, `retryable`, `message`, optional `detail`) while preserving
  the legacy `error` string for existing browser consumers. Successful open
  messages carry a final success diagnostic. The server handles
  `dataset_health` WebSocket requests and reports per-dataset binding status,
  backend kind, generated-coarse summary, and source-cache counters. The CLI has
  `dataset health [dataset]` with human and `--json` output; Python has
  `WorkspaceResource.datasets.health(...)`. Local smoke covered CPPX through CLI
  and Python; see [[outputs/2026-06-07-lucida-use-case-test-matrix#matrix]] row
  35.
- 2026-06-10: Browser parity for dataset health added. The web bridge can issue
  request-correlated `dataset_health` WebSocket requests, and the DebugPanel has
  a Health tab that refreshes server-authored binding/backend/source-cache and
  generated-coarse status. Browser smoke covered CPPX in a real workspace on a
  local server; the tab showed the same healthy local binding state as CLI/Python
  diagnostics.
- 2026-06-10: Binding restore health and retry implemented. Workspace restore
  records server-private source metadata and structured restore failures outside
  `DocumentState`, so health can report a persisted dataset with no runtime
  binding as unavailable while preserving source URL, backend, and last failure.
  Added `dataset_retry` to the WebSocket protocol, CLI `dataset retry
  <dataset>`, Python `WorkspaceResource.datasets.retry(...)`, and a DebugPanel
  Health-tab "Retry binding" button. Retry resolves the persisted
  workspace-dataset source and then reuses the normal dataset-open path.

Likely vertical slices:

1. Structured dataset-open result and failure categories. Initial implementation
   done 2026-06-10; progress-event streaming remains future work.
2. Dataset source health API surfaced through CLI, Python, and a minimal browser
   status/debug affordance. Done 2026-06-10.
3. Binding restore health and retry. Done 2026-06-10; deeper restart/failure
   fixture smokes remain part of slice 6.
4. Source cache stats and resource diagnostics.
5. Generated-coarse health and cache diagnostics.
6. Fixture-backed dataset reliability smoke matrix and scripts.
7. Documentation pass tying browser, CLI, Python, and server logs together.

Related shipped work:

- PRD #148 established the `lucida-store` storage abstraction and server-side
  chunk serving model.
- PRD #451 expanded bundled `t/c` chunk handling.
- PRD #703 established canonical dataset URL identity.
- PRD #745 / PR #760 and PR #761 made browser, CLI, and Python coherent enough
  to share one dataset reliability contract.

This PRD intentionally starts from those shipped decisions instead of reopening
them.
