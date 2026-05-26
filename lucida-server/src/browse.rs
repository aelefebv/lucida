//! `/api/browse` — filesystem listing for the SPA's FileBrowser modal.
//!
//! Cross-platform: on Unix the platform-default root is `/`. On Windows
//! there is no shared filesystem root — `\` resolves per-drive — so the
//! handler returns a *synthetic* drives-list entry list (`c:`, `d:`, …)
//! when the client doesn't supply a path. The client never has to know
//! which OS it's talking to; it just sends an empty `path` to ask for
//! "whatever root makes sense here" and follows links from there.
//!
//! All non-empty paths flow through `tokio::fs::canonicalize`, then the
//! response's `path` field is converted to the canonical display form
//! (see [`canonical_display_form`]) so the SPA never sees Windows
//! `\\?\C:\…` verbatim-UNC noise. The `data_dir` security check stays
//! on the raw canonicalized `PathBuf`s — display conversion is for the
//! wire only.

use std::path::Path;
use std::path::PathBuf;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::Json;
use serde::{Deserialize, Serialize};

use crate::AppState;

#[derive(Deserialize)]
pub struct BrowseQuery {
    /// Absent or empty → return the platform-default root response
    /// (synthetic drives list on Windows, listing of `/` on Unix). Any
    /// non-empty value is canonicalized and listed normally.
    path: Option<String>,
}

#[derive(Serialize)]
pub struct BrowseResponse {
    path: String,
    entries: Vec<BrowseEntry>,
}

#[derive(Serialize, Debug)]
pub struct BrowseEntry {
    name: String,
    #[serde(rename = "type")]
    entry_type: String,
}

/// Convert a canonicalized `Path` to the canonical-display form used on
/// the wire and in the SPA URL bar. Mirrors the
/// `lucida_content::url::normalize_dataset_url` shape so display, hash,
/// and storage keys all agree.
///
/// On Unix this is just `to_string_lossy()`. On Windows:
/// - `\\?\UNC\server\share\foo` → `//server/share/foo`
/// - `\\?\C:\Users\me` → `c:/Users/me`
/// - `C:\Users\me` (no verbatim prefix) → `c:/Users/me`
fn canonical_display_form(p: &Path) -> String {
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        // Strip the verbatim-UNC `\\?\UNC\` prefix → bare `\\` UNC form.
        let stripped = if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{rest}")
        } else if let Some(rest) = s.strip_prefix(r"\\?\") {
            rest.to_string()
        } else {
            s.into_owned()
        };
        // Forward-slashify.
        let forward = stripped.replace('\\', "/");
        // Lowercase drive letter when present (e.g. `C:/foo` → `c:/foo`).
        // UNC paths start with `//` and have no drive letter.
        let mut chars: Vec<char> = forward.chars().collect();
        if chars.len() >= 2 && chars[0].is_ascii_alphabetic() && chars[1] == ':' {
            chars[0] = chars[0].to_ascii_lowercase();
        }
        chars.into_iter().collect()
    }
    #[cfg(not(windows))]
    {
        p.to_string_lossy().to_string()
    }
}

/// Platform-default response path returned when the client sends an
/// empty `path`. Unix → `"/"`. Windows → `""` (empty sentinel meaning
/// "synthetic drives root"; the SPA treats an empty `currentPath` as
/// the root and prepends entry names directly when navigating in).
fn platform_root_path() -> String {
    #[cfg(windows)]
    {
        String::new()
    }
    #[cfg(not(windows))]
    {
        "/".to_string()
    }
}

