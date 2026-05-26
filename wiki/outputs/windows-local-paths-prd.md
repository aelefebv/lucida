# PRD: Windows local-path support

## Problem Statement

A developer running `cargo run -p lucida-server` on Windows cannot open an OME-Zarr dataset stored anywhere on a Windows filesystem. Typing a path like `C:\Users\me\foo.zarr` into the URL bar returns `UnsupportedScheme`. Pasting `file:///C:/Users/me/foo.zarr` (the form a browser produces when you drag-copy a file path) also fails. Opening the FileBrowser modal yields a backend error because the client immediately tries to browse `/`, which doesn't resolve to anything useful on Windows. The result: the bare-binary developer workflow — the one the README's "Develop on it" section recommends — is unusable on Windows for the entire class of local-filesystem datasets.

The bug exists because three layers (storage backend dispatch, web-side share-warning classifier, FileBrowser navigation) were written assuming POSIX path conventions, and the project has Linux-only CI, so the assumption was never tested.

## Solution

Add cross-platform local-path support such that:

- A Windows developer running `cargo run -p lucida-server` against a Windows-local OME-Zarr can open it via the URL bar (typed `C:\…`, `c:/…`, or `file:///C:/…`) or the FileBrowser modal.
- Saved views and bookmarks created in that session reload correctly on the same Windows machine after a browser refresh.
- Lab network shares accessed via UNC paths (`\\fileserver\share\…`) work the same way.

The mechanism is a single canonical URL form — `c:/Users/me/foo.zarr` for drive-letter paths, `//server/share/…` for UNC, Unix paths unchanged — used uniformly for `DatasetId` hashing, proxy-cache directory naming, wire transmission, and display. Lightweight string-level normalization at the storage boundary collapses spelling variants of the same file into one canonical key. The FileBrowser modal becomes platform-aware: on Windows the synthetic "drives list" root replaces `/`.

Cross-machine sharing of saved views with local paths continues to follow [ADR-0014](../decisions/0014-local-file-datasets-personal-only-in-saved-views.md) (personal-only). Production deploys (Linux containers) are unaffected.

## User Stories

