//! Classification of dataset-open failures into the wire diagnostic
//! vocabulary (`DatasetOpenFailureDiagnostic` and friends).
//!
//! A leaf module shared by the interactive open orchestration
//! ([`crate::dataset_open`]), the workspace binding restore
//! ([`crate::binding_restore`]), and the websocket layer's own denial
//! messages, so every path triages the same underlying error into the
//! same stage / kind / retryable shape. These shapes are wire-visible
//! (the fixtures pin them), so changes here are protocol changes.

use lucida_content::DatasetId;
use lucida_content::url::is_local_dataset_url;
use lucida_protocol::{
    DatasetOpenFailureDiagnostic, DatasetOpenFailureKind, DatasetOpenProgressDiagnostic,
    DatasetOpenStage, DatasetOpenSuccessDiagnostic, DatasetOpened, SourceChunkStatus,
};

pub(crate) fn open_failure(
    stage: DatasetOpenStage,
    kind: DatasetOpenFailureKind,
    retryable: bool,
    message: impl Into<String>,
    detail: Option<String>,
) -> DatasetOpenFailureDiagnostic {
    DatasetOpenFailureDiagnostic {
        stage,
        kind,
        retryable,
        message: message.into(),
        detail,
    }
}

pub(crate) fn open_progress(
    stage: DatasetOpenStage,
    message: impl Into<String>,
    workspace_dataset_id: Option<DatasetId>,
    dataset_source_id: Option<String>,
    detail: Option<String>,
) -> DatasetOpenProgressDiagnostic {
    DatasetOpenProgressDiagnostic {
        stage,
        message: message.into(),
        workspace_dataset_id,
        dataset_source_id,
        detail,
        warning: false,
    }
}

/// An [`open_progress`] entry flagged as a non-fatal problem (an import
/// warning), so clients can surface it durably instead of treating it as a
/// transient stage transition.
pub(crate) fn open_warning(
    stage: DatasetOpenStage,
    message: impl Into<String>,
    workspace_dataset_id: Option<DatasetId>,
    dataset_source_id: Option<String>,
    detail: Option<String>,
) -> DatasetOpenProgressDiagnostic {
    DatasetOpenProgressDiagnostic {
        warning: true,
        ..open_progress(
            stage,
            message,
            workspace_dataset_id,
            dataset_source_id,
            detail,
        )
    }
}

pub(crate) fn backend_open_failure(
    error: &lucida_store::backend::StoreError,
) -> DatasetOpenFailureDiagnostic {
    match error {
        lucida_store::backend::StoreError::UnsupportedScheme(_) => open_failure(
            DatasetOpenStage::BackendOpen,
            DatasetOpenFailureKind::UnsupportedScheme,
            false,
            error.to_string(),
            None,
        ),
        lucida_store::backend::StoreError::Metadata(message) => {
            let lower = message.to_ascii_lowercase();
            let kind = if lower.contains("bucket") || lower.contains("credential") {
                DatasetOpenFailureKind::CloudConfiguration
            } else {
                DatasetOpenFailureKind::MissingMetadata
            };
            open_failure(
                DatasetOpenStage::BackendOpen,
                kind,
                false,
                error.to_string(),
                None,
            )
        }
        lucida_store::backend::StoreError::ObjectStore(inner) => {
            let message = inner.to_string();
            let lower = message.to_ascii_lowercase();
            let (kind, retryable) = if is_not_found(inner) {
                (DatasetOpenFailureKind::MissingObject, false)
            } else if lower.contains("canonical")
                || lower.contains("no such file")
                || lower.contains("not a directory")
            {
                (DatasetOpenFailureKind::LocalPath, false)
            } else if lower.contains("permission")
                || lower.contains("forbidden")
                || lower.contains("unauthorized")
                || lower.contains("denied")
            {
                (DatasetOpenFailureKind::Permission, false)
            } else if lower.contains("credential")
                || lower.contains("token")
                || lower.contains("region")
                || lower.contains("bucket")
            {
                (DatasetOpenFailureKind::CloudConfiguration, false)
            } else if lower.contains("http") || lower.contains("status") {
                (DatasetOpenFailureKind::Http, true)
            } else {
                (DatasetOpenFailureKind::StorageBackend, true)
            };
            open_failure(
                DatasetOpenStage::BackendOpen,
                kind,
                retryable,
                format!("storage error: {message}"),
                None,
            )
        }
    }
}

