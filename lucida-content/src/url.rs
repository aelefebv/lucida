//! Cross-platform dataset URL helpers.
//!
//! The functions in this module are the **single source of truth** for
//! how lucida turns a user-typed dataset path into:
//!
//!   1. A canonical string form ([`normalize_dataset_url`]) used uniformly
//!      for `DatasetId` hashing, proxy-cache directory naming, wire
//!      transmission, and display.
//!   2. A boolean classification ([`is_local_dataset_url`]) of whether a
//!      *normalized* URL refers to a filesystem path (Unix, drive-letter,
//!      or UNC) versus a remote scheme (`gs://`, `s3://`, `http(s)://`).
//!   3. A stable content-derived id ([`dataset_id_for_url`]) and a
//!      16-byte URL hash ([`dataset_url_hash16`]) used by the proxy
//!      cache to name per-dataset directories. Both derive from the same
//!      BLAKE3 digest (see [`blake3_url`]) so they cannot drift.
//!
//! Normalization is **pure string-level**, not a filesystem
//! `canonicalize` call. `..` is not resolved, symlinks are not followed,
//! the path does not need to exist, and the function is **idempotent**
//! (safe to call defensively at every boundary). See
//! `wiki/decisions/0042-canonical-dataset-url-form.md` for the full
//! rationale and what's intentionally not solved.
//!
//! Placement here (in `lucida-content`) honors the existing crate
//! boundaries: every caller (`lucida-store`, `lucida-core`,
//! `lucida-server`) already depends on `lucida-content`, the crate
//! explicitly hosts pure (no-I/O, no-async) computation alongside the
//! identity types (`DatasetId` lives in `lucida-content::id`), and
//! `lucida-protocol` stays computation-free per its own systems article.

/// Strip a leading `file://` or `file:///`+ prefix, lowercase the drive
/// letter on Windows-style paths, forward-slashify backslashes, and
/// canonicalize UNC `\\server\share\…` to `//server/share/…`. Unix paths
/// and remote-scheme URLs (`gs://`, `s3://`, `http://`, `https://`) pass
/// through unchanged.
///
/// Idempotent: `normalize_dataset_url(normalize_dataset_url(s)) ==
/// normalize_dataset_url(s)` for every input.
///
/// Examples (see the `tests` module for the authoritative table):
///   - `"/foo/bar"` → `"/foo/bar"`
///   - `"C:\\foo"` → `"c:/foo"`
///   - `"C:/foo"` → `"c:/foo"`
///   - `"file:///C:/foo"` → `"c:/foo"`
///   - `"\\\\server\\share\\foo"` → `"//server/share/foo"`
///   - `"gs://bucket/path"` → `"gs://bucket/path"` (unchanged)
pub fn normalize_dataset_url(raw: &str) -> String {
    // Empty stays empty.
    if raw.is_empty() {
        return String::new();
    }

    // Remote schemes (gs://, s3://, http://, https://) pass through
    // unchanged. file:// is handled specially below.
    if is_remote_scheme(raw) {
        return raw.to_string();
    }

    // Strip leading `file://` and any extra slashes (`file:///` is the
    // browser-produced form for `file://` + an absolute path). After
    // strip, the remainder is treated like any other raw path and goes
    // through drive-letter / UNC / Unix recognition below.
    let stripped = strip_file_uri(raw);

    // UNC: `\\server\share\…` (two leading backslashes, no drive). The
    // input must literally start with `\\` before the file:// strip
    // *or* after it (a `file:////server/share/foo` form). Forward-slash
    // form `//server/share/foo` is already canonical — passthrough.
    if stripped.starts_with("\\\\") {
        // Convert all backslashes to forward slashes; the leading `\\`
        // becomes `//`, which is the canonical UNC form.
        let forward: String = stripped.chars().map(swap_backslash).collect();
        return forward;
    }

    // Drive-letter pattern: ASCII letter, colon, then optionally a
    // separator and a remainder. Examples: `C:`, `C:\foo`, `c:/foo`,
    // `C:/foo\bar/baz`.
    if let Some(canonical) = canonicalize_drive_letter(&stripped) {
        return canonical;
    }

    // Unix-style passthrough (including bare `/` and relative paths the
    // caller chose to hand us). No transformation; backslashes here are
    // legal Unix filename bytes and we don't second-guess them.
    stripped.into_owned()
}

