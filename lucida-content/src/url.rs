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
//!   3. A stable locator-derived id ([`dataset_id_for_url`]) and a
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

use std::fmt;

use serde::{Deserialize, Serialize};

/// Maximum accepted locator length at the parsed identity boundary.
pub const MAX_DATASET_URL_BYTES: usize = 16 * 1024;

/// A syntactically valid, normalized dataset locator.
///
/// Keeping the canonical value in a distinct type prevents callers from
/// accidentally using user spelling as a persistent id or cache key.  This is
/// deliberately string-level: it does not touch a filesystem or network.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CanonicalDatasetUrl(String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DatasetUrlError {
    Empty,
    TooLong { bytes: usize, limit: usize },
    ContainsNul,
    Relative(String),
    IdentityMismatch { persisted: String, expected: String },
}

impl fmt::Display for DatasetUrlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => f.write_str("dataset URL is empty"),
            Self::TooLong { bytes, limit } => {
                write!(f, "dataset URL is {bytes} bytes; limit is {limit}")
            }
            Self::ContainsNul => f.write_str("dataset URL contains a NUL byte"),
            Self::Relative(value) => write!(f, "dataset URL is not absolute: {value}"),
            Self::IdentityMismatch {
                persisted,
                expected,
            } => write!(
                f,
                "persisted source identity {persisted} does not match canonical locator identity {expected}"
            ),
        }
    }
}

impl std::error::Error for DatasetUrlError {}

