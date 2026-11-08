//! Storage backend abstraction for reading from Zarr Stores.
//!
//! Routing by the scheme of a parsed [`DatasetLocation`]:
//! - Unix `/path/...`, drive-letter `c:/path/...`, UNC `//server/share/...`
//!   → local filesystem.
//! - `gs://bucket/...` → Google Cloud Storage, with credentials from the
//!   `GOOGLE_*` env vars, then the ADC file, then the GCE metadata server.
//! - `s3://bucket/...` → Amazon S3 (environment/instance credentials)
//! - `http://...` / `https://...` → HTTP static file server

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use lucida_content::url::{DatasetLocation, LocationScheme};
use object_store::aws::AmazonS3Builder;
use object_store::gcp::GoogleCloudStorageBuilder;
use object_store::http::HttpBuilder;
use object_store::local::LocalFileSystem;
use object_store::prefix::PrefixStore;
use object_store::{BackoffConfig, ClientOptions, ObjectStore, RetryConfig};

use crate::source_policy::{GuardedHttpConnector, SourceDenied, SourcePolicy};

/// The client's fetch timeout for a single remote read.
///
/// This mirrors lucida-web `contentSource.ts` `DEFAULT_TIMEOUT_MS` and must be
/// kept in sync with it. The store's worst-case per-read budget
/// ([`max_source_read_budget`]) must stay under this value so the *client*, not
/// the server, wins the timeout race. If the server were allowed to hang past
/// the client's timeout, the client would give up and re-send the read while
/// the original is still in flight, re-introducing the duplicate work this
/// ordering exists to prevent.
pub const CLIENT_FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// Retry policy for remote source-path reads (GCS, S3, HTTP).
///
/// object_store's default retries for minutes, far past the client's fetch
/// timeout, which the user sees as a hang. This fails fast instead: a few
/// retries with backoff (100 ms → 1 s, base 2) inside a total budget
/// comfortably under the client's timeout.
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
pub(crate) const SOURCE_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// `ClientOptions` shared by the remote source backends, pinning the
/// per-attempt request timeout. HTTP layers its plain-`http` opt-in on top.
fn source_client_options() -> ClientOptions {
    ClientOptions::new().with_timeout(SOURCE_REQUEST_TIMEOUT)
}

/// Worst-case wall-clock for one failing remote source read.
///
/// The retry loop is bounded by [`source_retry_config`]'s `retry_timeout`, but
/// that budget only gates the time *between* attempts: a fresh attempt can be
/// dispatched right before the loop budget elapses and then run for its full
/// per-attempt [`SOURCE_REQUEST_TIMEOUT`] before giving up. The worst case is
/// therefore the sum of the two, not either alone.
///
/// This must stay under [`CLIENT_FETCH_TIMEOUT`] so the client's fetch timeout
/// never fires while the server is still working — see that constant's note on
/// why the client, not the server, must win the race.
pub fn max_source_read_budget() -> Duration {
    source_retry_config().retry_timeout + SOURCE_REQUEST_TIMEOUT
}

/// Errors from storage backend operations. Each is typed where it happens,
/// so a caller acts on the variant and never on the message.
#[derive(Debug)]
pub enum StoreError {
    /// A read from the object store failed.
    ObjectStore(object_store::Error),
    /// The location is a local path the filesystem would not open.
    LocalPath(object_store::Error),
    /// A remote backend could not be configured for the location, such as
    /// for want of credentials or a usable bucket name.
    BackendConfiguration(object_store::Error),
    /// The metadata read, but says something lucida cannot open.
    Metadata {
        fault: MetadataFault,
        message: String,
    },
    /// The source policy does not allow the location.
    Denied(SourceDenied),
    /// The array's data type, as its metadata names it, is one lucida can't
    /// show as its values.
    UnsupportedDataType(String),
}