/// `true` if `canonical` (already normalized) refers to a filesystem
/// path on the server: Unix (`/foo`), drive-letter (`c:/foo`), or UNC
/// (`//server/share/foo`). `false` for empty input and for the remote
/// schemes (`gs://`, `s3://`, `http://`, `https://`).
///
/// Callers should normalize first; see [`normalize_dataset_url`]. The
/// recommended idiom is `is_local_dataset_url(normalize_dataset_url(s))`.
pub fn is_local_dataset_url(canonical: &str) -> bool {
    if canonical.is_empty() {
        return false;
    }
    if is_remote_scheme(canonical) {
        return false;
    }
    // UNC: `//server/share/…`. A bare `//` with no host isn't a UNC
    // path — but it also isn't a remote scheme and isn't a drive
    // letter, so we'd fall through to the Unix branch. The classifier
    // treats anything `//…` after normalization as UNC; if the input
    // doesn't have a server/share the storage backend will fail open.
    if canonical.starts_with("//") {
        return true;
    }
    // Drive-letter pattern: `c:` or `c:/…` (lowercased by normalize).
    if is_drive_letter_canonical(canonical) {
        return true;
    }
    // Unix path: anything starting with `/`.
    canonical.starts_with('/')
}

/// Stable, content-derived `DatasetId` for a dataset URL. Format:
/// `ds-{first_8_bytes_of_blake3(url)_as_le_u64_hex}`.
///
/// Two opens of the same URL within a session produce the same id —
/// that's the dedup-on-reopen primitive lucida-server relies on. See
/// `wiki/decisions/0014-local-file-datasets-personal-only-in-saved-views.md`
/// for the BLAKE3-collision sharp edge on local-file paths.
///
/// Callers that want cross-machine equivalence on Windows / UNC should
/// pass a [`normalize_dataset_url`]-canonicalized URL.
pub fn dataset_id_for_url(canonical: &str) -> String {
    let digest = blake3_url(canonical);
    let prefix: [u8; 8] = digest[..8].try_into().expect("blake3 always >= 8 bytes");
    format!("ds-{:016x}", u64::from_le_bytes(prefix))
}

/// 16-byte URL hash used by the proxy cache for its per-dataset
/// directory name. Shares the underlying BLAKE3 digest with
/// [`dataset_id_for_url`] so the two stay in lockstep — the cache
/// directory's first 8 bytes (in BLAKE3 order) match the bytes from
/// which the `ds-...` ID is built.
pub fn dataset_url_hash16(canonical: &str) -> [u8; 16] {
    let digest = blake3_url(canonical);
    let mut out = [0u8; 16];
    out.copy_from_slice(&digest[..16]);
    out
}

/// Internal: full 32-byte BLAKE3 digest of `url`. Held as a single
/// helper so [`dataset_id_for_url`], [`dataset_url_hash16`], and any
/// future longer derivation cannot drift apart. Mirrors the same
/// shared-helper pattern the old `lucida-server::handler` used before
/// this module collected the URL helpers.
fn blake3_url(url: &str) -> [u8; 32] {
    *blake3::hash(url.as_bytes()).as_bytes()
}

// ---------- private helpers ----------

/// Match `gs://`, `s3://`, `http://`, `https://` (and only those).
/// `file://` is intentionally NOT a remote scheme — it's a local
/// filesystem URI and gets stripped to a plain path by normalize.
fn is_remote_scheme(s: &str) -> bool {
    s.starts_with("gs://")
        || s.starts_with("s3://")
        || s.starts_with("http://")
        || s.starts_with("https://")
}

