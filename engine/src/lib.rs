mod brick3d_builder;
mod cache_layout;
mod canonical_cache;
mod channel_block;
mod chunk_key;
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
mod source_inspector;
mod source_watch;
mod tile_preview_builder;
mod warning_service;

pub use brick3d_builder::{Brick3dBuilder, BrickBuildError, BrickBuildRequest, BrickBuildResult};
pub use cache_layout::{
    GenerationArtifactLayout, RetentionDecision, RetentionPolicy, decide_retention,
    remove_generation_artifacts,
};
pub use canonical_cache::{
    CanonicalCacheBuildRequest, CanonicalCacheBuildResult, CanonicalCacheBuilder,
    CanonicalCacheError,
};
pub use channel_block::{
    ChannelBlockError, ChannelBlockPackaging, ChannelBlockReadResult, ChannelBlockWriteRequest,
    PayloadCodec, PayloadKind,
};
pub use chunk_key::{ChunkAssetKind, ChunkKey, ChunkKeyError};
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
    AuditEventKindPayload, ClientJoinedPayload, DatasetUpsertPayload, EventBus, EventEnvelope,
    EventMessageSerializer, EventPayload, EventStreamError, EventType, LayerUpsertPayload,
    LeaseChangedKindPayload, LeaseChangedPayload, LeaseStatePayload, ProjectionState,
    SourceGenerationPayload, SourceUpsertPayload, ViewUpdatedPayload, WarningPayloadEntry,
    WarningsUpdatedPayload,
};
pub use id_allocator::{IdAllocator, IdKind};
pub use model::{
    AddSourceRequest, AddedSource, AttachRequest, AuditEventKind, AuditLogEntry, AxisName,
    AxisShape, AxisSpacing, CalibrationMetadata, CalibrationStatus, ChannelDescription,
    ChannelTable, ClientRosterEntry, ClientViewMode, CreatedSession, DatasetBinding, DatasetKind,
    ExposureMode, ExposureViewMode, GenerationAvailability, GenerationRecord, GenerationRef,
    GenerationRefMode, GenerationStage, HeartbeatEnvelope, LayerState, LeaseChangeKind, LeaseState,
    PerClientViewState, PermissionClass, Permissions, ReconnectRequest, SceneMode,
    SessionSnapshotEnvelope, SessionSnapshotPayload, SessionState, SharedSceneState, SourceKind,
    SourceMetadata, SourceRecord, SourceStatus, SourceWatchMode, StabilityWindow, TargetState,
    WarningCode, WarningEntry, WarningSeverity,
};
pub use revision_allocator::RevisionAllocator;
pub use session_manager::{LeaseTransition, SessionManager};
pub use source_inspector::{InspectedSource, SourceInspectionError, inspect_source};
pub use source_watch::{
    DirectoryWatcher, FileWatcher, SourceWatchController, SourceWatcher, SourceWatcherKind,
    StabilityWindowGate, WatchDecision, WatchError, WatchPoll, WatchSignature,
};
pub use tile_preview_builder::{
    TilePreviewBuildError, TilePreviewBuildRequest, TilePreviewBuildResult, TilePreviewBuilder,
};
pub use warning_service::{WarningAggregation, aggregate_warnings};
