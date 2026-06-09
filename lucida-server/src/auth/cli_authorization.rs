//! Short-lived browser approval requests for CLI bearer credentials.
//!
//! `lucida auth login` creates a pending row containing only a hash of
//! the raw token it generated locally. An authenticated browser approves
//! that row, turning the hash into a persistent bearer-token row. The
//! CLI polls with a separate poll secret and stores its raw token only
//! after approval.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliTokenAuthorization {
    pub id: String,
    pub poll_token_hash: String,
    pub token_hash: String,
    pub user_code: String,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub token_expires_at: DateTime<Utc>,
    pub approved_at: Option<DateTime<Utc>>,
    pub approved_token_id: Option<String>,
    pub approved_email: Option<String>,
}

impl CliTokenAuthorization {
    pub fn is_expired_at(&self, now: DateTime<Utc>) -> bool {
        self.expires_at <= now
    }

    pub fn is_approved(&self) -> bool {
        self.approved_at.is_some()
    }
}

#[derive(Debug, Error)]
pub enum CliTokenAuthorizationStoreError {
    #[error("storage backend error: {0}")]
    Backend(String),
}

#[async_trait]
pub trait CliTokenAuthorizationStore: Send + Sync + 'static {
    async fn create(
        &self,
        request: CliTokenAuthorization,
    ) -> Result<(), CliTokenAuthorizationStoreError>;

    async fn get(
        &self,
        id: &str,
    ) -> Result<Option<CliTokenAuthorization>, CliTokenAuthorizationStoreError>;

    async fn get_for_poll(
        &self,
        id: &str,
        poll_token_hash: &str,
    ) -> Result<Option<CliTokenAuthorization>, CliTokenAuthorizationStoreError>;

    async fn mark_approved(
        &self,
        id: &str,
        token_id: &str,
        email: &str,
        now: DateTime<Utc>,
    ) -> Result<(), CliTokenAuthorizationStoreError>;
}
