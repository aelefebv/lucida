## Parent PRD

#703

## What to build

Wire the `lucida-content::url` helpers from Slice 1 into the storage backend, the server handler, and the SPA's URL-bar / share-warning paths — so that a user typing any Windows-canonical or UNC dataset path opens correctly, spelling variants of the same file dedup to one `DatasetId`, and the personal-only-share warning fires on local paths regardless of spelling.

See PRD #703 §"Implementation Decisions / Modified modules" for the per-file design notes. ADR-0042 §"Consequences" describes the idempotent normalize-at-every-boundary pattern; ADR-0014 (as amended) is the source of the share-warning rule.

After this slice:
- `lucida-store::backend::open` normalizes its input via `normalize_dataset_url` at entry, then matches on the canonical form. Drive-letter (`c:/foo`) and UNC (`//server/share/foo`) canonical forms dispatch to `LocalFileSystem`. The current `file://`-strip line is removed (handled inside normalize). No new crate dependency.
- `lucida-server::handler::handle_open_remote_dataset` normalizes the incoming URL once at the input boundary; ID derivation, proxy-cache key derivation, and the `backend::open` call all use the canonical form. The existing dedup short-circuit (second open of an already-imported URL reuses the binding) now correctly dedups across spellings.
- SPA `lucida-web/src/hooks/useDatasets.ts::handleUrlSubmit` normalizes via the WASM-shimmed `normalize_dataset_url` on the trimmed input before passing to `sendOpenRemoteDataset`.
- SPA `lucida-web/src/savedView/captureBuilder.ts::isLocalFilePath` delegates to the WASM-shimmed `is_local_dataset_url`. The inline `startsWith('/') || startsWith('file://')` check is removed.

## Acceptance criteria

- [ ] `lucida-store::backend::open` calls `lucida_content::url::normalize_dataset_url` once at entry and classifies via `is_local_dataset_url`. Existing `open_local_path` and `open_unsupported_scheme` tests still pass. New unit-test cases (pure construction, no I/O on file): `open("C:\\foo")`, `open("c:/foo")`, `open("file:///C:/foo")`, `open("\\\\server\\share\\foo")` each return `Ok`. `open("ftp://host/path")` still returns `UnsupportedScheme`.
- [ ] `lucida-server::handler::handle_open_remote_dataset` normalizes the URL at entry; `DatasetId`, `dataset_url_hash16`-derived proxy cache directory, and the `backend::open` call all use the canonical form. The `tracing::info!` lines that log the URL show the canonical form, not the raw input.
- [ ] Existing `lucida-server/tests/dataset_id_stable.rs` extended with a test that demonstrates spelling variants of the same Windows path (e.g. `C:\foo`, `c:/foo`, `file:///C:/foo`) produce identical `DatasetId`s and reuse the same binding on second open.
- [ ] SPA `useDatasets.ts::handleUrlSubmit` calls the WASM-shimmed `normalize_dataset_url` before `sendOpenRemoteDataset`. Mocked-shim test asserts that `handleUrlSubmit("C:\\Users\\me\\foo.zarr")` results in `sendOpenRemoteDataset` being called with `c:/Users/me/foo.zarr`.
- [ ] SPA `captureBuilder.ts::isLocalFilePath` delegates to the WASM shim. New test cases: `isLocalFilePath("c:/foo")` → `true`, `isLocalFilePath("//server/share/foo")` → `true`, `isLocalFilePath("gs://bucket/foo")` → `false`. Existing Unix-path tests still pass.
- [ ] `cargo test --workspace` green. `pnpm test` (in `lucida-web`) green.
- [ ] Manual smoke (author-only, Windows): `cargo run -p lucida-server` + SPA dev server; type `C:\path\to\foo.zarr` in URL bar → dataset opens. Refresh → opens from same `DatasetId` (no re-import). Re-paste `c:/path/to/foo.zarr` → dedup to existing binding. Share-warning fires for the saved view containing this dataset.

## Blocked by

- Blocked by #704

## User stories addressed

- US 1 (typed `C:\…` opens)
- US 2 (`file:///C:/…` paste-form opens)
- US 3 (spelling variants dedup to one binding)
- US 6 (typed UNC `\\server\share\…` opens)
- US 7 (bookmark resolves after refresh)
- US 8 (same `DatasetId` after reload preserves display settings)
- US 12 (Linux paths unchanged, no regression)
- US 14 (URL bar shows canonical form after open)

## Wiki context

Read these before coding:

- **decisions** — `0042-canonical-dataset-url-form.md` (full design rationale + the idempotence invariant: normalize at every boundary), `0014-local-file-datasets-personal-only-in-saved-views.md` (the personal-only-share rule that the share-warning here implements)
- **systems** — `crates/lucida-store.md` (the `backend::open` URL-scheme dispatch contract), `crates/lucida-server.md` (dataset-open handler shape, dedup short-circuit), `crates/lucida-web.md` (SPA module layout)
- **outputs** — `windows-local-paths-prd.md` (full PRD)
