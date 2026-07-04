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
    DatasetOpenStage, DatasetOpenSuccessDiagnostic, DatasetOpened,
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
