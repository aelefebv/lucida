//! Admin endpoints and cache-clear helpers.
//!
//! ## CLI vs HTTP
//!
//! Two surfaces invoke the same underlying logic:
//!
//! - The compatibility-named `clear-proxy-cache` subcommand in `main.rs`
//!   calls [`clear_derived_cache_roots`] directly (synchronous, no auth).
//! - `POST /admin/clear-proxy-cache?dataset=<url>` invokes
//!   [`admin_clear_proxy_cache`], which runs [`clear_derived_cache_roots`] inside a
//!   `spawn_blocking` after the auth middleware + `AdminRequired`
//!   extractor confirm an admin principal.
//!
//! ## Auth
//!
//! Admin routes go through the auth-middleware path: the request must
//! carry a valid session cookie (or the admin route 401s through the
//! middleware), and the resulting `AuthPrincipal` must have
//! `is_admin: true` (or [`AdminRequired`](crate::auth::AdminRequired)
//! 403s with `{"error":"forbidden"}`). Admin status itself is derived
//! per-request from `LUCIDA_ADMIN_EMAILS`; if the env var is unset
//! the route 403s for everyone.
//!
//! ## Source identity scheme
//!
//! The generated-coarse cache uses
//! `{root}/{full source-identity digest}/{source-revision digest}/...`.
//! A targeted clear therefore removes the complete identity directory from
//! the active cache, including every revision. The distinct retired proxy root
//! and its truncated-hash directories are also removed as upgrade cleanup.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::Json;
use lucida_content::url::{SourceIdentity, dataset_url_hash16};
use serde::{Deserialize, Serialize};

use crate::AppState;
use crate::auth::AdminRequired;

/// Outcome of a cache-clear invocation.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct ClearOutcome {
    /// Number of cache identity roots removed (0 if the cache dirs were
    /// missing or already empty).
    pub datasets: usize,
    /// Total number of regular files removed across all cleared
    /// subdirectories. Includes nested files at any depth.
    pub files: usize,
}

impl ClearOutcome {
    fn add(&mut self, other: Self) {
        self.datasets = self.datasets.saturating_add(other.datasets);
        self.files = self.files.saturating_add(other.files);
    }
}

/// The active generated-coarse root and the retired proxy-era root are
/// intentionally distinct types of storage. New writes use only `active`;
/// cache-clearing traverses both so an upgrade cannot strand old artifacts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivedCacheRoots {
    active: PathBuf,
    legacy_proxy: PathBuf,
}

impl DerivedCacheRoots {
    pub fn new(active: PathBuf, legacy_proxy: PathBuf) -> Self {
        Self {
            active,
            legacy_proxy,
        }
    }

    pub fn active(&self) -> &Path {
        &self.active
    }

    pub fn legacy_proxy(&self) -> &Path {
        &self.legacy_proxy
    }
}

/// Clear both the active derived-data cache and the separate proxy-era cache.
/// Equal roots are deduplicated for compatibility. A parent/child pairing is
/// rejected before mutation: otherwise an all-datasets clear of the parent
/// could consume the other root (or unrelated durable state beside it).
pub fn clear_derived_cache_roots(
    roots: &DerivedCacheRoots,
    identity: Option<&SourceIdentity>,
) -> io::Result<ClearOutcome> {
    let active = comparable_root(roots.active())?;
    let legacy = comparable_root(roots.legacy_proxy())?;
    if active != legacy && (active.starts_with(&legacy) || legacy.starts_with(&active)) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "active and legacy cache roots must not contain one another",
        ));
    }

    // Clear the validated/canonical paths, not the original spellings. An
    // operator-configured symlink therefore cannot be retargeted between the
    // containment check and traversal.
    let mut outcome = clear_derived_cache(&active, identity)?;
    if active != legacy {
        outcome.add(clear_derived_cache(&legacy, identity)?);
    }
    Ok(outcome)
}

