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
    DatasetOpenStage, DatasetOpenSuccessDiagnostic, DatasetOpened, DatasetOpenedValidationCategory,
    DatasetOpenedValidationError, FailureDescriptor,
};

use crate::source_policy::{SourcePolicyCategory, SourcePolicyError};

pub(crate) fn open_failure(
    stage: DatasetOpenStage,
    kind: DatasetOpenFailureKind,
    retryable: bool,
    message: impl Into<String>,
    detail: Option<String>,
) -> DatasetOpenFailureDiagnostic {
    DatasetOpenFailureDiagnostic {
        stage,
        failure: FailureDescriptor::new(kind, retryable),
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
    DatasetOpenFailureDiagnostic {
        stage: DatasetOpenStage::BackendOpen,
        failure: error.failure(),
        message: error.public_message(),
        detail: None,
    }
}

/// Map source admission failures into the same stable diagnostic vocabulary
/// used by both interactive opens and workspace restore. Policy messages are
/// intentionally locator-free, so they are safe to surface to clients.
pub(crate) fn source_policy_failure(error: &SourcePolicyError) -> DatasetOpenFailureDiagnostic {
    let (stage, kind, retryable) = match error.category {
        SourcePolicyCategory::SchemeDenied => (
            DatasetOpenStage::BackendOpen,
            DatasetOpenFailureKind::UnsupportedScheme,
            false,
        ),
        SourcePolicyCategory::InvalidLocator => (
            DatasetOpenStage::BackendOpen,
            DatasetOpenFailureKind::InvalidLocator,
            false,
        ),
        SourcePolicyCategory::LocalRootDenied | SourcePolicyCategory::NetworkTargetDenied => (
            DatasetOpenStage::Authorization,
            DatasetOpenFailureKind::Permission,
            false,
        ),
        SourcePolicyCategory::CloudScopeDenied => (
            DatasetOpenStage::Authorization,
            DatasetOpenFailureKind::CloudConfiguration,
            false,
        ),
        SourcePolicyCategory::ResolutionFailed => (
            DatasetOpenStage::BackendOpen,
            DatasetOpenFailureKind::Http,
            true,
        ),
    };
    open_failure(
        stage,
        kind,
        retryable,
        "dataset source was rejected by server policy",
        Some(error.to_string()),
    )
}

pub(crate) fn import_failure(
    error: &lucida_store::backend::StoreError,
) -> DatasetOpenFailureDiagnostic {
    DatasetOpenFailureDiagnostic {
        stage: DatasetOpenStage::MetadataImport,
        failure: error.failure(),
        message: error.public_message(),
        detail: None,
    }
}

pub(crate) fn dataset_opened_validation_failure(
    error: &DatasetOpenedValidationError,
) -> DatasetOpenFailureDiagnostic {
    let kind = match error.category {
        DatasetOpenedValidationCategory::UnsafePath => DatasetOpenFailureKind::InvalidLocator,
        DatasetOpenedValidationCategory::ResourceLimit => DatasetOpenFailureKind::ResourceLimit,
        DatasetOpenedValidationCategory::Manifest
        | DatasetOpenedValidationCategory::Duplicate
        | DatasetOpenedValidationCategory::Missing
        | DatasetOpenedValidationCategory::Unexpected
        | DatasetOpenedValidationCategory::Inconsistent
        | DatasetOpenedValidationCategory::Unsupported => DatasetOpenFailureKind::MalformedMetadata,
    };
    open_failure(
        DatasetOpenStage::BindingBuild,
        kind,
        false,
        "dataset binding failed admission validation",
        Some(format!("{}: {}", error.path, error.message)),
    )
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
        for error in [&denied, &unauthenticated] {
            let failure = lucida_store::backend::object_store_failure(error);
            assert_eq!(failure.kind, lucida_protocol::FailureCode::Permission);
            assert!(!failure.retryable);
        }
    }

    #[test]
    fn other_store_errors_report_unavailable() {
        let generic = object_store::Error::Generic {
            store: "test",
            source: boxed("503 Service Unavailable"),
        };
        let failure = lucida_store::backend::object_store_failure(&generic);
        assert_eq!(failure.kind, lucida_protocol::FailureCode::StorageBackend);
        assert!(failure.retryable);
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
        let denied_failure = lucida_store::backend::object_store_failure(&denied);
        assert_eq!(
            denied_failure.kind,
            lucida_protocol::FailureCode::Permission
        );
        assert!(!denied_failure.retryable);

        let other = object_store::Error::Generic {
            store: "source",
            source: boxed("503 Service Unavailable"),
        };
        assert!(!is_not_found(&other));
        assert!(lucida_store::backend::object_store_failure(&other).retryable);
    }
}
