use lucida_content::DatasetId;
use serde::{Deserialize, Serialize};

use crate::generated_coarse::GeneratedChunkStatus;

/// Stable, transport-independent failure domains shared by dataset opens,
/// source-chunk reads, generated chunks, and client adapters.
///
/// Human-readable messages are deliberately not part of classification. A
/// client may localize or replace a message without changing the category,
/// code, or retry decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureCategory {
    Source,
    Schema,
    Codec,
    Bounds,
    Authorization,
    Protocol,
    Persistence,
    Internal,
}

/// Exhaustive stable code vocabulary for terminal data-path failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureCode {
    Authorization,
    SessionClosed,
    WorkspaceLookup,
    UnsupportedScheme,
    InvalidLocator,
    LocalPath,
    MissingObject,
    Permission,
    CloudConfiguration,
    Http,
    StorageBackend,
    UnsupportedCodec,
    DecodeFailure,
    UnsupportedLayout,
    ChunkOutOfBounds,
    ResourceLimit,
    MalformedMetadata,
    MissingMetadata,
    Import,
    UnknownDataset,
    UnknownImage,
    MissingChunkMetadata,
    InvalidChunkKey,
    Protocol,
    Persistence,
    Internal,
}

impl FailureCode {
    pub const ALL: [Self; 26] = [
        Self::Authorization,
        Self::SessionClosed,
        Self::WorkspaceLookup,
        Self::UnsupportedScheme,
        Self::InvalidLocator,
        Self::LocalPath,
        Self::MissingObject,
        Self::Permission,
        Self::CloudConfiguration,
        Self::Http,
        Self::StorageBackend,
        Self::UnsupportedCodec,
        Self::DecodeFailure,
        Self::UnsupportedLayout,
        Self::ChunkOutOfBounds,
        Self::ResourceLimit,
        Self::MalformedMetadata,
        Self::MissingMetadata,
        Self::Import,
        Self::UnknownDataset,
        Self::UnknownImage,
        Self::MissingChunkMetadata,
        Self::InvalidChunkKey,
        Self::Protocol,
        Self::Persistence,
        Self::Internal,
    ];

    pub const fn category(self) -> FailureCategory {
        match self {
            Self::UnsupportedScheme
            | Self::InvalidLocator
            | Self::LocalPath
            | Self::MissingObject
            | Self::CloudConfiguration
            | Self::Http
            | Self::StorageBackend
            | Self::UnknownDataset => FailureCategory::Source,
            Self::MalformedMetadata
            | Self::MissingMetadata
            | Self::Import
            | Self::UnknownImage
            | Self::MissingChunkMetadata => FailureCategory::Schema,
            Self::UnsupportedCodec | Self::DecodeFailure => FailureCategory::Codec,
            Self::UnsupportedLayout | Self::ChunkOutOfBounds | Self::ResourceLimit => {
                FailureCategory::Bounds
            }
            Self::Authorization | Self::Permission => FailureCategory::Authorization,
            Self::SessionClosed | Self::InvalidChunkKey | Self::Protocol => {
                FailureCategory::Protocol
            }
            Self::WorkspaceLookup | Self::Persistence => FailureCategory::Persistence,
            Self::Internal => FailureCategory::Internal,
        }
    }
}

/// Machine-readable portion of a terminal failure. This is flattened into
/// every failure response so all clients receive exactly the same three
/// fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FailureDescriptor {
    pub category: FailureCategory,
    /// Rust retains the historical `kind` field name for source compatibility;
    /// the stable wire field is `code`. Old `kind` payloads remain readable.
    #[serde(rename = "code", alias = "kind")]
    pub kind: FailureCode,
    pub retryable: bool,
}

impl FailureDescriptor {
    pub const fn new(kind: FailureCode, retryable: bool) -> Self {
        Self {
            category: kind.category(),
            kind,
            retryable,
        }
    }
}

impl GeneratedChunkStatus {
    /// Stable failure semantics for a generated-chunk terminal status. Ready
    /// and pending are not failures; every failure status carries a descriptor
    /// without consulting its display message.
    pub const fn failure_descriptor(self) -> Option<FailureDescriptor> {
        match self {
            Self::Ready | Self::Pending => None,
            Self::Unavailable => Some(FailureDescriptor::new(FailureCode::MissingObject, false)),
            Self::FailedTransient => {
                Some(FailureDescriptor::new(FailureCode::StorageBackend, true))
            }
            Self::FailedPermanent => {
                Some(FailureDescriptor::new(FailureCode::DecodeFailure, false))
            }
        }
    }
}

/// Coarse stages for a dataset-open request.
///
/// These names are intentionally user/API-facing. Server internals may have
/// finer steps, but every open result should map to one of these stable stages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatasetOpenStage {
    RequestReceived,
    Authorization,
    SourceLookup,
    BackendOpen,
    MetadataImport,
    BindingBuild,
    GeneratedCoarsePlanning,
    WorkspacePersist,
    Broadcast,
    Complete,
}

