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
use lucida_content::url::{DatasetLocation, LocationError};
use lucida_protocol::{
    DatasetOpenFailureDiagnostic, DatasetOpenFailureKind, DatasetOpenProgressDiagnostic,
    DatasetOpenStage, DatasetOpenSuccessDiagnostic, DatasetOpened,
};
use lucida_store::backend::{MetadataFault, StoreError};

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

/// A location that does not parse fails before any stage that reads
/// storage. Its message echoes the input as it was given.
pub(crate) fn location_failure(error: &LocationError) -> DatasetOpenFailureDiagnostic {
    let kind = match error {
        LocationError::UnknownScheme { .. } => DatasetOpenFailureKind::UnsupportedScheme,
        _ => DatasetOpenFailureKind::InvalidLocation,
    };
    open_failure(
        DatasetOpenStage::RequestReceived,
        kind,
        false,
        error.to_string(),
        None,
    )
}

/// The failure of opening a storage backend, triaged by where it happened.
pub(crate) fn backend_open_failure(error: &StoreError) -> DatasetOpenFailureDiagnostic {
    let (kind, retryable) = store_error_kind(error, DatasetOpenFailureKind::MissingObject);
    open_failure(
        DatasetOpenStage::BackendOpen,
        kind,
        retryable,
        error.to_string(),
        None,
    )
}

/// The failure of importing a dataset's metadata. An object the import
/// needed and did not find is missing metadata, not a missing dataset.
pub(crate) fn import_failure(error: &StoreError) -> DatasetOpenFailureDiagnostic {
    let (kind, retryable) = store_error_kind(error, DatasetOpenFailureKind::MissingMetadata);
    open_failure(
        DatasetOpenStage::MetadataImport,
        kind,
        retryable,
        error.to_string(),
        None,
    )
}

/// The open-failure kind of a store error, and whether a retry can help.
/// Every arm reads the error's variant; none reads its message.
fn store_error_kind(
    error: &StoreError,
    not_found: DatasetOpenFailureKind,
) -> (DatasetOpenFailureKind, bool) {
    match error {
        StoreError::Denied(_) => (DatasetOpenFailureKind::SourceNotAllowed, false),
        StoreError::LocalPath(_) => (DatasetOpenFailureKind::LocalPath, false),
        StoreError::BackendConfiguration(_) => (DatasetOpenFailureKind::CloudConfiguration, false),
        StoreError::Metadata { fault, .. } => (
            match fault {
                MetadataFault::Missing => DatasetOpenFailureKind::MissingMetadata,
                MetadataFault::Malformed => DatasetOpenFailureKind::MalformedMetadata,
                MetadataFault::UnsupportedCodec => DatasetOpenFailureKind::UnsupportedCodec,
                MetadataFault::UnsupportedLayout => DatasetOpenFailureKind::UnsupportedLayout,
            },
            false,
        ),
        StoreError::ObjectStore(object_store::Error::NotFound { .. }) => (not_found, false),
        StoreError::ObjectStore(
            object_store::Error::PermissionDenied { .. }
            | object_store::Error::Unauthenticated { .. },
        ) => (DatasetOpenFailureKind::Permission, false),
        StoreError::ObjectStore(_) => (DatasetOpenFailureKind::StorageBackend, true),
    }
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

/// What one dataset open's metadata reads cost: the difference of two
/// [`lucida_store::cache::CacheStats`] snapshots around the import.
///
/// The cache is shared per source, so concurrent opens of one source, or
/// chunk reads on an open binding, attribute some of each other's reads.
/// The number is exact only for an open with no overlapping reader.
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
    DatasetLocation::parse(url)
        .map_or("unknown", |location| location.scheme().as_str())
        .to_string()
}

