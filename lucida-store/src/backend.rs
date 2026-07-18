//! Storage backend abstraction for reading from Zarr Stores.
//!
//! URL scheme routing (after [`lucida_content::url::normalize_dataset_url`]
//! is applied at entry — see
//! `wiki/decisions/0042-canonical-dataset-url-form.md`):
//! - Unix `/path/...`, drive-letter `c:/path/...`, UNC `//server/share/...`
//!   → local filesystem (classified via [`lucida_content::url::is_local_dataset_url`]).
//!   [`open`] is the trusted library/client entry point and uses
//!   [`object_store::local::LocalFileSystem`] on every supported platform.
//!   Server-local sources instead enter through [`ConfinedLocalRoot`], which
//!   fails closed where descriptor-relative, no-symlink confinement is absent.
//! - `gs://bucket/...` → Google Cloud Storage. Credential discovery order:
//!   `GOOGLE_*` env vars (incl. `GOOGLE_SERVICE_ACCOUNT*` and Google's standard
//!   `GOOGLE_APPLICATION_CREDENTIALS`) read by `GoogleCloudStorageBuilder::from_env`,
//!   then the well-known ADC file at
//!   `$HOME/.config/gcloud/application_default_credentials.json`, then the GCE
//!   metadata server (Workload Identity / GCE instance default).
//! - `s3://bucket/...` → Amazon S3 (environment/instance credentials)
//! - `http://...` / `https://...` → HTTP static file server

use std::fmt;
use std::fs::File;
use std::io;
use std::path::{Path as FilePath, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use futures_util::stream::{self, BoxStream};
use lucida_content::url::{CanonicalDatasetUrl, is_local_dataset_url};
use lucida_protocol::{FailureCategory, FailureCode, FailureDescriptor};
use object_store::aws::AmazonS3Builder;
use object_store::gcp::GoogleCloudStorageBuilder;
use object_store::http::HttpBuilder;
use object_store::local::LocalFileSystem;
use object_store::path::Path;
use object_store::prefix::PrefixStore;
use object_store::{
    Attributes, BackoffConfig, ClientOptions, CopyOptions, GetOptions, GetResult, GetResultPayload,
    ListResult, MultipartUpload, ObjectMeta, ObjectStore, PutMultipartOptions, PutOptions,
    PutPayload, PutResult, RetryConfig,
};

/// The client's fetch timeout for a single remote read.
///
/// This mirrors lucida-web `contentSource.ts` `DEFAULT_TIMEOUT_MS` and MUST be
/// kept in sync with it. The store's worst-case per-read budget
/// ([`max_source_read_budget`]) must stay under this value so the *client*, not
/// the server, wins the timeout race. If the server were allowed to hang past
/// the client's timeout, the client would give up and re-send the read while
/// the original is still in flight, re-introducing the duplicate work this
/// ordering exists to prevent.
pub const CLIENT_FETCH_TIMEOUT: Duration = Duration::from_secs(10);

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

/// A configured local allowlist root pinned as an operating-system directory
/// capability. Dataset admission traverses beneath this descriptor without
/// following symlinks, so later path replacement cannot redirect the admitted
/// backend outside the configured root.
#[derive(Clone)]
pub struct ConfinedLocalRoot {
    root: Arc<File>,
    canonical_path: Arc<PathBuf>,
}

impl fmt::Debug for ConfinedLocalRoot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ConfinedLocalRoot(<redacted>)")
    }
}

/// A local dataset whose directory descriptor was pinned during source-policy
/// admission. Cloning/opening this capability never reparses or recanonicalizes
/// the original path.
#[derive(Clone)]
pub struct AdmittedLocalDataset {
    store: ConfinedLocalStore,
}

impl fmt::Debug for AdmittedLocalDataset {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AdmittedLocalDataset(<redacted>)")
    }
}

impl AdmittedLocalDataset {
    pub fn open_backend(&self) -> Arc<dyn ObjectStore> {
        Arc::new(self.store.clone())
    }
}