pub type DatasetOpenFailureKind = FailureCode;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatasetOpenFailureDiagnostic {
    pub stage: DatasetOpenStage,
    #[serde(flatten)]
    pub failure: FailureDescriptor,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl std::ops::Deref for DatasetOpenFailureDiagnostic {
    type Target = FailureDescriptor;

    fn deref(&self) -> &Self::Target {
        &self.failure
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatasetOpenProgressDiagnostic {
    pub stage: DatasetOpenStage,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_dataset_id: Option<DatasetId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset_source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// `true` when this entry reports a non-fatal problem (e.g. an import
    /// warning) rather than an ordinary stage transition, so clients can keep
    /// it visible after the open completes instead of treating it as
    /// transient progress. Absent on the wire when `false`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub warning: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatasetOpenSuccessDiagnostic {
    pub stage: DatasetOpenStage,
    pub source_url: String,
    pub workspace_dataset_id: DatasetId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset_source_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatasetHealthStatus {
    Healthy,
    Degraded,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatasetHealthComponent {
    pub status: DatasetHealthStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatasetSourceCacheStats {
    pub max_bytes: usize,
    pub current_bytes: usize,
    pub used_percent: u8,
    pub entry_count: usize,
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
    pub backend_errors: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatasetGeneratedCoarseCacheStats {
    pub storage: String,
    /// Conservative physical allocation charged to the shared cache root.
    /// The legacy field name is retained for wire compatibility.
    pub current_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<u8>,
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub entry_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_entries: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_used_percent: Option<u8>,
    pub evictions: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    /// Whether the disk-root byte ledger is authoritative and mutations are
    /// currently permitted. Healthy values are omitted for wire compatibility;
    /// `false` is always serialized and means the cache has failed closed.
    #[serde(
        default = "generated_cache_accounting_healthy",
        skip_serializing_if = "generated_cache_accounting_is_healthy"
    )]
    pub accounting_healthy: bool,
}

fn is_zero_u64(value: &u64) -> bool {
    *value == 0
}

const fn generated_cache_accounting_healthy() -> bool {
    true
}

fn generated_cache_accounting_is_healthy(value: &bool) -> bool {
    *value
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatasetGeneratedCoarseFailure {
    pub image_id: String,
    pub level_index: u32,
    pub key: String,
    pub status: GeneratedChunkStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<FailureDescriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatasetGeneratedCoarseHealth {
    pub status: DatasetHealthStatus,
    pub level_count: usize,
    pub ready_chunks: u64,
    pub pending_chunks: u64,
    pub failed_chunks: u64,
    pub unavailable_chunks: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache: Option<DatasetGeneratedCoarseCacheStats>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recent_failures: Vec<DatasetGeneratedCoarseFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatasetSourceHealth {
    pub workspace_dataset_id: DatasetId,
    pub name: String,
    pub status: DatasetHealthStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    pub binding: DatasetHealthComponent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_cache: Option<DatasetSourceCacheStats>,
    pub generated_coarse: DatasetGeneratedCoarseHealth,
    #[serde(default)]
    pub messages: Vec<String>,
}

#[cfg(test)]
mod failure_contract_tests {
    use std::collections::HashSet;

    use super::*;

    #[derive(Deserialize)]
    struct MatrixRow {
        code: FailureCode,
        category: FailureCategory,
        retryable: bool,
        #[serde(rename = "client_kind")]
        _client_kind: String,
    }

    #[test]
    fn shared_failure_matrix_is_exhaustive_and_category_safe() {
        let rows: Vec<MatrixRow> =
            serde_json::from_str(include_str!("../../test-fixtures/failure_contract.json"))
                .expect("failure contract fixture");
        let codes: HashSet<_> = rows.iter().map(|row| row.code).collect();
        assert_eq!(rows.len(), FailureCode::ALL.len());
        assert_eq!(codes.len(), rows.len(), "matrix contains duplicate codes");
        assert_eq!(codes, FailureCode::ALL.into_iter().collect());

        for row in rows {
            assert_eq!(row.category, row.code.category(), "{:?}", row.code);
            let value = serde_json::to_value(FailureDescriptor::new(row.code, row.retryable))
                .expect("serialize descriptor");
            assert_eq!(
                value["category"],
                serde_json::to_value(row.category).unwrap()
            );
            assert_eq!(value["code"], serde_json::to_value(row.code).unwrap());
            assert_eq!(value["retryable"], row.retryable);
            assert!(
                value.get("kind").is_none(),
                "legacy field must not be emitted"
            );
        }
    }

    #[test]
    fn generated_cache_accounting_health_is_backward_compatible_and_truthful() {
        let healthy: DatasetGeneratedCoarseCacheStats = serde_json::from_value(serde_json::json!({
            "storage": "disk",
            "current_bytes": 8,
            "evictions": 0
        }))
        .expect("legacy cache telemetry");
        assert!(healthy.accounting_healthy);
        assert_eq!(healthy.entry_count, 0);
        assert_eq!(healthy.max_entries, None);
        assert_eq!(healthy.entry_used_percent, None);
        assert!(
            serde_json::to_value(&healthy)
                .unwrap()
                .get("accounting_healthy")
                .is_none(),
            "healthy telemetry stays wire-compatible"
        );

        let mut unhealthy = healthy;
        unhealthy.entry_count = 90;
        unhealthy.max_entries = Some(100);
        unhealthy.entry_used_percent = Some(90);
        unhealthy.accounting_healthy = false;
        let value = serde_json::to_value(unhealthy).unwrap();
        assert_eq!(value["accounting_healthy"], serde_json::json!(false));
        assert_eq!(value["entry_count"], serde_json::json!(90));
        assert_eq!(value["max_entries"], serde_json::json!(100));
    }
}