/// Platform-default root listing. Unix: read `/` and apply the same
/// hidden-entries filter the normal handler uses. Windows: probe each
/// drive letter A–Z via `tokio::fs::metadata` and return the accessible
/// ones as lowercase `c:`, `d:`, … directory entries.
async fn platform_root_entries() -> Result<Vec<BrowseEntry>, (StatusCode, String)> {
    #[cfg(windows)]
    {
        let mut entries = Vec::new();
        for letter in b'A'..=b'Z' {
            let drive_root = format!("{}:\\", letter as char);
            if tokio::fs::metadata(&drive_root).await.is_ok() {
                entries.push(BrowseEntry {
                    name: format!("{}:", (letter as char).to_ascii_lowercase()),
                    entry_type: "directory".into(),
                });
            }
        }
        Ok(entries)
    }
    #[cfg(not(windows))]
    {
        let mut entries = Vec::new();
        let mut dir = tokio::fs::read_dir("/").await.map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Cannot read /: {e}"),
            )
        })?;
        while let Ok(Some(entry)) = dir.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let file_type = entry
                .file_type()
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            entries.push(BrowseEntry {
                name,
                entry_type: if file_type.is_dir() {
                    "directory".into()
                } else {
                    "file".into()
                },
            });
        }
        Ok(entries)
    }
}

pub async fn browse_handler(
    State(state): State<AppState>,
    Query(query): Query<BrowseQuery>,
) -> Result<Json<BrowseResponse>, (StatusCode, String)> {
    // Empty or absent path → return the platform root (synthetic drives
    // list on Windows, `/` listing on Unix). Skip the `data_dir` check
    // here: the root itself is never under `data_dir`, but every entry
    // the user clicks into is canonicalized + checked normally below.
    let raw_path = query.path.as_deref().unwrap_or("");
    if raw_path.is_empty() {
        let mut entries = platform_root_entries().await?;
        sort_entries(&mut entries);
        return Ok(Json(BrowseResponse {
            path: platform_root_path(),
            entries,
        }));
    }

    let path = PathBuf::from(raw_path);

    let canonical = tokio::fs::canonicalize(&path)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid path: {e}")))?;

    // Constrain to data_dir if set. Segment-aware `starts_with` on the
    // canonicalized `PathBuf`s — UNC-vs-non-UNC mismatch can't happen
    // because both sides go through `canonicalize`.
    if let Some(root) = &state.data_dir {
        let canonical_root = tokio::fs::canonicalize(root).await.map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Invalid data-dir: {e}"),
            )
        })?;
        if !canonical.starts_with(&canonical_root) {
            return Err((StatusCode::FORBIDDEN, "Path outside data directory".into()));
        }
    }

    let mut entries = Vec::new();
    let mut dir = tokio::fs::read_dir(&canonical)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, format!("Cannot read directory: {e}")))?;

    while let Ok(Some(entry)) = dir.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let file_type = entry
            .file_type()
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        entries.push(BrowseEntry {
            name,
            entry_type: if file_type.is_dir() {
                "directory".into()
            } else {
                "file".into()
            },
        });
    }

    sort_entries(&mut entries);

    Ok(Json(BrowseResponse {
        path: canonical_display_form(&canonical),
        entries,
    }))
}