/// Read-only local store whose lookups stay beneath a pinned dataset root and
/// reject every descendant symlink. `object_store::LocalFileSystem` explicitly
/// follows links outside its prefix, which is unsuitable for an admitted
/// server-side source capability.
#[derive(Clone)]
struct ConfinedLocalStore {
    root: Arc<File>,
    root_path: Arc<PathBuf>,
}

impl fmt::Debug for ConfinedLocalStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ConfinedLocalStore(<redacted>)")
    }
}

impl fmt::Display for ConfinedLocalStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ConfinedLocalStore(<redacted>)")
    }
}

impl ConfinedLocalRoot {
    pub fn new(prefix: &FilePath) -> Result<Self, StoreError> {
        #[cfg(not(unix))]
        {
            let _ = prefix;
            return Err(StoreError::SourceConfiguration(
                "race-safe local source confinement is unavailable on this platform".to_string(),
            ));
        }

        #[cfg(unix)]
        {
            Self::new_unix(prefix).map_err(StoreError::from)
        }
    }

    #[cfg(unix)]
    fn new_unix(prefix: &FilePath) -> object_store::Result<Self> {
        let canonical = std::fs::canonicalize(prefix)
            .map_err(|source| confined_io_error("dataset-root", source))?;
        let root = open_confined_root(&canonical)?;
        Ok(Self {
            root: Arc::new(root),
            canonical_path: Arc::new(canonical),
        })
    }

    /// Pin one already-canonical dataset directory beneath this allowlist root.
    /// The path string is used only to derive relative components; every actual
    /// lookup is descriptor-relative and rejects symlinks.
    pub fn admit_canonical_dataset(
        &self,
        canonical_dataset: &FilePath,
    ) -> Result<AdmittedLocalDataset, StoreError> {
        let relative = canonical_dataset
            .strip_prefix(self.canonical_path.as_path())
            .map_err(|_| {
                StoreError::InvalidLocator(
                    "local dataset source is outside its admitted root".to_string(),
                )
            })?;
        let root = open_confined_directory(&self.root, relative).map_err(StoreError::from)?;
        Ok(AdmittedLocalDataset {
            store: ConfinedLocalStore {
                root: Arc::new(root),
                root_path: Arc::new(canonical_dataset.to_path_buf()),
            },
        })
    }
}

impl ConfinedLocalStore {
    fn open_get(&self, location: Path, options: GetOptions) -> object_store::Result<GetResult> {
        let file = open_confined_file(&self.root, &self.root_path, &location)?;
        let metadata = file
            .metadata()
            .map_err(|source| confined_io_error(location.as_ref(), source))?;
        if !metadata.is_file() {
            return Err(object_store::Error::NotFound {
                path: location.to_string(),
                source: "local source object is not a regular file".into(),
            });
        }

        let modified = metadata
            .modified()
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        let size = metadata.len();
        let mtime = modified
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros();
        #[cfg(unix)]
        let inode = {
            use std::os::unix::fs::MetadataExt;
            metadata.ino()
        };
        #[cfg(not(unix))]
        let inode = 0u64;
        let meta = ObjectMeta {
            location: location.clone(),
            last_modified: modified.into(),
            size,
            e_tag: Some(format!("\"{inode:x}-{mtime:x}-{size:x}\"")),
            version: None,
        };
        options.check_preconditions(&meta)?;
        let range = match options.range {
            Some(range) => range
                .as_range(size)
                .map_err(|source| object_store::Error::Generic {
                    store: "confined-local",
                    source: Box::new(source),
                })?,
            None => 0..size,
        };
        let diagnostic_path = self.root_path.join(location.as_ref());
        Ok(GetResult {
            payload: GetResultPayload::File(file, diagnostic_path),
            meta,
            range,
            attributes: Attributes::default(),
            extensions: Default::default(),
        })
    }
}

fn read_only_local_error(operation: &str) -> object_store::Error {
    object_store::Error::NotImplemented {
        operation: operation.to_string(),
        implementer: "ConfinedLocalStore".to_string(),
    }
}

