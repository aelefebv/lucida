//! Authentication: the auth modes, the session, token, and pending-auth
//! stores, and the middleware that resolves each request to a principal.
//!
//! A store with two SQL implementations keeps its statements in a `*_sql`
//! module the two run, rather than in a second copy of the SQL. The Rust is
//! written once per engine, because code generic over the engine needs a
//! trait bound for every type it binds or decodes.

pub mod anonymous;
#[cfg(test)]
mod audit_event_tests;
pub mod bearer_token;
pub mod bearer_token_memory;
pub mod bearer_token_postgres;
pub(crate) mod bearer_token_sql;
pub mod bearer_token_sqlite;
pub mod cleanup;
pub mod cli_authorization;
pub mod cli_authorization_memory;
pub mod cli_authorization_postgres;
pub(crate) mod cli_authorization_sql;
pub mod cli_authorization_sqlite;
pub mod config;
pub mod cookie;
pub mod dev;
pub mod directory;
pub mod error_page;
pub mod extractors;
pub mod google_oauth;
pub mod handlers;
pub mod iap;
pub mod middleware;
pub mod pending_auth;
pub mod pending_auth_memory;
pub mod pending_auth_postgres;
pub(crate) mod pending_auth_sql;
pub mod pending_auth_sqlite;
pub mod principal;
pub mod session_store;
pub mod session_store_memory;
pub mod session_store_postgres;
pub(crate) mod session_store_sql;
pub mod session_store_sqlite;
pub mod unauth_landing;

pub use bearer_token::{BearerToken, BearerTokenStore, BearerTokenStoreError, hash_bearer_token};
pub use bearer_token_memory::MemoryBearerTokenStore;
pub use bearer_token_postgres::PostgresBearerTokenStore;
pub use bearer_token_sqlite::SqliteBearerTokenStore;
pub use cleanup::{CleanupState, spawn as spawn_cleanup};
pub use cli_authorization::{
    CliTokenAuthorization, CliTokenAuthorizationStore, CliTokenAuthorizationStoreError,
};
pub use cli_authorization_memory::MemoryCliTokenAuthorizationStore;
pub use cli_authorization_postgres::PostgresCliTokenAuthorizationStore;
pub use cli_authorization_sqlite::SqliteCliTokenAuthorizationStore;
pub use config::{
    AuthConfig, AuthConfigError, AuthMode, DirectoryConfig, GoogleOAuthConfig, IapConfig,
    LOGOUT_PATH,
};
pub use directory::{DirectoryError, ProfileDirectory};
pub use extractors::AdminRequired;
pub use google_oauth::{GoogleOAuthClient, OAuthError, VerifiedClaims};
pub use iap::{IapAssertionExtractor, IapError, IapVerifier, VerifiedAssertion};
pub use pending_auth::{PendingAuth, PendingAuthStore, PendingAuthStoreError};
pub use pending_auth_memory::MemoryPendingAuthStore;
pub use pending_auth_postgres::PostgresPendingAuthStore;
pub use pending_auth_sqlite::SqlitePendingAuthStore;
pub use principal::{
    AuthError, BearerTokenExtractor, DualCredentialExtractor, GoogleJwtPrincipalExtractor,
    PrincipalExtractor, RejectionReason, SessionCookieExtractor, StubPrincipalExtractor,
    principal_from_claims, principal_or_rejection_from_claims,
};
pub use session_store::{LoginSession, LoginSessionStore, SessionStoreError};
pub use session_store_memory::MemorySessionStore;
pub use session_store_postgres::PostgresSessionStore;
pub use session_store_sqlite::SqliteSessionStore;