impl CanonicalDatasetUrl {
    pub fn parse(raw: &str) -> Result<Self, DatasetUrlError> {
        let canonical = normalize_dataset_url(raw);
        if canonical.is_empty() {
            return Err(DatasetUrlError::Empty);
        }
        if canonical.len() > MAX_DATASET_URL_BYTES {
            return Err(DatasetUrlError::TooLong {
                bytes: canonical.len(),
                limit: MAX_DATASET_URL_BYTES,
            });
        }
        if canonical.contains('\0') {
            return Err(DatasetUrlError::ContainsNul);
        }
        if !is_local_dataset_url(&canonical) && !canonical.contains("://") {
            return Err(DatasetUrlError::Relative(canonical));
        }
        Ok(Self(canonical))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

impl AsRef<str> for CanonicalDatasetUrl {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl fmt::Display for CanonicalDatasetUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Collision-resistant locator identity.  Locator identity is intentionally
/// separate from a source-content revision: the same locator may publish new
/// bytes over time without becoming a different locator.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SourceIdentity {
    pub locator: CanonicalDatasetUrl,
    digest: [u8; 32],
}

impl SourceIdentity {
    pub fn parse(raw: &str) -> Result<Self, DatasetUrlError> {
        let locator = CanonicalDatasetUrl::parse(raw)?;
        let digest = blake3_url(locator.as_str());
        Ok(Self { locator, digest })
    }

    pub fn digest(&self) -> &[u8; 32] {
        &self.digest
    }

    /// Rebuild a typed identity from persisted fields and prove that the
    /// locator still hashes to the stored id. A mismatch is corruption (or a
    /// collision attempt), never a signal to overwrite either value.
    pub fn from_persisted(raw_locator: &str, persisted_id: &str) -> Result<Self, DatasetUrlError> {
        let identity = Self::parse(raw_locator)?;
        let expected = identity.dataset_id();
        if persisted_id != expected {
            return Err(DatasetUrlError::IdentityMismatch {
                persisted: persisted_id.to_string(),
                expected,
            });
        }
        Ok(identity)
    }

    pub fn digest_hex(&self) -> String {
        hex_digest(&self.digest)
    }

    pub fn dataset_id(&self) -> String {
        format!("ds-{}", hex_digest(&self.digest))
    }
}

/// A revision of the bytes/metadata reachable through a source locator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SourceRevision([u8; 32]);

impl SourceRevision {
    pub fn from_bytes(bytes: &[u8]) -> Self {
        Self(*blake3::hash(bytes).as_bytes())
    }

    pub fn as_hex(&self) -> String {
        hex_digest(&self.0)
    }

    pub fn digest(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn from_hex(raw: &str) -> Option<Self> {
        if raw.len() != 64 {
            return None;
        }
        let mut digest = [0_u8; 32];
        for (index, pair) in raw.as_bytes().chunks_exact(2).enumerate() {
            let high = hex_nibble(pair[0])?;
            let low = hex_nibble(pair[1])?;
            digest[index] = (high << 4) | low;
        }
        Some(Self(digest))
    }
}

/// A locator together with the exact source generation imported from it.
///
/// This is the only safe production cache namespace: locator identity alone
/// deliberately survives in-place source mutation, while a revision alone
/// is not globally unique to a locator.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SourceVersion {
    pub identity: SourceIdentity,
    pub revision: SourceRevision,
}

impl SourceVersion {
    pub fn new(identity: SourceIdentity, revision: SourceRevision) -> Self {
        Self { identity, revision }
    }

    pub fn cache_namespace(&self) -> String {
        format!("{}:{}", self.identity.dataset_id(), self.revision.as_hex())
    }
}

/// Strip a leading `file://` or `file:///`+ prefix, lowercase the drive
/// letter on Windows-style paths, forward-slashify backslashes, and
/// canonicalize UNC `\\server\share\…` to `//server/share/…`. URL schemes
/// are case-insensitive (RFC 3986 §3.1), so a leading scheme is lowercased
/// — and only the scheme: bucket names and object paths are case-sensitive
/// and pass through untouched. Unix paths and already-lowercase
/// remote-scheme URLs (`gs://`, `s3://`, `http://`, `https://`) pass
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
///   - `"HTTP://host/Path"` → `"http://host/Path"` (scheme only)
pub fn normalize_dataset_url(raw: &str) -> String {
    // Empty stays empty.
    if raw.is_empty() {
        return String::new();
    }

    // Canonical scheme form is lowercase. This also lets an uppercase
    // `FILE://` prefix reach the strip below.
    let raw = &*lowercase_scheme(raw);

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

/// Stable, collision-resistant `DatasetId` for a dataset URL. Format:
/// `ds-{full_blake3_digest_as_hex}`.
///
/// Two opens of the same locator within a session produce the same id —
/// that's the dedup-on-reopen primitive lucida-server relies on. See
/// `wiki/decisions/0014-local-file-datasets-personal-only-in-saved-views.md`
/// for the BLAKE3-collision sharp edge on local-file paths.
///
/// This compatibility helper normalizes internally. Admission boundaries
/// should prefer [`SourceIdentity::parse`] so invalid/relative locators are
/// rejected instead of assigned an id.
pub fn dataset_id_for_url(url: &str) -> String {
    match SourceIdentity::parse(url) {
        Ok(identity) => identity.dataset_id(),
        // Keep this infallible compatibility helper deterministic for legacy
        // callers. Admission boundaries should use `SourceIdentity::parse`.
        Err(_) => format!(
            "ds-{}",
            hex_digest(&blake3_url(&normalize_dataset_url(url)))
        ),
    }
}

/// 16-byte URL hash used by the proxy cache for its per-dataset
/// directory name. Shares the underlying BLAKE3 digest with
/// [`dataset_id_for_url`] so the cache key is a prefix of the persistent
/// locator identity.
pub fn dataset_url_hash16(url: &str) -> [u8; 16] {
    let digest = blake3_url(&normalize_dataset_url(url));
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

fn hex_digest(digest: &[u8; 32]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(64);
    for byte in digest {
        write!(&mut out, "{byte:02x}").expect("writing to String cannot fail");
    }
    out
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

// ---------- private helpers ----------

/// Match `gs://`, `s3://`, `http://`, `https://` (and only those), in any
/// letter case — schemes are case-insensitive per RFC 3986 §3.1. `file://`
/// is intentionally NOT a remote scheme — it's a local filesystem URI and
/// gets stripped to a plain path by normalize.
fn is_remote_scheme(s: &str) -> bool {
    has_scheme(s, "gs") || has_scheme(s, "s3") || has_scheme(s, "http") || has_scheme(s, "https")
}

/// `true` if `s` starts with `{scheme}://`, comparing the scheme portion
/// ASCII-case-insensitively.
fn has_scheme(s: &str, scheme: &str) -> bool {
    s.get(..scheme.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(scheme))
        && s[scheme.len()..].starts_with("://")
}

/// If `s` begins with a URI scheme (RFC 3986 §3.1: an ASCII letter followed
/// by letters, digits, `+`, `-`, or `.`) and `://`, return it with the
/// scheme portion lowercased and everything after `://` byte-for-byte
/// intact. Anything else — including drive-letter paths like `C:\foo`,
/// which have a colon but no `//` — is returned unchanged.
fn lowercase_scheme(s: &str) -> std::borrow::Cow<'_, str> {
    let Some(sep) = s.find("://") else {
        return std::borrow::Cow::Borrowed(s);
    };
    let scheme = &s[..sep];
    let shaped_like_scheme = scheme
        .as_bytes()
        .first()
        .is_some_and(|b| b.is_ascii_alphabetic())
        && scheme
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'-' || b == b'.');
    if !shaped_like_scheme || !scheme.bytes().any(|b| b.is_ascii_uppercase()) {
        return std::borrow::Cow::Borrowed(s);
    }
    std::borrow::Cow::Owned(format!("{}{}", scheme.to_ascii_lowercase(), &s[sep..]))
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
    // Browser-form Windows URI: the slash separates the empty authority
    // from `C:/...` and is not part of the drive path.
    if let Some(without_root) = after_scheme.strip_prefix('/')
        && canonicalize_drive_letter(without_root).is_some()
    {
        return std::borrow::Cow::Borrowed(without_root);
    }
    // For Unix, the slash after `file://` IS the absolute path root.  The old
    // implementation trimmed it and silently turned `file:///tmp/data` into
    // the relative path `tmp/data`.
    if after_scheme.starts_with('/') {
        return std::borrow::Cow::Borrowed(after_scheme);
    }
    // A non-drive authority (`file://server/share`) denotes UNC.
    if !after_scheme.is_empty() && canonicalize_drive_letter(after_scheme).is_none() {
        return std::borrow::Cow::Owned(format!("\\\\{after_scheme}"));
    }
    std::borrow::Cow::Borrowed(after_scheme)
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
            ("file:///tmp/data.zarr", "/tmp/data.zarr"),
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
            ("file://server/share/foo", "//server/share/foo"),
            // Edge cases.
            ("C:", "c:"),
            ("/", "/"),
            ("", ""),
            // Remote-scheme passthrough.
            ("gs://bucket/path", "gs://bucket/path"),
            ("s3://bucket/path", "s3://bucket/path"),
            ("http://host/p", "http://host/p"),
            ("https://host/p", "https://host/p"),
            // Schemes are case-insensitive (RFC 3986 §3.1): only the scheme
            // is lowercased — bucket names and object paths keep their case.
            ("HTTP://host/Path", "http://host/Path"),
            ("HtTpS://host/p", "https://host/p"),
            ("GS://Bucket/Key", "gs://Bucket/Key"),
            ("S3://bucket/Key", "s3://bucket/Key"),
            ("FILE:///C:/foo", "c:/foo"),
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
            // Remote schemes, in any letter case.
            ("gs://bucket/path", false),
            ("s3://bucket/path", false),
            ("http://host/p", false),
            ("https://host/p", false),
            ("HTTP://host/p", false),
            ("S3://bucket/path", false),
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
            vec!["http://host/p", "HTTP://host/p", "hTtP://host/p"],
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
        // 3 ("ds-") + the full 32-byte BLAKE3 digest as hex.
        assert_eq!(id.len(), 67);
    }

    #[test]
    fn dataset_id_for_url_distinguishes_different_urls() {
        let a = dataset_id_for_url("gs://bucket/a.zarr");
        let b = dataset_id_for_url("gs://bucket/b.zarr");
        assert_ne!(a, b);
    }

    // ---- dataset_url_hash16 ↔ dataset_id_for_url lockstep ----

    #[test]
    fn dataset_url_hash16_prefix_matches_dataset_id() {
        // The compatibility cache hash is the first 16 bytes of the full
        // digest carried by the collision-resistant source id.
        let url = "gs://bucket/a.zarr";
        let id = dataset_id_for_url(url);
        let hash = dataset_url_hash16(url);

        let id_hex = id.strip_prefix("ds-").expect("ds- prefix");
        let hash_hex = hex_digest(&blake3_url(url));
        assert_eq!(id_hex, hash_hex);
        assert_eq!(&id_hex[..32], &hex_digest(&blake3_url(url))[..32]);
        assert_eq!(hash.as_slice(), &blake3_url(url)[..16]);
    }

    #[test]
    fn canonical_type_rejects_relative_and_preserves_absolute_unix_file_uri() {
        let url = CanonicalDatasetUrl::parse("file:///tmp/data.zarr").unwrap();
        assert_eq!(url.as_str(), "/tmp/data.zarr");
        assert!(matches!(
            CanonicalDatasetUrl::parse("tmp/data.zarr"),
            Err(DatasetUrlError::Relative(_))
        ));
    }

    #[test]
    fn source_revision_is_distinct_from_locator_identity() {
        let identity = SourceIdentity::parse("gs://bucket/data.zarr").unwrap();
        let a = SourceRevision::from_bytes(b"revision-a");
        let b = SourceRevision::from_bytes(b"revision-b");
        assert_ne!(a, b);
        assert_eq!(
            identity.dataset_id(),
            dataset_id_for_url(identity.locator.as_str())
        );
    }

    #[test]
    fn persisted_identity_rejects_locator_mismatch() {
        let a = SourceIdentity::parse("gs://bucket/a.zarr").unwrap();
        let error = SourceIdentity::from_persisted("gs://bucket/b.zarr", &a.dataset_id())
            .expect_err("mismatched locator must not reuse a persisted id");
        assert!(matches!(error, DatasetUrlError::IdentityMismatch { .. }));
    }

    #[test]
    fn equivalent_spelling_produces_the_same_version_namespace() {
        let revision = SourceRevision::from_bytes(b"same generation");
        let a = SourceVersion::new(
            SourceIdentity::parse("FILE:///C:/data/example.zarr").unwrap(),
            revision,
        );
        let b = SourceVersion::new(
            SourceIdentity::parse("c:\\data\\example.zarr").unwrap(),
            revision,
        );
        assert_eq!(a.cache_namespace(), b.cache_namespace());
        assert_eq!(a.identity.digest_hex(), b.identity.digest_hex());
    }
}
