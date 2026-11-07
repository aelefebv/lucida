//! Admin endpoints and the shared `clear_proxy_cache` helper.
//!
//! The `clear-proxy-cache` subcommand calls [`clear_proxy_cache`] directly,
//! with no auth. `POST /admin/clear-proxy-cache?dataset=<url>` runs it in
//! `spawn_blocking` behind the auth middleware and
//! [`AdminRequired`](crate::auth::AdminRequired). The per-dataset directory
//! name must match `proxy::ProxyCache`, so both derive it with
//! [`lucida_content::url::dataset_url_hash16`].

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::Json;
use lucida_content::url::dataset_url_hash16;
use serde::{Deserialize, Serialize};

use crate::AppState;
use crate::auth::AdminRequired;

/// Outcome of a `clear_proxy_cache` invocation.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct ClearOutcome {
    /// Number of dataset subdirectories removed (0 if the cache dir was
    /// missing or already empty; 1 when a specific dataset was targeted
    /// and existed; up to N when clearing all).
    pub datasets: usize,
    /// Total number of regular files removed across all cleared
    /// subdirectories. Includes nested files at any depth.
    pub files: usize,
}

/// Synchronously clear cached proxies under `cache_dir`: the one
/// `{cache_dir}/{hex}` directory from [`dataset_url_hash16`] when
/// `dataset_url` is given, otherwise every subdirectory. A missing
/// `cache_dir` clears nothing and is not an error. File counts are taken
/// before each removal; an I/O error in the count or removal propagates.
pub fn clear_proxy_cache(cache_dir: &Path, dataset_url: Option<&str>) -> io::Result<ClearOutcome> {
    if !cache_dir.exists() {
        return Ok(ClearOutcome::default());
    }

    match dataset_url {
        Some(url) => {
            let hash = dataset_url_hash16(url);
            let dataset_dir = cache_dir.join(hex16(&hash));
            clear_one_subdir(&dataset_dir)
        }
        None => {
            let mut outcome = ClearOutcome::default();
            let read = match fs::read_dir(cache_dir) {
                Ok(r) => r,
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(outcome),
                Err(e) => return Err(e),
            };
            for entry in read {
                let entry = entry?;
                let file_type = entry.file_type()?;
                if !file_type.is_dir() {
                    // Top-level files are not part of the layout; skip them.
                    continue;
                }
                let sub_outcome = clear_one_subdir(&entry.path())?;
                outcome.datasets += sub_outcome.datasets;
                outcome.files += sub_outcome.files;
            }
            Ok(outcome)
        }
    }
}

/// Remove `dir` recursively, counting files first so the caller can
/// report a meaningful number. A missing directory yields a zero outcome.
fn clear_one_subdir(dir: &Path) -> io::Result<ClearOutcome> {
    if !dir.exists() {
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
/// (private) helper in `proxy::cache` so the directory names line up.
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
    let cache_dir = app.proxy_cache_dir();
    let dataset = q.dataset;
    let outcome =
        tokio::task::spawn_blocking(move || clear_proxy_cache(&cache_dir, dataset.as_deref()))
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

    Ok(Json(ClearResponse {
        cleared: true,
        datasets: outcome.datasets,
        files: outcome.files,
    }))
}

/// Re-export of the canonical default cache dir, so `main.rs` and tests
/// don't need to peek at `ProxyConfig` from two places.
pub fn default_cache_dir() -> PathBuf {
    crate::ProxyConfig::default_cache_dir()
}
