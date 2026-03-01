use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    ValidationError,
    UnknownOp,
    PermissionDenied,
    InvalidToken,
    LeaseRequired,
    PreconditionFailed,
    StaleRevision,
    NotFound,
    SourceUnavailable,
    GenerationUnavailable,
    GenerationBuildIncomplete,
    MetadataMismatch,
    PublishConflict,
    UnsupportedCodec,
    QuotaExceeded,
    InternalError,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorScope {
    ClientView,
    SceneShared,
    Admin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValidationErrorKind {
    CommandEnvelopeMalformed,
    ScopeMismatch,
    LeaseRequirementMismatch,
    ArgsShapeMismatch,
    UnsupportedOperation,
    ClientSequenceInvalid,
    InternalRoutingInconsistency,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LeaseErrorReason {
    ActiveLeaseRequired,
    LeaseHeldByAnotherClient,
    LeaseNotStealable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotFoundResource {
    Session,
    Client,
    Source,
    Layer,
    Generation,
    Metadata,
    PublishBatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RevisionKind {
    Session,
    Scene,
    View,
    Layer,
    Metadata,
    Write,
    Generation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationErrorDetail {
    pub kind: ValidationErrorKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionDeniedDetail {
    pub required_scope: ErrorScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaseRequiredDetail {
    pub required_scope: ErrorScope,
    pub reason: LeaseErrorReason,
    pub current_lease_holder_client_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotFoundDetail {
    pub resource: NotFoundResource,
    pub resource_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StaleRevisionDetail {
    pub revision_kind: RevisionKind,
    pub expected_revision: u64,
    pub actual_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceUnavailableDetail {
    pub source_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GenerationUnavailableDetail {
    pub source_id: String,
    pub generation_seq: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MetadataMismatchDetail {
    pub layer_id: String,
    pub expected_metadata_rev: u64,
    pub actual_metadata_rev: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublishConflictDetail {
    pub layer_id: String,
    pub expected_write_rev: u64,
    pub actual_write_rev: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "detail_type", content = "detail", rename_all = "snake_case")]
pub enum ErrorDetails {
    None,
    ValidationError(ValidationErrorDetail),
    PermissionDenied(PermissionDeniedDetail),
    LeaseRequired(LeaseRequiredDetail),
    NotFound(NotFoundDetail),
    StaleRevision(StaleRevisionDetail),
    SourceUnavailable(SourceUnavailableDetail),
    GenerationUnavailable(GenerationUnavailableDetail),
    MetadataMismatch(MetadataMismatchDetail),
    PublishConflict(PublishConflictDetail),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorEnvelope {
    pub message_type: String,
    pub schema_version: String,
    pub session_id: String,
    pub request_id: String,
    pub client_id: String,
    pub client_seq: u64,
    pub op: String,
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    pub details: ErrorDetails,
    pub sent_at: String,
}

pub struct ErrorMessageSerializer;

impl ErrorMessageSerializer {
    pub fn serialize(error: &ErrorEnvelope) -> Result<String, serde_json::Error> {
        serde_json::to_string(error)
    }

    pub fn deserialize(raw: &str) -> Result<ErrorEnvelope, serde_json::Error> {
        serde_json::from_str(raw)
    }
}

#[cfg(test)]
mod tests {
    use crate::constants::{ERROR_MESSAGE_TYPE, SCHEMA_VERSION};

    use super::{
        ErrorCode, ErrorDetails, ErrorEnvelope, ErrorMessageSerializer, ErrorScope,
        LeaseErrorReason, LeaseRequiredDetail,
    };

    #[test]
    fn serializer_round_trips_typed_error_envelopes() {
        let error = ErrorEnvelope {
            message_type: ERROR_MESSAGE_TYPE.to_owned(),
            schema_version: SCHEMA_VERSION.to_owned(),
            session_id: "sess_00000001".to_owned(),
            request_id: "req_lease_01".to_owned(),
            client_id: "cli_00000001".to_owned(),
            client_seq: 22,
            op: "scene.layer_add".to_owned(),
            code: ErrorCode::LeaseRequired,
            message: "Shared scene edit requires lease.".to_owned(),
            retryable: true,
            details: ErrorDetails::LeaseRequired(LeaseRequiredDetail {
                required_scope: ErrorScope::SceneShared,
                reason: LeaseErrorReason::LeaseHeldByAnotherClient,
                current_lease_holder_client_id: Some("cli_00000007".to_owned()),
            }),
            sent_at: "2026-03-01T09:00:00Z".to_owned(),
        };

        let serialized =
            ErrorMessageSerializer::serialize(&error).expect("error serialization should succeed");
        let decoded = ErrorMessageSerializer::deserialize(&serialized)
            .expect("error deserialization should succeed");

        assert_eq!(decoded, error);
    }
}