/// What is wrong with metadata that a [`StoreError::Metadata`] reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetadataFault {
    /// A block the format requires is not there.
    Missing,
    /// The metadata is there and is not valid: not JSON, a field of the
    /// wrong type, or values that contradict each other.
    Malformed,
    /// The storage codec chain names a codec or a configuration that
    /// lucida does not decode.
    UnsupportedCodec,
    /// The array's chunk layout is one lucida cannot slice into wire chunks.
    UnsupportedLayout,
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::ObjectStore(e)
            | StoreError::LocalPath(e)
            | StoreError::BackendConfiguration(e) => write!(f, "storage error: {e}"),
            StoreError::Metadata { message, .. } => write!(f, "metadata error: {message}"),
            StoreError::Denied(denied) => write!(f, "{denied}"),
            StoreError::UnsupportedDataType(s) => write!(f, "unsupported data type: {s}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl StoreError {
    pub fn missing_metadata(message: impl Into<String>) -> Self {
        Self::metadata(MetadataFault::Missing, message)
    }

    pub fn malformed_metadata(message: impl Into<String>) -> Self {
        Self::metadata(MetadataFault::Malformed, message)
    }

    pub fn unsupported_codec(message: impl Into<String>) -> Self {
        Self::metadata(MetadataFault::UnsupportedCodec, message)
    }

    pub fn unsupported_layout(message: impl Into<String>) -> Self {
        Self::metadata(MetadataFault::UnsupportedLayout, message)
    }

    fn metadata(fault: MetadataFault, message: impl Into<String>) -> Self {
        StoreError::Metadata {
            fault,
            message: message.into(),
        }
    }

    /// This error with `context` in front of its metadata message, so a
    /// failure names where it was found: the level, or the codec whose
    /// configuration held it. An error that is not about metadata passes
    /// through unchanged.
    pub fn in_context(self, context: impl fmt::Display) -> Self {
        match self {
            StoreError::Metadata { fault, message } => StoreError::Metadata {
                fault,
                message: format!("{context}: {message}"),
            },
            other => other,
        }
    }
}

impl From<object_store::Error> for StoreError {
    fn from(e: object_store::Error) -> Self {
        StoreError::ObjectStore(e)
    }
}

/// Open a storage backend for `location` if `policy` allows it. Every HTTP
/// connection of a store opened under a restricted policy is checked again
/// as it is made, and every read waits on the source throttle when one is
/// installed.
pub async fn open_permitted(
    location: &DatasetLocation,
    policy: &SourcePolicy,
) -> Result<Arc<dyn ObjectStore>, StoreError> {
    policy.check(location).await.map_err(StoreError::Denied)?;
    let store = match location.scheme() {
        scheme @ (LocationScheme::Http | LocationScheme::Https) => {
            let allow_http = scheme == LocationScheme::Http;
            match policy.http_connector(allow_http, SOURCE_REQUEST_TIMEOUT) {
                Some(connector) => http_store(location.as_str(), allow_http, Some(connector)),
                None => open(location),
            }
        }
        _ => open(location),
    }?;
    Ok(crate::source_throttle::throttled(store))
}

/// Open a storage backend for a dataset location, under no source policy:
/// for local tools and tests. The server opens through [`open_permitted`].
///
/// Schemes route as the module docs list. Plain `http://` is explicitly
/// enabled on the client, whose default is https-only.
pub fn open(location: &DatasetLocation) -> Result<Arc<dyn ObjectStore>, StoreError> {
    let url = location.as_str();
    match location.scheme() {
        LocationScheme::Local => {
            let store = LocalFileSystem::new_with_prefix(url).map_err(StoreError::LocalPath)?;
            Ok(Arc::new(store))
        }
        LocationScheme::Gcs => {
            // `from_env()` iterates `GOOGLE_*` env vars (incl.
            // `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_SERVICE_ACCOUNT*`) — mirrors
            // the S3 branch below. If none are set, falls back to
            // `$HOME/.config/gcloud/application_default_credentials.json` and then
            // the GCE metadata server (Workload Identity).
            let store = GoogleCloudStorageBuilder::from_env()
                .with_bucket_name(location.bucket_name().unwrap_or_default())
                .with_client_options(source_client_options())
                .with_retry(source_retry_config())
                .build()
                .map_err(StoreError::BackendConfiguration)?;
            Ok(with_prefix(store, location.object_prefix()))
        }
        LocationScheme::S3 => {
            let store = AmazonS3Builder::from_env()
                .with_bucket_name(location.bucket_name().unwrap_or_default())
                .with_client_options(source_client_options())
                .with_retry(source_retry_config())
                .build()
                .map_err(StoreError::BackendConfiguration)?;
            Ok(with_prefix(store, location.object_prefix()))
        }
        scheme @ (LocationScheme::Http | LocationScheme::Https) => {
            http_store(url, scheme == LocationScheme::Http, None)
        }
    }
}

pub(crate) fn http_store(
    url: &str,
    allow_http: bool,
    connector: Option<GuardedHttpConnector>,
) -> Result<Arc<dyn ObjectStore>, StoreError> {
    // The underlying HTTP client defaults to https-only; a plain `http://`
    // endpoint (a static file server on localhost or a LAN) must opt in
    // explicitly or every request fails with a scheme error before it is
    // even sent. `https://` URLs need no opt-in and keep the default.
    let mut builder = HttpBuilder::new()
        .with_url(url)
        .with_client_options(source_client_options().with_allow_http(allow_http))
        .with_retry(source_retry_config());
    if let Some(connector) = connector {
        builder = builder.with_http_connector(connector);
    }
    Ok(Arc::new(
        builder.build().map_err(StoreError::BackendConfiguration)?,
    ))
}