1. As a Windows developer running `cargo run -p lucida-server`, I want to open a local OME-Zarr by typing `C:\Users\me\experiment.zarr` into the URL bar, so that I don't have to copy data into a Docker volume first.
2. As a Windows developer, I want to paste `file:///C:/Users/me/experiment.zarr` (the form browsers and file managers produce) into the URL bar and have it work the same as the typed form, so that copy-paste workflows from external tools are friction-free.
3. As a Windows developer, I want spelling variants of the same file (`C:\foo` vs `c:/foo` vs `C:/foo` vs `file:///C:/foo`) to dedup into one dataset binding, so that I don't accidentally re-import multi-gigabyte datasets when the path string differs trivially.
4. As a Windows developer, I want to click "Browse Local Files" and see my drive letters (`C:`, `D:`, etc.) as the initial entries, so that I can navigate to data regardless of which drive it's on without typing anything.
5. As a Windows developer browsing inside the FileBrowser, I want to navigate back up to the drives list from any directory by clicking the root breadcrumb, so that I can switch drives without dismissing and reopening the modal.
6. As a microscopy lab user on Windows, I want to open a dataset stored on a lab network share via `\\fileserver\microscopy\experiment.zarr`, so that I don't have to copy multi-TB datasets to local disk before opening them.
7. As a Windows developer, I want to bookmark a local dataset and have the bookmark resolve to the same dataset after a browser refresh, so that I can resume work without re-typing paths.
8. As a Windows developer who saves a view URL and reloads the page, I want the dataset to load with the same `DatasetId`, so that all my display settings (contrast, gamma, viewport, multichannel state) reapply correctly.
9. As a Windows developer constrained to `LUCIDA_DATA_DIR`, I want the constraint to be enforced correctly against Windows paths — including the UNC and `\\?\` verbatim forms canonicalize produces — so that the security boundary works on Windows the same way it does on Linux.
10. As a maintainer reading the codebase, I want a single source of truth for URL normalization shared between Rust and TypeScript, so that the server and SPA cannot drift in classifying or hashing dataset URLs.
11. As a maintainer reading the codebase, I want `dataset_id_for_url` to live in one place rather than being duplicated between `lucida-core::saved_view` and `lucida-server::handler`, so that future changes to the ID derivation rule are made once.
12. As a Linux developer, I want my existing dataset-open and saved-view flows to behave identically (no regression, no surprise normalization applied to Unix paths), so that the Windows-support work doesn't disrupt my Linux-only sessions.
13. As a maintainer, I want browse-handler errors on paths outside the `data_dir` constraint to behave identically on Windows and Linux, so that the security boundary semantics aren't platform-coupled.
14. As a SPA user, I want the URL bar after opening a dataset to show the canonical form (`c:/Users/me/foo.zarr`), so that what I see is what gets stored, hashed, broadcast, and shared.
15. As a future contributor reading the wiki, I want an ADR explaining why drive letters are lowercased and slashes are forward-only in the canonical form, so that I can judge edge cases without guessing at intent.
16. As a future contributor adding Windows CI later, I want the codebase to be CI-ready — no manual hacks, all tests platform-portable — so that flipping on `windows-latest` is a one-line `runs-on` matrix change rather than a debug expedition.

## Implementation Decisions

### New module

- **`lucida-content::url`** — pure string-level URL helpers. Adds `blake3 = "1"` as a `lucida-content` dependency. Members:
  - `normalize_dataset_url(raw) -> String` — strips `file://[/]+`, on a recognized drive-letter pattern lowercases the drive and replaces backslashes with forward slashes, on a recognized UNC pattern forward-slashifies. Unix paths and remote-scheme URLs pass through unchanged. Idempotent.
  - `is_local_dataset_url(canonical) -> bool` — true for canonical Unix paths, drive-letter paths, and UNC paths. Operates on the normalized form; callers normalize first.
  - `dataset_id_for_url(canonical) -> String` — moved from `lucida-core::saved_view`. Same blake3 algorithm.
  - `dataset_url_hash16(canonical) -> [u8; 16]` — also relocated from `lucida-server::handler`. Kept in lockstep with the `ds-…` ID via a shared internal digest helper, same pattern as today.

### Modified modules