/// Whether a read found nothing at the path, which a chunk read serves as
/// fill. Decided by the variant alone, so a single-flight follower, whose
/// reconstructed error keeps the leader's variant but not its path, reads
/// the same as its leader.
pub(crate) fn is_not_found(error: &object_store::Error) -> bool {
    matches!(error, object_store::Error::NotFound { .. })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn boxed(message: &str) -> Box<dyn std::error::Error + Send + Sync> {
        message.to_string().into()
    }

    fn sharded_chain(inner: serde_json::Value, index_location: &str) -> Vec<serde_json::Value> {
        vec![serde_json::json!({
            "name": "sharding_indexed",
            "configuration": {
                "chunk_shape": [8, 8],
                "codecs": inner,
                "index_codecs": [
                    {"name": "bytes", "configuration": {"endian": "little"}},
                    {"name": "crc32c"}
                ],
                "index_location": index_location
            }
        })]
    }

    /// Whichever part of the layout was refused, the open is triaged as an
    /// unsupported codec and not as malformed metadata.
    #[test]
    fn a_refused_sharded_layout_is_an_unsupported_codec() {
        let bytes = serde_json::json!({"name": "bytes", "configuration": {"endian": "little"}});
        let refused = [
            sharded_chain(
                serde_json::json!([{"name": "sharding_indexed", "configuration": {}}]),
                "end",
            ),
            sharded_chain(serde_json::json!([bytes, {"name": "gzip"}]), "end"),
            sharded_chain(serde_json::json!([bytes, {"name": "zstd"}]), "middle"),
        ];
        for chain in refused {
            let error =
                lucida_store::shard::ShardLayout::from_codec_chain(&chain, &[16, 16]).unwrap_err();
            let diagnostic = import_failure(&error);
            assert_eq!(
                diagnostic.kind,
                DatasetOpenFailureKind::UnsupportedCodec,
                "{error}"
            );
            assert_eq!(diagnostic.stage, DatasetOpenStage::MetadataImport);
            assert!(!diagnostic.retryable);
        }
    }

    /// Each kind of store error is triaged by its variant, so the same
    /// failure classifies the same way whatever its message says.
    #[test]
    fn store_errors_are_triaged_by_variant() {
        let generic = |message: &str| object_store::Error::Generic {
            store: "test",
            source: boxed(message),
        };
        let cases = [
            (
                StoreError::LocalPath(generic("permission denied: bucket credential")),
                DatasetOpenFailureKind::LocalPath,
                false,
            ),
            (
                StoreError::BackendConfiguration(generic("no such file")),
                DatasetOpenFailureKind::CloudConfiguration,
                false,
            ),
            (
                StoreError::ObjectStore(object_store::Error::PermissionDenied {
                    path: "zarr.json".into(),
                    source: boxed("http status 403"),
                }),
                DatasetOpenFailureKind::Permission,
                false,
            ),
            (
                StoreError::ObjectStore(generic("a codec chunk is missing from the bucket")),
                DatasetOpenFailureKind::StorageBackend,
                true,
            ),
            (
                StoreError::missing_metadata("the json has no codec"),
                DatasetOpenFailureKind::MissingMetadata,
                false,
            ),
            (
                StoreError::malformed_metadata("chunk axis layout"),
                DatasetOpenFailureKind::MalformedMetadata,
                false,
            ),
            (
                StoreError::unsupported_layout("missing json"),
                DatasetOpenFailureKind::UnsupportedLayout,
                false,
            ),
        ];
        for (error, kind, retryable) in cases {
            for diagnostic in [backend_open_failure(&error), import_failure(&error)] {
                assert_eq!(diagnostic.kind, kind, "{error}");
                assert_eq!(diagnostic.retryable, retryable, "{error}");
                assert_eq!(diagnostic.message, error.to_string());
            }
        }
    }

    /// A missing object is the dataset itself while the backend opens, and a
    /// metadata object once the import reads one.
    #[test]
    fn a_missing_object_depends_on_the_stage() {
        let missing = StoreError::ObjectStore(object_store::Error::NotFound {
            path: "zarr.json".into(),
            source: boxed("permission"),
        });
        assert_eq!(
            backend_open_failure(&missing).kind,
            DatasetOpenFailureKind::MissingObject
        );
        assert_eq!(
            import_failure(&missing).kind,
            DatasetOpenFailureKind::MissingMetadata
        );
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
        // in the preserved message), so not-found must key off the variant:
        // a coalesced 404 must read as sparse data, not as a hard failure.
        let not_found = object_store::Error::NotFound {
            path: String::new(),
            source: boxed("object at gs://bucket/chunk not found"),
        };
        assert!(is_not_found(&not_found));

        let denied = object_store::Error::PermissionDenied {
            path: String::new(),
            source: boxed("403 Forbidden"),
        };
        assert!(!is_not_found(&denied));

        // A message that says "not found" on another variant is not an absence.
        let other = object_store::Error::Generic {
            store: "source",
            source: boxed("upstream not found: 503"),
        };
        assert!(!is_not_found(&other));
    }
}