pub(crate) fn import_failure(error: &dyn std::fmt::Display) -> DatasetOpenFailureDiagnostic {
    let message = error.to_string();
    let lower = message.to_ascii_lowercase();
    let kind = if lower.contains("codec")
        || lower.contains("blosc")
        || lower.contains("cname")
        || lower.contains("compressor")
    {
        DatasetOpenFailureKind::UnsupportedCodec
    } else if lower.contains("chunk")
        || lower.contains("axis")
        || lower.contains("non-prefix")
        || lower.contains("layout")
    {
        DatasetOpenFailureKind::UnsupportedLayout
    } else if lower.contains("missing") || lower.contains("not found") {
        DatasetOpenFailureKind::MissingMetadata
    } else if lower.contains("json")
        || lower.contains("metadata")
        || lower.contains("multiscale")
        || lower.contains("malformed")
    {
        DatasetOpenFailureKind::MalformedMetadata
    } else {
        DatasetOpenFailureKind::Import
    };
    open_failure(DatasetOpenStage::MetadataImport, kind, false, message, None)
}

pub(crate) fn open_success(
    url: &str,
    opened: &DatasetOpened,
    dataset_source_id: Option<String>,
) -> DatasetOpenSuccessDiagnostic {
    DatasetOpenSuccessDiagnostic {
        stage: DatasetOpenStage::Complete,
        source_url: url.to_string(),
        workspace_dataset_id: opened.manifest.dataset_id.clone(),
        dataset_source_id,
        message: "dataset opened and broadcast".to_string(),
    }
}

/// What one dataset open's metadata reads cost, taken as the difference of
/// two [`lucida_store::cache::CacheStats`] snapshots around the import.
///
/// The import reads through the same `CachedStore` the chunk path uses, so
/// the cache's own counters already observe it; this is the per-open slice of
/// those counters, which is the number an operator wants when asking why an
/// open took seconds. Both open paths report it — the interactive open on the
/// progress trail the CLI and the web's open view render, the workspace
/// restore in its log line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct MetadataReadCost {
    /// Backend round trips performed during the import.
    pub reads: u64,
    /// Reads the cache served without touching the backend.
    pub hits: u64,
    /// Cumulative time in those round trips, including queueing behind the
    /// source-read cap. Reads overlap, so this exceeds elapsed wall time.
    pub read_millis: u64,
}

impl MetadataReadCost {
    pub fn between(
        before: &lucida_store::cache::CacheStats,
        after: &lucida_store::cache::CacheStats,
    ) -> Self {
        MetadataReadCost {
            reads: after.source_reads.saturating_sub(before.source_reads),
            hits: after.hits.saturating_sub(before.hits),
            read_millis: after
                .source_read_millis
                .saturating_sub(before.source_read_millis),
        }
    }

    /// One-line form for the open trail and the log.
    pub fn summary(&self) -> String {
        format!(
            "metadata reads: {} ({} ms in backend reads, {} served from cache)",
            self.reads, self.read_millis, self.hits
        )
    }
}

pub(crate) fn backend_kind_for_url(url: &str) -> String {
    if is_local_dataset_url(url) {
        "local".to_string()
    } else if url.starts_with("gs://") {
        "gcs".to_string()
    } else if url.starts_with("s3://") {
        "s3".to_string()
    } else if url.starts_with("http://") || url.starts_with("https://") {
        "http".to_string()
    } else {
        "unknown".to_string()
    }
}

pub(crate) fn is_not_found(error: &object_store::Error) -> bool {
    matches!(error, object_store::Error::NotFound { .. })
        || error.to_string().contains("not found")
        || error.to_string().contains("No such file or directory")
}

