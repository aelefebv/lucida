## Summary

Cross-platform local dataset paths for Lucida. A Windows developer running `cargo run -p lucida-server` can now open a Windows-local OME-Zarr via the URL bar (typed `C:\…`, `c:/…`, `file:///C:/…`, or UNC `\\server\share\…`) or the FileBrowser modal. Same-machine refresh preserves `DatasetId` and bookmarks; spelling variants of the same path dedup to one binding.

Implements PRD #703. Design recorded in [ADR-0042](wiki/decisions/0042-canonical-dataset-url-form.md); the personal-only-share decision in [ADR-0014](wiki/decisions/0014-local-file-datasets-personal-only-in-saved-views.md) is amended (classifier rule re-pointed) but the share-warning semantics are unchanged.

## What landed

Three squash-merged slices on top of the docs-prep commit:

- **Slice 1 — `lucida-content::url` foundation + WASM shims (#704, PR #707, commit `178f8f8`)** — extracts the cross-platform URL helpers (`normalize_dataset_url`, `is_local_dataset_url`, `dataset_id_for_url` moved, `dataset_url_hash16` moved) into a new pure module on `lucida-content`. Adds `#[wasm_bindgen]` shims in `lucida-core::saved_view` so the SPA imports the same single source of truth. Deletes the previously-duplicated copies in `lucida-server::handler`.
- **Slice 2 — URL-bar flow + share-warning classifier (#705, PR #708, commit `d4c92df`)** — `lucida-store::backend::open` normalizes input at entry and classifies via `is_local_dataset_url`; `lucida-server::handler::handle_open_remote_dataset` normalizes once at the input boundary; SPA `useDatasets::handleUrlSubmit` normalizes via the WASM shim; `captureBuilder::isLocalFilePath` delegates to the WASM shim.
- **Slice 3 — FileBrowser cross-platform (#706, PR #709, commit `5e77969`)** — `lucida-server::browse::BrowseQuery::path` becomes optional; empty path returns a platform-default response (drives list on Windows via A–Z `tokio::fs::metadata` scan, `/` listing on Unix). Response `path` field always in canonical-display form (strips `\\?\` / `\\?\UNC\` verbatim prefixes from `canonicalize`, lowercases drive letter, forward-slashifies). SPA `FileBrowser.tsx` sends empty initial path; navigation joins entries with `/`; `..` button hidden at platform root.

Plus a wiki-refresh `docs:` commit (`e4cd866`) updating `now.md` and the affected systems articles (`lucida-content`, `lucida-core`, `lucida-store`, `lucida-server`, `saved-views`).

## Canonical URL form (the load-bearing design call)

- **Drive-letter**: `c:/Users/me/foo.zarr` — lowercase drive, forward slashes, `file://` stripped
- **UNC**: `//server/share/foo.zarr` — forward-slashified
- **Unix**: `/foo/bar.zarr` — unchanged

Used uniformly for `DatasetId` hashing, proxy-cache directory naming, wire transmission, and display. Full filesystem `canonicalize` was rejected — it requires the file to exist at hash time, returns `\\?\C:\…` UNC we'd have to strip back for display, and changes Unix dedup behavior unnecessarily. Light string-level normalization gives the spelling-variant dedup users need at zero disk-touch cost. Full rationale + considered options in ADR-0042.

## Out of scope (recorded in PRD)

- Cross-machine sharing of saved views with local paths — still personal-only per ADR-0014
- Windows CI matrix — deferred (see `wiki/queue.md` entry); manual verification at PR time while Windows usage is single-developer
- Production Windows deployments — production stays Linux containers
- Cross-OS path equivalence by design (a Linux `/foo/bar` and a Windows `C:\foo\bar` produce different `DatasetId`s)
- Exotic UNC forms (`\\?\UNC\`, IPv6-literal hostnames, embedded credentials)

## Test plan

Each slice ran the workspace test suite plus targeted new tests; CI was green on all three slice PRs against `fix/windows-local-paths`. Before merging to main, you may want to:

- [ ] Manual Windows smoke: `cargo run -p lucida-server` + SPA dev server; type `C:\path\to\an.zarr` in URL bar → opens; refresh → preserves `DatasetId`; paste the same path in a different spelling → dedups; share-warning fires for the saved-view URL containing that dataset
- [ ] Manual Windows smoke: open FileBrowser → drives list shows; click a drive → navigate in; click root breadcrumb → back to drives list
- [ ] Manual UNC smoke (if you have a lab share): type `\\fileserver\share\foo.zarr` → opens
- [ ] Manual `LUCIDA_DATA_DIR` smoke on Windows: set the env var, verify browse is constrained to the subtree
- [ ] Verify Linux behavior unchanged (open a Unix-path dataset, refresh, share — all should look exactly like before)

## Notes for the reviewer

- Wire-protocol shape unchanged — no version bump needed
- `release-please` will see this squash-merge subject (`feat:`) and bump the minor version on the next release PR
- The Phase-1 design grilling, Phase-2 PRD/ADR drafting, and Phase-5 wiki refresh were all part of running `/code` end-to-end on this branch; all decisions are recorded in PRD #703 and ADR-0042

🤖 Generated with [Claude Code](https://claude.com/claude-code)
