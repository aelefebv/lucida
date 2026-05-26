## Parent PRD

#703

## What to build

Foundational `lucida-content::url` module containing the cross-platform URL helpers, plus `lucida-core::saved_view` WASM shims exposing them to the SPA, plus deduplication of the existing `dataset_id_for_url` / `dataset_url_hash16` definitions across crates.

See PRD #703 §"New module" and §"Implementation Decisions / Modified modules" for the full design context. ADR-0042 captures the canonical-form rule and the rationale for light string-level normalization over filesystem canonicalize.

After this slice:
- `lucida_content::url::normalize_dataset_url(raw) -> String` exists, is idempotent, and is correct against the table from PRD §"Testing Decisions".
- `lucida_content::url::is_local_dataset_url(canonical) -> bool` exists and classifies Unix / drive-letter / UNC correctly.
- `lucida_content::url::dataset_id_for_url(canonical) -> String` is the single source of truth (was duplicated in `lucida-core::saved_view` and `lucida-server::handler`).
- `lucida_content::url::dataset_url_hash16(canonical) -> [u8; 16]` is co-located and stays in lockstep with the ID via a shared internal digest helper.
- `lucida-core::saved_view` exposes all three of `dataset_id_for_url`, `normalize_dataset_url`, `is_local_dataset_url` as `#[wasm_bindgen]` shims that delegate to `lucida_content::url`.
- Every previous caller of the two duplicated functions in `lucida-server::handler` now imports from `lucida_content::url`.

No user-visible behavior change yet. Verification is via tests + WASM build + SPA imports resolving.

## Acceptance criteria

- [ ] New `lucida-content/src/url.rs` module (re-exported via `lucida-content/src/lib.rs`) with the four functions above.
- [ ] `blake3 = "1"` added to `lucida-content/Cargo.toml`.
- [ ] Table-driven unit tests in `lucida-content::url::tests` covering: Unix passthrough, drive-letter case variants (`C:\foo`, `c:/foo`, `C:/foo`), file-URI forms (`file:///C:/foo`, `file://C:\foo`), mixed separators (`C:\foo/bar\baz`), UNC (`\\server\share\foo` → `//server/share/foo`), edge cases (bare `C:`, bare `/`, empty string, `gs://` / `s3://` / `http(s)://` passthrough). Classifier table covering each branch. Round-trip: equivalent-spelling groups → identical `dataset_id_for_url` output. Idempotence: `normalize(normalize(s)) == normalize(s)` for every table entry.
- [ ] `lucida-core::saved_view::dataset_id_for_url` becomes a thin `#[wasm_bindgen]` wrapper over `lucida_content::url::dataset_id_for_url`. Existing `lucida-core` test suite still passes.
- [ ] Two new `#[wasm_bindgen]` shims in `lucida-core::saved_view` for `normalize_dataset_url` and `is_local_dataset_url`.
- [ ] One TS smoke test in `lucida-web` asserts `import { normalize_dataset_url, is_local_dataset_url } from "lucida-core"` resolves and produces expected output for representative inputs.
- [ ] `lucida-server::handler::dataset_id_for_url` and `lucida-server::handler::dataset_url_hash16` deleted; every call site updated to import from `lucida_content::url`.
- [ ] Existing tests across `cargo test --workspace` and `pnpm test` (in `lucida-web`) still pass.
- [ ] `pnpm run build:wasm` succeeds and emits the two new function names in `lucida-core/pkg/`.

## Blocked by

None — can start immediately.

## User stories addressed

- US 10 (single source of truth for URL normalization shared between Rust and TS)
- US 11 (single home for `dataset_id_for_url`)

## Wiki context

Read these before coding:

- **decisions** — `0042-canonical-dataset-url-form.md` (full design rationale, canonical-form rule, what's not solved), `0014-local-file-datasets-personal-only-in-saved-views.md` (related; gets the addendum classifier rule applied here)
- **systems** — `crates/lucida-content.md` (home of the new module; respect "no I/O, no async"), `crates/lucida-core.md` (WASM shim pattern — `dataset_id_for_url` already exists as a wasm-bindgen export to model from), `crates/lucida-server.md` (handler duplicates to delete)
- **outputs** — `windows-local-paths-prd.md` (full PRD source)