fn comparable_root(root: &Path) -> io::Result<PathBuf> {
    match fs::canonicalize(root) {
        Ok(root) => return Ok(root),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let absolute = if root.is_absolute() {
        root.to_path_buf()
    } else {
        std::env::current_dir()?.join(root)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    Ok(normalized)
}

/// Clear the active generated-coarse cache. A targeted clear removes the full
/// source-identity directory (all revisions) and any proxy-era truncated-hash
/// directory left by an older deployment. A missing cache root is a successful
/// zero-result operation.
pub fn clear_derived_cache(
    cache_dir: &Path,
    identity: Option<&SourceIdentity>,
) -> io::Result<ClearOutcome> {
    match identity {
        Some(identity) => {
            let mut outcome = ClearOutcome::default();
            let legacy = hex16(&dataset_url_hash16(identity.locator.as_str()));
            for path in [
                cache_dir.join(identity.digest_hex()),
                cache_dir.join(legacy),
            ] {
                let cleared = clear_one_subdir(&path)?;
                outcome.datasets += cleared.datasets;
                outcome.files += cleared.files;
            }
            Ok(outcome)
        }
        None => clear_all_subdirs(cache_dir),
    }
}

fn clear_all_subdirs(root: &Path) -> io::Result<ClearOutcome> {
    if !root.exists() {
        return Ok(ClearOutcome::default());
    }
    let mut outcome = ClearOutcome::default();
    let read = match fs::read_dir(root) {
        Ok(read) => read,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(outcome),
        Err(error) => return Err(error),
    };
    for entry in read {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let cleared = clear_one_subdir(&entry.path())?;
        outcome.datasets += cleared.datasets;
        outcome.files += cleared.files;
    }
    Ok(outcome)
}

/// Remove `dir` recursively, counting files first so the caller can
/// report a meaningful number. A missing directory yields a zero outcome.
fn clear_one_subdir(dir: &Path) -> io::Result<ClearOutcome> {
    let metadata = match fs::symlink_metadata(dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(ClearOutcome::default());
        }
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_symlink() {
        fs::remove_file(dir)?;
        return Ok(ClearOutcome {
            datasets: 1,
            files: 0,
        });
    }
    if !metadata.is_dir() {
        return Ok(ClearOutcome::default());
    }
    let files = count_files_recursive(dir)?;
    fs::remove_dir_all(dir)?;
    Ok(ClearOutcome { datasets: 1, files })
}

/// Count regular files under `dir` recursively. Symlinks are not
/// followed (they shouldn't appear in our cache layout, but this keeps
/// the count bounded even if one slips in).
fn count_files_recursive(dir: &Path) -> io::Result<usize> {
    let mut total = 0usize;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            total += count_files_recursive(&entry.path())?;
        } else if file_type.is_file() {
            total += 1;
        }
        // Symlinks and other special files are ignored.
    }
    Ok(total)
}

/// Hex-encode a 16-byte hash to 32 lowercase chars. Mirrors the
/// retired proxy cache so its old directory can be cleaned up.
fn hex16(bytes: &[u8; 16]) -> String {
    let mut out = String::with_capacity(32);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// Query parameters for `POST /admin/clear-proxy-cache`.
#[derive(Debug, Deserialize)]
pub struct ClearQuery {
    /// Optional dataset URL. If omitted, every dataset subdir is cleared.
    pub dataset: Option<String>,
}

/// JSON body of a successful `POST /admin/clear-proxy-cache`.
#[derive(Debug, Serialize)]
pub struct ClearResponse {
    pub cleared: bool,
    pub datasets: usize,
    pub files: usize,
}

/// `POST /admin/clear-proxy-cache`. Auth: requires a session cookie
/// whose principal has `is_admin: true`. The auth middleware handles
/// the cookie -> principal -> 401 path; [`AdminRequired`] handles the
/// `is_admin` -> 403 path. If `LUCIDA_ADMIN_EMAILS` is unset (no
/// admins configured) every request 403s here.
///
/// - 401 if the request has no valid session (auth middleware).
/// - 403 if the principal isn't an admin ([`AdminRequired`]).
/// - 200 with [`ClearResponse`] on success.
pub async fn admin_clear_proxy_cache(
    _admin: AdminRequired,
    State(app): State<AppState>,
    Query(q): Query<ClearQuery>,
) -> Result<Json<ClearResponse>, (StatusCode, String)> {
    let cache_roots = app.derived_cache_roots();
    let identity = q
        .dataset
        .as_deref()
        .map(SourceIdentity::parse)
        .transpose()
        .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
    let source_cache = Arc::clone(&app.dataset_runtime.source_cache);
    let disk_identity = identity.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        clear_derived_cache_roots(&cache_roots, disk_identity.as_ref())
    })
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("join error: {e}"),
        )
    })?
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("clear failed: {e}"),
        )
    })?;

    match identity.as_ref() {
        Some(identity) => {
            source_cache.invalidate_source(identity);
        }
        None => {
            source_cache.invalidate_all();
        }
    }

    Ok(Json(ClearResponse {
        cleared: true,
        datasets: outcome.datasets,
        files: outcome.files,
    }))
}

/// Re-export of the canonical default cache dir, so `main.rs` and tests
/// don't need to peek at the runtime configuration from two places.
pub fn default_cache_dir() -> PathBuf {
    crate::DatasetRuntimeConfig::default_generated_cache_dir()
}

pub fn default_legacy_proxy_cache_dir() -> PathBuf {
    crate::DatasetRuntimeConfig::default_legacy_proxy_cache_dir()
}