/// Strip a `file://` prefix and any number of trailing slashes after
/// it. Returns a borrowed `Cow` to avoid allocating when no prefix was
/// present (the common Linux case).
fn strip_file_uri(raw: &str) -> std::borrow::Cow<'_, str> {
    if !raw.starts_with("file://") {
        return std::borrow::Cow::Borrowed(raw);
    }
    // After `file://`, eat any extra ASCII slashes. Browsers produce
    // `file:///C:/foo` (three slashes); some shells produce
    // `file:////server/share/foo` for UNC. Eating the slashes leaves
    // the path remainder for the drive-letter / UNC / Unix branches.
    //
    // We need to special-case UNC: `file:////server/share/foo` has
    // four slashes; eating all four loses the UNC marker. So if after
    // the prefix we see `//`, we *re-add* `\\` so the UNC branch in
    // the caller fires.
    let after_scheme = &raw["file://".len()..];
    // `file://\\server\…` — human-typed (rare); pass the remainder
    // through after stripping just the scheme, leaving the UNC marker
    // intact for the caller's UNC branch.
    if after_scheme.starts_with("\\\\") {
        return std::borrow::Cow::Borrowed(after_scheme);
    }
    // `file:////server/share/foo` — the URI form for UNC (two
    // forward slashes after `file://`). Re-emit a backslash UNC
    // marker so the caller's UNC branch picks it up.
    if after_scheme.starts_with("//") {
        let trimmed = after_scheme.trim_start_matches('/');
        return std::borrow::Cow::Owned(format!("\\\\{trimmed}"));
    }
    // Browser-form `file:///C:/foo` — three slashes, the third
    // belongs to the absolute-path remainder. Eat the leading
    // slashes that are part of the URI scheme, not the path.
    let trimmed = after_scheme.trim_start_matches('/');
    std::borrow::Cow::Owned(trimmed.to_string())
}

/// If `s` is `[A-Za-z]:` optionally followed by a separator and a
/// remainder, return the canonicalized form (`c:`, `c:/foo`, etc.).
/// Otherwise return `None`.
fn canonicalize_drive_letter(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    // Need at least `X:` (2 bytes).
    if bytes.len() < 2 {
        return None;
    }
    if !is_ascii_letter(bytes[0]) || bytes[1] != b':' {
        return None;
    }

    let mut out = String::with_capacity(s.len());
    // Lowercase the drive letter, keep the colon.
    out.push((bytes[0] as char).to_ascii_lowercase());
    out.push(':');

    // Bare `C:` → `c:` (no separator, no remainder). Done.
    if bytes.len() == 2 {
        return Some(out);
    }

    // After `X:`, there may be a separator (`\` or `/`) and a
    // remainder. Forward-slashify everything that follows. We keep at
    // most one separator in canonical form — extra leading slashes
    // (e.g. `C:\\\\foo`) collapse to a single `/`, matching what the
    // OS would do.
    let rest = &s[2..];
    out.push('/');
    let rest_trimmed = rest.trim_start_matches(['\\', '/']);
    for ch in rest_trimmed.chars() {
        out.push(swap_backslash(ch));
    }
    Some(out)
}

/// `true` if `s` is the canonical drive-letter form: lowercase ASCII
/// letter, colon, then either end-of-string or `/`. (Used by
/// [`is_local_dataset_url`]; relies on input having been normalized.)
fn is_drive_letter_canonical(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() < 2 {
        return false;
    }
    let drive_ok =
        bytes[0].is_ascii_lowercase() && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if !drive_ok {
        return false;
    }
    // Either `c:` (length 2) or `c:/…` (third byte is `/`).
    bytes.len() == 2 || bytes[2] == b'/'
}

fn is_ascii_letter(b: u8) -> bool {
    b.is_ascii_alphabetic()
}

