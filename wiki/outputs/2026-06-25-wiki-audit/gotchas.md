---
created: 2026-06-25
modified: 2026-06-25
---

# Gotchas accuracy audit — 2026-06-25

Scope: all 22 articles in `wiki/gotchas/` cross-checked against current source (ground truth) at repo `main`. Read-only on source and existing articles; this file is a standalone output, not an edit to any article.

Verdict tally: **1 materially broken** (`wasm-rebuild-after-rust-changes`), **4 inaccurate in a load-bearing detail** (`document-vs-viewport-classification`, `oss-config-defaults`, `scene-document-state-json-compat`, `ts-typecheck-trap`), **1 stale label only** (`strict-mode-destroyable-classes`), the remaining **16 still apply** (a handful with minor path/wording nits called out inline).

---

## (1) Not accurately reflected

### `wasm-rebuild-after-rust-changes.md` — **materially broken** (two false premises + a missing canonical tool)

Three load-bearing defects; the article was touched today (`modified: 2026-06-25`) but the errors survived.

- **FALSE: "committed as a build artifact" and the entire "Why we commit the WASM bundle" section.** `lucida-core/pkg/` is gitignored at three levels — `.gitignore:202` (`lucida-core/pkg/`), `lucida-core/.gitignore:1` (`pkg/`), and `lucida-core/pkg/.gitignore` contains `*`. `git ls-files lucida-core/pkg/` returns nothing. Both stated reasons are fabricated: (1) a fresh clone canNOT run the web app without the Rust toolchain — `README.md` lists `wasm-pack` as a prerequisite and the pkg must be built; (2) there is no "committed bundle" for CI determinism.
  - Fix: delete the "Why we commit the WASM bundle" section and the line-10 parenthetical "(committed as a build artifact)". Replace with the truth: `pkg/` is generated and gitignored; first run must build it.
- **WRONG package manager: `npm`, not `pnpm`.** The article uses `npm install` / `npm run dev` / `npm run build:wasm` throughout (lines 25, 35, 38, 42). Repo is pnpm-only: `pnpm-lock.yaml` at root and `lucida-web/`, no `package-lock.json`, README uses `pnpm install --force` / `pnpm run dev`, and `scripts/dev.sh` runs `pnpm install`. (`npm run build:wasm` happens to still invoke the script, but `npm install` is simply wrong for this repo.)
  - Fix: s/npm/pnpm/ across the article.
