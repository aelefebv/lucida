//! Server-side bearer credentials for CLI/Python clients.
//!
//! Browser sessions keep using httpOnly cookies. Non-browser clients
//! use opaque tokens whose raw value is generated client-side and
//! stored locally by that client; the server stores only a hash plus
//! identity metadata. Extraction yields the same `AuthPrincipal` type
//! as cookie sessions.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use lucida_core::auth_principal::AuthPrincipal;
use thiserror::Error;

use super::config::AuthConfig;
use crate::persistence::{
    PersistenceOperation, PersistenceOperationId, PersistenceRecoveryDisposition,
};

/// One row in `bearer_tokens`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BearerToken {
    pub id: String,
    pub token_hash: String,
    pub name: String,
    pub email: String,
    pub display_name: String,
    pub picture_url: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub expires_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

impl BearerToken {
    pub fn principal(&self, config: &AuthConfig) -> AuthPrincipal {
        AuthPrincipal {
            email: self.email.clone(),
            display_name: self.display_name.clone(),
            picture_url: self.picture_url.clone(),
            is_admin: config
                .admin_emails
                .contains(&self.email.to_ascii_lowercase()),
            auth_epoch: 0,
        }
    }

    pub fn is_active_at(&self, now: DateTime<Utc>) -> bool {
        self.revoked_at.is_none() && self.expires_at > now
    }
}

/// Stable hash for raw bearer credentials.
///
/// BLAKE3 is already a runtime dependency of `lucida-server`; a keyed
/// hash is unnecessary here because the raw token is 256 bits of random
/// material and the hash is used only for database lookup.
pub fn hash_bearer_token(raw: &str) -> String {
    blake3::hash(raw.as_bytes()).to_hex().to_string()
}

#[derive(Debug, Error)]
pub enum BearerTokenStoreError {
    #[error("storage backend error: {0}")]
    Backend(String),
    #[error(
        "persistence operation {operation_id} is recoverably indeterminate ({recovery:?}): {detail}"
    )]
    RecoverablyIndeterminate {
        operation_id: PersistenceOperationId,
        recovery: PersistenceRecoveryDisposition,
        detail: String,
    },
}

#[async_trait]
pub trait BearerTokenStore: Send + Sync + 'static {
    async fn create(&self, token: BearerToken) -> Result<(), BearerTokenStoreError>;

    async fn get_by_hash(
        &self,
        token_hash: &str,
    ) -> Result<Option<BearerToken>, BearerTokenStoreError>;

    async fn touch_last_used(
        &self,
        id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), BearerTokenStoreError>;

    /// Atomically revoke a not-yet-revoked credential and return the row that
    /// won the transition. Missing and already-revoked credentials both
    /// return `None`, so concurrent callers cannot each act as the revocation
    /// owner.
    async fn revoke_by_hash(
        &self,
        token_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<BearerToken>, BearerTokenStoreError>;

    /// Begin a finite backend-owned credential revocation.
    fn begin_revoke_by_hash(
        &self,
        token_hash: &str,
        now: DateTime<Utc>,
    ) -> PersistenceOperation<Option<BearerToken>, BearerTokenStoreError>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::time::Duration;

    fn token() -> BearerToken {
        let now = Utc::now();
        BearerToken {
            id: "tok-1".into(),
            token_hash: hash_bearer_token("lucida_pat_test"),
            name: "laptop".into(),
            email: "Alice@Example.com".into(),
            display_name: "Alice".into(),
            picture_url: None,
            created_at: now,
            last_used_at: None,
            expires_at: now + chrono::Duration::hours(1),
            revoked_at: None,
        }
    }

    #[test]
    fn token_hash_is_stable_and_non_raw() {
        let a = hash_bearer_token("lucida_pat_abc");
        let b = hash_bearer_token("lucida_pat_abc");
        assert_eq!(a, b);
        assert_ne!(a, "lucida_pat_abc");
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn principal_derives_admin_from_config() {
        let mut cfg = AuthConfig::for_tests();
        cfg.admin_emails = HashSet::from(["alice@example.com".to_string()]);

        let principal = token().principal(&cfg);
        assert_eq!(principal.email, "Alice@Example.com");
        assert!(principal.is_admin);

        let mut cfg = AuthConfig::for_tests();
        cfg.admin_emails = HashSet::new();
        assert!(!token().principal(&cfg).is_admin);
        assert_eq!(cfg.hard_cap, Duration::from_secs(720 * 3600));
    }
}
