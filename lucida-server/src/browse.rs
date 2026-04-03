use std::path::PathBuf;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::Json;
use serde::{Deserialize, Serialize};

use crate::AppState;

#[derive(Deserialize)]
pub struct BrowseQuery {
    path: String,
}

#[derive(Serialize)]
pub struct BrowseResponse {
    path: String,
    entries: Vec<BrowseEntry>,
}

#[derive(Serialize)]
pub struct BrowseEntry {
    name: String,
    #[serde(rename = "type")]
    entry_type: String,
}

pub async fn browse_handler(
    State(state): State<AppState>,
    Query(query): Query<BrowseQuery>,
) -> Result<Json<BrowseResponse>, (StatusCode, String)> {
    let path = PathBuf::from(&query.path);

    let canonical = tokio::fs::canonicalize(&path)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid path: {e}")))?;

    // Constrain to data_dir if set.
    if let Some(root) = &state.data_dir {
        let canonical_root = tokio::fs::canonicalize(root)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Invalid data-dir: {e}")))?;
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

    // Sort: directories first, then alphabetically within each group.
    entries.sort_by(|a, b| {
        let a_dir = a.entry_type == "directory";
        let b_dir = b.entry_type == "directory";
        b_dir.cmp(&a_dir).then(a.name.cmp(&b.name))
    });

    Ok(Json(BrowseResponse {
        path: canonical.to_string_lossy().to_string(),
        entries,
    }))
}