/// Sort: directories first, then alphabetically within each group.
fn sort_entries(entries: &mut [BrowseEntry]) {
    entries.sort_by(|a, b| {
        let a_dir = a.entry_type == "directory";
        let b_dir = b.entry_type == "directory";
        b_dir.cmp(&a_dir).then(a.name.cmp(&b.name))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::sync::atomic::AtomicU64;
    use tokio::sync::{Mutex, broadcast};

    use crate::session::Session;
    use crate::{BroadcastItem, ProxyConfig};

    /// Minimal `AppState` for tests that don't need real proxy infra,
    /// real sessions, or a real data-dir. Only the `data_dir` field is
    /// inspected by `browse_handler`; the proxy cache paths are never
    /// touched in browse tests, so we hand it stub paths. Mirrors the
    /// field set in `main::main`.
    fn test_state(data_dir: Option<PathBuf>) -> AppState {
        let proxy_config = ProxyConfig {
            cache_dir: PathBuf::from("/tmp/lucida-browse-test-proxy"),
            legacy_proxy_enabled: false,
            concurrency: 1,
            generated_enabled: false,
            generated_cache_dir: PathBuf::from("/tmp/lucida-browse-test-generated"),
            generated_concurrency: 1,
            generated_background_chunk_limit: 1,
            generated_target_long_axis: 512,
            generated_chunk_long_axis: 256,
            generated_max_chunk_bytes: 2 * 1024 * 1024,
            generated_disk_budget_bytes: None,
        };
        let (tx, _) = broadcast::channel::<BroadcastItem>(8);
        AppState {
            session: Arc::new(Mutex::new(Session::new())),
            tx,
            next_id: Arc::new(AtomicU64::new(0)),
            unicast_routes: Arc::new(Mutex::new(HashMap::new())),
            data_dir,
            proxy_config,
        }
    }

    // Unix-style inputs work everywhere — passthrough.
    #[test]
    fn canonical_display_form_unix_passthrough() {
        let p = PathBuf::from("/foo/bar");
        let out = canonical_display_form(&p);
        // On Unix this is exactly the input. On Windows, `PathBuf::from`
        // keeps forward slashes verbatim — there's no drive letter or
        // `\\?\` prefix to rewrite, so the only transform is the
        // backslash→forward-slash replace, which is a no-op here.
        assert_eq!(out, "/foo/bar");
    }

    #[cfg(windows)]
    #[test]
    fn canonical_display_form_windows_verbatim_drive() {
        let p = PathBuf::from(r"\\?\C:\Users\me");
        assert_eq!(canonical_display_form(&p), "c:/Users/me");
    }

    #[cfg(windows)]
    #[test]
    fn canonical_display_form_windows_verbatim_unc() {
        let p = PathBuf::from(r"\\?\UNC\server\share\foo");
        assert_eq!(canonical_display_form(&p), "//server/share/foo");
    }

    #[cfg(windows)]
    #[test]
    fn canonical_display_form_windows_plain_drive() {
        let p = PathBuf::from(r"C:\Users\me");
        assert_eq!(canonical_display_form(&p), "c:/Users/me");
    }

    #[cfg(windows)]
    #[test]
    fn canonical_display_form_windows_already_lowercase_drive() {
        // Idempotent on an already-display-form input.
        let p = PathBuf::from("c:/Users/me");
        assert_eq!(canonical_display_form(&p), "c:/Users/me");
    }

    #[cfg(windows)]
    #[test]
    fn canonical_display_form_windows_plain_unc() {
        let p = PathBuf::from(r"\\server\share\foo");
        assert_eq!(canonical_display_form(&p), "//server/share/foo");
    }

    // Empty-path branch returns a non-empty entries list on Linux CI
    // (the listing of `/`). The Windows drives-list branch is verified
    // manually by the author.
    #[tokio::test]
    async fn browse_handler_empty_path_returns_platform_root() {
        let state = test_state(None);
        let resp = browse_handler(State(state), Query(BrowseQuery { path: None }))
            .await
            .expect("empty-path browse should succeed");
        let body = resp.0;
        #[cfg(not(windows))]
        {
            assert_eq!(body.path, "/", "Unix platform root path should be `/`");
            assert!(
                !body.entries.is_empty(),
                "Unix `/` listing should not be empty on a real filesystem; got {:?}",
                body.entries,
            );
        }
        #[cfg(windows)]
        {
            assert_eq!(
                body.path, "",
                "Windows platform root path should be empty (synthetic drives sentinel)",
            );
            // At least the C: drive should exist on any sensible
            // Windows host running tests.
            assert!(
                !body.entries.is_empty(),
                "Windows drives list should not be empty; got {:?}",
                body.entries,
            );
            assert!(
                body.entries.iter().all(|e| e.entry_type == "directory"),
                "all drive entries should be directory-typed",
            );
        }
    }

    #[tokio::test]
    async fn browse_handler_empty_string_path_treated_as_root() {
        // Same as `None` — the SPA can send either shape.
        let state = test_state(None);
        let resp = browse_handler(
            State(state),
            Query(BrowseQuery {
                path: Some(String::new()),
            }),
        )
        .await
        .expect("empty-string path should also return platform root");
        let body = resp.0;
        #[cfg(not(windows))]
        assert_eq!(body.path, "/");
        #[cfg(windows)]
        assert_eq!(body.path, "");
    }
}
