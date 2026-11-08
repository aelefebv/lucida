//! Dataset locations: where a dataset lives, parsed once where it enters
//! ([`DatasetLocation::parse`]), and the id and cache hash derived from its
//! canonical string ([`dataset_id_for_url`], [`dataset_url_hash16`]).
//!
//! Parsing is pure string work, not `canonicalize`: `..` is not resolved,
//! symlinks are not followed, and the path need not exist. The canonical
//! string is what dataset ids and cache directories hash, so a canonical
//! string parses to itself, and a form that once parsed keeps its spelling.

use std::fmt;
use std::str::FromStr;

/// Where a dataset lives: a path on the server's filesystem, or a URL in an
/// object store, in canonical form.
///
/// Canonical forms (the `tests` module holds the authoritative table):
///   - Unix paths pass through: `/srv/a.zarr`.
///   - Drive-letter paths lowercase the drive and use forward slashes:
///     `C:\data\a.zarr` → `c:/data/a.zarr`.
///   - UNC paths use forward slashes: `\\server\share\a.zarr` →
///     `//server/share/a.zarr`.
///   - A `file://` URL becomes the path it names (RFC 8089), percent-decoded:
///     `file:///srv/a.zarr` → `/srv/a.zarr`, `file:///C:/a.zarr` →
///     `c:/a.zarr`, `file://server/share/a.zarr` → `//server/share/a.zarr`,
///     `file:///srv/a%20b.zarr` → `/srv/a b.zarr`. A bare path is never
///     decoded, since `%` is an ordinary filename character.
///   - `gs://`, `s3://`, `http://`, and `https://` URLs lowercase the scheme
///     and nothing else, since bucket names and object paths are
///     case-sensitive.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct DatasetLocation {
    scheme: LocationScheme,
    canonical: String,
}

/// How a [`DatasetLocation`] is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LocationScheme {
    /// A path on the server's filesystem.
    Local,
    Gcs,
    S3,
    Http,
    Https,
}

impl LocationScheme {
    /// The storage kind named in open diagnostics.
    pub fn as_str(self) -> &'static str {
        match self {
            LocationScheme::Local => "local",
            LocationScheme::Gcs => "gcs",
            LocationScheme::S3 => "s3",
            LocationScheme::Http | LocationScheme::Https => "http",
        }
    }
}

/// Why a string is not a [`DatasetLocation`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocationError {
    Empty,
    /// A path that is not absolute. Only the client knows the working
    /// directory it is relative to, so the client resolves it.
    RelativePath {
        input: String,
    },
    /// A URL whose scheme names no storage this server reads.
    UnknownScheme {
        scheme: String,
    },
    /// A `gs://` or `s3://` URL without a bucket.
    MissingBucket {
        scheme: &'static str,
    },
    /// An `http://` or `https://` URL without a host.
    MissingHost {
        scheme: &'static str,
    },
}

impl fmt::Display for LocationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LocationError::Empty => f.write_str("the dataset location is empty"),
            LocationError::RelativePath { input } => write!(
                f,
                "relative path \"{input}\": a dataset path must be absolute"
            ),
            LocationError::UnknownScheme { scheme } => write!(
                f,
                "unsupported URL scheme {scheme}://: use a path, or a gs://, s3://, http://, or https:// URL"
            ),
            LocationError::MissingBucket { scheme } => {
                write!(f, "{scheme}:// URL has no bucket name")
            }
            LocationError::MissingHost { scheme } => write!(f, "{scheme}:// URL has no host name"),
        }
    }
}

impl std::error::Error for LocationError {}

impl LocationError {
    /// A stable snake_case name for the variant, for clients that word the
    /// problem themselves.
    pub fn kind(&self) -> &'static str {
        match self {
            LocationError::Empty => "empty",
            LocationError::RelativePath { .. } => "relative_path",
            LocationError::UnknownScheme { .. } => "unknown_scheme",
            LocationError::MissingBucket { .. } => "missing_bucket",
            LocationError::MissingHost { .. } => "missing_host",
        }
    }
}

impl DatasetLocation {
    /// Parse a user-typed path or URL. Fails, naming what is wrong, for an
    /// empty or relative path, an unknown scheme, or a URL with nothing
    /// after its scheme.
    pub fn parse(raw: &str) -> Result<Self, LocationError> {
        if raw.is_empty() {
            return Err(LocationError::Empty);
        }
        let relative = || LocationError::RelativePath {
            input: raw.to_string(),
        };
        let Some((scheme, rest)) = split_scheme(raw) else {
            return local_path(raw).map(Self::local).ok_or_else(relative);
        };
        match scheme.to_ascii_lowercase().as_str() {
            "gs" => Self::bucket(LocationScheme::Gcs, "gs", rest),
            "s3" => Self::bucket(LocationScheme::S3, "s3", rest),
            "http" => Self::host(LocationScheme::Http, "http", rest),
            "https" => Self::host(LocationScheme::Https, "https", rest),
            "file" => file_url_path(&percent_decode(rest))
                .map(Self::local)
                .ok_or_else(relative),
            _ => Err(LocationError::UnknownScheme {
                scheme: scheme.to_string(),
            }),
        }
    }

