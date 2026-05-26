## Parent PRD

#703

## What to build

Make the FileBrowser modal cross-platform: on Windows it shows a synthetic drives-list root (`c:`, `d:`, …) instead of trying to browse a non-existent `/`. The browse handler returns canonical-form paths (no `\\?\` verbatim UNC noise), and the SPA component is platform-agnostic — it never synthesizes roots client-side.

See PRD #703 §"Implementation Decisions / Modified modules" — specifically the `lucida-server::browse` and `lucida-web/src/components/FileBrowser.tsx` entries. ADR-0042 §"Consequences" describes the canonical-display-form conversion (strip `\\?\` and `\\?\UNC\`, lowercase drive, forward-slashify).

After this slice:
- `lucida-server::browse::BrowseQuery::path` becomes `Option<String>`. When absent or empty, the handler returns a platform-default response: on Windows, a synthetic entry list of accessible drives (scan A–Z via `tokio::fs::metadata`, return matches as `directory`-typed entries named lowercase `c:`, `d:`, …); on Unix, the existing `/` listing.
- A small helper converts a canonicalized `PathBuf` to the canonical display form for the response's `path` field (strip `\\?\` and `\\?\UNC\` prefixes on Windows, lowercase drive letter, replace backslashes with forward slashes). Unix paths pass through unchanged.
- The `data_dir` constraint check stays exactly as today (segment-aware `starts_with` on canonicalized PathBufs from the same `tokio::fs::canonicalize` call — UNC-vs-non-UNC mismatch cannot happen because both sides go through canonicalize).
- SPA `lucida-web/src/components/FileBrowser.tsx` on initial open sends a fetch with no `path=` query param; it then uses the response's `path` field as its current path. Navigation joins entries with `/` (canonical form is always forward-slash). The root breadcrumb sends an empty path again to return to the platform-default root. Breadcrumb segment-split uses `/` throughout. Existing `sessionStorage` persistence is preserved.

## Acceptance criteria

- [ ] `lucida-server::browse::BrowseQuery::path` becomes optional. When absent/empty: returns a platform-default response. Existing path-supplied behavior unchanged.
- [ ] New `lucida-server::browse` helper converts canonicalized PathBufs to canonical display form. Test it directly with sample inputs (mock `PathBuf` constructions like `\\?\C:\Users\me` → `c:/Users/me`).
- [ ] Existing `lucida-server/tests/auth_disabled_mode_e2e.rs::data_dir_browse` test still passes; extended with an assertion that the returned `path` field is in canonical form.
- [ ] New `lucida-server::browse` unit test asserts empty-`path` request returns a non-error response (entries shape verified — on Linux CI, the test asserts `entries` contains entries reachable from `/`; the Windows drives-list behavior is verified manually).
- [ ] SPA `FileBrowser.tsx` initial fetch sends no `path=` query param. On subsequent navigation, joins with `/`. Mocked-fetch test asserts: empty initial path → request URL has no `path` param; clicking a returned `directory` entry → next request URL has `path=<previous-path>/<entry-name>`.
- [ ] SPA `FileBrowser.tsx` breadcrumb segment-split logic uses `/` (canonical form). Root breadcrumb click sends empty path to return to platform-default.
- [ ] `cargo test --workspace` green. `pnpm test` (in `lucida-web`) green.
- [ ] Manual smoke (author-only, Windows): open the FileBrowser modal → drives list (`c:`, `d:`, …) appears. Click `c:` → navigate into `C:\` contents. Click breadcrumb root → back to drives list. With `LUCIDA_DATA_DIR=C:\test-data` set, browse is constrained to that subtree (out-of-tree paths return 403).

## Blocked by

- Blocked by #704

## User stories addressed

- US 4 (drives list as initial entries on Windows)
- US 5 (root breadcrumb returns to drives list)
- US 9 (`LUCIDA_DATA_DIR` correctly enforced on Windows including UNC and `\\?\` verbatim forms)
- US 13 (browse-handler errors behave identically across platforms)

## Wiki context

Read these before coding:

- **decisions** — `0042-canonical-dataset-url-form.md` (canonical-display-form requirement; UNC handling)
- **systems** — `crates/lucida-server.md` (browse handler shape; `data_dir` constraint security check), `crates/lucida-web.md` (FileBrowser component)
- **outputs** — `windows-local-paths-prd.md` (full PRD)
