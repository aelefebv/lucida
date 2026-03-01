use crate::clock::rfc3339_now;
use crate::constants::{
    COMMAND_ACK_MESSAGE_TYPE, COMMAND_MESSAGE_TYPE, ERROR_MESSAGE_TYPE, SCHEMA_VERSION,
};
use crate::error_model::{
    ErrorCode, ErrorDetails, ErrorEnvelope, ErrorScope, LeaseErrorReason, LeaseRequiredDetail,
    NotFoundDetail, NotFoundResource, PermissionDeniedDetail, SourceUnavailableDetail,
    ValidationErrorDetail, ValidationErrorKind,
};
use crate::errors::SessionError;
use crate::event_stream::{
    DatasetUpsertPayload, EventEnvelope, LayerUpsertPayload, LeaseChangedPayload,
    LeaseStatePayload, SourceUpsertPayload, ViewUpdatedPayload, WarningsUpdatedPayload,
    audit_event_kind_payload, lease_change_kind_payload, warning_payloads,
};
use crate::model::AddSourceRequest;
use crate::model::PermissionClass;
use crate::session_manager::{LeaseTransition, SessionManager};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandScope {
    ClientView,
    SceneShared,
    Admin,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandArgs {
    ViewSetActiveLayer { active_layer_id: Option<String> },
    SceneAddSource { name: String, uri: String },
    SceneLayerAdd { name: String },
    LeaseRequest,
    LeaseSteal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandEnvelope {
    pub message_type: String,
    pub schema_version: String,
    pub session_id: String,
    pub request_id: String,
    pub client_id: String,
    pub client_seq: u64,
    pub op: String,
    pub scope: CommandScope,
    pub requires_lease: bool,
    pub args: CommandArgs,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandAck {
    pub message_type: String,
    pub schema_version: String,
    pub session_id: String,
    pub request_id: String,
    pub client_id: String,
    pub client_seq: u64,
    pub accepted: bool,
    pub resulting_session_rev: u64,
    pub resulting_scene_rev: Option<u64>,
    pub resulting_view_rev: Option<u64>,
    pub created_object_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutcome {
    pub ack: CommandAck,
    pub events: Vec<EventEnvelope>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandErrorCode {
    ValidationError,
    UnknownOperation,
    PermissionDenied,
    LeaseRequired,
    LeaseUnavailable,
    LeaseNotStealable,
    SessionNotFound,
    ClientNotFound,
    SourceNotFound,
    SourceUnavailable,
    LayerNotFound,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandError {
    pub code: CommandErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Operation {
    ViewSetActiveLayer,
    SceneAddSource,
    SceneLayerAdd,
    LeaseRequest,
    LeaseSteal,
}

impl Operation {
    fn parse(op: &str) -> Result<Self, CommandError> {
        match op {
            "view.set_active_layer" => Ok(Self::ViewSetActiveLayer),
            "scene.add_source" => Ok(Self::SceneAddSource),
            "scene.layer_add" => Ok(Self::SceneLayerAdd),
            "lease.request" => Ok(Self::LeaseRequest),
            "lease.steal" => Ok(Self::LeaseSteal),
            _ => Err(CommandError {
                code: CommandErrorCode::UnknownOperation,
                message: format!("unsupported op `{op}`"),
            }),
        }
    }

    const fn expected_scope(self) -> CommandScope {
        match self {
            Operation::ViewSetActiveLayer => CommandScope::ClientView,
            Operation::SceneAddSource => CommandScope::SceneShared,
            Operation::SceneLayerAdd => CommandScope::SceneShared,
            Operation::LeaseRequest => CommandScope::SceneShared,
            Operation::LeaseSteal => CommandScope::SceneShared,
        }
    }

    const fn expected_requires_lease(self) -> bool {
        match self {
            Operation::ViewSetActiveLayer => false,
            Operation::SceneAddSource => true,
            Operation::SceneLayerAdd => true,
            Operation::LeaseRequest => false,
            Operation::LeaseSteal => false,
        }
    }
}

#[derive(Debug, Default)]
pub struct CommandRouter;

impl CommandRouter {
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    pub fn route(
        &self,
        session_manager: &mut SessionManager,
        envelope: CommandEnvelope,
    ) -> Result<CommandOutcome, CommandError> {
        let operation = validate_envelope(&envelope)?;

        let (permission_class, is_lease_holder) = session_manager
            .client_permission_and_lease(&envelope.session_id, &envelope.client_id)
            .map_err(CommandError::from)?;
        authorize(
            permission_class,
            is_lease_holder,
            operation.expected_scope(),
            operation.expected_requires_lease(),
        )?;

        dispatch(operation, session_manager, envelope)
    }
}

#[must_use]
pub fn command_error_to_envelope(command: &CommandEnvelope, error: &CommandError) -> ErrorEnvelope {
    ErrorEnvelope {
        message_type: ERROR_MESSAGE_TYPE.to_owned(),
        schema_version: SCHEMA_VERSION.to_owned(),
        session_id: command.session_id.clone(),
        request_id: command.request_id.clone(),
        client_id: command.client_id.clone(),
        client_seq: command.client_seq,
        op: command.op.clone(),
        code: error_code(error.code),
        message: error.message.clone(),
        retryable: is_retryable(error.code),
        details: error_details(command, error),
        sent_at: rfc3339_now(),
    }
}

const fn error_scope(scope: CommandScope) -> ErrorScope {
    match scope {
        CommandScope::ClientView => ErrorScope::ClientView,
        CommandScope::SceneShared => ErrorScope::SceneShared,
        CommandScope::Admin => ErrorScope::Admin,
    }
}

const fn error_code(code: CommandErrorCode) -> ErrorCode {
    match code {
        CommandErrorCode::ValidationError => ErrorCode::ValidationError,
        CommandErrorCode::UnknownOperation => ErrorCode::UnknownOp,
        CommandErrorCode::PermissionDenied => ErrorCode::PermissionDenied,
        CommandErrorCode::LeaseRequired
        | CommandErrorCode::LeaseUnavailable
        | CommandErrorCode::LeaseNotStealable => ErrorCode::LeaseRequired,
        CommandErrorCode::SessionNotFound
        | CommandErrorCode::ClientNotFound
        | CommandErrorCode::SourceNotFound
        | CommandErrorCode::LayerNotFound => ErrorCode::NotFound,
        CommandErrorCode::SourceUnavailable => ErrorCode::SourceUnavailable,
    }
}

const fn is_retryable(code: CommandErrorCode) -> bool {
    match code {
        CommandErrorCode::LeaseRequired | CommandErrorCode::LeaseUnavailable => true,
        CommandErrorCode::ValidationError
        | CommandErrorCode::UnknownOperation
        | CommandErrorCode::PermissionDenied
        | CommandErrorCode::LeaseNotStealable
        | CommandErrorCode::SessionNotFound
        | CommandErrorCode::ClientNotFound
        | CommandErrorCode::SourceNotFound
        | CommandErrorCode::LayerNotFound
        | CommandErrorCode::SourceUnavailable => false,
    }
}

fn error_details(command: &CommandEnvelope, error: &CommandError) -> ErrorDetails {
    match error.code {
        CommandErrorCode::ValidationError => ErrorDetails::ValidationError(ValidationErrorDetail {
            kind: ValidationErrorKind::CommandEnvelopeMalformed,
        }),
        CommandErrorCode::UnknownOperation => {
            ErrorDetails::ValidationError(ValidationErrorDetail {
                kind: ValidationErrorKind::UnsupportedOperation,
            })
        }
        CommandErrorCode::PermissionDenied => {
            ErrorDetails::PermissionDenied(PermissionDeniedDetail {
                required_scope: error_scope(command.scope),
            })
        }
        CommandErrorCode::LeaseRequired => ErrorDetails::LeaseRequired(LeaseRequiredDetail {
            required_scope: ErrorScope::SceneShared,
            reason: LeaseErrorReason::ActiveLeaseRequired,
            current_lease_holder_client_id: None,
        }),
        CommandErrorCode::LeaseUnavailable => ErrorDetails::LeaseRequired(LeaseRequiredDetail {
            required_scope: ErrorScope::SceneShared,
            reason: LeaseErrorReason::LeaseHeldByAnotherClient,
            current_lease_holder_client_id: None,
        }),
        CommandErrorCode::LeaseNotStealable => ErrorDetails::LeaseRequired(LeaseRequiredDetail {
            required_scope: ErrorScope::SceneShared,
            reason: LeaseErrorReason::LeaseNotStealable,
            current_lease_holder_client_id: None,
        }),
        CommandErrorCode::SessionNotFound => ErrorDetails::NotFound(NotFoundDetail {
            resource: NotFoundResource::Session,
            resource_id: Some(command.session_id.clone()),
        }),
        CommandErrorCode::ClientNotFound => ErrorDetails::NotFound(NotFoundDetail {
            resource: NotFoundResource::Client,
            resource_id: Some(command.client_id.clone()),
        }),
        CommandErrorCode::SourceNotFound => ErrorDetails::NotFound(NotFoundDetail {
            resource: NotFoundResource::Source,
            resource_id: None,
        }),
        CommandErrorCode::LayerNotFound => ErrorDetails::NotFound(NotFoundDetail {
            resource: NotFoundResource::Layer,
            resource_id: None,
        }),
        CommandErrorCode::SourceUnavailable => {
            ErrorDetails::SourceUnavailable(SourceUnavailableDetail {
                source_id: "unknown".to_owned(),
            })
        }
    }
}

fn validate_envelope(envelope: &CommandEnvelope) -> Result<Operation, CommandError> {
    if envelope.message_type != COMMAND_MESSAGE_TYPE {
        return Err(CommandError {
            code: CommandErrorCode::ValidationError,
            message: format!(
                "message_type must be `{}` but was `{}`",
                COMMAND_MESSAGE_TYPE, envelope.message_type
            ),
        });
    }

    if envelope.schema_version != SCHEMA_VERSION {
        return Err(CommandError {
            code: CommandErrorCode::ValidationError,
            message: format!(
                "schema_version must be `{}` but was `{}`",
                SCHEMA_VERSION, envelope.schema_version
            ),
        });
    }

    if envelope.client_seq == 0 {
        return Err(CommandError {
            code: CommandErrorCode::ValidationError,
            message: "client_seq must be a positive integer".to_owned(),
        });
    }

    let operation = Operation::parse(&envelope.op)?;

    if envelope.scope != operation.expected_scope() {
        return Err(CommandError {
            code: CommandErrorCode::ValidationError,
            message: format!(
                "scope mismatch for `{}`: expected {:?}, got {:?}",
                envelope.op,
                operation.expected_scope(),
                envelope.scope
            ),
        });
    }

    if envelope.requires_lease != operation.expected_requires_lease() {
        return Err(CommandError {
            code: CommandErrorCode::ValidationError,
            message: format!(
                "requires_lease mismatch for `{}`: expected {}, got {}",
                envelope.op,
                operation.expected_requires_lease(),
                envelope.requires_lease
            ),
        });
    }

    match (operation, &envelope.args) {
        (Operation::ViewSetActiveLayer, CommandArgs::ViewSetActiveLayer { .. })
        | (Operation::SceneAddSource, CommandArgs::SceneAddSource { .. })
        | (Operation::SceneLayerAdd, CommandArgs::SceneLayerAdd { .. })
        | (Operation::LeaseRequest, CommandArgs::LeaseRequest)
        | (Operation::LeaseSteal, CommandArgs::LeaseSteal) => Ok(operation),
        _ => Err(CommandError {
            code: CommandErrorCode::ValidationError,
            message: format!("args shape does not match op `{}`", envelope.op),
        }),
    }
}

fn authorize(
    permission_class: PermissionClass,
    is_lease_holder: bool,
    scope: CommandScope,
    requires_lease: bool,
) -> Result<(), CommandError> {
    match scope {
        CommandScope::ClientView => Ok(()),
        CommandScope::SceneShared => {
            if !matches!(
                permission_class,
                PermissionClass::Control | PermissionClass::Admin
            ) {
                return Err(CommandError {
                    code: CommandErrorCode::PermissionDenied,
                    message: "scene_shared command requires control/admin permission".to_owned(),
                });
            }

            if requires_lease && !is_lease_holder {
                return Err(CommandError {
                    code: CommandErrorCode::LeaseRequired,
                    message: "scene_shared command requires active lease".to_owned(),
                });
            }

            Ok(())
        }
        CommandScope::Admin => {
            if matches!(permission_class, PermissionClass::Admin) {
                Ok(())
            } else {
                Err(CommandError {
                    code: CommandErrorCode::PermissionDenied,
                    message: "admin command requires admin permission".to_owned(),
                })
            }
        }
    }
}

fn dispatch(
    operation: Operation,
    session_manager: &mut SessionManager,
    envelope: CommandEnvelope,
) -> Result<CommandOutcome, CommandError> {
    let mut resulting_scene_rev = None;
    let mut resulting_view_rev = None;
    let mut created_object_id = None;
    let mut events = Vec::new();

    match (operation, envelope.args) {
        (Operation::ViewSetActiveLayer, CommandArgs::ViewSetActiveLayer { active_layer_id }) => {
            let view_rev = session_manager
                .update_client_active_layer(
                    &envelope.session_id,
                    &envelope.client_id,
                    active_layer_id,
                )
                .map_err(CommandError::from)?;
            resulting_view_rev = Some(view_rev);

            let view_state = session_manager
                .client_view_state(&envelope.session_id, &envelope.client_id)
                .map_err(CommandError::from)?;
            let (session_rev, _) = session_manager
                .session_and_scene_revisions(&envelope.session_id)
                .map_err(CommandError::from)?;
            events.push(EventEnvelope::view_updated(
                envelope.session_id.clone(),
                session_rev,
                ViewUpdatedPayload::from(&view_state),
                rfc3339_now(),
            ));
        }
        (Operation::SceneAddSource, CommandArgs::SceneAddSource { name, uri }) => {
            let added_source = session_manager
                .add_source(&envelope.session_id, AddSourceRequest { name, uri })
                .map_err(CommandError::from)?;
            created_object_id = Some(added_source.source.source_id.clone());
            let (session_rev, scene_rev) = session_manager
                .session_and_scene_revisions(&envelope.session_id)
                .map_err(CommandError::from)?;
            resulting_scene_rev = Some(scene_rev);
            events.push(EventEnvelope::scene_source_upsert(
                envelope.session_id.clone(),
                session_rev,
                SourceUpsertPayload::from(&added_source.source),
                rfc3339_now(),
            ));
            events.push(EventEnvelope::scene_dataset_upsert(
                envelope.session_id.clone(),
                session_rev,
                DatasetUpsertPayload::from(&added_source.dataset),
                rfc3339_now(),
            ));
        }
        (Operation::SceneLayerAdd, CommandArgs::SceneLayerAdd { name }) => {
            let layer = session_manager
                .add_layer(&envelope.session_id, name)
                .map_err(CommandError::from)?;
            created_object_id = Some(layer.layer_id.clone());
            let (session_rev, scene_rev) = session_manager
                .session_and_scene_revisions(&envelope.session_id)
                .map_err(CommandError::from)?;
            resulting_scene_rev = Some(scene_rev);
            events.push(EventEnvelope::scene_layer_upsert(
                envelope.session_id.clone(),
                session_rev,
                LayerUpsertPayload::from(&layer),
                rfc3339_now(),
            ));
        }
        (Operation::LeaseRequest, CommandArgs::LeaseRequest) => {
            if let Some(transition) = session_manager
                .request_lease(&envelope.session_id, &envelope.client_id)
                .map_err(CommandError::from)?
            {
                events.push(lease_changed_event(&envelope.session_id, &transition));
            }
        }
        (Operation::LeaseSteal, CommandArgs::LeaseSteal) => {
            if let Some(transition) = session_manager
                .steal_lease(&envelope.session_id, &envelope.client_id)
                .map_err(CommandError::from)?
            {
                events.push(lease_changed_event(&envelope.session_id, &transition));
            }
        }
        _ => {
            return Err(CommandError {
                code: CommandErrorCode::ValidationError,
                message: "validated op/args combination became inconsistent".to_owned(),
            });
        }
    }

    let (session_rev, _) = session_manager
        .session_and_scene_revisions(&envelope.session_id)
        .map_err(CommandError::from)?;
    let warnings = session_manager
        .combined_warnings_for_client(&envelope.session_id, &envelope.client_id)
        .map_err(CommandError::from)?;
    if !warnings.is_empty() {
        events.push(EventEnvelope::warnings_updated(
            envelope.session_id.clone(),
            session_rev,
            WarningsUpdatedPayload {
                client_id: envelope.client_id.clone(),
                warnings: warning_payloads(&warnings),
            },
            rfc3339_now(),
        ));
    }

    Ok(CommandOutcome {
        ack: CommandAck {
            message_type: COMMAND_ACK_MESSAGE_TYPE.to_owned(),
            schema_version: SCHEMA_VERSION.to_owned(),
            session_id: envelope.session_id,
            request_id: envelope.request_id,
            client_id: envelope.client_id,
            client_seq: envelope.client_seq,
            accepted: true,
            resulting_session_rev: session_rev,
            resulting_scene_rev,
            resulting_view_rev,
            created_object_id,
        },
        events,
    })
}

fn lease_changed_event(session_id: &str, transition: &LeaseTransition) -> EventEnvelope {
    EventEnvelope::lease_changed(
        session_id.to_owned(),
        transition.resulting_session_rev,
        LeaseChangedPayload {
            lease_state: LeaseStatePayload::from(&transition.lease_state),
            change_kind: lease_change_kind_payload(transition.change_kind),
            changed_by_client_id: transition.changed_by_client_id.clone(),
            changed_by_label: transition.changed_by_label.clone(),
            previous_lease_holder_client_id: transition.previous_lease_holder_client_id.clone(),
            previous_lease_holder_label: transition.previous_lease_holder_label.clone(),
            audit_event_kind: audit_event_kind_payload(transition.audit_entry.event_kind),
            audit_recorded_at: transition.audit_entry.recorded_at.clone(),
        },
        transition.changed_at.clone(),
    )
}

impl From<SessionError> for CommandError {
    fn from(value: SessionError) -> Self {
        match value {
            SessionError::SessionNotFound { session_id } => Self {
                code: CommandErrorCode::SessionNotFound,
                message: format!("session `{session_id}` was not found"),
            },
            SessionError::ClientNotFound {
                session_id,
                client_id,
            } => Self {
                code: CommandErrorCode::ClientNotFound,
                message: format!("client `{client_id}` was not found in session `{session_id}`"),
            },
            SessionError::SourceNotFound {
                session_id,
                source_id,
            } => Self {
                code: CommandErrorCode::SourceNotFound,
                message: format!("source `{source_id}` was not found in session `{session_id}`"),
            },
            SessionError::SourceUnavailable { uri, reason } => Self {
                code: CommandErrorCode::SourceUnavailable,
                message: format!("source `{uri}` is unavailable: {reason}"),
            },
            SessionError::GenerationNotFound {
                session_id,
                source_id,
                generation_seq,
            } => Self {
                code: CommandErrorCode::SourceNotFound,
                message: format!(
                    "generation `{generation_seq}` for source `{source_id}` was not found in session `{session_id}`"
                ),
            },
            SessionError::InvalidGenerationTransition {
                source_id,
                generation_seq,
                current_stage,
                requested_stage,
            } => Self {
                code: CommandErrorCode::ValidationError,
                message: format!(
                    "invalid generation transition for source `{source_id}` generation `{generation_seq}`: {:?} -> {:?}",
                    current_stage, requested_stage
                ),
            },
            SessionError::CanonicalCacheBuildFailed {
                source_id,
                generation_seq,
                reason,
            } => Self {
                code: CommandErrorCode::SourceUnavailable,
                message: format!(
                    "canonical cache build failed for source `{source_id}` generation `{generation_seq}`: {reason}"
                ),
            },
            SessionError::TilePreviewBuildFailed {
                source_id,
                generation_seq,
                reason,
            } => Self {
                code: CommandErrorCode::SourceUnavailable,
                message: format!(
                    "tile/preview build failed for source `{source_id}` generation `{generation_seq}`: {reason}"
                ),
            },
            SessionError::LayerNotFound {
                session_id,
                layer_id,
            } => Self {
                code: CommandErrorCode::LayerNotFound,
                message: format!("layer `{layer_id}` was not found in session `{session_id}`"),
            },
            SessionError::LeaseUnavailable {
                session_id,
                lease_holder_client_id,
            } => Self {
                code: CommandErrorCode::LeaseUnavailable,
                message: format!(
                    "lease in session `{session_id}` is held by `{lease_holder_client_id}`"
                ),
            },
            SessionError::LeaseNotStealable { session_id } => Self {
                code: CommandErrorCode::LeaseNotStealable,
                message: format!("lease in session `{session_id}` is not stealable"),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use crate::constants::{COMMAND_MESSAGE_TYPE, SCHEMA_VERSION};
    use crate::error_model::{
        ErrorCode, ErrorDetails, ErrorScope, LeaseErrorReason, NotFoundResource,
    };
    use crate::event_stream::{EventPayload, EventType};
    use crate::model::{AttachRequest, PermissionClass};
    use crate::session_manager::SessionManager;

    use super::{
        CommandArgs, CommandEnvelope, CommandErrorCode, CommandRouter, CommandScope,
        command_error_to_envelope,
    };

    fn write_minimal_rgb_tiff(path: &Path) {
        const TIFF_BYTES: [u8; 62] = [
            0x49, 0x49, 0x2A, 0x00, // II + classic TIFF marker
            0x08, 0x00, 0x00, 0x00, // first IFD offset
            0x04, 0x00, // entry count
            0x00, 0x01, // tag 256 image width
            0x04, 0x00, // type LONG
            0x01, 0x00, 0x00, 0x00, // count
            0x20, 0x00, 0x00, 0x00, // width 32
            0x01, 0x01, // tag 257 image length
            0x04, 0x00, // type LONG
            0x01, 0x00, 0x00, 0x00, // count
            0x10, 0x00, 0x00, 0x00, // height 16
            0x15, 0x01, // tag 277 samples per pixel
            0x03, 0x00, // type SHORT
            0x01, 0x00, 0x00, 0x00, // count
            0x03, 0x00, 0x00, 0x00, // 3 channels
            0x02, 0x01, // tag 258 bits per sample
            0x03, 0x00, // type SHORT
            0x01, 0x00, 0x00, 0x00, // count
            0x08, 0x00, 0x00, 0x00, // 8 bits
            0x00, 0x00, 0x00, 0x00, // next IFD offset
        ];
        fs::write(path, TIFF_BYTES).expect("TIFF fixture write should succeed");
    }

    fn fixture_tiff_path(suffix: &str) -> PathBuf {
        let fixture_dir = std::env::temp_dir().join(format!(
            "lucida_luc200_router_{}_{}",
            std::process::id(),
            suffix
        ));
        fs::create_dir_all(&fixture_dir).expect("fixture dir creation should succeed");
        let path = fixture_dir.join("source.tiff");
        write_minimal_rgb_tiff(&path);
        path
    }

    #[test]
    fn rejects_malformed_command_envelope() {
        let mut manager = SessionManager::new();
        let created = manager.create_session("cmd-session");
        let attached = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "client-a".to_owned(),
                requested_permission: PermissionClass::View,
            })
            .expect("attach should succeed");

        let router = CommandRouter::new();
        let result = router.route(
            &mut manager,
            CommandEnvelope {
                message_type: "not-command".to_owned(),
                schema_version: SCHEMA_VERSION.to_owned(),
                session_id: created.session_id,
                request_id: "req_1".to_owned(),
                client_id: attached.snapshot.client_view.client_id,
                client_seq: 1,
                op: "view.set_active_layer".to_owned(),
                scope: CommandScope::ClientView,
                requires_lease: false,
                args: CommandArgs::ViewSetActiveLayer {
                    active_layer_id: None,
                },
            },
        );

        assert!(result.is_err());
        assert_eq!(
            result
                .expect_err("expected malformed envelope to fail")
                .code,
            CommandErrorCode::ValidationError
        );
    }

    #[test]
    fn rejects_unknown_operation() {
        let mut manager = SessionManager::new();
        let created = manager.create_session("cmd-session");
        let attached = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "client-a".to_owned(),
                requested_permission: PermissionClass::View,
            })
            .expect("attach should succeed");

        let router = CommandRouter::new();
        let result = router.route(
            &mut manager,
            CommandEnvelope {
                message_type: COMMAND_MESSAGE_TYPE.to_owned(),
                schema_version: SCHEMA_VERSION.to_owned(),
                session_id: created.session_id,
                request_id: "req_1b".to_owned(),
                client_id: attached.snapshot.client_view.client_id,
                client_seq: 1,
                op: "view.does_not_exist".to_owned(),
                scope: CommandScope::ClientView,
                requires_lease: false,
                args: CommandArgs::ViewSetActiveLayer {
                    active_layer_id: None,
                },
            },
        );

        assert_eq!(
            result.expect_err("unknown operation should fail").code,
            CommandErrorCode::UnknownOperation
        );
    }

    #[test]
    fn rejects_scope_mismatch() {
        let mut manager = SessionManager::new();
        let created = manager.create_session("cmd-session");
        let attached = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "client-a".to_owned(),
                requested_permission: PermissionClass::View,
            })
            .expect("attach should succeed");

        let router = CommandRouter::new();
        let result = router.route(
            &mut manager,
            CommandEnvelope {
                message_type: COMMAND_MESSAGE_TYPE.to_owned(),
                schema_version: SCHEMA_VERSION.to_owned(),
                session_id: created.session_id,
                request_id: "req_1c".to_owned(),
                client_id: attached.snapshot.client_view.client_id,
                client_seq: 1,
                op: "view.set_active_layer".to_owned(),
                scope: CommandScope::SceneShared,
                requires_lease: false,
                args: CommandArgs::ViewSetActiveLayer {
                    active_layer_id: None,
                },
            },
        );

        assert_eq!(
            result.expect_err("scope mismatch should fail").code,
            CommandErrorCode::ValidationError
        );
    }

    #[test]
    fn rejects_requires_lease_mismatch() {
        let mut manager = SessionManager::new();
        let created = manager.create_session("cmd-session");
        let attached = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "control-client".to_owned(),
                requested_permission: PermissionClass::Control,
            })
            .expect("attach should succeed");

        manager
            .set_lease_holder(
                &created.session_id,
                Some(&attached.snapshot.client_view.client_id),
            )
            .expect("lease holder assignment should succeed");

        let router = CommandRouter::new();
        let result = router.route(
            &mut manager,
            CommandEnvelope {
                message_type: COMMAND_MESSAGE_TYPE.to_owned(),
                schema_version: SCHEMA_VERSION.to_owned(),
                session_id: created.session_id,
                request_id: "req_1d".to_owned(),
                client_id: attached.snapshot.client_view.client_id,
                client_seq: 1,
                op: "scene.add_source".to_owned(),
                scope: CommandScope::SceneShared,
                requires_lease: false,
                args: CommandArgs::SceneAddSource {
                    name: "source-a".to_owned(),
                    uri: "/tmp/unused.tiff".to_owned(),
                },
            },
        );

        assert_eq!(
            result
                .expect_err("requires_lease mismatch should fail")
                .code,
            CommandErrorCode::ValidationError
        );
    }

    #[test]
    fn rejects_args_shape_mismatch() {
        let mut manager = SessionManager::new();
        let created = manager.create_session("cmd-session");
        let attached = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "control-client".to_owned(),
                requested_permission: PermissionClass::Control,
            })
            .expect("attach should succeed");

        manager
            .set_lease_holder(
                &created.session_id,
                Some(&attached.snapshot.client_view.client_id),
            )
            .expect("lease holder assignment should succeed");

        let router = CommandRouter::new();
        let result = router.route(
            &mut manager,
            CommandEnvelope {
                message_type: COMMAND_MESSAGE_TYPE.to_owned(),
                schema_version: SCHEMA_VERSION.to_owned(),
                session_id: created.session_id,
                request_id: "req_1e".to_owned(),
                client_id: attached.snapshot.client_view.client_id,
                client_seq: 1,
                op: "scene.add_source".to_owned(),
                scope: CommandScope::SceneShared,
                requires_lease: true,
                args: CommandArgs::SceneLayerAdd {
                    name: "layer-a".to_owned(),
                },
            },
        );

        assert_eq!(
            result.expect_err("args mismatch should fail").code,
            CommandErrorCode::ValidationError
        );
    }

    #[test]
    fn rejects_unauthorized_scene_command() {
        let mut manager = SessionManager::new();
        let created = manager.create_session("cmd-session");
        let attached = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "view-client".to_owned(),
                requested_permission: PermissionClass::View,
            })
            .expect("attach should succeed");

        let router = CommandRouter::new();
        let result = router.route(
            &mut manager,
            CommandEnvelope {
                message_type: COMMAND_MESSAGE_TYPE.to_owned(),
                schema_version: SCHEMA_VERSION.to_owned(),
                session_id: created.session_id,
                request_id: "req_2".to_owned(),
                client_id: attached.snapshot.client_view.client_id,
                client_seq: 1,
                op: "scene.add_source".to_owned(),
                scope: CommandScope::SceneShared,
                requires_lease: true,
                args: CommandArgs::SceneAddSource {
                    name: "source-a".to_owned(),
                    uri: "/tmp/unused.tiff".to_owned(),
                },
            },
        );

        assert_eq!(
            result.expect_err("expected permission check to fail").code,
            CommandErrorCode::PermissionDenied
        );
    }

    #[test]
    fn rejects_scene_command_when_lease_is_missing() {
        let mut manager = SessionManager::new();
        let created = manager.create_session("cmd-session");
        let attached = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "control-client".to_owned(),
                requested_permission: PermissionClass::Control,
            })
            .expect("attach should succeed");

        let router = CommandRouter::new();
        let result = router.route(
            &mut manager,
            CommandEnvelope {
                message_type: COMMAND_MESSAGE_TYPE.to_owned(),
                schema_version: SCHEMA_VERSION.to_owned(),
                session_id: created.session_id,
                request_id: "req_3".to_owned(),
                client_id: attached.snapshot.client_view.client_id,
                client_seq: 1,
                op: "scene.add_source".to_owned(),
                scope: CommandScope::SceneShared,
                requires_lease: true,
                args: CommandArgs::SceneAddSource {
                    name: "source-a".to_owned(),
                    uri: "/tmp/unused.tiff".to_owned(),
                },
            },
        );

        assert_eq!(
            result.expect_err("expected lease enforcement to fail").code,
            CommandErrorCode::LeaseRequired
        );
    }

    #[test]
    fn routes_valid_commands_and_returns_typed_ack_and_events() {
        let source_path = fixture_tiff_path("routes_valid_commands");
        let mut manager = SessionManager::new();
        let created = manager.create_session("cmd-session");
        let attached = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "control-client".to_owned(),
                requested_permission: PermissionClass::Control,
            })
            .expect("attach should succeed");
        manager
            .set_lease_holder(
                &created.session_id,
                Some(&attached.snapshot.client_view.client_id),
            )
            .expect("lease holder assignment should succeed");

        let router = CommandRouter::new();

        let view_outcome = router
            .route(
                &mut manager,
                CommandEnvelope {
                    message_type: COMMAND_MESSAGE_TYPE.to_owned(),
                    schema_version: SCHEMA_VERSION.to_owned(),
                    session_id: created.session_id.clone(),
                    request_id: "req_4".to_owned(),
                    client_id: attached.snapshot.client_view.client_id.clone(),
                    client_seq: 1,
                    op: "view.set_active_layer".to_owned(),
                    scope: CommandScope::ClientView,
                    requires_lease: false,
                    args: CommandArgs::ViewSetActiveLayer {
                        active_layer_id: Some("lay_00000001".to_owned()),
                    },
                },
            )
            .expect("view command should be accepted");

        let scene_outcome = router
            .route(
                &mut manager,
                CommandEnvelope {
                    message_type: COMMAND_MESSAGE_TYPE.to_owned(),
                    schema_version: SCHEMA_VERSION.to_owned(),
                    session_id: created.session_id,
                    request_id: "req_5".to_owned(),
                    client_id: attached.snapshot.client_view.client_id,
                    client_seq: 2,
                    op: "scene.add_source".to_owned(),
                    scope: CommandScope::SceneShared,
                    requires_lease: true,
                    args: CommandArgs::SceneAddSource {
                        name: "source-a".to_owned(),
                        uri: source_path.display().to_string(),
                    },
                },
            )
            .expect("scene command should be accepted");

        assert!(view_outcome.ack.accepted);
        assert_eq!(view_outcome.ack.resulting_view_rev, Some(1));
        assert!(view_outcome.ack.resulting_session_rev >= 3);
        assert_eq!(view_outcome.ack.resulting_scene_rev, None);
        assert!(
            view_outcome
                .events
                .iter()
                .any(|event| event.event_type == EventType::ViewUpdated)
        );
        assert!(
            view_outcome
                .events
                .iter()
                .any(|event| event.event_type == EventType::WarningsUpdated)
        );

        assert!(scene_outcome.ack.accepted);
        assert!(scene_outcome.ack.resulting_scene_rev.is_some());
        assert!(scene_outcome.ack.resulting_session_rev > view_outcome.ack.resulting_session_rev);
        assert!(
            scene_outcome
                .ack
                .created_object_id
                .expect("source id should be present")
                .starts_with("src_")
        );
        assert!(
            scene_outcome
                .events
                .iter()
                .any(|event| event.event_type == EventType::SceneSourceUpsert)
        );
        assert!(
            scene_outcome
                .events
                .iter()
                .any(|event| event.event_type == EventType::SceneDatasetUpsert)
        );
        assert!(
            scene_outcome
                .events
                .iter()
                .any(|event| event.event_type == EventType::WarningsUpdated)
        );

        let fixture_dir = source_path
            .parent()
            .expect("fixture parent should exist")
            .to_path_buf();
        fs::remove_dir_all(fixture_dir).expect("fixture cleanup should succeed");
    }

    #[test]
    fn rejects_lease_request_when_another_client_holds_the_lease() {
        let mut manager = SessionManager::new();
        let created = manager.create_session("lease-cmd-session");
        let first = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "first-control".to_owned(),
                requested_permission: PermissionClass::Control,
            })
            .expect("first attach should succeed");
        let second = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "second-control".to_owned(),
                requested_permission: PermissionClass::Control,
            })
            .expect("second attach should succeed");

        manager
            .request_lease(&created.session_id, &first.snapshot.client_view.client_id)
            .expect("first request should succeed");

        let router = CommandRouter::new();
        let result = router.route(
            &mut manager,
            CommandEnvelope {
                message_type: COMMAND_MESSAGE_TYPE.to_owned(),
                schema_version: SCHEMA_VERSION.to_owned(),
                session_id: created.session_id,
                request_id: "req_lease_fail".to_owned(),
                client_id: second.snapshot.client_view.client_id,
                client_seq: 1,
                op: "lease.request".to_owned(),
                scope: CommandScope::SceneShared,
                requires_lease: false,
                args: CommandArgs::LeaseRequest,
            },
        );

        assert_eq!(
            result
                .expect_err("request should fail when held by another client")
                .code,
            CommandErrorCode::LeaseUnavailable
        );
    }

    #[test]
    fn routes_lease_request_and_steal_with_passive_events() {
        let mut manager = SessionManager::new();
        let created = manager.create_session("lease-cmd-session");
        let first = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "first-control".to_owned(),
                requested_permission: PermissionClass::Control,
            })
            .expect("first attach should succeed");
        let second = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "second-control".to_owned(),
                requested_permission: PermissionClass::Control,
            })
            .expect("second attach should succeed");

        let router = CommandRouter::new();
        let request_outcome = router
            .route(
                &mut manager,
                CommandEnvelope {
                    message_type: COMMAND_MESSAGE_TYPE.to_owned(),
                    schema_version: SCHEMA_VERSION.to_owned(),
                    session_id: created.session_id.clone(),
                    request_id: "req_lease_request".to_owned(),
                    client_id: first.snapshot.client_view.client_id.clone(),
                    client_seq: 1,
                    op: "lease.request".to_owned(),
                    scope: CommandScope::SceneShared,
                    requires_lease: false,
                    args: CommandArgs::LeaseRequest,
                },
            )
            .expect("lease request should succeed");

        let steal_outcome = router
            .route(
                &mut manager,
                CommandEnvelope {
                    message_type: COMMAND_MESSAGE_TYPE.to_owned(),
                    schema_version: SCHEMA_VERSION.to_owned(),
                    session_id: created.session_id,
                    request_id: "req_lease_steal".to_owned(),
                    client_id: second.snapshot.client_view.client_id.clone(),
                    client_seq: 2,
                    op: "lease.steal".to_owned(),
                    scope: CommandScope::SceneShared,
                    requires_lease: false,
                    args: CommandArgs::LeaseSteal,
                },
            )
            .expect("lease steal should succeed");

        assert!(request_outcome.ack.accepted);
        assert_eq!(request_outcome.events.len(), 1);
        assert_eq!(
            request_outcome.events[0].event_type,
            EventType::LeaseChanged
        );
        assert!(matches!(
            request_outcome.events[0].payload,
            EventPayload::LeaseChanged(_)
        ));

        assert!(steal_outcome.ack.accepted);
        assert_eq!(steal_outcome.events.len(), 1);
        assert_eq!(steal_outcome.events[0].event_type, EventType::LeaseChanged);
        let payload = match &steal_outcome.events[0].payload {
            EventPayload::LeaseChanged(payload) => payload,
            _ => panic!("expected lease changed payload"),
        };
        assert_eq!(
            payload.previous_lease_holder_client_id.as_deref(),
            Some(first.snapshot.client_view.client_id.as_str())
        );
        assert_eq!(
            payload.lease_state.lease_holder_client_id.as_deref(),
            Some(second.snapshot.client_view.client_id.as_str())
        );

        let audit_log = manager
            .audit_log(&request_outcome.ack.session_id)
            .expect("audit log lookup should succeed");
        assert_eq!(audit_log.len(), 2);
    }

    #[test]
    fn maps_permission_failures_to_typed_error_envelopes() {
        let mut manager = SessionManager::new();
        let created = manager.create_session("typed-error-session");
        let attached = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "view-client".to_owned(),
                requested_permission: PermissionClass::View,
            })
            .expect("attach should succeed");

        let router = CommandRouter::new();
        let command = CommandEnvelope {
            message_type: COMMAND_MESSAGE_TYPE.to_owned(),
            schema_version: SCHEMA_VERSION.to_owned(),
            session_id: created.session_id,
            request_id: "req_typed_perm".to_owned(),
            client_id: attached.snapshot.client_view.client_id,
            client_seq: 1,
            op: "scene.add_source".to_owned(),
            scope: CommandScope::SceneShared,
            requires_lease: true,
            args: CommandArgs::SceneAddSource {
                name: "source-a".to_owned(),
                uri: "/tmp/unused.tiff".to_owned(),
            },
        };

        let error = router
            .route(&mut manager, command.clone())
            .expect_err("permission check should fail");
        let envelope = command_error_to_envelope(&command, &error);

        assert_eq!(envelope.code, ErrorCode::PermissionDenied);
        assert_eq!(envelope.message_type, crate::constants::ERROR_MESSAGE_TYPE);
        match envelope.details {
            ErrorDetails::PermissionDenied(detail) => {
                assert_eq!(detail.required_scope, ErrorScope::SceneShared);
            }
            other => panic!("unexpected detail variant: {other:?}"),
        }
    }

    #[test]
    fn route_or_error_envelope_uses_typed_not_found_details() {
        let mut manager = SessionManager::new();
        let router = CommandRouter::new();
        let command = CommandEnvelope {
            message_type: COMMAND_MESSAGE_TYPE.to_owned(),
            schema_version: SCHEMA_VERSION.to_owned(),
            session_id: "sess_missing".to_owned(),
            request_id: "req_typed_not_found".to_owned(),
            client_id: "cli_00000001".to_owned(),
            client_seq: 1,
            op: "view.set_active_layer".to_owned(),
            scope: CommandScope::ClientView,
            requires_lease: false,
            args: CommandArgs::ViewSetActiveLayer {
                active_layer_id: None,
            },
        };

        let error = router
            .route(&mut manager, command.clone())
            .expect_err("missing session should produce a route error");
        let error_envelope = command_error_to_envelope(&command, &error);

        assert_eq!(error_envelope.code, ErrorCode::NotFound);
        assert!(!error_envelope.retryable);
        match error_envelope.details {
            ErrorDetails::NotFound(detail) => {
                assert_eq!(detail.resource, NotFoundResource::Session);
                assert_eq!(detail.resource_id.as_deref(), Some("sess_missing"));
            }
            other => panic!("unexpected detail variant: {other:?}"),
        }
    }

    #[test]
    fn route_or_error_envelope_maps_lease_hold_conflict_without_string_parsing() {
        let mut manager = SessionManager::new();
        let created = manager.create_session("typed-lease-session");
        let first = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "first-control".to_owned(),
                requested_permission: PermissionClass::Control,
            })
            .expect("first attach should succeed");
        let second = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "second-control".to_owned(),
                requested_permission: PermissionClass::Control,
            })
            .expect("second attach should succeed");

        manager
            .request_lease(&created.session_id, &first.snapshot.client_view.client_id)
            .expect("first request should succeed");

        let router = CommandRouter::new();
        let command = CommandEnvelope {
            message_type: COMMAND_MESSAGE_TYPE.to_owned(),
            schema_version: SCHEMA_VERSION.to_owned(),
            session_id: created.session_id,
            request_id: "req_typed_lease".to_owned(),
            client_id: second.snapshot.client_view.client_id,
            client_seq: 1,
            op: "lease.request".to_owned(),
            scope: CommandScope::SceneShared,
            requires_lease: false,
            args: CommandArgs::LeaseRequest,
        };
        let error = router
            .route(&mut manager, command.clone())
            .expect_err("lease hold conflict should fail routing");
        let error_envelope = command_error_to_envelope(&command, &error);

        assert_eq!(error_envelope.code, ErrorCode::LeaseRequired);
        assert!(error_envelope.retryable);
        match error_envelope.details {
            ErrorDetails::LeaseRequired(detail) => {
                assert_eq!(detail.required_scope, ErrorScope::SceneShared);
                assert_eq!(detail.reason, LeaseErrorReason::LeaseHeldByAnotherClient);
                assert_eq!(detail.current_lease_holder_client_id, None);
            }
            other => panic!("unexpected detail variant: {other:?}"),
        }
    }
}
