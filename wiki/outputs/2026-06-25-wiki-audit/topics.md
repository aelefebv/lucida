---
created: 2026-06-25
modified: 2026-06-25
---

# Topics audit + suggestions — 2026-06-25

Audit of `wiki/topics/` against current source (ground truth). Read-only on source and on existing wiki articles. Verdict up front: **no broken links and no topic to delete — the defect is coverage.** Of 98 linkable content articles (`systems/` + `decisions/` + `flows/` + `gotchas/` + `principles/`, excluding `index.md`/`deferred.md`), **39 are orphaned** — reachable from no topic page — and that gap lands on whole concerns (auth, deployment/release, agent surfaces, workspaces, diagnostics) that have no topic at all. Two existing topics also carry stale framing and miss post-edit ADRs.

Method: extracted every `[[link]]` from the four topic pages, resolved each target's basename against the article inventory, and diffed the linked set against the full inventory to compute orphans. Source claims spot-checked at `file:line`/symbol.

---

## 1. Existing topics — accuracy / usefulness / broken links

**Link integrity (all four pages):** every `[[link]]` resolves to a real article. 59 unique link targets checked against the 98-article inventory; the only non-resolving token is the literal `[[wiki-links]]` used three times as prose ("follow `[[wiki-links]]` for the content" in `rendering.md:10`, `collaboration.md:10`, `storage-and-import.md:10`) — that is intentional prose, not a link. **No broken links anywhere.**

### `topics/build-and-tooling.md` — accurate; keep as-is
- `modified: 2026-05-07` (oldest topic). All 5 links resolve; scope (build-/typecheck-/WASM-time-only footguns, distinct from runtime gotchas) is tight and still correct.
- No drift found in its targets.
- Optional, low priority: `gotchas/strict-mode-destroyable-classes` (React Strict-Mode double-invoke of `destroy()` on `DestroyableClass`) is partly a dev-loop footgun and is currently orphaned. It is runtime-ish, so it is a weak fit here; flagged only because it is unreferenced anywhere.

### `topics/collaboration.md` — accurate but now incomplete (workspaces landed)
- `modified: 2026-06-25`; all links resolve. The document-vs-viewport framing and the presence/follow/saved-view grouping are correct.
- **Stale by omission:** `systems/subsystems/workspaces.md` (created 2026-06-25, backed by `lucida-server/src/workspace.rs`, a 360 KB module) is now the container of collaboration. Per that article (`workspaces.md:8`): "presence, follow, the sequenced document, and the broadcast channel are all per-workspace"; (`:38`) "each `LiveWorkspace` owns its `Session`, broadcast channel, peer map, and `seq` … There is no longer a single global shared session (ADR-0020)." This topic never links `[[workspaces]]`. Recommend adding it (or broadening this page into a workspaces-and-collaboration hub — see §3).
- **Also orphaned and squarely collaboration:** `gotchas/saved-view-client-only-state` ("SavedView mirrors WASM presence; client-only state won't round-trip") and `gotchas/scene-document-state-json-compat` (`Scene` `#[serde(flatten)]`s `DocumentState`; field collisions corrupt the wire format). Both belong under this topic and neither is referenced by any topic today.
- Omits `flows/dataset-diagnostics` (relevant where collaboration meets failure reporting), though that fits agent-surfaces/diagnostics better.

