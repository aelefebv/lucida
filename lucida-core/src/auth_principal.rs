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
/// persisted on any session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthPrincipal {
    pub email: String,
    pub display_name: String,
    pub picture_url: Option<String>,
    pub is_admin: bool,
}
