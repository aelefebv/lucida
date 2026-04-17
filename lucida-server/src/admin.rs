//! Admin endpoints and the shared `clear_proxy_cache` helper.
//!
//! ## CLI vs HTTP
//!
//! Two surfaces invoke the same underlying logic:
//!
//! - The `clear-proxy-cache` subcommand in `main.rs` calls
//!   [`clear_proxy_cache`] directly (synchronous, no auth).
//! - `POST /admin/clear-proxy-cache?dataset=<url>` invokes
//!   [`admin_clear_proxy_cache`], which runs [`clear_proxy_cache`] inside a
//!   `spawn_blocking` after gating on the `LUCIDA_ADMIN_TOKEN` env var.
//!
//! ## Auth
//!
//! The HTTP endpoint requires `Authorization: Bearer <token>` matching the
//! `LUCIDA_ADMIN_TOKEN` environment variable. If the env var is not set,
//! the endpoint replies `503 Service Unavailable` ("admin disabled"). We
//! intentionally do not ship a default token — admin must be opted into.
//!
//! ## URL hash scheme
//!
//! The on-disk layout — `{cache_dir}/{url_hash hex}/{entity_id}/{kind}/...`
//! — is owned by `proxy::ProxyCache` (see S4). We use
//! [`crate::handler::dataset_url_hash16`] to compute the same 16-byte
//! BLAKE3-prefix hash that the cache uses for its per-dataset directory
//! name, formatted as 32 lowercase hex chars.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Json;
use serde::{Deserialize, Serialize};

use crate::AppState;
use crate::handler::dataset_url_hash16;

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

/// Synchronously clear cached proxies under `cache_dir`.
///
/// - If `dataset_url` is `Some(url)`: compute the URL hash via
///   [`dataset_url_hash16`] and recursively remove the matching
///   `{cache_dir}/{hex}` subdirectory. Returns `datasets = 1` if it
///   existed; `0` if not.
/// - If `dataset_url` is `None`: enumerate every subdirectory of
///   `cache_dir` and recursively remove each. Skips files in the root
///   (the cache layout never puts files at the top level).
///
/// A missing `cache_dir` is treated as "0 cleared", not an error — this
/// matches the user-facing semantics of "nothing to clean up".
///
/// File counts are best-effort: we sum a quick recursive count *before*
/// each removal so we can report it. If the count or removal hits a
/// transient I/O error, that error propagates.
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

// ---------------------------------------------------------------------------
// HTTP admin endpoint
// ---------------------------------------------------------------------------

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

/// `POST /admin/clear-proxy-cache`. Auth: `Authorization: Bearer <token>`
/// where `<token>` matches the `LUCIDA_ADMIN_TOKEN` env var.
///
/// - 503 if `LUCIDA_ADMIN_TOKEN` is not set.
/// - 401 if the header is missing or doesn't match.
/// - 200 with [`ClearResponse`] on success.
pub async fn admin_clear_proxy_cache(
    State(app): State<AppState>,
    Query(q): Query<ClearQuery>,
    headers: HeaderMap,
) -> Result<Json<ClearResponse>, (StatusCode, String)> {
    check_admin_auth(&headers)?;

    let cache_dir = app.proxy_cache_dir();
    let dataset = q.dataset;
    let outcome = tokio::task::spawn_blocking(move || {
        clear_proxy_cache(&cache_dir, dataset.as_deref())
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("join error: {e}")))?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("clear failed: {e}")))?;

    Ok(Json(ClearResponse {
        cleared: true,
        datasets: outcome.datasets,
        files: outcome.files,
    }))
}

/// Verify the request carries a valid admin token. Returns the same
/// status codes documented on [`admin_clear_proxy_cache`].
///
/// Exposed at crate scope for tests; not a stable part of the public API.
pub fn check_admin_auth(headers: &HeaderMap) -> Result<(), (StatusCode, String)> {
    let token = std::env::var("LUCIDA_ADMIN_TOKEN").map_err(|_| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "admin disabled".to_string(),
        )
    })?;
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let expected = format!("Bearer {token}");
    if auth != expected {
        return Err((StatusCode::UNAUTHORIZED, "invalid token".to_string()));
    }
    Ok(())
}

/// Re-export of the canonical default cache dir, so `main.rs` and tests
/// don't need to peek at `ProxyConfig` from two places.
pub fn default_cache_dir() -> PathBuf {
    crate::ProxyConfig::default_cache_dir()
}
