use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LayoutValidationIssue {
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LayoutValidationReport {
    pub source_id: String,
    pub generation_seq: u64,
    pub generation_root: String,
    pub valid: bool,
    pub issues: Vec<LayoutValidationIssue>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LayoutValidationError {
    InvalidInput { message: String },
}

pub fn validate_generation_layout(
    cache_root: impl AsRef<Path>,
    source_id: &str,
    generation_seq: u64,
) -> Result<LayoutValidationReport, LayoutValidationError> {
    if source_id.is_empty() {
        return Err(LayoutValidationError::InvalidInput {
            message: "source_id must not be empty".to_owned(),
        });
    }
    if generation_seq == 0 {
        return Err(LayoutValidationError::InvalidInput {
            message: "generation_seq must be > 0".to_owned(),
        });
    }

    let generation_root = cache_root
        .as_ref()
        .join(source_id)
        .join(format!("gen_{generation_seq:08}"));
    let mut issues = Vec::new();

    check_required_file(
        &mut issues,
        generation_root.join("canonical.ome.zarr").join(".zattrs"),
        "canonical.ome.zarr/.zattrs is required",
    );
    check_required_file(
        &mut issues,
        generation_root
            .join("canonical.ome.zarr")
            .join("0")
            .join(".zarray"),
        "canonical.ome.zarr/0/.zarray is required",
    );
    check_required_file(
        &mut issues,
        generation_root.join("tile2d").join("manifest.json"),
        "tile2d/manifest.json is required",
    );
    check_required_preview(&mut issues, &generation_root.join("preview2d"));
    check_tile_payloads(&mut issues, &generation_root.join("tile2d"));
    check_optional_brick_layout(&mut issues, &generation_root.join("brick3d"));

    let valid = issues.iter().all(|issue| issue.level != "error");
    Ok(LayoutValidationReport {
        source_id: source_id.to_owned(),
        generation_seq,
        generation_root: generation_root.display().to_string(),
        valid,
        issues,
    })
}

fn check_required_file(issues: &mut Vec<LayoutValidationIssue>, path: PathBuf, message: &str) {
    if !path.exists() {
        issues.push(LayoutValidationIssue {
            level: "error".to_owned(),
            message: format!("{message}: {}", path.display()),
        });
    }
}

fn check_required_preview(issues: &mut Vec<LayoutValidationIssue>, preview_root: &Path) {
    if !preview_root.exists() {
        issues.push(LayoutValidationIssue {
            level: "error".to_owned(),
            message: format!(
                "preview2d directory is required: {}",
                preview_root.display()
            ),
        });
        return;
    }

    let mut found_preview = false;
    if let Ok(entries) = fs::read_dir(preview_root) {
        for entry in entries.flatten() {
            if entry
                .path()
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("lod_") && name.ends_with(".pgm"))
            {
                found_preview = true;
                break;
            }
        }
    }
    if !found_preview {
        issues.push(LayoutValidationIssue {
            level: "error".to_owned(),
            message: format!(
                "preview2d must contain at least one lod_*.pgm payload: {}",
                preview_root.display()
            ),
        });
    }
}

fn check_tile_payloads(issues: &mut Vec<LayoutValidationIssue>, tile_root: &Path) {
    if !tile_root.exists() {
        issues.push(LayoutValidationIssue {
            level: "error".to_owned(),
            message: format!("tile2d directory is required: {}", tile_root.display()),
        });
        return;
    }

    let mut found_tile_payload = false;
    let mut pending = vec![tile_root.to_path_buf()];
    while let Some(path) = pending.pop() {
        let Ok(entries) = fs::read_dir(&path) else {
            continue;
        };
        for entry in entries.flatten() {
            let entry_path = entry.path();
            if entry_path.is_dir() {
                pending.push(entry_path);
                continue;
            }
            if entry_path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext == "tileblk")
            {
                found_tile_payload = true;
                break;
            }
        }
        if found_tile_payload {
            break;
        }
    }

    if !found_tile_payload {
        issues.push(LayoutValidationIssue {
            level: "error".to_owned(),
            message: format!(
                "tile2d layout must include at least one .tileblk payload: {}",
                tile_root.display()
            ),
        });
    }
}

fn check_optional_brick_layout(issues: &mut Vec<LayoutValidationIssue>, brick_root: &Path) {
    if !brick_root.exists() {
        issues.push(LayoutValidationIssue {
            level: "warning".to_owned(),
            message: format!(
                "brick3d directory is absent (allowed before first 3D demand): {}",
                brick_root.display()
            ),
        });
        return;
    }
    let manifest_path = brick_root.join("manifest.json");
    if !manifest_path.exists() {
        issues.push(LayoutValidationIssue {
            level: "warning".to_owned(),
            message: format!(
                "brick3d manifest is missing; lazy build may be incomplete: {}",
                manifest_path.display()
            ),
        });
    }
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::validate_generation_layout;

    fn unique_path(prefix: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "lucida_luc305_{prefix}_{}_{}",
            std::process::id(),
            nanos
        ))
    }

    #[test]
    fn report_marks_invalid_when_required_files_missing() {
        let root = unique_path("invalid");
        std::fs::create_dir_all(root.join("src_00000001").join("gen_00000001"))
            .expect("fixture root creation should succeed");
        let report = validate_generation_layout(&root, "src_00000001", 1)
            .expect("validation should succeed");
        assert!(!report.valid);
        assert!(report.issues.iter().any(|issue| issue.level == "error"));
        std::fs::remove_dir_all(root).expect("fixture cleanup should succeed");
    }
}
