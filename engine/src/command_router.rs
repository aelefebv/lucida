use crate::constants::{COMMAND_ACK_MESSAGE_TYPE, COMMAND_MESSAGE_TYPE, SCHEMA_VERSION};
use crate::errors::SessionError;
use crate::model::PermissionClass;
use crate::session_manager::SessionManager;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandScope {
    ClientView,
    SceneShared,
    Admin,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandArgs {
    ViewSetActiveLayer { active_layer_id: Option<String> },
    SceneAddSource { name: String },
    SceneLayerAdd { name: String },
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandErrorCode {
    ValidationError,
    UnknownOperation,
    PermissionDenied,
    LeaseRequired,
    SessionNotFound,
    ClientNotFound,
    SourceNotFound,
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
}

impl Operation {
    fn parse(op: &str) -> Result<Self, CommandError> {
        match op {
            "view.set_active_layer" => Ok(Self::ViewSetActiveLayer),
            "scene.add_source" => Ok(Self::SceneAddSource),
            "scene.layer_add" => Ok(Self::SceneLayerAdd),
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
        }
    }

    const fn expected_requires_lease(self) -> bool {
        match self {
            Operation::ViewSetActiveLayer => false,
            Operation::SceneAddSource => true,
            Operation::SceneLayerAdd => true,
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
    ) -> Result<CommandAck, CommandError> {
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
        | (Operation::SceneLayerAdd, CommandArgs::SceneLayerAdd { .. }) => Ok(operation),
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
) -> Result<CommandAck, CommandError> {
    let mut resulting_scene_rev = None;
    let mut resulting_view_rev = None;
    let mut created_object_id = None;

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
        }
        (Operation::SceneAddSource, CommandArgs::SceneAddSource { name }) => {
            let source = session_manager
                .add_source(&envelope.session_id, name)
                .map_err(CommandError::from)?;
            created_object_id = Some(source.source_id);
            let (_, scene_rev) = session_manager
                .session_and_scene_revisions(&envelope.session_id)
                .map_err(CommandError::from)?;
            resulting_scene_rev = Some(scene_rev);
        }
        (Operation::SceneLayerAdd, CommandArgs::SceneLayerAdd { name }) => {
            let layer = session_manager
                .add_layer(&envelope.session_id, name)
                .map_err(CommandError::from)?;
            created_object_id = Some(layer.layer_id);
            let (_, scene_rev) = session_manager
                .session_and_scene_revisions(&envelope.session_id)
                .map_err(CommandError::from)?;
            resulting_scene_rev = Some(scene_rev);
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

    Ok(CommandAck {
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
    })
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
            SessionError::LayerNotFound {
                session_id,
                layer_id,
            } => Self {
                code: CommandErrorCode::LayerNotFound,
                message: format!("layer `{layer_id}` was not found in session `{session_id}`"),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::model::{AttachRequest, PermissionClass};

    use super::{CommandArgs, CommandEnvelope, CommandErrorCode, CommandRouter, CommandScope};
    use crate::constants::{COMMAND_MESSAGE_TYPE, SCHEMA_VERSION};
    use crate::session_manager::SessionManager;

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
                },
            },
        );

        assert_eq!(
            result.expect_err("expected lease enforcement to fail").code,
            CommandErrorCode::LeaseRequired
        );
    }

    #[test]
    fn routes_valid_commands_and_returns_typed_ack() {
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

        let view_ack = router
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

        let scene_ack = router
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
                    },
                },
            )
            .expect("scene command should be accepted");

        assert!(view_ack.accepted);
        assert_eq!(view_ack.resulting_view_rev, Some(1));
        assert!(view_ack.resulting_session_rev >= 3);
        assert_eq!(view_ack.resulting_scene_rev, None);

        assert!(scene_ack.accepted);
        assert!(scene_ack.resulting_scene_rev.is_some());
        assert!(scene_ack.resulting_session_rev > view_ack.resulting_session_rev);
        assert!(
            scene_ack
                .created_object_id
                .expect("source id should be present")
                .starts_with("src_")
        );
    }
}