/// Triage a non-not-found store error from a source-chunk read into the
/// wire status vocabulary. Permission/credential rejections are permanent
/// (the store answered; retrying without operator action cannot succeed);
/// everything else — backend faults, unreachable services — reports the
/// source as unavailable. Callers must handle not-found before calling
/// this: a missing chunk is legitimate sparse data, not a failure.
pub(crate) fn store_error_status(error: &object_store::Error) -> SourceChunkStatus {
    match error {
        object_store::Error::PermissionDenied { .. }
        | object_store::Error::Unauthenticated { .. } => SourceChunkStatus::FailedPermanent,
        _ => SourceChunkStatus::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn boxed(message: &str) -> Box<dyn std::error::Error + Send + Sync> {
        message.to_string().into()
    }

    #[test]
    fn permission_class_store_errors_are_permanent() {
        let denied = object_store::Error::PermissionDenied {
            path: "chunk".into(),
            source: boxed("403 Forbidden"),
        };
        let unauthenticated = object_store::Error::Unauthenticated {
            path: "chunk".into(),
            source: boxed("credentials expired"),
        };
        assert_eq!(
            store_error_status(&denied),
            SourceChunkStatus::FailedPermanent
        );
        assert_eq!(
            store_error_status(&unauthenticated),
            SourceChunkStatus::FailedPermanent
        );
    }

    #[test]
    fn other_store_errors_report_unavailable() {
        let generic = object_store::Error::Generic {
            store: "test",
            source: boxed("503 Service Unavailable"),
        };
        assert_eq!(store_error_status(&generic), SourceChunkStatus::Unavailable);
    }

    #[test]
    fn metadata_read_cost_is_the_per_open_slice_of_the_cache_counters() {
        // The cache is process-lived and shared with the chunk path, so the
        // per-open cost must be a difference of snapshots, never the absolute
        // counters — otherwise a second open would report the first one's
        // reads on top of its own.
        let before = lucida_store::cache::CacheStats {
            max_bytes: 1024,
            current_bytes: 10,
            entry_count: 1,
            hits: 4,
            misses: 7,
            evictions: 0,
            backend_errors: 0,
            coalesced: 0,
            source_reads: 7,
            source_read_millis: 900,
        };
        let after = lucida_store::cache::CacheStats {
            hits: 9,
            misses: 20,
            source_reads: 20,
            source_read_millis: 3_400,
            ..before.clone()
        };

        let cost = MetadataReadCost::between(&before, &after);
        assert_eq!(cost.reads, 13);
        assert_eq!(cost.hits, 5);
        assert_eq!(cost.read_millis, 2_500);
        assert_eq!(
            cost.summary(),
            "metadata reads: 13 (2500 ms in backend reads, 5 served from cache)"
        );

        // A repeat open that reads nothing new reports zero, not a negative
        // wrap-around.
        assert_eq!(
            MetadataReadCost::between(&after, &before),
            MetadataReadCost::default()
        );
    }

    #[test]
    fn reconstructed_follower_errors_classify_like_their_leader() {
        // A single-flight follower reconstructs a coalesced failure carrying
        // the leader's error *variant* but an empty path (the real path lives
        // in the preserved message). Both classifiers must key off the variant
        // so a follower triages identically to the leader that produced it —
        // otherwise a coalesced 403 could self-heal into a retry storm, or a
        // coalesced 404 could look like a hard failure instead of sparse data.
        let not_found = object_store::Error::NotFound {
            path: String::new(),
            source: boxed("object at gs://bucket/chunk not found"),
        };
        // Recognized by variant, not a fragile message substring.
        assert!(is_not_found(&not_found));

        let denied = object_store::Error::PermissionDenied {
            path: String::new(),
            source: boxed("403 Forbidden"),
        };
        assert!(!is_not_found(&denied));
        assert_eq!(
            store_error_status(&denied),
            SourceChunkStatus::FailedPermanent
        );

        let other = object_store::Error::Generic {
            store: "source",
            source: boxed("503 Service Unavailable"),
        };
        assert!(!is_not_found(&other));
        assert_eq!(store_error_status(&other), SourceChunkStatus::Unavailable);
    }
}
