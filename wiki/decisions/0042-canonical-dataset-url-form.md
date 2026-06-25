---
type: Decision
title: "Canonical dataset URL form"
description: "Every dataset URL passes through a single string-level normalization step at the storage boundary, producing one canonical form used uniformly for DatasetId hashing, proxy-cache directory naming, wire transmission, an…"
tags: [lucida, decision]
source_path: wiki/decisions/0042-canonical-dataset-url-form.md
created: 2026-05-26
modified: 2026-05-26
---

# Canonical dataset URL form

Status: Accepted (PRD #703).

## Decision

Every dataset URL passes through a single string-level normalization step at the storage boundary, producing one canonical form used uniformly for `DatasetId` hashing, proxy-cache directory naming, wire transmission, and display:

- **Unix paths** (`/foo/bar.zarr`) — unchanged.
- **Drive-letter paths** (`C:\…`, `c:/…`, `C:/…`, `file:///C:/…`) — lowercased drive letter, forward slashes, no `file://` prefix. Canonical form: `c:/foo/bar.zarr`.
- **UNC paths** (`\\server\share\…`) — forward-slashified. Canonical form: `//server/share/foo.zarr`.
- **Cloud URLs** (`gs://`, `s3://`, `http://`, `https://`) — unchanged passthrough.

The normalization is **pure string-level**, not a filesystem `canonicalize` call. `..` is not resolved, symlinks are not followed, the path does not need to exist at normalization time, and the function is idempotent (safe to call defensively at every boundary).

The implementation lives in a new module `lucida-content::url` with three exported functions: `normalize_dataset_url`, `is_local_dataset_url`, and `dataset_id_for_url` (the last is moved here from `lucida-core::saved_view`; the previously-duplicated copy in `lucida-server::handler` is deleted). `lucida-core::saved_view` keeps `#[wasm_bindgen]` shims so the SPA imports continue to work via `lucida-core`.

## Why

The bug surfaced first as "Windows paths return `UnsupportedScheme`," but the deeper problem is that `dataset_id_for_url` is `blake3(url)` over the raw user-typed string. On Windows a single file has many legal spellings (`C:\foo`, `c:/foo`, `C:/foo`, `file:///C:/foo`) that all resolve to the same bytes but produce different `DatasetId`s, different proxy-cache directories, and different `#view=…` URLs. Pick the wrong spelling once and you re-import the whole dataset and lose your saved-view association.

Light string normalization fixes this without paying the cost of full filesystem `canonicalize`. Specifically it solves the spelling-variation problem (case-different drive letter, forward vs back slash, `file://` prefix variants) at zero disk-touch cost, in a deterministic and synchronous-friendly way, and produces a canonical form that's also pleasant to display.

Placement in `lucida-content::url` honors the existing crate boundaries: both `lucida-store` and `lucida-core` already depend on `lucida-content`, and the crate explicitly hosts pure (no-I/O, no-async) computation alongside the identity types (`DatasetId` already lives in `lucida-content::id`). `lucida-protocol` is intentionally computation-free per its own systems article and stays that way.

## Considered options

**Full filesystem canonicalization at hash time.** Calling `tokio::fs::canonicalize` before hashing would additionally fold `..` resolution and symlink chains into the same `DatasetId`. Rejected because: (a) it requires the file to exist at hash time, killing the existing "compute DatasetId before opening to dedup" pattern; (b) on Windows it returns `\\?\C:\…` verbatim UNC, which we'd have to strip back to a display form anyway; (c) it changes Unix dedup behavior (`/foo/./bar` would start deduping with `/foo/bar`), a behavior shift well beyond the scope of cross-platform support; (d) for the actual workflow — opening OME-Zarr datasets via clean absolute paths — the wins (`..`, symlinks) basically don't apply.

**No normalization, document Windows users must stick to one spelling.** Rejected because the problem surfaces silently — different spellings produce different `DatasetId`s with no visible warning, so users would learn the rule only by losing work.

**Placement in `lucida-protocol::url`.** Rejected because `lucida-protocol`'s systems article explicitly states "intentionally thin — owns nothing computational." Adding computational helpers would weaken that boundary claim. `lucida-content` already hosts computation alongside identity types and is the lower-of-both-callers in the dep graph.

## Consequences

- **`DatasetId`** and **proxy-cache directory naming** derive from the normalized form. Existing v0 bookmarks (Unix-pathed) are unaffected — Unix-path normalization is a passthrough.
- **`lucida-store::backend::open` normalizes internally**, so all callers (server, py, future cli) get cross-platform classification for free; the server also normalizes at its own input boundary because it needs the canonical form for `dataset_id_for_url` *before* calling open. Idempotence makes the double-call safe.
- **The SPA normalizes user input on submit** in `handleUrlSubmit`. Cosmetic surprise: a Windows user typing `C:\Users\me\foo.zarr` sees `c:/Users/me/foo.zarr` in the URL bar and saved-view URLs after open. Acceptable for v0; what's stored is what's shown.
- **The browse handler returns canonical-form paths** in its response, converting `\\?\C:\…` and `\\?\UNC\…` verbatim UNC results from `tokio::fs::canonicalize` back to canonical form via a small helper. The `data_dir` constraint security check stays on segment-aware `starts_with` over canonicalized PathBufs.
- **What's explicitly NOT solved:** `..` resolution (`/foo/../bar` stays `/foo/../bar`); symlink collapse; full case-folding of the path (only the drive letter is lowercased); cross-machine path equivalence (still deferred to [Local-File Datasets Are Personal-Only in Saved Views](0014-local-file-datasets-personal-only-in-saved-views.md)'s personal-only-share rule).
- **ADR-0014's classifier rule** is amended (one-line addendum): the test is now `is_local_dataset_url(normalize_dataset_url(s))`, extended to cover drive-letter and UNC patterns. The personal-only-share decision and the `DatasetId`-blake3-collision sharp edge remain valid verbatim.
- **`lucida-protocol`'s "owns nothing computational" claim stays valid** — the new helpers live in `lucida-content::url`, not protocol.
- **CI stays Linux-only**; Windows support is verified manually by the author at PR time. [Queue — Open Questions](../queue.md) entry records the deferral. Adding a `windows-latest` matrix entry remains a future option, deferred until Windows usage stops being single-developer.

## Related

- [Local-File Datasets Are Personal-Only in Saved Views](0014-local-file-datasets-personal-only-in-saved-views.md) — gets a one-line addendum re-pointing classifier at the new helper; the personal-only-share decision still stands
- [lucida-content](../systems/crates/lucida-content.md) — hosts the new `url` module
- [lucida-store](../systems/crates/lucida-store.md) — `backend::open` normalizes internally before classifying
- [lucida-server](../systems/crates/lucida-server.md) — `/api/browse` returns canonical-form paths and a platform-default root
- PRD #703
