//! Cancellation-safe credential invalidation.
//!
//! HTTP request futures are disposable: a client can disconnect after the
//! backing credential has committed but before process-local authorization is
//! revoked. This executor gives the complete durable-mutation -> auth-epoch ->
//! connection-quiescence sequence to an owned Tokio task. Dropping a handler's
//! await only detaches that owner; it cannot split the sequence.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use super::bearer_token::{BearerToken, BearerTokenStore, BearerTokenStoreError};
use super::session_store::{LoginSession, LoginSessionStore, SessionStoreError};
use crate::workspace::WorkspaceManager;

#[derive(Clone)]
pub(crate) struct CredentialMutationExecutor {
    workspace_manager: Option<Arc<WorkspaceManager>>,
}

impl CredentialMutationExecutor {
    pub(crate) fn new(workspace_manager: Option<Arc<WorkspaceManager>>) -> Self {
        Self { workspace_manager }
    }

    pub(crate) async fn revoke_bearer(
        &self,
        store: Arc<dyn BearerTokenStore>,
        token_hash: String,
        now: DateTime<Utc>,
    ) -> Result<Option<BearerToken>, BearerTokenStoreError> {
        let command = CredentialMutation::RevokeBearer {
            store,
            token_hash,
            now,
        };
        match self.execute(command).await.map_err(|error| match error {
            CredentialMutationError::Bearer(error) => error,
            CredentialMutationError::Session(_) => {
                BearerTokenStoreError::Backend("credential worker returned wrong result".into())
            }
            CredentialMutationError::Worker(error) => BearerTokenStoreError::Backend(error),
        })? {
            CredentialMutationResult::Bearer(row) => Ok(row),
            CredentialMutationResult::Session(_) => Err(BearerTokenStoreError::Backend(
                "credential worker returned wrong result".into(),
            )),
        }
    }

    pub(crate) async fn delete_session(
        &self,
        store: Arc<dyn LoginSessionStore>,
        session_id: String,
    ) -> Result<Option<LoginSession>, SessionStoreError> {
        let command = CredentialMutation::DeleteSession { store, session_id };
        match self.execute(command).await.map_err(|error| match error {
            CredentialMutationError::Session(error) => error,
            CredentialMutationError::Bearer(_) => {
                SessionStoreError::Backend("credential worker returned wrong result".into())
            }
            CredentialMutationError::Worker(error) => SessionStoreError::Backend(error),
        })? {
            CredentialMutationResult::Session(row) => Ok(row),
            CredentialMutationResult::Bearer(_) => Err(SessionStoreError::Backend(
                "credential worker returned wrong result".into(),
            )),
        }
    }

    async fn execute(
        &self,
        command: CredentialMutation,
    ) -> Result<CredentialMutationResult, CredentialMutationError> {
        let manager = self.workspace_manager.clone();
        tokio::spawn(async move {
            let (result, email) = match command {
                CredentialMutation::RevokeBearer {
                    store,
                    token_hash,
                    now,
                } => {
                    let row = store
                        .revoke_by_hash(&token_hash, now)
                        .await
                        .map_err(CredentialMutationError::Bearer)?;
                    let email = row.as_ref().map(|row| row.email.clone());
                    (CredentialMutationResult::Bearer(row), email)
                }
                CredentialMutation::DeleteSession { store, session_id } => {
                    let row = store
                        .delete(&session_id)
                        .await
                        .map_err(CredentialMutationError::Session)?;
                    let email = row.as_ref().map(|row| row.email.clone());
                    (CredentialMutationResult::Session(row), email)
                }
            };

            if let (Some(manager), Some(email)) = (manager, email) {
                #[cfg(test)]
                manager.pause_credential_mutation_after_commit().await;
                manager.revoke_principal_connections(&email).await;
            }
            Ok(result)
        })
        .await
        .map_err(|error| {
            CredentialMutationError::Worker(format!("credential worker failed: {error}"))
        })?
    }
}

enum CredentialMutation {
    RevokeBearer {
        store: Arc<dyn BearerTokenStore>,
        token_hash: String,
        now: DateTime<Utc>,
    },
    DeleteSession {
        store: Arc<dyn LoginSessionStore>,
        session_id: String,
    },
}

enum CredentialMutationResult {
    Bearer(Option<BearerToken>),
    Session(Option<LoginSession>),
}

enum CredentialMutationError {
    Bearer(BearerTokenStoreError),
    Session(SessionStoreError),
    Worker(String),
}
