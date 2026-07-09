//! Storage backend abstraction for reading from Zarr Stores.
//!
//! URL scheme routing (after [`lucida_content::url::normalize_dataset_url`]
//! is applied at entry — see
//! `wiki/decisions/0042-canonical-dataset-url-form.md`):
//! - Unix `/path/...`, drive-letter `c:/path/...`, UNC `//server/share/...`
//!   → local filesystem (classified via [`lucida_content::url::is_local_dataset_url`]).
//! - `gs://bucket/...` → Google Cloud Storage. Credential discovery order:
//!   `GOOGLE_*` env vars (incl. `GOOGLE_SERVICE_ACCOUNT*` and Google's standard
//!   `GOOGLE_APPLICATION_CREDENTIALS`) read by `GoogleCloudStorageBuilder::from_env`,
//!   then the well-known ADC file at
//!   `$HOME/.config/gcloud/application_default_credentials.json`, then the GCE
//!   metadata server (Workload Identity / GCE instance default).
//! - `s3://bucket/...` → Amazon S3 (environment/instance credentials)
//! - `http://...` / `https://...` → HTTP static file server

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use lucida_content::url::{is_local_dataset_url, normalize_dataset_url};
use object_store::aws::AmazonS3Builder;
use object_store::gcp::GoogleCloudStorageBuilder;
use object_store::http::HttpBuilder;
use object_store::local::LocalFileSystem;
use object_store::prefix::PrefixStore;
use object_store::{BackoffConfig, ClientOptions, ObjectStore, RetryConfig};

/// Retry policy for remote source-path reads (GCS, S3, HTTP).
///
/// object_store's default policy retries up to 10 times over 3 minutes. A
/// single struggling object can therefore keep a request alive for minutes —
/// far past the client's fetch timeout, which surfaces to the user as a hang
/// rather than a prompt, retryable failure. This policy instead fails fast:
/// a small number of retries bounded by a total budget comfortably under the
/// client's timeout, so a bad object gives up quickly and the client can move
/// on or retry itself.
///
/// The exponential backoff (100 ms → 1 s, base 2) leaves room for two retries
/// within the `retry_timeout` budget while still absorbing transient blips.
pub fn source_retry_config() -> RetryConfig {
    RetryConfig {
        backoff: BackoffConfig {
            init_backoff: Duration::from_millis(100),
            max_backoff: Duration::from_secs(1),
            base: 2.0,
        },
        max_retries: 2,
        retry_timeout: Duration::from_secs(3),
    }
}

/// Per-attempt request timeout for remote source reads (GCS, S3, HTTP).
///
/// [`source_retry_config`] only bounds the time *between* attempts; the
/// per-attempt timeout is a separate `ClientOptions` knob. object_store's
/// default of 30s means a source that connects but never sends a body would
/// hang for ~30s — far past the client's fetch timeout, surfacing as a stall
/// rather than a prompt, retryable failure. Bounding each attempt well under
/// the client's timeout makes such a stall fail fast so the client can move
/// on or self-heal.
const SOURCE_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// `ClientOptions` shared by the remote source backends, pinning the
/// per-attempt request timeout. HTTP layers its plain-`http` opt-in on top.
fn source_client_options() -> ClientOptions {
    ClientOptions::new().with_timeout(SOURCE_REQUEST_TIMEOUT)
}

