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
use crate::persistence::{
    PersistenceCompletion, PersistenceIndeterminateCause, PersistenceRecoveryDisposition,
};
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
        authenticated_email: Option<String>,
    ) -> Result<Option<BearerToken>, BearerTokenStoreError> {
        let command = CredentialMutation::RevokeBearer {
            store,
            token_hash,
            now,
            authenticated_email,
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
        authenticated_email: Option<String>,
    ) -> Result<Option<LoginSession>, SessionStoreError> {
        let command = CredentialMutation::DeleteSession {
            store,
            session_id,
            authenticated_email,
        };
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
                    authenticated_email,
                } => {
                    let row = match store.begin_revoke_by_hash(&token_hash, now).resolve().await {
                        PersistenceCompletion::Committed(row) => row,
                        PersistenceCompletion::DefinitelyNotCommitted(error) => {
                            return Err(CredentialMutationError::Bearer(error));
                        }
                        PersistenceCompletion::RecoverablyIndeterminate(indeterminate) => {
                            let detail = indeterminate.to_string();
                            let (operation_id, cause, recovery, deadline) =
                                indeterminate.into_parts();
                            match (cause, recovery) {
                                (
                                    PersistenceIndeterminateCause::Backend(error),
                                    PersistenceRecoveryDisposition::Quiesced,
                                ) => match tokio::time::timeout(
                                    deadline.duration(),
                                    store.get_by_hash(&token_hash),
                                )
                                .await
                                {
                                    Ok(Ok(Some(row))) if row.revoked_at.is_some() => {
                                        tracing::warn!(token_id = %row.id, "auth.bearer_revoke_commit_recovered");
                                        Some(row)
                                    }
                                    Ok(Ok(_)) => {
                                        return Err(CredentialMutationError::Bearer(error));
                                    }
                                    Ok(Err(readback)) => {
                                        if let Some(manager) = &manager {
                                            manager
                                                .fail_closed_bearer_persistence(
                                                    &token_hash,
                                                    authenticated_email.as_deref(),
                                                    false,
                                                )
                                                .await;
                                        }
                                        return Err(CredentialMutationError::Bearer(
                                            BearerTokenStoreError::RecoverablyIndeterminate {
                                                operation_id,
                                                recovery: PersistenceRecoveryDisposition::Quiesced,
                                                detail: format!(
                                                    "{detail}; durable read-back failed ({readback})"
                                                ),
                                            },
                                        ));
                                    }
                                    Err(_) => {
                                        if let Some(manager) = &manager {
                                            manager
                                                .fail_closed_bearer_persistence(
                                                    &token_hash,
                                                    authenticated_email.as_deref(),
                                                    false,
                                                )
                                                .await;
                                        }
                                        return Err(CredentialMutationError::Bearer(
                                            BearerTokenStoreError::RecoverablyIndeterminate {
                                                operation_id,
                                                recovery: PersistenceRecoveryDisposition::Quiesced,
                                                detail: format!(
                                                    "{detail}; durable read-back exceeded {deadline:?}"
                                                ),
                                            },
                                        ));
                                    }
                                },
                                _ => {
                                    if let Some(manager) = &manager {
                                        manager
                                            .fail_closed_bearer_persistence(
                                                &token_hash,
                                                authenticated_email.as_deref(),
                                                recovery
                                                    == PersistenceRecoveryDisposition::RestartRequired,
                                            )
                                            .await;
                                    }
                                    return Err(CredentialMutationError::Bearer(
                                        BearerTokenStoreError::RecoverablyIndeterminate {
                                            operation_id,
                                            recovery,
                                            detail,
                                        },
                                    ));
                                }
                            }
                        }
                    };
                    let email = row.as_ref().map(|row| row.email.clone());
                    (CredentialMutationResult::Bearer(row), email)
                }
                CredentialMutation::DeleteSession {
                    store,
                    session_id,
                    authenticated_email,
                } => {
                    let (row, recovered_delete) =
                        match store.begin_delete(&session_id).resolve().await {
                            PersistenceCompletion::Committed(row) => (row, false),
                            PersistenceCompletion::DefinitelyNotCommitted(error) => {
                                return Err(CredentialMutationError::Session(error));
                            }
                            PersistenceCompletion::RecoverablyIndeterminate(indeterminate) => {
                                let detail = indeterminate.to_string();
                                let (operation_id, cause, recovery, deadline) =
                                    indeterminate.into_parts();
                                match (cause, recovery) {
                                    (
                                        PersistenceIndeterminateCause::Backend(error),
                                        PersistenceRecoveryDisposition::Quiesced,
                                    ) => match tokio::time::timeout(
                                        deadline.duration(),
                                        store.get(&session_id),
                                    )
                                    .await
                                    {
                                        Ok(Ok(None)) => {
                                            tracing::warn!("auth.session_delete_commit_recovered");
                                            (None, true)
                                        }
                                        Ok(Ok(Some(_))) => {
                                            return Err(CredentialMutationError::Session(error));
                                        }
                                        Ok(Err(readback)) => {
                                            if let Some(manager) = &manager {
                                                manager
                                                    .fail_closed_session_persistence(
                                                        &session_id,
                                                        authenticated_email.as_deref(),
                                                        false,
                                                    )
                                                    .await;
                                            }
                                            return Err(CredentialMutationError::Session(
                                                SessionStoreError::RecoverablyIndeterminate {
                                                    operation_id,
                                                    recovery: PersistenceRecoveryDisposition::Quiesced,
                                                    detail: format!(
                                                        "{detail}; durable read-back failed ({readback})"
                                                    ),
                                                },
                                            ));
                                        }
                                        Err(_) => {
                                            if let Some(manager) = &manager {
                                                manager
                                                    .fail_closed_session_persistence(
                                                        &session_id,
                                                        authenticated_email.as_deref(),
                                                        false,
                                                    )
                                                    .await;
                                            }
                                            return Err(CredentialMutationError::Session(
                                                SessionStoreError::RecoverablyIndeterminate {
                                                    operation_id,
                                                    recovery: PersistenceRecoveryDisposition::Quiesced,
                                                    detail: format!(
                                                        "{detail}; durable read-back exceeded {deadline:?}"
                                                    ),
                                                },
                                            ));
                                        }
                                    },
                                    _ => {
                                        if let Some(manager) = &manager {
                                            manager
                                                .fail_closed_session_persistence(
                                                    &session_id,
                                                    authenticated_email.as_deref(),
                                                    recovery
                                                        == PersistenceRecoveryDisposition::RestartRequired,
                                                )
                                                .await;
                                        }
                                        return Err(CredentialMutationError::Session(
                                            SessionStoreError::RecoverablyIndeterminate {
                                                operation_id,
                                                recovery,
                                                detail,
                                            },
                                        ));
                                    }
                                }
                            }
                        };
                    let email = row.as_ref().map(|row| row.email.clone()).or_else(|| {
                        recovered_delete.then(|| authenticated_email.clone()).flatten()
                    });
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
        authenticated_email: Option<String>,
    },
    DeleteSession {
        store: Arc<dyn LoginSessionStore>,
        session_id: String,
        authenticated_email: Option<String>,
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

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::Duration;

    use async_trait::async_trait;
    use chrono::Utc;
    use lucida_core::auth_principal::AuthPrincipal;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;
    use crate::DatasetRuntimeConfig;
    use crate::auth::MemorySessionStore;
    use crate::persistence::{
        PersistenceDeadline, PersistenceOperation, PersistenceOperationId,
        PersistenceRecoveryDisposition, PersistenceWorkerOutcome,
    };
    use crate::workspace::{SqliteWorkspaceStore, WorkspaceStore};

    struct NeverCompletingSessionStore {
        inner: Arc<MemorySessionStore>,
        last_operation_id: StdMutex<Option<PersistenceOperationId>>,
    }

    impl NeverCompletingSessionStore {
        fn new(inner: Arc<MemorySessionStore>) -> Self {
            Self {
                inner,
                last_operation_id: StdMutex::new(None),
            }
        }

        fn last_operation_id(&self) -> PersistenceOperationId {
            self.last_operation_id
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .expect("credential persistence operation must have started")
        }
    }

    #[async_trait]
    impl LoginSessionStore for NeverCompletingSessionStore {
        async fn create(&self, session: LoginSession) -> Result<(), SessionStoreError> {
            self.inner.create(session).await
        }

        async fn get(&self, id: &str) -> Result<Option<LoginSession>, SessionStoreError> {
            self.inner.get(id).await
        }

        async fn touch_last_used(
            &self,
            id: &str,
            now: DateTime<Utc>,
        ) -> Result<(), SessionStoreError> {
            self.inner.touch_last_used(id, now).await
        }

        async fn delete(&self, id: &str) -> Result<Option<LoginSession>, SessionStoreError> {
            self.inner.delete(id).await
        }

        fn begin_delete(
            &self,
            _id: &str,
        ) -> PersistenceOperation<Option<LoginSession>, SessionStoreError> {
            let operation = PersistenceOperation::spawn(
                PersistenceDeadline::bounded(Duration::from_millis(10)),
                std::future::pending(),
                std::future::pending,
            );
            *self
                .last_operation_id
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) =
                Some(operation.operation_id());
            operation
        }

        async fn delete_expired(&self, now: DateTime<Utc>) -> Result<u64, SessionStoreError> {
            self.inner.delete_expired(now).await
        }
    }

    struct StalledReconciliationSessionStore {
        inner: Arc<MemorySessionStore>,
        last_operation_id: StdMutex<Option<PersistenceOperationId>>,
    }

    impl StalledReconciliationSessionStore {
        fn new(inner: Arc<MemorySessionStore>) -> Self {
            Self {
                inner,
                last_operation_id: StdMutex::new(None),
            }
        }

        fn last_operation_id(&self) -> PersistenceOperationId {
            self.last_operation_id
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .expect("credential persistence operation must have started")
        }
    }

    #[async_trait]
    impl LoginSessionStore for StalledReconciliationSessionStore {
        async fn create(&self, session: LoginSession) -> Result<(), SessionStoreError> {
            self.inner.create(session).await
        }

        async fn get(&self, _id: &str) -> Result<Option<LoginSession>, SessionStoreError> {
            std::future::pending().await
        }

        async fn touch_last_used(
            &self,
            id: &str,
            now: DateTime<Utc>,
        ) -> Result<(), SessionStoreError> {
            self.inner.touch_last_used(id, now).await
        }

        async fn delete(&self, id: &str) -> Result<Option<LoginSession>, SessionStoreError> {
            self.inner.delete(id).await
        }

        fn begin_delete(
            &self,
            _id: &str,
        ) -> PersistenceOperation<Option<LoginSession>, SessionStoreError> {
            let operation = PersistenceOperation::spawn(
                PersistenceDeadline::bounded(Duration::from_millis(10)),
                async {
                    PersistenceWorkerOutcome::RecoverablyIndeterminate(SessionStoreError::Backend(
                        "injected session completion loss after quiescence".into(),
                    ))
                },
                || async { true },
            );
            *self
                .last_operation_id
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) =
                Some(operation.operation_id());
            operation
        }

        async fn delete_expired(&self, now: DateTime<Utc>) -> Result<u64, SessionStoreError> {
            self.inner.delete_expired(now).await
        }
    }

    #[tokio::test]
    async fn stalled_credential_reconciliation_returns_quiesced_indeterminate_without_a_restart_tombstone()
     {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(":memory:")
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let workspace_store = SqliteWorkspaceStore::new(pool);
        let manager = Arc::new(WorkspaceManager::new(
            Arc::new(workspace_store.clone()),
            DatasetRuntimeConfig::defaults(),
        ));
        let principal = AuthPrincipal {
            email: "stalled-credential@example.com".into(),
            display_name: "Stalled Credential".into(),
            picture_url: None,
            is_admin: false,
            auth_epoch: 0,
        };
        let workspace = workspace_store
            .create_workspace(&principal, Some("Credential reconciliation fail-close"))
            .await
            .unwrap();
        let attachment = manager
            .attach_workspace(&workspace.id, &principal)
            .await
            .unwrap();
        let old_live = Arc::clone(attachment.live());
        let (route_tx, mut route_rx, route_process_budget) =
            crate::outbox::unicast_channel_with_process_budget_probe(4, 1024, 4096);
        let route_payload_baseline = route_tx.queued_bytes();
        old_live
            .unicast_routes
            .lock()
            .await
            .insert(201, route_tx.clone());
        let lease = manager
            .register_attachment_connection(&attachment, 201, &principal)
            .await
            .unwrap();

        let inner = Arc::new(MemorySessionStore::new());
        let now = Utc::now();
        let session = LoginSession {
            id: "stalled-session".into(),
            email: principal.email.clone(),
            display_name: principal.display_name.clone(),
            picture_url: None,
            created_at: now,
            last_used_at: now,
            expires_at: now + chrono::Duration::hours(1),
        };
        inner.create(session.clone()).await.unwrap();
        let credential_store = Arc::new(StalledReconciliationSessionStore::new(Arc::clone(&inner)));
        let executor = CredentialMutationExecutor::new(Some(Arc::clone(&manager)));

        let started = tokio::time::Instant::now();
        let error = tokio::time::timeout(
            Duration::from_millis(250),
            executor.delete_session(
                credential_store.clone(),
                session.id.clone(),
                Some(principal.email.clone()),
            ),
        )
        .await
        .expect("credential read-back must be bounded by the operation deadline")
        .expect_err("a stalled durable read cannot claim deletion or non-deletion");
        let SessionStoreError::RecoverablyIndeterminate {
            operation_id,
            recovery,
            detail,
        } = error
        else {
            panic!("stalled credential read-back must remain a typed indeterminate");
        };
        assert!(started.elapsed() < Duration::from_millis(250));
        assert_eq!(operation_id, credential_store.last_operation_id());
        assert_eq!(recovery, PersistenceRecoveryDisposition::Quiesced);
        assert!(detail.contains(&operation_id.to_string()));
        assert_eq!(inner.get(&session.id).await.unwrap(), Some(session.clone()));

        assert!(lease.is_revoked());
        assert!(lease.begin_operation().await.is_none());
        assert!(
            !manager
                .auth_epoch_registry()
                .is_blocked(&principal.email)
                .await,
            "Quiesced uncertainty must not be upgraded to a restart tombstone"
        );
        assert!(
            !manager
                .auth_epoch_registry()
                .is_session_blocked(&session.id)
                .await
        );
        assert_eq!(
            manager
                .auth_epoch_registry()
                .blocked_principal_count()
                .await,
            0
        );
        let close = tokio::time::timeout(Duration::from_millis(250), route_rx.recv())
            .await
            .expect("credential fail-close must release its revocation guard")
            .expect("credential fail-close must close the stale route");
        assert!(matches!(close, axum::extract::ws::Message::Close(_)));
        drop(close);
        assert!(route_rx.try_recv().is_err());
        assert_eq!(route_tx.queued_bytes(), route_payload_baseline);
        tokio::time::timeout(Duration::from_millis(100), async {
            while crate::persistence::persistence_operation_resources(operation_id)
                != (false, false)
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("stalled credential reconciliation must release operation resources");
        assert_eq!(
            crate::persistence::persistence_operation_resources(operation_id),
            (false, false)
        );

        old_live.unicast_routes.lock().await.clear();
        drop(attachment);
        drop(old_live);
        drop(route_tx);
        drop(route_rx);
        assert_eq!(route_process_budget.queued_bytes(), 0);
    }

    #[tokio::test]
    async fn never_completing_credential_revocation_returns_typed_indeterminate_and_blocks_principal_until_restart()
     {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(":memory:")
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let workspace_store = SqliteWorkspaceStore::new(pool);
        let manager = Arc::new(WorkspaceManager::new(
            Arc::new(workspace_store.clone()),
            DatasetRuntimeConfig::defaults(),
        ));
        let principal = AuthPrincipal {
            email: "never-credential@example.com".into(),
            display_name: "Never Credential".into(),
            picture_url: None,
            is_admin: false,
            auth_epoch: 0,
        };
        let workspace = workspace_store
            .create_workspace(&principal, Some("Credential fail-close"))
            .await
            .unwrap();
        let attachment = manager
            .attach_workspace(&workspace.id, &principal)
            .await
            .unwrap();
        let old_live = Arc::clone(attachment.live());
        let (route_tx, mut route_rx, route_process_budget) =
            crate::outbox::unicast_channel_with_process_budget_probe(4, 1024, 4096);
        let route_payload_baseline = route_tx.queued_bytes();
        old_live
            .unicast_routes
            .lock()
            .await
            .insert(211, route_tx.clone());
        let lease = manager
            .register_attachment_connection(&attachment, 211, &principal)
            .await
            .unwrap();

        let inner = Arc::new(MemorySessionStore::new());
        let now = Utc::now();
        let session = LoginSession {
            id: "never-session".into(),
            email: principal.email.clone(),
            display_name: principal.display_name.clone(),
            picture_url: None,
            created_at: now,
            last_used_at: now,
            expires_at: now + chrono::Duration::hours(1),
        };
        inner.create(session.clone()).await.unwrap();
        let credential_store = Arc::new(NeverCompletingSessionStore::new(Arc::clone(&inner)));
        let executor = CredentialMutationExecutor::new(Some(Arc::clone(&manager)));

        let started = tokio::time::Instant::now();
        let error = tokio::time::timeout(
            Duration::from_millis(250),
            executor.delete_session(
                credential_store.clone(),
                session.id.clone(),
                Some(principal.email.clone()),
            ),
        )
        .await
        .expect("credential mutation and recovery deadlines must bound return")
        .expect_err("an unquiesced credential mutation cannot claim deletion or non-deletion");
        let SessionStoreError::RecoverablyIndeterminate {
            operation_id,
            recovery,
            detail,
        } = error
        else {
            panic!("credential deadline must remain typed as indeterminate");
        };
        assert!(started.elapsed() < Duration::from_millis(250));
        assert_eq!(operation_id, credential_store.last_operation_id());
        assert_eq!(recovery, PersistenceRecoveryDisposition::RestartRequired);
        assert!(detail.contains(&operation_id.to_string()));
        assert_eq!(inner.get(&session.id).await.unwrap(), Some(session.clone()));

        assert!(lease.is_revoked());
        assert!(lease.begin_operation().await.is_none());
        assert!(
            manager
                .auth_epoch_registry()
                .is_blocked(&principal.email)
                .await,
            "unquiesced credential state must create a process-lifetime auth tombstone"
        );
        assert!(
            manager
                .auth_epoch_registry()
                .is_session_blocked(&session.id)
                .await,
            "the affected credential key must remain blocked even if principal context is unavailable"
        );
        assert_eq!(
            manager
                .auth_epoch_registry()
                .blocked_principal_count()
                .await,
            1,
            "restart-required state must retain one bounded tombstone, not work"
        );
        let close = tokio::time::timeout(Duration::from_millis(250), route_rx.recv())
            .await
            .expect("credential fail-close must release its revocation guard")
            .expect("credential fail-close must close the live route");
        assert!(matches!(close, axum::extract::ws::Message::Close(_)));
        drop(close);
        assert!(route_rx.try_recv().is_err());
        assert_eq!(route_tx.queued_bytes(), route_payload_baseline);

        tokio::time::timeout(Duration::from_millis(100), async {
            while crate::persistence::persistence_operation_resources(operation_id)
                != (false, false)
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("restart-required return must retain no worker, controller, or recovery future");

        old_live.unicast_routes.lock().await.clear();
        drop(attachment);
        drop(old_live);
        drop(route_tx);
        drop(route_rx);
        assert_eq!(route_process_budget.queued_bytes(), 0);
    }
}