fn confined_io_error(path: &str, source: io::Error) -> object_store::Error {
    #[cfg(unix)]
    if source.raw_os_error() == Some(libc::ELOOP) {
        return object_store::Error::PermissionDenied {
            path: path.to_string(),
            source: Box::new(source),
        };
    }
    match source.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory => object_store::Error::NotFound {
            path: path.to_string(),
            source: Box::new(source),
        },
        io::ErrorKind::PermissionDenied => object_store::Error::PermissionDenied {
            path: path.to_string(),
            source: Box::new(source),
        },
        _ => object_store::Error::Generic {
            store: "confined-local",
            source: Box::new(source),
        },
    }
}

#[cfg(unix)]
fn open_at(parent: &File, component: &[u8], directory: bool) -> object_store::Result<File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};

    let component = CString::new(component).map_err(|_| object_store::Error::PermissionDenied {
        path: "local-source-object".to_string(),
        source: "local source path contains NUL".into(),
    })?;
    let mut flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW;
    if directory {
        flags |= libc::O_DIRECTORY;
    }
    // SAFETY: `parent` is a live directory descriptor, `component` is a
    // NUL-terminated single path component, and a successful descriptor is
    // transferred exactly once into `File` below.
    let descriptor = unsafe { libc::openat(parent.as_raw_fd(), component.as_ptr(), flags) };
    if descriptor < 0 {
        return Err(confined_io_error(
            "local-source-object",
            io::Error::last_os_error(),
        ));
    }
    // SAFETY: `openat` returned a new owned descriptor and no other owner exists.
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

#[cfg(unix)]
fn open_confined_root(canonical: &FilePath) -> object_store::Result<File> {
    use std::os::unix::ffi::OsStrExt;

    let mut directory =
        File::open("/").map_err(|source| confined_io_error("dataset-root", source))?;
    for component in canonical.components() {
        match component {
            std::path::Component::RootDir => {}
            std::path::Component::Normal(component) => {
                directory = open_at(&directory, component.as_bytes(), true)?;
            }
            _ => {
                return Err(object_store::Error::PermissionDenied {
                    path: "dataset-root".to_string(),
                    source: "local dataset root is not canonical".into(),
                });
            }
        }
    }
    Ok(directory)
}

#[cfg(unix)]
fn open_confined_directory(root: &File, relative: &FilePath) -> object_store::Result<File> {
    use std::os::unix::ffi::OsStrExt;

    let mut directory = root
        .try_clone()
        .map_err(|source| confined_io_error("dataset-root", source))?;
    for component in relative.components() {
        match component {
            std::path::Component::Normal(component) => {
                directory = open_at(&directory, component.as_bytes(), true)?;
            }
            std::path::Component::CurDir => {}
            _ => {
                return Err(object_store::Error::PermissionDenied {
                    path: "dataset-root".to_string(),
                    source: "local dataset path is not confined beneath its admitted root".into(),
                });
            }
        }
    }
    Ok(directory)
}

#[cfg(not(unix))]
fn open_confined_directory(_root: &File, _relative: &FilePath) -> object_store::Result<File> {
    Err(object_store::Error::PermissionDenied {
        path: "dataset-root".to_string(),
        source: "race-safe local source confinement is unavailable on this platform".into(),
    })
}

#[cfg(unix)]
fn open_confined_file(
    root: &File,
    _root_path: &FilePath,
    location: &Path,
) -> object_store::Result<File> {
    let parts = location.parts().collect::<Vec<_>>();
    let Some((last, parents)) = parts.split_last() else {
        return Err(object_store::Error::NotFound {
            path: location.to_string(),
            source: "local source object path is empty".into(),
        });
    };
    let mut directory = root
        .try_clone()
        .map_err(|source| confined_io_error(location.as_ref(), source))?;
    for component in parents {
        let component = component.as_ref();
        if component.is_empty() || matches!(component, "." | "..") {
            return Err(object_store::Error::PermissionDenied {
                path: location.to_string(),
                source: "local source path is not relative".into(),
            });
        }
        directory = open_at(&directory, component.as_bytes(), true)?;
    }
    let last = last.as_ref();
    if last.is_empty() || matches!(last, "." | "..") {
        return Err(object_store::Error::PermissionDenied {
            path: location.to_string(),
            source: "local source path is not relative".into(),
        });
    }
    open_at(&directory, last.as_bytes(), false)
}