- **`lucida-core::saved_view`** — `dataset_id_for_url` becomes a thin `#[wasm_bindgen]` shim over `lucida_content::url::dataset_id_for_url`. New shims expose `normalize_dataset_url` and `is_local_dataset_url`. The SPA's existing `import { dataset_id_for_url } from "lucida-core"` call sites continue to work; two new named imports become available.
- **`lucida-store::backend::open`** — calls `lucida_content::url::normalize_dataset_url` at entry, then matches on the canonical form. Local-path classification extends to drive-letter and UNC patterns via `is_local_dataset_url`. The current `file://`-strip line is removed (now handled inside `normalize_dataset_url`). No new crate dependency (lucida-store already depends on lucida-content).
- **`lucida-server::handler`** — local `dataset_id_for_url` and `dataset_url_hash16` deleted; call sites import from `lucida_content::url`. `handle_open_remote_dataset` normalizes the URL once at the input boundary; the normalized form is used for ID derivation, proxy-cache key derivation, and the `backend::open` call.
- **`lucida-server::browse`** — `BrowseQuery::path` becomes optional. When absent or empty, the handler returns a platform-default response: on Windows, a synthetic entry list naming each accessible drive (lowercase, e.g. `c:`, `d:`) as a `directory`-typed entry; on Unix, the existing `/` listing. A new helper converts canonicalized PathBufs to the canonical display form (strips `\\?\` and `\\?\UNC\` prefixes, lowercases drive letter, forward-slashifies) before returning the response's `path` field. The `data_dir` constraint check stays as today: segment-aware `starts_with` on canonicalized PathBufs.
- **`lucida-web/src/savedView/captureBuilder.ts`** — `isLocalFilePath` delegates to the WASM-shimmed `is_local_dataset_url`. The inline `startsWith('/') || startsWith('file://')` check is removed.
- **`lucida-web/src/hooks/useDatasets.ts`** — `handleUrlSubmit` calls the WASM-shimmed `normalize_dataset_url` on the trimmed input before passing to `sendOpenRemoteDataset`. The normalized form is what's tracked in `urlByDatasetId` (in `useSavedViewSync`) and what's emitted on the wire.
- **`lucida-web/src/components/FileBrowser.tsx`** — initial fetch sends an empty `path` (no query param) and uses the response's `path` as the current path. Navigation joins entries with `/` (canonical form is always forward-slash). The root breadcrumb sends empty `path` again to return to drives-list (Windows) or `/` (Unix). The breadcrumb's segment-split logic uses `/` throughout.

### Unchanged

- **`lucida-py::lib.rs`** — its `open` call to `lucida-store::backend::open` gains cross-platform behavior transparently because normalization is internal to `backend::open`.
- **`lucida-cli`** — no callers of `backend::open` and no FileBrowser equivalent.
- **`lucida-protocol`** — stays computation-free. URL helpers do not move here.
- **Wire protocol shape** — `DatasetManifest` does not carry the URL today, and the SPA's `urlByDatasetId` map is populated locally at `sendOpenRemoteDataset` time. No new fields, no version bump.

### Cross-cutting

- **Canonical form**: drive-letter `c:/Users/me/foo.zarr`, UNC `//server/share/foo.zarr`, Unix `/foo/bar.zarr` (unchanged). Used uniformly for hashing, proxy-cache directory naming, wire transmission, display, and FileBrowser navigation.
- **Idempotence**: `normalize_dataset_url` on an already-normalized string is a no-op. Safe to call defensively at every boundary.
- **ADR-0014 amendment**: classifier rule updates to `is_local_dataset_url(normalize_dataset_url(s))`. The personal-only-share decision and `DatasetId`-blake3-collision sharp edge remain valid verbatim.
- **One new ADR**: "Canonical URL form for datasets (Windows local-path support)" — captures the normalization rule, the rationale for light string-level over filesystem canonicalization, the canonical form on each platform, the placement in `lucida-content::url`, and what's *not* solved (`..` resolution, symlink collapse, cross-machine path equivalence — the last defers to ADR-0014).
- **Systems article updates**: `lucida-content` gets the new `url` module documented; `lucida-store` mentions the canonical form expected by `backend::open`; `lucida-server` documents the platform-default-root behavior of `/api/browse`.

### CI posture

Linux-only CI remains the status quo. Manual Windows verification by the author at PR time is the v0 safety net. A `wiki/queue.md` entry records the deferral so it's visible and revisitable when Windows usage stops being single-developer.

## Testing Decisions

A good test here asserts an externally observable property — same input string produces same canonical form, same canonical form produces same `DatasetId`, same dataset opens via either spelling — rather than re-asserting internal helper return values.

| Module | Tests |
|---|---|
| `lucida-content::url` | Table-driven unit tests for `normalize_dataset_url`: Unix passthrough, drive-letter case variants (`C:\foo`, `c:/foo`, `C:/foo`), file-URI forms (`file:///C:/foo`, `file://C:\foo`), mixed separators, UNC (`\\server\share\foo` → `//server/share/foo`), edge cases (bare `C:`, bare `/`, empty string, `gs://` / `s3://` / `http(s)://` passthrough). Classifier table for `is_local_dataset_url` covering each branch. Round-trip: every equivalent-spelling group from the normalize table produces a single `dataset_id_for_url` output. Idempotence: `normalize(normalize(s)) == normalize(s)` for every entry in the table |
| `lucida-store::backend` | Existing `open_local_path` test extended with drive-letter and UNC variants — pure construction (no I/O on the file). Existing `open_unsupported_scheme` test still passes because `ftp://` doesn't match any local-path pattern |
| `lucida-server::browse` | New test: empty `path` returns a response whose `entries` are platform-appropriate. The existing `data_dir`-constraint test extended with an assertion that the returned `path` field is in canonical form |
| `lucida-core` WASM shim | One TS smoke test asserts `import { normalize_dataset_url, is_local_dataset_url } from "lucida-core"` resolves and produces the documented output for two or three representative inputs — catches build-config drift if the wasm-pack output ever stops re-exporting these names |
| `captureBuilder.ts` | Extends existing tests with `isLocalFilePath("c:/foo")` → `true`, `isLocalFilePath("//server/share/foo")` → `true` |
| `FileBrowser.tsx` | Mocked-fetch test that an empty initial `path` triggers a request without a `path=` query param, renders the entries the mock returns, and on click constructs the next request by joining with `/` |
| `useDatasets.ts` | Test that `handleUrlSubmit("C:\\Users\\me\\foo.zarr")` results in `sendOpenRemoteDataset` being called with `c:/Users/me/foo.zarr` |

Prior art:

- `lucida-server/tests/dataset_id_stable.rs` for ID-stability assertion patterns.
- `lucida-server/tests/auth_disabled_mode_e2e.rs::data_dir_browse` for the browse-handler test pattern.
- `lucida-web/src/hooks/useSavedViewSync.test.tsx` for the WASM-shim mocking pattern (already mocks `dataset_id_for_url`).

## Out of Scope

- **Cross-machine sharing of saved views containing local paths** — still personal-only per ADR-0014. Recipients on a different machine or different OS get `OpenDatasetFailed`.
- **Full filesystem canonicalization** of dataset URLs — `..` resolution, symlink collapse, case-folding of the entire path. Light string-level normalization only.
- **Windows CI matrix** — deferred. Recorded in `wiki/queue.md`. Manual verification only while Windows usage is single-developer.
- **Production Windows deployments** — out of scope; production stays Linux containers.
- **Cross-OS path equivalence** — a Linux user opening `/foo/bar.zarr` and a Windows user opening `C:\foo\bar.zarr` get different `DatasetId`s by design. Same machine only.
- **Exotic UNC forms** — `\\?\UNC\…` verbatim, IPv6-literal UNC hostnames, embedded-credentials UNC. Supported form is `\\server\share\…` only; exotic forms return clean errors.
- **FileBrowser UX polish on Linux/Mac** — not regressed, not improved.
- **`lucida-cli` cross-platform** — no current local-path codepaths to fix.
- **Existing-bookmark / saved-view migration** — v0; no migration story needed.

## Further Notes

- **The recipient-peer URL-lookup limitation is pre-existing**: a peer who receives a `DatasetOpened` broadcast for a dataset another peer opened only knows the `DatasetId`, not the URL. The SPA's `urlByDatasetId` map is populated locally at `sendOpenRemoteDataset` time. This means a recipient cannot include such datasets in their own saved-view captures with full fidelity. Not addressed by this PRD.
- **`DatasetId` and proxy-cache directory derive from the same blake3 prefix** today, and they'll stay in sync after the move to `lucida-content::url` because the helper is the single shared implementation.
- **A cosmetic surprise for Windows users**: typing `C:\Users\me\foo.zarr` will show `c:/Users/me/foo.zarr` in saved-view URLs and the URL bar after open. This is the intended consequence of normalize-on-input — what gets stored is what gets shown.
- **The "intentionally thin, owns nothing computational" claim about `lucida-protocol` stays verbatim**. Placement of the new URL helpers in `lucida-content::url` honors that claim.
- **Branch**: `fix/windows-local-paths` (already checked out).
