//! Shared identity contract between auth code and feature code.
//!
//! The `AuthPrincipal` is what feature code consumes after authentication.
//! It knows nothing about how it was derived, so every provider flows through
//! the same shape. The type lives here and the trait and extractors live in
//! lucida-server (ADR 0015).

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