fn swap_backslash(c: char) -> char {
    if c == '\\' { '/' } else { c }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- normalize_dataset_url: table-driven ----

    /// Each row: (input, expected_canonical). The same table is reused
    /// by the idempotence and round-trip-id tests below.
    fn normalize_cases() -> Vec<(&'static str, &'static str)> {
        vec![
            // Unix passthrough.
            ("/foo/bar", "/foo/bar"),
            ("/data/scans/foo.zarr", "/data/scans/foo.zarr"),
            // Drive-letter case variants — all collapse to `c:/foo`.
            ("C:\\foo", "c:/foo"),
            ("c:/foo", "c:/foo"),
            ("C:/foo", "c:/foo"),
            // file:// forms (browser-produced and shell-produced).
            ("file:///C:/foo", "c:/foo"),
            ("file://C:\\foo", "c:/foo"),
            // Mixed separators inside a drive-letter path.
            ("C:\\foo/bar\\baz", "c:/foo/bar/baz"),
            // Deeper drive-letter path with spaces.
            (
                "C:\\Users\\me\\my data\\foo.zarr",
                "c:/Users/me/my data/foo.zarr",
            ),
            // UNC: backslash form folds to forward-slash form.
            ("\\\\server\\share\\foo", "//server/share/foo"),
            (
                "\\\\fileserver\\share\\foo.zarr",
                "//fileserver/share/foo.zarr",
            ),
            // file:// UNC form (rare, but `file:////host/share/…` is
            // the URI form for UNC).
            ("file:////server/share/foo", "//server/share/foo"),
            // Edge cases.
            ("C:", "c:"),
            ("/", "/"),
            ("", ""),
            // Remote-scheme passthrough.
            ("gs://bucket/path", "gs://bucket/path"),
            ("s3://bucket/path", "s3://bucket/path"),
            ("http://host/p", "http://host/p"),
            ("https://host/p", "https://host/p"),
        ]
    }

    #[test]
    fn normalize_dataset_url_table() {
        for (input, expected) in normalize_cases() {
            let got = normalize_dataset_url(input);
            assert_eq!(
                got, expected,
                "normalize_dataset_url({input:?}) = {got:?}, expected {expected:?}"
            );
        }
    }

    #[test]
    fn normalize_dataset_url_is_idempotent() {
        for (input, _) in normalize_cases() {
            let once = normalize_dataset_url(input);
            let twice = normalize_dataset_url(&once);
            assert_eq!(
                once, twice,
                "normalize not idempotent for {input:?}: once={once:?}, twice={twice:?}"
            );
        }
    }

    // ---- is_local_dataset_url: classifier table ----

    #[test]
    fn is_local_dataset_url_table() {
        let cases: Vec<(&str, bool)> = vec![
            // Unix.
            ("/foo/bar", true),
            ("/", true),
            // Drive-letter (canonical form).
            ("c:/foo", true),
            ("c:", true),
            // UNC (canonical form).
            ("//server/share/foo", true),
            // Remote schemes.
            ("gs://bucket/path", false),
            ("s3://bucket/path", false),
            ("http://host/p", false),
            ("https://host/p", false),
            // Empty.
            ("", false),
        ];
        for (input, expected) in cases {
            let got = is_local_dataset_url(input);
            assert_eq!(
                got, expected,
                "is_local_dataset_url({input:?}) = {got}, expected {expected}"
            );
        }
    }

    // ---- Round-trip: equivalent spellings produce the same id ----

    #[test]
    fn dataset_id_for_url_is_stable_across_spelling_variants() {
        // Each group is a set of input spellings that should normalize
        // to the same canonical form, and therefore produce the same
        // `dataset_id_for_url`. Checks the property at the externally
        // observable layer (same id) — see the PRD's "Testing
        // Decisions" §.
        let groups: Vec<Vec<&str>> = vec![
            vec![
                "C:\\foo",
                "c:/foo",
                "C:/foo",
                "file:///C:/foo",
                "file://C:\\foo",
            ],
            vec!["\\\\server\\share\\foo", "//server/share/foo"],
        ];
        for group in groups {
            let ids: Vec<String> = group
                .iter()
                .map(|s| dataset_id_for_url(&normalize_dataset_url(s)))
                .collect();
            let first = &ids[0];
            for (i, id) in ids.iter().enumerate().skip(1) {
                assert_eq!(
                    id, first,
                    "spelling {:?} produced id {id}, expected {first} (same as {:?})",
                    group[i], group[0]
                );
            }
        }
    }

    // ---- dataset_id_for_url: format ----

    #[test]
    fn dataset_id_for_url_format() {
        let id = dataset_id_for_url("gs://bucket/a.zarr");
        assert!(id.starts_with("ds-"));
        // 3 ("ds-") + 16 hex chars
        assert_eq!(id.len(), 19);
    }

    #[test]
    fn dataset_id_for_url_distinguishes_different_urls() {
        let a = dataset_id_for_url("gs://bucket/a.zarr");
        let b = dataset_id_for_url("gs://bucket/b.zarr");
        assert_ne!(a, b);
    }

    // ---- dataset_url_hash16 ↔ dataset_id_for_url lockstep ----

    #[test]
    fn dataset_url_hash16_first_8_bytes_match_dataset_id() {
        // The id is `ds-{first_8_bytes_le_u64_hex}`; the hash16 is the
        // first 16 bytes of the same digest. So the id's hex (after
        // little-endian decoding) must equal the first 8 bytes of the
        // hash16 in raw byte order.
        let url = "gs://bucket/a.zarr";
        let id = dataset_id_for_url(url);
        let hash = dataset_url_hash16(url);

        let id_hex = id.strip_prefix("ds-").expect("ds- prefix");
        let id_le_u64 = u64::from_str_radix(id_hex, 16).expect("hex");
        let id_bytes_le = id_le_u64.to_le_bytes();

        assert_eq!(id_bytes_le.as_slice(), &hash[..8]);
    }
}