#[cfg(not(unix))]
fn open_confined_file(
    _root: &File,
    _root_path: &FilePath,
    location: &Path,
) -> object_store::Result<File> {
    Err(object_store::Error::PermissionDenied {
        path: location.to_string(),
        source: "race-safe local source confinement is unavailable on this platform".into(),
    })
}

#[async_trait::async_trait]
impl ObjectStore for ConfinedLocalStore {
    async fn put_opts(
        &self,
        _location: &Path,
        _payload: PutPayload,
        _opts: PutOptions,
    ) -> object_store::Result<PutResult> {
        Err(read_only_local_error("put_opts"))
    }

    async fn put_multipart_opts(
        &self,
        _location: &Path,
        _opts: PutMultipartOptions,
    ) -> object_store::Result<Box<dyn MultipartUpload>> {
        Err(read_only_local_error("put_multipart_opts"))
    }

    async fn get_opts(
        &self,
        location: &Path,
        options: GetOptions,
    ) -> object_store::Result<GetResult> {
        let store = self.clone();
        let location = location.clone();
        tokio::task::spawn_blocking(move || store.open_get(location, options))
            .await
            .map_err(|source| object_store::Error::Generic {
                store: "confined-local",
                source: Box::new(source),
            })?
    }

    fn delete_stream(
        &self,
        locations: BoxStream<'static, object_store::Result<Path>>,
    ) -> BoxStream<'static, object_store::Result<Path>> {
        locations
            .map(|location| location.and_then(|_| Err(read_only_local_error("delete"))))
            .boxed()
    }

    fn list(&self, _prefix: Option<&Path>) -> BoxStream<'static, object_store::Result<ObjectMeta>> {
        stream::once(async { Err(read_only_local_error("list")) }).boxed()
    }

    async fn list_with_delimiter(
        &self,
        _prefix: Option<&Path>,
    ) -> object_store::Result<ListResult> {
        Err(read_only_local_error("list_with_delimiter"))
    }

    async fn copy_opts(
        &self,
        _from: &Path,
        _to: &Path,
        _options: CopyOptions,
    ) -> object_store::Result<()> {
        Err(read_only_local_error("copy_opts"))
    }
}

/// Worst-case wall-clock for ONE failing remote source read.
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

/// Errors from storage backend operations.
#[derive(Debug)]
pub enum StoreError {
    /// The URL scheme is not supported.
    UnsupportedScheme(String),
    /// The admitted locator itself is invalid.
    InvalidLocator(String),
    /// Backend/bucket/credential configuration is invalid before a read.
    SourceConfiguration(String),
    /// An error from the underlying object store. `context` contains only
    /// admitted store-relative identities (never the source locator), so a
    /// caller can name the metadata object that failed without weakening the
    /// stable source/auth/retry classification carried by `source`.
    ObjectStore {
        source: object_store::Error,
        context: Vec<String>,
    },
    /// Metadata did not satisfy the schema expected by the importer.
    Schema(String),
    /// The declared storage codec is unsupported or malformed.
    Codec(String),
    /// Shape, layout, byte-size, or coordinate bounds are invalid.
    Bounds(String),
}

impl StoreError {
    /// Stable descriptor used by every transport. Classification is an
    /// exhaustive match over typed variants; display text is never parsed.
    pub fn failure(&self) -> FailureDescriptor {
        match self {
            Self::UnsupportedScheme(_) => {
                FailureDescriptor::new(FailureCode::UnsupportedScheme, false)
            }
            Self::InvalidLocator(_) => FailureDescriptor::new(FailureCode::InvalidLocator, false),
            Self::SourceConfiguration(_) => {
                FailureDescriptor::new(FailureCode::CloudConfiguration, false)
            }
            Self::ObjectStore { source, .. } => object_store_failure(source),
            Self::Schema(_) => FailureDescriptor::new(FailureCode::MalformedMetadata, false),
            Self::Codec(_) => FailureDescriptor::new(FailureCode::UnsupportedCodec, false),
            Self::Bounds(_) => FailureDescriptor::new(FailureCode::UnsupportedLayout, false),
        }
    }

    pub fn category(&self) -> FailureCategory {
        self.failure().category
    }

