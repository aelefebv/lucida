//! `/api/browse` — filesystem listing for the SPA's FileBrowser modal.
//!
//! Empty-path browsing starts at the operator-configured dataset root, never
//! the host filesystem root. Every explicit path is admitted by the same
//! process-wide source policy used for direct opens and workspace restore.
//! Canonicalization and root containment therefore cannot drift between the
//! discovery and open paths.

use std::path::Path;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::Json;
use serde::{Deserialize, Serialize};

use crate::AppState;

#[derive(Deserialize)]
pub struct BrowseQuery {
    /// Absent or empty means the configured dataset root. Any non-empty value
    /// is canonicalized and admitted against that same root policy.
    path: Option<String>,
}

#[derive(Serialize, Debug)]
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

pub async fn browse_handler(
    State(state): State<AppState>,
    Query(query): Query<BrowseQuery>,
) -> Result<Json<BrowseResponse>, (StatusCode, String)> {
    let raw_path = query.path.as_deref().unwrap_or("");
    let canonical = if raw_path.is_empty() {
        state
            .dataset_runtime
            .source_policy
            .local_roots()
            .first()
            .cloned()
            .ok_or((
                StatusCode::FORBIDDEN,
                "Local dataset browsing is disabled".to_string(),
            ))?
    } else {
        state
            .dataset_runtime
            .source_policy
            .admit_local_path(Path::new(raw_path))
            .await
            .map_err(|error| {
                let status = match error.category {
                    crate::source_policy::SourcePolicyCategory::LocalRootDenied => {
                        StatusCode::FORBIDDEN
                    }
                    _ => StatusCode::BAD_REQUEST,
                };
                (status, error.to_string())
            })?
    };

    let mut entries = Vec::new();
    let mut dir = tokio::fs::read_dir(&canonical).await.map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            "Dataset directory is unavailable".to_string(),
        )
    })?;

    while let Ok(Some(entry)) = dir.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let file_type = entry.file_type().await.map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Dataset directory entry is unavailable".to_string(),
            )
        })?;
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
    use crate::DatasetRuntimeConfig;
    use std::path::PathBuf;
    use std::sync::Arc;

    /// Minimal `AppState` for tests that don't need real generated-coarse
    /// infrastructure or sessions. Browse itself only reaches source policy.
    fn test_state(data_dir: Option<PathBuf>) -> AppState {
        let source_policy = match data_dir.as_ref() {
            Some(root) => crate::source_policy::SourceTrustPolicy::from_config(
                crate::source_policy::SourceTrustConfig {
                    local_roots: vec![root.clone()],
                    ..crate::source_policy::SourceTrustConfig::default()
                },
            )
            .unwrap(),
            None => crate::source_policy::SourceTrustPolicy::deny_all(),
        };
        let dataset_runtime = DatasetRuntimeConfig {
            source_policy: Arc::new(source_policy),
            source_cache: lucida_store::cache::SharedObjectCache::new(1024 * 1024, 1024 * 1024),
            generated_enabled: false,
            generated_cache_dir: PathBuf::from("/tmp/lucida-browse-test-generated"),
            legacy_proxy_cache_dir: PathBuf::from("/tmp/lucida-browse-test-proxies"),
            generated_concurrency: 1,
            generated_background_chunk_limit: 1,
            generated_target_long_axis: 512,
            generated_chunk_long_axis: 256,
            generated_max_chunk_bytes: 2 * 1024 * 1024,
            generated_disk_budget_bytes: crate::DEFAULT_GENERATED_DISK_BUDGET_BYTES,
        };
        AppState {
            data_dir,
            dataset_runtime,
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

    #[tokio::test]
    async fn browse_handler_empty_path_returns_configured_root() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("dataset.zarr")).unwrap();
        let state = test_state(Some(root.path().to_path_buf()));
        let resp = browse_handler(State(state), Query(BrowseQuery { path: None }))
            .await
            .expect("empty-path browse should succeed");
        let body = resp.0;
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        assert_eq!(body.path, canonical_display_form(&canonical_root));
        assert_eq!(body.entries.len(), 1);
        assert_eq!(body.entries[0].name, "dataset.zarr");
    }

    #[tokio::test]
    async fn browse_handler_without_configured_root_is_forbidden() {
        let state = test_state(None);
        let error = browse_handler(State(state), Query(BrowseQuery { path: None }))
            .await
            .unwrap_err();
        assert_eq!(error.0, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn browse_handler_rejects_escape_without_echoing_path() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let outside_text = outside.path().to_string_lossy().to_string();
        let state = test_state(Some(root.path().to_path_buf()));
        let error = browse_handler(
            State(state),
            Query(BrowseQuery {
                path: Some(outside_text.clone()),
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, StatusCode::FORBIDDEN);
        assert!(!error.1.contains(&outside_text));
    }
}