    fn local(canonical: String) -> Self {
        Self {
            scheme: LocationScheme::Local,
            canonical,
        }
    }

    fn bucket(
        scheme: LocationScheme,
        name: &'static str,
        rest: &str,
    ) -> Result<Self, LocationError> {
        if rest.is_empty() || rest.starts_with('/') {
            return Err(LocationError::MissingBucket { scheme: name });
        }
        Ok(Self {
            scheme,
            canonical: format!("{name}://{rest}"),
        })
    }

    fn host(scheme: LocationScheme, name: &'static str, rest: &str) -> Result<Self, LocationError> {
        if rest.is_empty() || rest.starts_with('/') {
            return Err(LocationError::MissingHost { scheme: name });
        }
        Ok(Self {
            scheme,
            canonical: format!("{name}://{rest}"),
        })
    }

    /// The canonical string: what is hashed, broadcast, persisted, and shown.
    pub fn as_str(&self) -> &str {
        &self.canonical
    }

    pub fn into_string(self) -> String {
        self.canonical
    }

    pub fn scheme(&self) -> LocationScheme {
        self.scheme
    }

    pub fn is_local(&self) -> bool {
        self.scheme == LocationScheme::Local
    }

    /// The bucket of a `gs://` or `s3://` location.
    pub fn bucket_name(&self) -> Option<&str> {
        self.bucket_and_prefix().map(|(bucket, _)| bucket)
    }

    /// The object key prefix of a `gs://` or `s3://` location, when it
    /// names more than a bucket.
    pub fn object_prefix(&self) -> Option<&str> {
        self.bucket_and_prefix().and_then(|(_, prefix)| prefix)
    }

    fn bucket_and_prefix(&self) -> Option<(&str, Option<&str>)> {
        let scheme_len = match self.scheme {
            LocationScheme::Gcs => "gs://".len(),
            LocationScheme::S3 => "s3://".len(),
            _ => return None,
        };
        let rest = &self.canonical[scheme_len..];
        Some(match rest.split_once('/') {
            Some((bucket, prefix)) if !prefix.is_empty() => (bucket, Some(prefix)),
            Some((bucket, _)) => (bucket, None),
            None => (rest, None),
        })
    }

    /// The source-derived dataset id; see [`dataset_id_for_url`].
    pub fn source_id(&self) -> String {
        dataset_id_for_url(&self.canonical)
    }

    /// The generated-level cache's directory hash; see [`dataset_url_hash16`].
    pub fn hash16(&self) -> [u8; 16] {
        dataset_url_hash16(&self.canonical)
    }

    /// The last path component, which names a newly opened dataset.
    pub fn display_name(&self) -> &str {
        self.canonical
            .rsplit('/')
            .find(|segment| !segment.is_empty())
            .unwrap_or("dataset")
    }
}

impl fmt::Display for DatasetLocation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.canonical)
    }
}

impl FromStr for DatasetLocation {
    type Err = LocationError;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        Self::parse(raw)
    }
}

/// The canonical string for `raw` when it parses, and `raw` unchanged when
/// it does not. For comparing and showing what was typed; anything that
/// opens a dataset parses a [`DatasetLocation`] and handles the error.
pub fn normalize_dataset_url(raw: &str) -> String {
    DatasetLocation::parse(raw).map_or_else(|_| raw.to_string(), DatasetLocation::into_string)
}

/// `true` if `url` parses as a path on the server's filesystem.
pub fn is_local_dataset_url(url: &str) -> bool {
    DatasetLocation::parse(url).is_ok_and(|location| location.is_local())
}

/// Stable, URL-derived `DatasetId` for a dataset URL. Format:
/// `ds-{first_8_bytes_of_blake3(url)_as_le_u64_hex}`.
///
/// Two opens of the same URL produce the same id, which is how the server
/// dedupes a reopen. The id hashes the URL, not the bytes, so one local
/// path gets one id on every server, whatever file it names there. Pass a
/// [`DatasetLocation`]'s canonical string for equivalence across Windows
/// and UNC spellings.
pub fn dataset_id_for_url(canonical: &str) -> String {
    let digest = blake3_url(canonical);
    let prefix: [u8; 8] = digest[..8].try_into().expect("blake3 always >= 8 bytes");
    format!("ds-{:016x}", u64::from_le_bytes(prefix))
}