- **MISSING: `./scripts/dev.sh`.** The canonical dev loop now auto-rebuilds WASM only when a `lucida-*` Rust source actually changed — content-hashed via `lucida-core/pkg/.dev-src-hash` (`scripts/dev.sh:29,62,65-66,76-82`; the hash is bytes-not-mtime precisely so a `git checkout` doesn't trigger a needless rebuild). This directly undercuts the article's core advice ("add `npm run build:wasm` to your muscle memory" / "the manual rebuild step"). The article never mentions the script.
  - Fix: lead with `./scripts/dev.sh` as the normal loop; frame the manual `pnpm run build:wasm` as the fallback for ad-hoc rebuilds.
- Correct bits to keep: `build:wasm` = `wasm-pack build --target web --out-dir pkg` (`lucida-web/package.json:9`); the `"lucida-core": "file:../lucida-core/pkg"` alias; `lucida_core.d.ts` is the generated TS surface; Python equivalent is `maturin develop`.

### `document-vs-viewport-classification.md` — **inaccurate** (wrong sync mechanism + overstated centralization)

Classification core is correct (the `DocumentCommand`/`ViewportCommand`/`Command` enums at `lucida-core/src/command.rs:17/213/378`; slice indices are Viewport; server splits `ClientMessage::Command` vs `::Presence` at the JSON tag level). Two defects:

- **WRONG: "`applyDocumentCommand` awaits the `Ack`/`CommandBroadcast` before applying locally."** It does not. `lucida-web/src/applyAndSend.ts:10-13` applies locally **immediately** (`scene.apply_command(json)`), bumps the settings generation, then `sendCommand(json)` — an optimistic local apply, **no await**. Explicitly corroborated by the in-source comment at `lucida-web/src/components/SliceViewer.tsx:234`: "Apply locally AND send … the sender is excluded from the server's rebroadcast, so without the local apply the author would never see their own shape."
  - Fix: replace the "awaits Ack" sentence with "applies optimistically-locally, then sends; the author is excluded from the rebroadcast, so the local apply is what they see."
- **OVERSTATED: "Open `applyAndSend.ts` and confirm the dispatch table matches."** There is no dispatch table — `applyAndSend.ts` defines exactly two helpers (`applyDocumentCommand`, `applyViewportCommand`) and nothing else; classification is decided ad hoc at each call site (SliceViewer / VolumeViewer / annotation overlays). `grep -nE "dispatch|table"` in the file returns nothing.
  - Fix: drop "dispatch table"; say classification is per-call-site, the two helpers just encode the send-or-not decision.

### `oss-config-defaults.md` — **inaccurate** (one nonexistent env-var name)

Self-inconsistent. Everything else verified (`LUCIDA_BIND` default `127.0.0.1:9876`; `LUCIDA_DB_PATH` default `lucida.db`; insecure-opt-in / unknown-auth-mode errors; `LUCIDA_LOG_FORMAT` text default; CLI-wins env wiring; admin/hosted-domain CSV lowercasing).

- **WRONG: line 20 lists `LUCIDA_GOOGLE_{CLIENT_ID,CLIENT_SECRET,REDIRECT_URI}`, implying `LUCIDA_GOOGLE_REDIRECT_URI`.** The actual env var is `LUCIDA_OAUTH_REDIRECT_URI` (`lucida-server/src/auth/config.rs:110,165,365,612`). The article itself uses the correct name at line 42 — only the line-20 bullet is wrong.
  - Fix: change the line-20 bullet to `LUCIDA_GOOGLE_{CLIENT_ID,CLIENT_SECRET}` + `LUCIDA_OAUTH_REDIRECT_URI` (the redirect URI does not share the `LUCIDA_GOOGLE_` prefix).

### `scene-document-state-json-compat.md` — **inaccurate** (test cited in the wrong file)

Core mechanism intact: `Scene` has `#[serde(flatten)] pub document: DocumentState` (`lucida-core/src/scene/mod.rs:75-76`); additive `#[serde(default)]` compat is real.

- **WRONG: the named example test and its location.** Line 20 says compat tests live in "`scene/types.rs` and `scene/mod.rs`", and line 24 cites `dataset_display_settings_backward_compat`. That test actually lives in **`lucida-core/src/command.rs:1894`**, not the scene module. The scene module's backward-compat test is named **`scene_backward_compat_deserialization_without_settings`** (`lucida-core/src/scene/mod.rs:1483`). `types.rs` has only `pin_without_view_*` compat tests, not a `dataset_display_settings` one.
  - Fix: cite `scene_backward_compat_deserialization_without_settings` (`scene/mod.rs:1483`) as the scene-module example; if keeping the `dataset_display_settings_backward_compat` reference, relocate it to `command.rs:1894`.

### `ts-typecheck-trap.md` — **inaccurate** (mislabels `tsconfig.node.json`)

Core claim correct: root `lucida-web/tsconfig.json` is a references-only container (`files: []`, no `include`); app sources in `tsconfig.app.json` (`include: ["src"]`); `tsc --noEmit -p tsconfig.app.json` and `tsc -b --dry` both valid; build is `tsc -b && vite build` and repo uses pnpm.

- **WRONG: line 36 labels `lucida-web/tsconfig.node.json` "(worker / build-tool config)".** It is build-tool only — it `include`s just `vite.config.ts` (`tsconfig.node.json:25`). The app's actual Web Workers (e.g. `pipeline/fetch/decode.worker.ts`) live under `src/` and are covered by `tsconfig.app.json`. The "worker" label is misleading. Line 28 prose ("keep the worker config and the app config independent") carries the same error.
  - Fix: relabel as "build-tool config (`vite.config.ts` only)"; drop "worker" from both line 28 and line 36.

### `strict-mode-destroyable-classes.md` — **stale label only** (gotcha itself still applies)

Core gotcha + canonical fix verified: `start()` resets `this.destroyed = false` and short-circuits on a non-null handle (`lucida-web/src/savedView/urlSync.ts:120-121`); `notifyChange`/`flush` early-return on `destroyed`; `<StrictMode>` still wraps the app (`lucida-web/src/main.tsx:8-12`). Behavior still reproduces in dev.

- **STALE: title + body say "React 18 Strict-Mode" (lines 6, 11/17).** App is on **React 19.2** (`lucida-web/package.json:18`, `react: ^19.2.0`). Double-invoke still applies in React 19, so the gotcha stands; only the version number is dated. The source comment at `urlSync.ts:117` carries the same stale "React 18" wording, so the wiki is mirroring stale source — worth fixing both, but the article can be corrected independently.
  - Fix: s/React 18/React 19 (or just "React Strict-Mode").
- **Worth a light re-check (not a defect):** the claim "only `UrlSync` matches the pattern" (line 33) is narrowly true (stable-identity instance in `useState`/`useRef` + `useEffect` cleanup + entry-guard flag that `destroy()` permanently sets), but the codebase now has more `destroyed`-flag / `destroy()`+`start()` classes than when written (`bridge.ts`, `renderer/worker/state.ts`, `renderer/renderClient.ts`). They don't fully match the footgun shape, so the assertion holds — it is just more fragile than it reads. Consider softening to "as of PR #483, `UrlSync` is the only instance matching all of: …".

---

## (2) Still applies

Accurate against current source (minor path/wording nits noted, none warranting a verdict downgrade):

- **`app-tsx-hook-order.md`** — callback-refs pattern intact (`App.tsx:188-204`, no-op stubs populated at `:744`; in-source comments at `:204,:330,:363` corroborate "order matters"). Hook order matches. *Nit:* "~10 React hooks" undercounts — the file has grown more refs/hooks; the structural pragma is unchanged.
- **`axum-query-multivalue.md`** — `parse_dataset_params` hand-rolled at `lucida-server/src/bookmarks/handlers.rs:71`; `axum-extra` still NOT a dependency (only the explanatory comment references it); backed by real tests (`handlers.rs:902-926`). Fully accurate.
- **`blosc-support.md`** — subset matches exactly: Blosc1 only / Blosc2 rejected (`lucida-server/src/decode/blosc.rs:5`); inner `zstd` only (`COMPRESSOR_CODE_ZSTD=4`, `blosc.rs:62`); typesize 1/2/4, 8 rejected with literal message "blosc typesize {other} not supported (only 1, 2, or 4)" (`lucida-store/src/codec.rs:181,184`); MEMCPYED short-circuit (`FLAG_MEMCPYED=0x02`, `blosc.rs:60`). Regen one-liners inline in the test file.
- **`branching-and-releases.md`** — `release-please-config.json:8` has `"pull-request-title-pattern": "chore(release): ${version}"` exactly as quoted; cited ADRs (0022/0021/0020/0001) all exist. Process/policy claims (branch-protection, RUNBOOK) are infra-config, not verifiable from crate source, but every code-adjacent anchor checks out.
- **`gcs-credentials.md`** — fix in place: `GoogleCloudStorageBuilder::from_env().with_bucket_name(...)` (`lucida-store/src/backend.rs:140`), mirroring the S3 arm (`:149`); module doc at `:10`, inline comment at `:135`. Anonymous/public-bucket reads still NOT surfaced — no `skip_signature`/`with_skip_signature` anywhere in `lucida-store/src` (the only grep hits were unrelated `layout.rs` axis doc-comments). Article holds.
- **`minimap-render-key.md`** — `tickMinimap` computes `renderKey` vs `state.lastRenderKey` (`lucida-web/src/minimapPath.ts:295-297`); component list (`theta,phi,mode,sliceZ,activeC,mainCamSnap,orderSnap,settingsSnap,uploadGeneration`) accurate; `uploadGeneration` bumped on overview upload (`:260`). *Nit:* the camera component now varies by mode (`eye_position()` in volume vs `zoom()|center()` in slice, `:294`) — less specific in the article than in code.
- **`non-canonical-axes.md`** — `classify_axes` + `PinnedAxis{pinned_index:0}` (`lucida-content/src/normalize.rs:31,41`); `chunk_key_to_store_path` injects `"0"` (`lucida-store/src/lib.rs:35`, tests at `:198`); `ChunkByteLayout`/`compute_chunk_byte_layout`/`slice_range` present (`lucida-store/src/layout.rs`); `MultiscaleInfo.pinned_axes` on the wire with `#[serde(default)]` (`lucida-content/src/image.rs`). *Nit:* the non-canonical log line is `eprintln!` (`import.rs:588`), not the tracing logger; article paraphrases the prefix accurately.
- **`preexisting-ts-build-errors.md`** — correctly self-labeled historical/resolved. Build is `tsc -b && vite build` (`lucida-web/package.json:8`); commit `593eb8d` exists; all three referenced files exist (the article correctly notes the decode worker moved from `lz4.worker.ts` → `pipeline/fetch/decode.worker.ts`); `as ArrayBuffer` narrowing casts present. No live footgun.
- **`proxy-priority-not-honored.md`** — verbatim-accurate. `ProxyGenerator::request(spec, _priority: u8)` with priority bound as `_priority` and unused (`lucida-server/src/proxy/generator.rs:110-113`). Module/overview comments match the quotes. Correctly cites `lucida-server/src/proxy/generator.rs` (the generator lives in lucida-server's `proxy` module, **not** the `lucida-proxy` crate — the article's path is right).
- **`rust-2024-binding-modes.md`** — workspace `Cargo.toml:4` has `resolver = "3"`; all 8 lucida crates declare `edition = "2024"` (verified count). Caveat remains valid.
- **`saved-view-client-only-state.md`** — fully accurate, matches line-for-line: `SavedView.auto_contrast: IndexMap<DatasetId,bool>` with `#[serde(default, skip_serializing_if = "IndexMap::is_empty")]` (`lucida-core/src/saved_view.rs:135-136`); encoder strips defaults / emits only `false` (`encoder.ts:121-128`); restore via `subscribeApplyComplete` → `useSavedViewSync` → `setAutoContrastMap`, absent ⇒ `true` (`hooks/useSavedViewSync.ts:340-365`, `hooks/useDatasetSettings.ts:65,83`).
- **`saved-view-credentials-in-urls.md`** — `ShareToolbarButton.tsx` shows link size + local-file warning + soft 4 KB warning, and does NOT inspect URL contents for credential-shaped queries (repo-wide grep for `X-Amz`/`api_key`/`presigned` heuristics is empty). Mitigated/NOT-mitigated split holds; `#b=<id>` server-side resolution confirmed (`urlSync.ts`, `bookmarksApi.ts`).
- **`stage-translations-are-microns.md`** — fully accurate; all named tests exist verbatim in `lucida-store/src/import.rs` (`stage_translations_normalized_to_voxel_units:1363`, `missing_voxel_scale_falls_back_to_unit_scale:1473`, `zero_voxel_scale_falls_back_with_warning:1515`, `grid_plates_unaffected:1421`, `import_plate_with_stage_positions:1024`); conversion logic (divide by level-0 scale, `is_finite() && != 0.0`, fall back `1.0`) matches `import.rs:295-309,360-364`.
- **`upload-budgets-per-frame.md`** — main 8 MB / minimap 2 MB exact (`pipeline/upload/constants.ts:8`, `renderLoopTypes.ts:51`); one-item soft-cap overshoot correct for both paths (`uploader.ts:164-201`; `minimapPath.ts:237-238`); debug-panel telemetry claims hold. *Nit:* exact field labels are paraphrases, not literal UI strings.
- **`wire-chunk-key-conventions.md`** — invariant verified: `t/c` voxel coords, `z/y/x` chunk-grid coords; `chunk_key_to_store_path` divides only `t/c` by chunk shape (`lucida-store/src/lib.rs:50-64`); `slice_range(wire_t,wire_c)` math matches the worked example (`layout.rs:83-98`); both server call sites exist. *Nit (path-drift):* the volume path `fetch_dense_volume` lives in `lucida-server/src/proxy/server_source.rs` (the lucida-server `proxy` module), so the bare `proxy::server_source::` qualifier could mislead toward the `lucida-proxy` crate — worth disambiguating.
- **`worker-eviction-async-reporting.md`** — async path verified (`gpu.worker.ts:12` → `renderClient.ts:62-63` → `onChunksEvicted`); wire shape `ChunksEvictedMessage{type,memberId,keys,skipped?,reason?}` (`workerProtocol.ts:464-483`); `keys`/`skipped` semantics match (`feedback.ts`, `cpuCache.ts`). *Nit:* step 4 says `memberId` is parsed "at the upload wire boundary"; `parseWorkerMemberId` is actually called inside the feedback handler (`feedback.ts:40,86`) — mechanics right, locational phrasing loose.

---

## (3) Undocumented footguns (optional)

Real footguns observed in code with no gotcha yet:

- **Stale "React 18" comment in `lucida-web/src/savedView/urlSync.ts:117`.** The source comment that the strict-mode gotcha mirrors is itself wrong (app is React 19.2). Fixing only the wiki leaves the next reader to re-derive the version from the source. A trivial source-comment fix would close the loop; flagging here so the wiki fix and the source fix travel together.
- **`fetch_dense_volume` / `server_source` naming collision risk.** `lucida-server/src/proxy/` and the separate `lucida-proxy` crate both carry "proxy" semantics; symbols like `proxy::server_source::fetch_dense_volume` read as if they belong to the `lucida-proxy` crate but live in `lucida-server`. Multiple articles (`wire-chunk-key-conventions`, `proxy-priority-not-honored`) brush against this. A one-line note in the `lucida-server` / `lucida-proxy` crate articles clarifying "the request-time proxy generator is `lucida-server::proxy`; `lucida-proxy` is the offline downsample/aggregate library" would prevent recurring path confusion.
- **`pkg/.dev-src-hash` content-hash invalidation is bytes-only.** `scripts/dev.sh` rebuilds WASM when the hash of `lucida-*` Rust sources changes — deliberately ignoring mtime so `git checkout` doesn't trigger a rebuild (`dev.sh:62,65-66`). The flip side: editing the build flags / `wasm-pack` invocation itself (not a `.rs` source) will NOT invalidate the hash, so `--force` (or deleting the hash file) is required after toolchain/flag changes. Worth a sentence in the rewritten `wasm-rebuild` article.
