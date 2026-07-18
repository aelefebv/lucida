//! Shared identity contract between auth code and feature code.
//!
//! The `AuthPrincipal` is what feature code (saved views, future
//! admin-gated endpoints, audit logs) consumes after authentication. It
//! deliberately knows nothing about how it was derived: stub for dev,
//! Google JWT in production, future providers all flow through the same
//! shape.
//!
//! See `wiki/decisions/0015-server-stored-bookmarks-and-auth-seam.md`
//! for the rationale behind landing this in lucida-core (the shared
//! type) rather than in lucida-server (the trait + extractors).

use serde::{Deserialize, Serialize};

/// Authenticated identity attached to an inbound request.
///
/// `email` is the canonical user identifier (lowercased by the
/// extractor). `display_name` and `picture_url` are presentational and
/// may be empty/`None` depending on what the auth provider supplied.
/// `is_admin` is derived per-request from configuration and is not
/// persisted on any session. `auth_epoch` is a server-internal capability
/// captured while the backing credential is validated. It is deliberately
/// omitted from JSON so `/auth/whoami` does not expose authorization
/// bookkeeping and clients cannot manufacture a newer capability.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthPrincipal {
    pub email: String,
    pub display_name: String,
    pub picture_url: Option<String>,
    pub is_admin: bool,
    #[serde(skip)]
    pub auth_epoch: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_epoch_is_not_exposed_or_accepted_over_json() {
        let principal = AuthPrincipal {
            email: "alice@example.com".into(),
            display_name: "Alice".into(),
            picture_url: None,
            is_admin: false,
            auth_epoch: 41,
        };
        let encoded = serde_json::to_value(&principal).unwrap();
        assert!(encoded.get("auth_epoch").is_none());

        let mut claimed = encoded;
        claimed["auth_epoch"] = serde_json::json!(99);
        let decoded: AuthPrincipal = serde_json::from_value(claimed).unwrap();
        assert_eq!(decoded.auth_epoch, 0);
    }
}