### `topics/rendering.md` — real drift; needs an update pass
- `modified: 2026-05-19`; all links resolve. "Start here / Subsystems / Crate ownership / Why / Flows / Gotchas" structure is good and the cluster is correctly the largest.
- **Misses the entire 0023–0038 rendering-refactor ADR band**, all created after this page's last edit and all in this cluster: `0023-minimap-lane-with-highest-priority`, `0024-catalog-degrade-one-tier-at-a-time`, `0032-cpucache-split-into-pipeline-fetch`, `0033-typed-fetch-error`, `0034-orchestrator-split-into-pipeline-upload`, `0035-gpu-worker-split-into-renderer-subdirectories`, `0036-descriptor-byte-layout-ssot-and-wgsl-lock-test`, `0037-delivery-state-as-cpucache-sidecar`, `0038-budgeted-proxy-gpu-residency`. (Planning-flavored ADRs `0025`/`0027`/`0028`/`0029`/`0030`/`0031` from the same band arguably belong here too via the planning subsystem, or under a planning topic.)
- Also omits the `systems/subsystems/upload-pipeline.md` article (the upload half of the pipeline, split out per ADR 0034) and the orphaned `gotchas/strict-mode-destroyable-classes`.
- **Framing nit:** "historical proxy" / "legacy proxy" (lines 36, 48, 55) is slightly overstated. ADRs 0039–0041 made chunk-only coarse/detail the *default*, but `lucida-proxy/` and `lucida-server/src/proxy/` are still compiled and wired. "opt-in / non-default" is more accurate than "historical/legacy."

