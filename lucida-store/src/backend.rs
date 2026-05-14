//! Storage backend abstraction for reading from Zarr Stores.
//!
//! URL scheme routing:
//! - `/path/...` → local filesystem
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

use object_store::ObjectStore;
use object_store::aws::AmazonS3Builder;
use object_store::gcp::GoogleCloudStorageBuilder;
use object_store::http::HttpBuilder;
use object_store::local::LocalFileSystem;
use object_store::prefix::PrefixStore;

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
/// - Paths starting with `/` are treated as local filesystem paths.
/// - `gs://bucket/path` URLs use Google Cloud Storage. Credentials are
///   discovered, in order: `GOOGLE_*` env vars (incl. `GOOGLE_SERVICE_ACCOUNT*`
///   and Google's standard `GOOGLE_APPLICATION_CREDENTIALS`) via
///   `GoogleCloudStorageBuilder::from_env`, then the well-known ADC file at
///   `$HOME/.config/gcloud/application_default_credentials.json`, then the GCE
///   metadata server (Workload Identity / GCE instance default).
/// - `s3://bucket/path` URLs use Amazon S3 with environment/instance credentials.
/// - `http://` and `https://` URLs use an HTTP static file server.
pub fn open(url: &str) -> Result<Arc<dyn ObjectStore>, StoreError> {
    // Strip file:// prefix for local paths.
    let url = url.strip_prefix("file://").unwrap_or(url);

    if url.starts_with('/') {
        let store = LocalFileSystem::new_with_prefix(url).map_err(StoreError::ObjectStore)?;
        Ok(Arc::new(store))
    } else if url.starts_with("gs://") {
        let (bucket, prefix) = parse_gs_url(url)?;
        // `from_env()` iterates `GOOGLE_*` env vars (incl.
        // `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_SERVICE_ACCOUNT*`) — mirrors
        // the S3 line below. If none are set, falls back to
        // `$HOME/.config/gcloud/application_default_credentials.json` and then
        // the GCE metadata server (Workload Identity).
        let store = GoogleCloudStorageBuilder::from_env()
            .with_bucket_name(bucket)
            .build()?;
        match prefix {
            Some(p) => Ok(Arc::new(PrefixStore::new(store, p))),
            None => Ok(Arc::new(store)),
        }
    } else if url.starts_with("s3://") {
        let (bucket, prefix) = parse_s3_url(url)?;
        let store = AmazonS3Builder::from_env()
            .with_bucket_name(bucket)
            .build()?;
        match prefix {
            Some(p) => Ok(Arc::new(PrefixStore::new(store, p))),
            None => Ok(Arc::new(store)),
        }
    } else if url.starts_with("http://") || url.starts_with("https://") {
        let store = HttpBuilder::new().with_url(url).build()?;
        Ok(Arc::new(store))
    } else {
        Err(StoreError::UnsupportedScheme(url.into()))
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

    #[test]
    fn open_http_constructs_store() {
        let store = open("http://localhost:8080/data/store.zarr");
        assert!(store.is_ok());
    }

    #[test]
    fn open_https_constructs_store() {
        let store = open("https://data.example.com/store.zarr");
        assert!(store.is_ok());
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
}