/// 16-byte URL hash used by the generated-level cache for its per-dataset
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
/// future longer derivation cannot drift apart.
fn blake3_url(url: &str) -> [u8; 32] {
    *blake3::hash(url.as_bytes()).as_bytes()
}

/// Split `scheme://rest` when the head is shaped like a URI scheme (RFC 3986
/// §3.1). A one-letter head is a drive letter, never a scheme, so `C://data`
/// stays a Windows path.
fn split_scheme(raw: &str) -> Option<(&str, &str)> {
    let (scheme, rest) = raw.split_once("://")?;
    let bytes = scheme.as_bytes();
    let shaped = bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'));
    shaped.then_some((scheme, rest))
}

/// `text` with each `%XX` escape replaced by the byte it names (RFC 3986
/// §2.1). An escape that is not two hex digits stays as written, and so does
/// the whole text when the decoded bytes are not UTF-8, since a path the
/// decoding cannot name is better opened as typed.
fn percent_decode(text: &str) -> String {
    if !text.contains('%') {
        return text.to_string();
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |at: usize| bytes.get(at).and_then(|b| (*b as char).to_digit(16));
        match (bytes[i], hex(i + 1), hex(i + 2)) {
            (b'%', Some(high), Some(low)) => {
                out.push((high * 16 + low) as u8);
                i += 3;
            }
            (byte, _, _) => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| text.to_string())
}

/// The canonical form of a filesystem path, or `None` when it is relative.
fn local_path(path: &str) -> Option<String> {
    if path.starts_with("\\\\") {
        return Some(path.chars().map(swap_backslash).collect());
    }
    if let Some(canonical) = canonicalize_drive_letter(path) {
        return Some(canonical);
    }
    // Backslashes in a Unix path are legal filename bytes, so they stay.
    path.starts_with('/').then(|| path.to_string())
}

/// The path a `file://` URL names, given what follows `file://`, or `None`
/// when that is no absolute path.
fn file_url_path(rest: &str) -> Option<String> {
    // `file:////server/share` and `file://\\server\share`: a UNC path after
    // an empty authority.
    if rest.starts_with("//") {
        return local_path(&format!("\\\\{}", rest.trim_start_matches('/')));
    }
    if rest.starts_with("\\\\") {
        return local_path(rest);
    }
    // An empty authority: the path keeps its leading slash, except before a
    // drive letter (`file:///C:/data`), where the slash belongs to the URL.
    if let Some(after_slash) = rest.strip_prefix('/') {
        if is_drive_prefix(after_slash) {
            return canonicalize_drive_letter(after_slash);
        }
        return Some(rest.to_string());
    }
    // `file://C:\data`, a hand-typed form.
    if is_drive_prefix(rest) {
        return canonicalize_drive_letter(rest);
    }
    let (host, path) = rest.split_once('/')?;
    if host.eq_ignore_ascii_case("localhost") {
        return file_url_path(&rest[host.len()..]);
    }
    // `file://server/share/a.zarr` names a UNC path. A lone name after
    // `file://` is a relative path typed as a URL, not a server.
    if path.is_empty() || host == "." || host == ".." {
        return None;
    }
    Some(
        format!("//{host}/{path}")
            .chars()
            .map(swap_backslash)
            .collect(),
    )
}

/// `true` if `s` starts with a drive letter followed by a separator or
/// nothing, as in `C:`, `C:\`, or `c:/data`.
fn is_drive_prefix(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes.get(2), None | Some(b'/' | b'\\'))
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
    if !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' {
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

fn swap_backslash(c: char) -> char {
    if c == '\\' { '/' } else { c }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canonical(raw: &str) -> String {
        DatasetLocation::parse(raw)
            .unwrap_or_else(|e| panic!("{raw:?} must parse: {e}"))
            .into_string()
    }

    /// Each row: (input, expected_canonical). The same table is reused
    /// by the idempotence and round-trip-id tests below.
    fn parse_cases() -> Vec<(&'static str, &'static str)> {
        vec![
            // Unix passthrough.
            ("/foo/bar", "/foo/bar"),
            ("/data/scans/foo.zarr", "/data/scans/foo.zarr"),
            ("/", "/"),
            // file:// on Unix keeps the path's leading slash (RFC 8089).
            ("file:///srv/x.zarr", "/srv/x.zarr"),
            ("file:///", "/"),
            ("file://localhost/srv/x.zarr", "/srv/x.zarr"),
            ("FILE:///srv/X.zarr", "/srv/X.zarr"),
            // A file:// URL is percent-decoded; a malformed escape stays.
            ("file:///a%20b.zarr", "/a b.zarr"),
            ("file:///srv/100%25%2Fx.zarr", "/srv/100%/x.zarr"),
            ("file:///srv/caf%C3%A9.zarr", "/srv/café.zarr"),
            ("file:///srv/50%zz%2.zarr", "/srv/50%zz%2.zarr"),
            ("file:///srv/%FF.zarr", "/srv/%FF.zarr"),
            ("file:///C:/my%20data/a.zarr", "c:/my data/a.zarr"),
            (
                "file://server/my%20share/a.zarr",
                "//server/my share/a.zarr",
            ),
            // A bare path is not a URL, so its `%` is a filename character.
            ("/srv/a%20b.zarr", "/srv/a%20b.zarr"),
            // Drive-letter case variants — all collapse to `c:/foo`.
            ("C:\\foo", "c:/foo"),
            ("c:/foo", "c:/foo"),
            ("C:/foo", "c:/foo"),
            ("C://foo", "c:/foo"),
            ("C:", "c:"),
            // file:// forms of drive-letter paths (browser-produced and
            // hand-typed).
            ("file:///C:/foo", "c:/foo"),
            ("file://C:\\foo", "c:/foo"),
            ("file://C:/foo", "c:/foo"),
            ("file://localhost/C:/foo", "c:/foo"),
            ("FILE:///C:/foo", "c:/foo"),
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
            ("//server/share/foo", "//server/share/foo"),
            // file:// forms of UNC paths: an empty authority before the UNC
            // path, or the server as the authority.
            ("file:////server/share/foo", "//server/share/foo"),
            ("file://\\\\server\\share\\foo", "//server/share/foo"),
            ("file://server/share/foo", "//server/share/foo"),
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
        ]
    }

    #[test]
    fn parse_table() {
        for (input, expected) in parse_cases() {
            assert_eq!(canonical(input), expected, "parse({input:?})");
        }
    }

    #[test]
    fn a_canonical_string_parses_to_itself() {
        for (input, _) in parse_cases() {
            let once = canonical(input);
            assert_eq!(canonical(&once), once, "not idempotent for {input:?}");
        }
    }

    /// Dataset ids and cache directories hash the canonical string, so a
    /// change of spelling would orphan every workspace that holds one.
    #[test]
    fn canonical_strings_keep_their_dataset_ids() {
        let pinned = [
            ("/data/scans/foo.zarr", "ds-0a35d571e03f8e57"),
            ("C:\\foo", "ds-051f346713f4488b"),
            ("\\\\server\\share\\foo", "ds-b1fbf89a3be65850"),
            ("GS://bucket/a.zarr", "ds-37ef3ddca2044767"),
        ];
        for (input, id) in pinned {
            let location = DatasetLocation::parse(input).unwrap();
            assert_eq!(location.source_id(), id, "{input:?}");
            assert_eq!(location.hash16(), dataset_url_hash16(location.as_str()));
        }
    }

    #[test]
    fn parse_classifies_the_scheme() {
        let cases = [
            ("/foo", LocationScheme::Local),
            ("c:/foo", LocationScheme::Local),
            ("//server/share/foo", LocationScheme::Local),
            ("file:///srv/a.zarr", LocationScheme::Local),
            ("gs://bucket/a", LocationScheme::Gcs),
            ("s3://bucket/a", LocationScheme::S3),
            ("http://host/a", LocationScheme::Http),
            ("HTTPS://host/a", LocationScheme::Https),
        ];
        for (input, scheme) in cases {
            assert_eq!(
                DatasetLocation::parse(input).unwrap().scheme(),
                scheme,
                "{input:?}"
            );
        }
    }

    #[test]
    fn a_relative_path_is_refused_with_the_input_unchanged() {
        for input in [
            "x.zarr",
            "./x.zarr",
            "../data/x.zarr",
            "data/x.zarr",
            "~/x.zarr",
            "data\\x.zarr",
            "file://x.zarr",
            "file://./x.zarr",
        ] {
            let err = DatasetLocation::parse(input).unwrap_err();
            assert_eq!(
                err,
                LocationError::RelativePath {
                    input: input.to_string()
                },
                "{input:?}"
            );
            let message = err.to_string();
            assert!(message.contains(input), "{message}");
            assert!(message.contains("absolute"), "{message}");
        }
    }

    #[test]
    fn an_unknown_scheme_is_named() {
        let err = DatasetLocation::parse("ftp://host/x.zarr").unwrap_err();
        assert_eq!(
            err,
            LocationError::UnknownScheme {
                scheme: "ftp".to_string()
            }
        );
        assert!(err.to_string().contains("ftp://"), "{err}");
    }

    #[test]
    fn a_url_with_nothing_after_its_scheme_is_refused() {
        assert_eq!(
            DatasetLocation::parse("gs://").unwrap_err(),
            LocationError::MissingBucket { scheme: "gs" }
        );
        assert_eq!(
            DatasetLocation::parse("S3:///key").unwrap_err(),
            LocationError::MissingBucket { scheme: "s3" }
        );
        assert_eq!(
            DatasetLocation::parse("https://").unwrap_err(),
            LocationError::MissingHost { scheme: "https" }
        );
        assert_eq!(
            DatasetLocation::parse("").unwrap_err(),
            LocationError::Empty
        );
    }

    #[test]
    fn bucket_and_prefix() {
        let cases = [
            ("gs://my-bucket", Some("my-bucket"), None),
            ("gs://my-bucket/", Some("my-bucket"), None),
            (
                "gs://my-bucket/path/to/store.zarr",
                Some("my-bucket"),
                Some("path/to/store.zarr"),
            ),
            ("s3://my-bucket", Some("my-bucket"), None),
            (
                "s3://my-bucket/path/to/store.zarr",
                Some("my-bucket"),
                Some("path/to/store.zarr"),
            ),
            ("https://host/a.zarr", None, None),
            ("/srv/a.zarr", None, None),
        ];
        for (input, bucket, prefix) in cases {
            let location = DatasetLocation::parse(input).unwrap();
            assert_eq!(location.bucket_name(), bucket, "{input:?}");
            assert_eq!(location.object_prefix(), prefix, "{input:?}");
        }
    }

    #[test]
    fn display_name_is_the_last_path_component() {
        let cases = [
            ("/srv/a.zarr", "a.zarr"),
            ("/srv/a.zarr/", "a.zarr"),
            ("c:/data/b.zarr", "b.zarr"),
            ("gs://bucket", "bucket"),
            ("/", "dataset"),
        ];
        for (input, name) in cases {
            assert_eq!(
                DatasetLocation::parse(input).unwrap().display_name(),
                name,
                "{input:?}"
            );
        }
    }

    #[test]
    fn normalize_falls_back_to_the_input() {
        assert_eq!(normalize_dataset_url("C:\\foo"), "c:/foo");
        assert_eq!(normalize_dataset_url("file:///srv/x"), "/srv/x");
        assert_eq!(normalize_dataset_url("./x.zarr"), "./x.zarr");
        assert_eq!(normalize_dataset_url(""), "");
    }

    #[test]
    fn is_local_dataset_url_table() {
        let cases: Vec<(&str, bool)> = vec![
            // Unix.
            ("/foo/bar", true),
            ("/", true),
            // Drive-letter.
            ("c:/foo", true),
            ("c:", true),
            ("C:\\foo", true),
            // UNC.
            ("//server/share/foo", true),
            // file:// URLs name local paths.
            ("file:///srv/a.zarr", true),
            // Remote schemes, in any letter case.
            ("gs://bucket/path", false),
            ("s3://bucket/path", false),
            ("http://host/p", false),
            ("https://host/p", false),
            ("HTTP://host/p", false),
            ("S3://bucket/path", false),
            // Not a location at all.
            ("", false),
            ("x.zarr", false),
        ];
        for (input, expected) in cases {
            let got = is_local_dataset_url(input);
            assert_eq!(
                got, expected,
                "is_local_dataset_url({input:?}) = {got}, expected {expected}"
            );
        }
    }

    #[test]
    fn dataset_id_for_url_is_stable_across_spelling_variants() {
        // Each group is a set of input spellings that should parse to the
        // same canonical form, and therefore produce the same
        // `dataset_id_for_url`. Checks the property at the externally
        // observable layer: the same id.
        let groups: Vec<Vec<&str>> = vec![
            vec![
                "C:\\foo",
                "c:/foo",
                "C:/foo",
                "file:///C:/foo",
                "file://C:\\foo",
            ],
            vec![
                "\\\\server\\share\\foo",
                "//server/share/foo",
                "file://server/share/foo",
            ],
            vec!["/srv/x.zarr", "file:///srv/x.zarr"],
            vec!["http://host/p", "HTTP://host/p", "hTtP://host/p"],
        ];
        for group in groups {
            let ids: Vec<String> = group
                .iter()
                .map(|s| DatasetLocation::parse(s).unwrap().source_id())
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