/// Errors from storage backend operations.
#[derive(Debug)]
pub enum StoreError {
    /// The URL scheme is not supported.
    UnsupportedScheme(String),
    /// An error from the underlying object store.
    ObjectStore(object_store::Error),
    /// An error parsing metadata.
    Metadata(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::UnsupportedScheme(s) => write!(f, "unsupported URL scheme: {s}"),
            StoreError::ObjectStore(e) => write!(f, "storage error: {e}"),
            StoreError::Metadata(s) => write!(f, "metadata error: {s}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<object_store::Error> for StoreError {
    fn from(e: object_store::Error) -> Self {
        StoreError::ObjectStore(e)
    }
}

/// Parse a `gs://bucket/prefix` URL into (bucket, optional prefix).
fn parse_gs_url(url: &str) -> Result<(&str, Option<&str>), StoreError> {
    let rest = url
        .strip_prefix("gs://")
        .ok_or_else(|| StoreError::UnsupportedScheme(url.into()))?;
    if rest.is_empty() {
        return Err(StoreError::Metadata("gs:// URL missing bucket name".into()));
    }
    match rest.find('/') {
        Some(idx) => {
            let bucket = &rest[..idx];
            let prefix = &rest[idx + 1..];
            if prefix.is_empty() {
                Ok((bucket, None))
            } else {
                Ok((bucket, Some(prefix)))
            }
        }
        None => Ok((rest, None)),
    }
}

/// Parse an `s3://bucket/prefix` URL into (bucket, optional prefix).
fn parse_s3_url(url: &str) -> Result<(&str, Option<&str>), StoreError> {
    let rest = url
        .strip_prefix("s3://")
        .ok_or_else(|| StoreError::UnsupportedScheme(url.into()))?;
    if rest.is_empty() {
        return Err(StoreError::Metadata("s3:// URL missing bucket name".into()));
    }
    match rest.find('/') {
        Some(idx) => {
            let bucket = &rest[..idx];
            let prefix = &rest[idx + 1..];
            if prefix.is_empty() {
                Ok((bucket, None))
            } else {
                Ok((bucket, Some(prefix)))
            }
        }
        None => Ok((rest, None)),
    }
}

/// Open a storage backend from a URL.
///
/// The input URL is first normalized via
/// [`lucida_content::url::normalize_dataset_url`] (idempotent, pure
/// string-level). All subsequent dispatch — and the value embedded in
/// any [`StoreError::UnsupportedScheme`] — uses the canonical form. See
/// `wiki/decisions/0042-canonical-dataset-url-form.md` for the rationale.
///
/// Dispatch on the canonical form. Normalization lowercases a leading URI
/// scheme (schemes are case-insensitive per RFC 3986), so `HTTP://…` and
/// `S3://…` spellings dispatch like their lowercase forms while bucket and
/// object paths keep their case.
///
/// - Unix `/path/...`, drive-letter `c:/path/...`, UNC `//server/share/...`
///   classified by [`lucida_content::url::is_local_dataset_url`] → local
///   filesystem.
/// - `gs://bucket/path` URLs use Google Cloud Storage. Credentials are
///   discovered, in order: `GOOGLE_*` env vars (incl. `GOOGLE_SERVICE_ACCOUNT*`
///   and Google's standard `GOOGLE_APPLICATION_CREDENTIALS`) via
///   `GoogleCloudStorageBuilder::from_env`, then the well-known ADC file at
///   `$HOME/.config/gcloud/application_default_credentials.json`, then the GCE
///   metadata server (Workload Identity / GCE instance default).
/// - `s3://bucket/path` URLs use Amazon S3 with environment/instance credentials.
/// - `http://` and `https://` URLs use an HTTP static file server. Plain
///   `http://` is explicitly enabled on the client (the default is
///   https-only, which would reject every plain-http request).
/// - Anything else → [`StoreError::UnsupportedScheme`].
pub fn open(url: &str) -> Result<Arc<dyn ObjectStore>, StoreError> {
    // Normalize once at entry: drive-letter case, slash direction, UNC
    // backslashes, `file://` prefix — see ADR-0042. Idempotent, so it's
    // safe even if the caller already normalized.
    let canonical = normalize_dataset_url(url);

    if is_local_dataset_url(&canonical) {
        let store =
            LocalFileSystem::new_with_prefix(&canonical).map_err(StoreError::ObjectStore)?;
        Ok(Arc::new(store))
    } else if canonical.starts_with("gs://") {
        let (bucket, prefix) = parse_gs_url(&canonical)?;
        // `from_env()` iterates `GOOGLE_*` env vars (incl.
        // `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_SERVICE_ACCOUNT*`) — mirrors
        // the S3 line below. If none are set, falls back to
        // `$HOME/.config/gcloud/application_default_credentials.json` and then
        // the GCE metadata server (Workload Identity).
        let store = GoogleCloudStorageBuilder::from_env()
            .with_bucket_name(bucket)
            .with_client_options(source_client_options())
            .with_retry(source_retry_config())
            .build()?;
        match prefix {
            Some(p) => Ok(Arc::new(PrefixStore::new(store, p))),
            None => Ok(Arc::new(store)),
        }
    } else if canonical.starts_with("s3://") {
        let (bucket, prefix) = parse_s3_url(&canonical)?;
        let store = AmazonS3Builder::from_env()
            .with_bucket_name(bucket)
            .with_client_options(source_client_options())
            .with_retry(source_retry_config())
            .build()?;
        match prefix {
            Some(p) => Ok(Arc::new(PrefixStore::new(store, p))),
            None => Ok(Arc::new(store)),
        }
    } else if canonical.starts_with("http://") || canonical.starts_with("https://") {
        // The underlying HTTP client defaults to https-only; a plain `http://`
        // endpoint (a static file server on localhost or a LAN) must opt in
        // explicitly or every request fails with a scheme error before it is
        // even sent. `https://` URLs need no opt-in and keep the default.
        let client_options =
            source_client_options().with_allow_http(canonical.starts_with("http://"));
        let store = HttpBuilder::new()
            .with_url(&canonical)
            .with_client_options(client_options)
            .with_retry(source_retry_config())
            .build()?;
        Ok(Arc::new(store))
    } else {
        Err(StoreError::UnsupportedScheme(canonical))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_local_path() {
        let dir = std::env::temp_dir();
        let store = open(dir.to_str().unwrap());
        assert!(store.is_ok());
    }

    #[test]
    fn open_unsupported_scheme() {
        let err = open("ftp://host/path").unwrap_err();
        assert!(matches!(err, StoreError::UnsupportedScheme(_)));
    }

    // --- Cross-platform local-path construction (ADR-0042) ---
    //
    // These tests assert that each canonical-equivalent spelling of a
    // local path *dispatches* to the local-filesystem branch (i.e. NOT
    // `StoreError::UnsupportedScheme`). Whether the path actually exists
    // is out of scope — `LocalFileSystem::new_with_prefix` calls
    // `std::fs::canonicalize` which surfaces non-existing paths as
    // `ObjectStore(UnableToCanonicalize)`. That's a real local-storage
    // error, not a classification miss, and it's the cross-platform
    // observable proxy for "this URL was treated as local."
    //
    // To exercise the canonicalize-succeeds path with an existing path,
    // see [`open_local_path`] above (it uses `std::env::temp_dir()`).

    /// Helper: assert that `open(url)` did NOT bail with `UnsupportedScheme`.
    /// Any other outcome (success, NotFound, UnableToCanonicalize) means
    /// dispatch reached the local-filesystem branch — that's the property
    /// we're verifying.
    fn assert_dispatched_local(url: &str, result: Result<Arc<dyn ObjectStore>, StoreError>) {
        if let Err(StoreError::UnsupportedScheme(scheme)) = &result {
            panic!(
                "open({url:?}) classified as UnsupportedScheme({scheme:?}) — expected local dispatch"
            );
        }
    }

    #[test]
    fn open_drive_letter_path_backslash_dispatches_local() {
        assert_dispatched_local("C:\\foo", open("C:\\foo"));
    }

    #[test]
    fn open_drive_letter_path_forward_slash_lowercase_dispatches_local() {
        assert_dispatched_local("c:/foo", open("c:/foo"));
    }

    #[test]
    fn open_file_uri_drive_letter_dispatches_local() {
        assert_dispatched_local("file:///C:/foo", open("file:///C:/foo"));
    }

    #[test]
    fn open_unc_path_dispatches_local() {
        assert_dispatched_local("\\\\server\\share\\foo", open("\\\\server\\share\\foo"));
    }

    // --- S3 tests ---

    #[test]
    fn parse_s3_bucket_only() {
        let (bucket, prefix) = parse_s3_url("s3://my-bucket").unwrap();
        assert_eq!(bucket, "my-bucket");
        assert_eq!(prefix, None);
    }

    #[test]
    fn parse_s3_bucket_trailing_slash() {
        let (bucket, prefix) = parse_s3_url("s3://my-bucket/").unwrap();
        assert_eq!(bucket, "my-bucket");
        assert_eq!(prefix, None);
    }

    #[test]
    fn parse_s3_bucket_with_prefix() {
        let (bucket, prefix) = parse_s3_url("s3://my-bucket/path/to/store.zarr").unwrap();
        assert_eq!(bucket, "my-bucket");
        assert_eq!(prefix, Some("path/to/store.zarr"));
    }

    #[test]
    fn parse_s3_empty_bucket_error() {
        let err = parse_s3_url("s3://").unwrap_err();
        assert!(matches!(err, StoreError::Metadata(_)));
    }

    #[test]
    fn open_s3_constructs_store() {
        let store = open("s3://test-bucket/some/prefix");
        assert!(store.is_ok());
    }

    // --- HTTP tests ---
    //
    // Construction-path only: whether plain-http requests actually go through
    // is a property of the built client (https-only vs. allow-http) that only
    // surfaces on a real request, so these tests pin down that every http(s)
    // URL shape builds a store — including plain `http://`, which requires
    // the explicit allow-http opt-in wired in `open`.

    #[test]
    fn open_http_constructs_store() {
        let store = open("http://localhost:8080/data/store.zarr");
        assert!(store.is_ok());
    }

    #[test]
    fn open_http_ip_and_port_constructs_store() {
        let store = open("http://192.168.1.20:9000/shared/collection.zarr");
        assert!(store.is_ok());
    }

    #[test]
    fn open_http_bare_host_constructs_store() {
        let store = open("http://fileserver.internal/store.zarr");
        assert!(store.is_ok());
    }

    #[test]
    fn open_https_constructs_store() {
        let store = open("https://data.example.com/store.zarr");
        assert!(store.is_ok());
    }

    // Scheme case-insensitivity (RFC 3986): uppercase and mixed-case scheme
    // spellings must dispatch exactly like their lowercase forms instead of
    // falling through to UnsupportedScheme.

    #[test]
    fn open_uppercase_http_scheme_constructs_store() {
        let store = open("HTTP://localhost:8080/data/store.zarr");
        assert!(store.is_ok(), "{:?}", store.err());
    }

    #[test]
    fn open_mixed_case_https_scheme_constructs_store() {
        let store = open("HtTpS://data.example.com/store.zarr");
        assert!(store.is_ok(), "{:?}", store.err());
    }

    #[test]
    fn open_uppercase_s3_scheme_constructs_store() {
        let store = open("S3://test-bucket/some/prefix");
        assert!(store.is_ok(), "{:?}", store.err());
    }

    #[test]
    fn open_uppercase_gs_scheme_constructs_store() {
        let store = open("GS://test-bucket/some/prefix");
        assert!(store.is_ok(), "{:?}", store.err());
    }

    // --- GCS tests ---

    #[test]
    fn parse_gs_bucket_only() {
        let (bucket, prefix) = parse_gs_url("gs://my-bucket").unwrap();
        assert_eq!(bucket, "my-bucket");
        assert_eq!(prefix, None);
    }

    #[test]
    fn parse_gs_bucket_trailing_slash() {
        let (bucket, prefix) = parse_gs_url("gs://my-bucket/").unwrap();
        assert_eq!(bucket, "my-bucket");
        assert_eq!(prefix, None);
    }

    #[test]
    fn parse_gs_bucket_with_prefix() {
        let (bucket, prefix) = parse_gs_url("gs://my-bucket/path/to/store.zarr").unwrap();
        assert_eq!(bucket, "my-bucket");
        assert_eq!(prefix, Some("path/to/store.zarr"));
    }

    #[test]
    fn parse_gs_empty_bucket_error() {
        let err = parse_gs_url("gs://").unwrap_err();
        assert!(matches!(err, StoreError::Metadata(_)));
    }

    #[test]
    fn open_gs_constructs_store() {
        // Verifies that GCS builder construction succeeds (no credentials needed
        // until an actual I/O operation is performed).
        let store = open("gs://test-bucket/some/prefix");
        assert!(store.is_ok());
    }

    // --- Retry policy ---

    #[test]
    fn source_retry_config_is_capped_below_client_timeout() {
        let cfg = source_retry_config();
        // Few retries — nowhere near object_store's default of 10.
        assert!(
            cfg.max_retries >= 2 && cfg.max_retries <= 3,
            "expected 2-3 retries, got {}",
            cfg.max_retries
        );
        // Total budget must stay comfortably under the client's 10s fetch
        // timeout so a struggling object fails fast instead of hanging.
        assert!(
            cfg.retry_timeout <= Duration::from_secs(4),
            "retry_timeout {:?} must be <= 4s",
            cfg.retry_timeout
        );
        // Exponential backoff that still fits inside the timeout budget.
        assert!(cfg.backoff.base > 1.0);
        assert!(cfg.backoff.init_backoff > Duration::ZERO);
        assert!(cfg.backoff.max_backoff >= cfg.backoff.init_backoff);
    }

    #[test]
    fn source_request_timeout_bounds_a_stalling_connection() {
        // The retry budget only gates *between* attempts; a source that
        // connects but never sends a body is bounded by this per-attempt
        // timeout instead. It must stay comfortably under the client's 10s
        // fetch timeout so a stall fails fast rather than hanging.
        assert!(
            SOURCE_REQUEST_TIMEOUT >= Duration::from_secs(1)
                && SOURCE_REQUEST_TIMEOUT <= Duration::from_secs(8),
            "per-attempt timeout {SOURCE_REQUEST_TIMEOUT:?} must be a fail-fast value under 10s",
        );
    }
}
