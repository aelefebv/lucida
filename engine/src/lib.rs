mod clock;
mod command_router;
mod constants;
mod error_model;
mod errors;
mod event_stream;
mod id_allocator;
mod model;
mod revision_allocator;
mod session_manager;
mod warning_service;

pub use command_router::{
    CommandAck, CommandArgs, CommandEnvelope, CommandError, CommandErrorCode, CommandOutcome,
    CommandRouter, CommandScope, command_error_to_envelope,
};
pub use constants::{
    COMMAND_ACK_MESSAGE_TYPE, COMMAND_MESSAGE_TYPE, ENGINE_VERSION, ERROR_MESSAGE_TYPE,
    HEARTBEAT_MESSAGE_TYPE, SCHEMA_VERSION, SNAPSHOT_MESSAGE_TYPE,
};
pub use error_model::{
    ErrorCode, ErrorDetails, ErrorEnvelope, ErrorMessageSerializer, ErrorScope,
    GenerationUnavailableDetail, LeaseErrorReason, LeaseRequiredDetail, MetadataMismatchDetail,
    NotFoundDetail, NotFoundResource, PermissionDeniedDetail, PublishConflictDetail, RevisionKind,
    SourceUnavailableDetail, StaleRevisionDetail, ValidationErrorDetail, ValidationErrorKind,
};
pub use errors::SessionError;
pub use event_stream::{
    AuditEventKindPayload, ClientJoinedPayload, EventBus, EventEnvelope, EventMessageSerializer,
    EventPayload, EventStreamError, EventType, LayerUpsertPayload, LeaseChangedKindPayload,
    LeaseChangedPayload, LeaseStatePayload, ProjectionState, SourceUpsertPayload,
    ViewUpdatedPayload, WarningPayloadEntry, WarningsUpdatedPayload,
};
pub use id_allocator::{IdAllocator, IdKind};
pub use model::{
    AttachRequest, AuditEventKind, AuditLogEntry, ClientRosterEntry, ClientViewMode,
    CreatedSession, DatasetBinding, ExposureMode, ExposureViewMode, HeartbeatEnvelope, LayerState,
    LeaseChangeKind, LeaseState, PerClientViewState, PermissionClass, Permissions,
    ReconnectRequest, SceneMode, SessionSnapshotEnvelope, SessionSnapshotPayload, SessionState,
    SharedSceneState, SourceRecord, TargetState, WarningCode, WarningEntry, WarningSeverity,
};
pub use revision_allocator::RevisionAllocator;
pub use session_manager::{LeaseTransition, SessionManager};
pub use warning_service::{WarningAggregation, aggregate_warnings};