    pub fn is_retryable(&self) -> bool {
        self.failure().retryable
    }

    /// A locator-safe message suitable for a terminal client response. The
    /// full underlying object-store error remains available for trusted logs.
    pub fn public_message(&self) -> String {
        match self {
            Self::UnsupportedScheme(scheme) => {
                format!("unsupported dataset source scheme: {scheme}")
            }
            Self::InvalidLocator(_) => "dataset source locator is invalid".to_string(),
            Self::SourceConfiguration(_) => "dataset storage configuration is invalid".to_string(),
            Self::ObjectStore { source, context } => {
                let message = object_store_public_message(source);
                if context.is_empty() {
                    message.to_string()
                } else {
                    format!("{}: {message}", context.join(": "))
                }
            }
            Self::Schema(message) => format!("dataset metadata is invalid: {message}"),
            Self::Codec(message) => format!("dataset codec is unsupported: {message}"),
            Self::Bounds(message) => format!("dataset layout is invalid: {message}"),
        }
    }

    /// Add structural context without erasing the typed failure variant.
    pub fn with_context(self, context: impl fmt::Display) -> Self {
        let prefix = context.to_string();
        match self {
            Self::UnsupportedScheme(message) => {
                Self::UnsupportedScheme(format!("{prefix}: {message}"))
            }
            Self::InvalidLocator(message) => Self::InvalidLocator(format!("{prefix}: {message}")),
            Self::SourceConfiguration(message) => {
                Self::SourceConfiguration(format!("{prefix}: {message}"))
            }
            Self::ObjectStore {
                source,
                mut context,
            } => {
                context.insert(0, prefix);
                Self::ObjectStore { source, context }
            }
            Self::Schema(message) => Self::Schema(format!("{prefix}: {message}")),
            Self::Codec(message) => Self::Codec(format!("{prefix}: {message}")),
            Self::Bounds(message) => Self::Bounds(format!("{prefix}: {message}")),
        }
    }
}

/// Exhaustive mapping from the storage library's typed error variants to the
/// shared failure contract. `object_store::Error` is non-exhaustive, so future
/// upstream variants land in the conservative retryable backend bucket rather
/// than being classified from prose.
pub fn object_store_failure(error: &object_store::Error) -> FailureDescriptor {
    let (code, retryable) = match error {
        object_store::Error::NotFound { .. } => (FailureCode::MissingObject, false),
        object_store::Error::InvalidPath { .. } => (FailureCode::InvalidLocator, false),
        object_store::Error::PermissionDenied { .. }
        | object_store::Error::Unauthenticated { .. } => (FailureCode::Permission, false),
        object_store::Error::UnknownConfigurationKey { .. } => {
            (FailureCode::CloudConfiguration, false)
        }
        object_store::Error::NotSupported { .. }
        | object_store::Error::NotImplemented { .. }
        | object_store::Error::AlreadyExists { .. }
        | object_store::Error::Precondition { .. }
        | object_store::Error::NotModified { .. } => (FailureCode::StorageBackend, false),
        object_store::Error::Generic { .. } | object_store::Error::JoinError { .. } => {
            (FailureCode::StorageBackend, true)
        }
        _ => (FailureCode::StorageBackend, true),
    };
    FailureDescriptor::new(code, retryable)
}