fn with_prefix<S: ObjectStore>(store: S, prefix: Option<&str>) -> Arc<dyn ObjectStore> {
    match prefix {
        Some(prefix) => Arc::new(PrefixStore::new(store, prefix)),
        None => Arc::new(store),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_url(url: &str) -> Result<Arc<dyn ObjectStore>, StoreError> {
        open(&DatasetLocation::parse(url).unwrap())
    }

    #[test]
    fn open_local_path() {
        let dir = std::env::temp_dir();
        assert!(open_url(dir.to_str().unwrap()).is_ok());
    }

    /// Every spelling of a local path reaches the filesystem. A missing path
    /// fails there as `UnableToCanonicalize`, which is proof enough.
    #[test]
    fn every_spelling_of_a_local_path_opens_the_filesystem() {
        let dir = std::env::temp_dir().join("lucida-backend-missing");
        let unix_file_url = format!(
            "file://{}{}",
            if cfg!(windows) { "/" } else { "" },
            dir.to_str().unwrap().replace('\\', "/")
        );
        for url in [
            "C:\\foo",
            "c:/foo",
            "file:///C:/foo",
            "\\\\server\\share\\foo",
            unix_file_url.as_str(),
        ] {
            match open_url(url) {
                Ok(_) => {}
                Err(StoreError::LocalPath(e)) => {
                    let message = e.to_string().to_ascii_lowercase();
                    assert!(
                        message.contains("canonical") || message.contains("not found"),
                        "open({url:?}) failed outside the filesystem: {e}"
                    );
                }
                Err(e) => panic!("open({url:?}) failed outside the filesystem: {e}"),
            }
        }
    }

    // Construction-path only: whether plain-http requests actually go through
    // is a property of the built client (https-only vs. allow-http) that only
    // surfaces on a real request, so this pins down that every remote URL
    // shape builds a store, including plain `http://`, which requires the
    // explicit allow-http opt-in wired in `open`. No credentials are needed
    // until an actual read.
    #[test]
    fn every_remote_url_shape_constructs_a_store() {
        for url in [
            "s3://test-bucket/some/prefix",
            "S3://test-bucket/some/prefix",
            "gs://test-bucket/some/prefix",
            "GS://test-bucket/some/prefix",
            "gs://test-bucket",
            "http://localhost:8080/data/store.zarr",
            "HTTP://localhost:8080/data/store.zarr",
            "http://192.168.1.20:9000/shared/collection.zarr",
            "http://fileserver.internal/store.zarr",
            "https://data.example.com/store.zarr",
            "HtTpS://data.example.com/store.zarr",
        ] {
            let store = open_url(url);
            assert!(store.is_ok(), "{url}: {:?}", store.err());
        }
    }

    #[test]
    fn source_retry_config_is_capped_below_client_timeout() {
        let cfg = source_retry_config();
        // Few retries — nowhere near object_store's default of 10.
        assert!(
            cfg.max_retries >= 2 && cfg.max_retries <= 3,
            "expected 2-3 retries, got {}",
            cfg.max_retries
        );
        // Total budget must stay comfortably under CLIENT_FETCH_TIMEOUT so a
        // struggling object fails fast instead of hanging.
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
    fn max_source_read_budget_stays_under_client_fetch_timeout() {
        let budget = max_source_read_budget();

        // The client, not the server, must win the timeout race.
        assert!(
            budget < CLIENT_FETCH_TIMEOUT,
            "worst-case read budget {budget:?} must be under the client timeout {CLIENT_FETCH_TIMEOUT:?}",
        );
        // Keep at least 1s of headroom so drift on either side that erases the
        // margin fails here rather than in production.
        assert!(
            budget + Duration::from_secs(1) <= CLIENT_FETCH_TIMEOUT,
            "worst-case read budget {budget:?} must leave >= 1s headroom under {CLIENT_FETCH_TIMEOUT:?}",
        );
        // The retry-loop budget is one of the two components of the worst case.
        assert!(
            source_retry_config().retry_timeout < budget,
            "retry_timeout must be a proper component of the worst-case budget",
        );
    }

    #[test]
    fn source_request_timeout_bounds_a_stalling_connection() {
        // The retry budget only gates *between* attempts; a source that
        // connects but never sends a body is bounded by this per-attempt
        // timeout instead. It must stay comfortably under CLIENT_FETCH_TIMEOUT
        // so a stall fails fast rather than hanging.
        assert!(
            SOURCE_REQUEST_TIMEOUT >= Duration::from_secs(1)
                && SOURCE_REQUEST_TIMEOUT <= Duration::from_secs(8),
            "per-attempt timeout {SOURCE_REQUEST_TIMEOUT:?} must be a fail-fast value under CLIENT_FETCH_TIMEOUT",
        );
    }
}