### `topics/storage-and-import.md` — needs an update pass
- `modified: 2026-05-19`; all links resolve; grouping accurate.
- **Misses `decisions/0042-canonical-dataset-url-form`** (created 2026-05-26, after this page's `modified: 2026-05-19`), which governs `DatasetId` hashing, proxy-cache naming, and wire-vs-display URL form — a core storage-and-import decision.
- Should also reference `flows/dataset-diagnostics` (the `backend::open` failure-category trace, relevant to import failures).
- Same mild "historical/legacy proxy" overstatement as rendering (lines 21).

---

## 2. Suggested new topics

Each grounded in currently-orphaned articles (not in section-slicing of articles that already have a topic home), ordered by strength of case.

### (1) `topics/auth-and-deployment.md` — strongest case
The entire auth + deployment/release concern has **zero** topic coverage; ~13 orphaned articles cluster here. Source: `lucida-server/src/auth/` is a 25-file module (`mod.rs`, `google_oauth.rs`, `session_store{,_sqlite,_memory}.rs`, `bearer_token*`, `cli_authorization*`, `pending_auth*`, `cookie.rs`, `middleware.rs`, `principal.rs`, …).

Would aggregate:
- Articles: `[[auth]]`, `[[deployment]]`, `[[flows/auth-signin]]`, `[[gotchas/oss-config-defaults]]`, `[[gotchas/gcs-credentials]]`, `[[gotchas/branching-and-releases]]`
- ADRs: `[[decisions/0016-backend-mediated-oauth-with-session-cookies]]`, `0017-configurable-from-day-one-for-oss-release`, `0018-auth-mode-auto-detect-by-bind-address`, `0019-post-logout-marker-cookie-and-prompt-select-account`, `0020-single-image-with-servedir`, `0021-deployment-artifacts-as-reference-templates`, `0022-manual-merge-release-please-on-main`

Why one hub rather than two: auth and deployment cross-reference heavily (e.g. `LUCIDA_COOKIE_SECURE` and bind-address-driven auto-detect span both, ADR 0018/0020). A single page keeps the config story in one place. Splitting into `auth` + `deployment-and-release` is defensible if it grows.

### (2) `topics/agent-surfaces.md` (CLI + Python + montage/overview) — strong case
`lucida-cli`, `lucida-py`, and the montage/overview contact-sheet feature have no topic. Source confirms the surface: `lucida-cli/src/montage.rs` (18 KB) and `ViewerCommand::Overview` at `lucida-cli/src/main.rs:1056` (agent-overview contact sheet); `lucida-protocol/src/diagnostics.rs` backs the cross-surface failure model.

Would aggregate:
- Articles: `[[lucida-cli]]`, `[[lucida-py]]`, `[[flows/dataset-diagnostics]]` (its whole point is CLI/Python/browser/logs parity)
- The montage/overview material currently documented only inside `lucida-cli.md` (`dataset montage`) — surfacing it at topic level makes the agent-facing rendering path discoverable.

### (3) `topics/workspaces.md` — strong, but resolve the overlap with collaboration
`systems/subsystems/workspaces.md` is brand-new (2026-06-25), backed by the largest server module (`workspace.rs`, 360 KB), and is now the container for saved views + sharing + live collaboration.

Would aggregate:
- Articles: `[[workspaces]]`, `[[saved-views]]`, `[[presence-and-follow-mode]]`, `[[auth]]` (membership resolves through `AuthPrincipal` — `workspaces.md:36`)
- ADRs: `[[decisions/0026-discriminated-active-set-and-entity-types]]`, and the saved-view ADRs `0013`/`0014`/`0015`
- Orphaned gotchas: `[[gotchas/saved-view-client-only-state]]`

**Caveat / overlap:** this page and `collaboration` would both own presence/follow/saved-views/sharing. Do not ship two heavily-overlapping hubs. Cleaner: **rename/broaden `collaboration` into a workspaces-and-collaboration hub** (see §3) rather than adding a third overlapping page. Listed here as the third priority on that understanding.

### (4) `topics/diagnostics-and-observability.md` — optional / consider folding into (2)
Defensible but thinner, because it leans on *sections* of articles rather than whole orphaned articles.
- Would aggregate: `[[flows/dataset-diagnostics]]`, `[[decisions/0012-logging-conventions]]`, plus observability slices of `[[deployment]]` (probes, `LUCIDA_LOG_FORMAT`, deferred metrics) and `[[lucida-cli]]` (`dataset health`, `plan visible-chunks`, `debug state`).
- Recommendation: fold `dataset-diagnostics` + `logging-conventions` into the agent-surfaces page (2) instead of standing this up separately.

**Explicitly NOT suggested:** a dedicated `annotations-and-mentions` topic. There are no annotation/mention articles in the current set and no such surface appears in the CLI / saved-view / workspace code checked — ungrounded.

**Coverage note:** even after topics (1)–(3), several planning-cluster ADRs (`0025`/`0027`/`0028`/`0029`/`0030`/`0031`) and `principles/planning.md` remain orphaned. Either add them to `rendering` or stand up a small `topics/planning.md`; flagged for completeness, lower priority than (1)–(3).

Priority order: **auth-and-deployment (1) > agent-surfaces (2) > workspaces-or-broaden-collaboration (3) > diagnostics (4, fold into 2)**.

---

## 3. Remove / merge

- **Remove: none.** All four topics carry their weight; all links resolve.
- **Merge:** if a workspaces topic is added, fold the live-collaboration concern into it (or vice-versa) so presence/follow/saved-views/sharing has exactly one hub. **Recommendation: keep `collaboration` and broaden it to cover workspaces**, rather than maintaining two overlapping pages. Whichever wins, it should pick up the two orphaned collaboration gotchas (`saved-view-client-only-state`, `scene-document-state-json-compat`).
- **Update, do not remove** `topics/rendering.md` and `topics/storage-and-import.md`: add the post-edit ADRs listed in §1 (rendering: 0023/0024/0032–0038; storage: 0042) and soften "historical/legacy proxy" to "opt-in/non-default," since `lucida-proxy/` and `lucida-server/src/proxy/` are still compiled and wired.

---

## Evidence

- Topic pages: `wiki/topics/{rendering,storage-and-import,collaboration,build-and-tooling,index}.md`
- Orphaned-but-substantial articles: `wiki/systems/subsystems/{auth,deployment,workspaces,upload-pipeline}.md`, `wiki/systems/crates/{lucida-cli,lucida-py}.md`, `wiki/flows/{auth-signin,dataset-diagnostics}.md`, `wiki/gotchas/{saved-view-client-only-state,scene-document-state-json-compat,strict-mode-destroyable-classes}.md`, `wiki/decisions/0042-canonical-dataset-url-form.md`
- Source confirmations: `lucida-server/src/workspace.rs` (360 KB), `lucida-server/src/auth/` (25 files), `lucida-cli/src/montage.rs` (18 KB), `lucida-cli/src/main.rs:1056` (`ViewerCommand::Overview`), `lucida-protocol/src/diagnostics.rs`, live `lucida-proxy/` crate and `lucida-server/src/proxy/`
- Counts: 98 linkable content articles; 39 orphaned from all topic pages; 59 unique topic-link targets, all resolving (only `[[wiki-links]]` is prose)