fn object_store_public_message(error: &object_store::Error) -> &'static str {
    match object_store_failure(error).kind {
        FailureCode::MissingObject => "dataset source object was not found",
        FailureCode::InvalidLocator => "dataset source object path is invalid",
        FailureCode::Permission => "dataset source access was denied",
        FailureCode::CloudConfiguration => "dataset storage configuration is invalid",
        _ => "dataset storage backend is unavailable",
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::UnsupportedScheme(s) => write!(f, "unsupported URL scheme: {s}"),
            StoreError::InvalidLocator(s) => write!(f, "invalid dataset locator: {s}"),
            StoreError::SourceConfiguration(s) => write!(f, "storage configuration error: {s}"),
            StoreError::ObjectStore { source, context } => {
                if context.is_empty() {
                    write!(f, "storage error: {source}")
                } else {
                    write!(f, "storage error at {}: {source}", context.join(": "))
                }
            }
            StoreError::Schema(s) => write!(f, "metadata schema error: {s}"),
            StoreError::Codec(s) => write!(f, "codec error: {s}"),
            StoreError::Bounds(s) => write!(f, "layout bounds error: {s}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<object_store::Error> for StoreError {
    fn from(e: object_store::Error) -> Self {
        StoreError::ObjectStore {
            source: e,
            context: Vec::new(),
        }
    }
}

/// Parse a `gs://bucket/prefix` URL into (bucket, optional prefix).
fn parse_gs_url(url: &str) -> Result<(&str, Option<&str>), StoreError> {
    let rest = url
        .strip_prefix("gs://")
        .ok_or_else(|| StoreError::UnsupportedScheme(url.into()))?;
    if rest.is_empty() {
        return Err(StoreError::SourceConfiguration(
            "gs:// URL missing bucket name".into(),
        ));
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
        return Err(StoreError::SourceConfiguration(
            "s3:// URL missing bucket name".into(),
        ));
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

/// Open a trusted library/client storage backend from a URL.
///
/// Local paths passed here are trusted ambient filesystem access. The local
/// backend follows normal platform filesystem semantics, including symlinks,
/// so server code must first admit local sources through [`ConfinedLocalRoot`]
/// and retain the resulting [`AdmittedLocalDataset`] capability instead of
/// reopening the locator through this function.
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
///   filesystem using the platform-neutral trusted-client backend.
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
    // Parse and normalize once at the admission boundary.  Downstream code
    // cannot accidentally use the raw spelling as a source identity or cache
    // key, and relative/NUL/oversized locators fail before reaching a backend.
    let canonical = CanonicalDatasetUrl::parse(url)
        .map_err(|error| StoreError::InvalidLocator(format!("dataset_url: {error}")))?;
    let canonical = canonical.as_str();

    if is_local_dataset_url(canonical) {
        let store = LocalFileSystem::new_with_prefix(FilePath::new(canonical))?;
        Ok(Arc::new(store))
    } else if canonical.starts_with("gs://") {
        let (bucket, prefix) = parse_gs_url(canonical)?;
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
        let (bucket, prefix) = parse_s3_url(canonical)?;
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
            .with_url(canonical)
            .with_client_options(client_options)
            .with_retry(source_retry_config())
            .build()?;
        Ok(Arc::new(store))
    } else {
        Err(StoreError::UnsupportedScheme(
            canonical
                .split_once("://")
                .map_or("unknown", |(scheme, _)| scheme)
                .to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use object_store::ObjectStoreExt;

    fn local_test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("lucida_backend_test_{}", std::process::id()))
            .join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn trusted_open_reads_local_object() {
        let dir = local_test_dir("trusted_local_open");
        std::fs::write(dir.join("zarr.json"), b"trusted-local").unwrap();

        let bytes = open(dir.to_str().unwrap())
            .unwrap()
            .get(&Path::from("zarr.json"))
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();

        assert_eq!(&bytes[..], b"trusted-local");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(not(unix))]
    #[test]
    fn confined_local_root_fails_closed_without_descriptor_confinement() {
        let dir = local_test_dir("unsupported_server_confinement");
        assert!(matches!(
            ConfinedLocalRoot::new(&dir),
            Err(StoreError::SourceConfiguration(_))
        ));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn confined_local_store_reads_regular_objects_but_rejects_descendant_symlinks() {
        use std::os::unix::fs::symlink;

        let root = local_test_dir("confined_symlinks");
        let dataset = root.join("dataset.zarr");
        let outside = root.join("outside");
        std::fs::create_dir_all(dataset.join("0")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(dataset.join("zarr.json"), b"inside").unwrap();
        std::fs::write(outside.join("secret.json"), b"outside").unwrap();

        let allowlisted_root = ConfinedLocalRoot::new(&root).unwrap();
        let canonical_dataset = std::fs::canonicalize(&dataset).unwrap();
        let store = allowlisted_root
            .admit_canonical_dataset(&canonical_dataset)
            .unwrap()
            .open_backend();
        let regular = store
            .get(&Path::from("zarr.json"))
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        assert_eq!(&regular[..], b"inside");

        symlink(outside.join("secret.json"), dataset.join("linked.json")).unwrap();
        let final_link = store.get(&Path::from("linked.json")).await.unwrap_err();
        assert!(matches!(
            final_link,
            object_store::Error::PermissionDenied { .. } | object_store::Error::NotFound { .. }
        ));

        std::fs::remove_dir(dataset.join("0")).unwrap();
        symlink(&outside, dataset.join("0")).unwrap();
        let intermediate_link = store.get(&Path::from("0/secret.json")).await.unwrap_err();
        assert!(matches!(
            intermediate_link,
            object_store::Error::PermissionDenied { .. } | object_store::Error::NotFound { .. }
        ));

        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn admitted_local_dataset_capability_is_not_reopened_after_path_swap() {
        use std::os::unix::fs::symlink;

        let root = local_test_dir("pinned_dataset_swap");
        let dataset = root.join("dataset.zarr");
        let pinned_location = root.join("pinned-original.zarr");
        let outside = root.join("outside");
        std::fs::create_dir_all(&dataset).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(dataset.join("zarr.json"), b"inside").unwrap();
        std::fs::write(outside.join("zarr.json"), b"outside").unwrap();

        let allowlisted_root = ConfinedLocalRoot::new(&root).unwrap();
        let canonical_dataset = std::fs::canonicalize(&dataset).unwrap();
        let admitted = allowlisted_root
            .admit_canonical_dataset(&canonical_dataset)
            .unwrap();

        std::fs::rename(&dataset, &pinned_location).unwrap();
        symlink(&outside, &dataset).unwrap();
        assert_eq!(
            std::fs::read(dataset.join("zarr.json")).unwrap(),
            b"outside"
        );

        let bytes = admitted
            .open_backend()
            .get(&Path::from("zarr.json"))
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        assert_eq!(&bytes[..], b"inside");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn open_unsupported_scheme() {
        let err = open("ftp://host/path").unwrap_err();
        assert!(matches!(err, StoreError::UnsupportedScheme(ref scheme) if scheme == "ftp"));
        assert_eq!(err.category(), FailureCategory::Source);
        assert!(!err.to_string().contains("host/path"));
    }

    #[test]
    fn open_rejects_relative_locator_before_backend_dispatch() {
        let err = open("relative/store.zarr").unwrap_err();
        assert_eq!(err.category(), FailureCategory::Source);
        assert_eq!(err.failure().kind, FailureCode::InvalidLocator);
        assert!(!err.is_retryable());
    }

    // --- Cross-platform local-path construction (ADR-0042) ---
    //
    // These tests assert that each canonical-equivalent spelling of a local
    // path *dispatches* to the trusted local branch (i.e. NOT
    // `StoreError::UnsupportedScheme`). Whether the path exists is out of
    // scope: canonicalization failure still proves local classification
    // occurred.
    //
    // To exercise the canonicalize-succeeds path with an existing path,
    // see [`trusted_open_reads_local_object`] above.

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
        assert!(matches!(err, StoreError::SourceConfiguration(_)));
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
        assert!(matches!(err, StoreError::SourceConfiguration(_)));
    }

    #[test]
    fn open_gs_constructs_store() {
        // Verifies that GCS builder construction succeeds (no credentials needed
        // until an actual I/O operation is performed).
        let store = open("gs://test-bucket/some/prefix");
        assert!(store.is_ok());
    }

    #[test]
    fn object_store_context_names_safe_identity_without_losing_typed_classification() {
        let error = StoreError::from(object_store::Error::PermissionDenied {
            path: "/secret/source/bucket/token".to_string(),
            source: "credential material".into(),
        })
        .with_context("tile \"A/1/0\"");

        assert_eq!(error.failure().kind, FailureCode::Permission);
        assert!(!error.is_retryable());
        let public = error.public_message();
        assert!(public.contains("tile \"A/1/0\""), "{public}");
        assert!(public.contains("access was denied"), "{public}");
        assert!(!public.contains("secret"), "{public}");
        assert!(!public.contains("credential"), "{public}");
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
