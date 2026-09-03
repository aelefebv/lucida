//! Storage backends: where the server's persistent state lives.
//!
//! A **storage backend** owns one database connection, runs the
//! migrations against it, and hands out the six stores the rest of the
//! server programs against. A **store** is one of those six — it holds
//! a single kind of record and knows nothing about how the connection
//! was made.
//!
//! Which backend runs is a matter of configuration, not compilation.
//! `LUCIDA_DB_URL` carries a connection string, its scheme names a
//! backend, and [`open`] matches on that scheme once at startup. This
//! is the shape ADR-0017 established for authentication providers, and
//! it is here for the same reason: adding a backend should be one pull
//! request against this module, not a change to every site that reads
//! or writes a row.
//!
//! Module map:
//!
//! - `url` — [`DatabaseUrl`], the parsed connection string, and the
//!   [`Scheme`] enum that [`open`] dispatches on.
//! - `sqlite` — [`SqliteStorageBackend`], the only backend [`open`] can
//!   select.
//! - `postgres` — [`PostgresStorageBackend`], which serves one of the six
//!   stores and is reached only by tests. See ADR-0058.
//! - `conformance` (tests) — one suite per store trait, run against
//!   every implementation of that trait.
//! - `test_support` (tests) — how a test opens a database, written once.
//!
//! See ADR-0055 for why the seam exists.

#[cfg(test)]
mod conformance;
mod postgres;
mod sqlite;
#[cfg(test)]
pub(crate) mod test_support;
mod url;

// `pub` even though `open` cannot select this backend and only tests
// construct it: anything narrower makes the type dead code in a release
// build, and a `cfg(test)` module would drop it from the ordinary build.
pub use postgres::PostgresStorageBackend;
pub use sqlite::SqliteStorageBackend;
pub use url::{DatabaseUrl, DatabaseUrlError, Scheme};

use std::sync::Arc;

use crate::auth::{
    BearerTokenStore, CliTokenAuthorizationStore, LoginSessionStore, PendingAuthStore,
};
use crate::bookmarks::BookmarkStore;
use crate::workspace::WorkspaceStore;

/// Why a storage backend could not be brought up. Both variants are
/// startup failures: the server reports them and exits rather than
/// serving requests against a database it cannot reach.
///
/// `target` is the redacted connection string, never the raw one.
#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("cannot open the database at {target}: {reason}")]
    Connect { target: String, reason: String },
    #[error("cannot migrate the database at {target}: {reason}")]
    Migrate { target: String, reason: String },
}

/// One database, and the six stores that read and write it.
///
/// Implementations are constructed by [`open`] and shared as
/// `Arc<dyn StorageBackend>`. Every accessor returns a handle over the
/// same connection pool, so the stores share one connection budget and
/// one transaction domain, and calling an accessor twice is cheap.
pub trait StorageBackend: Send + Sync + std::fmt::Debug {
    fn login_sessions(&self) -> Arc<dyn LoginSessionStore>;
    fn pending_auth(&self) -> Arc<dyn PendingAuthStore>;
    fn bearer_tokens(&self) -> Arc<dyn BearerTokenStore>;
    fn cli_token_authorizations(&self) -> Arc<dyn CliTokenAuthorizationStore>;
    fn bookmarks(&self) -> Arc<dyn BookmarkStore>;
    fn workspaces(&self) -> Arc<dyn WorkspaceStore>;
}

/// Connect to the database named by `url`, migrate it, and return the
/// backend that serves it.
///
/// The match is exhaustive with no fallback arm, because
/// [`DatabaseUrl::parse`] has already rejected every scheme this build
/// does not implement.
pub async fn open(url: &DatabaseUrl) -> Result<Arc<dyn StorageBackend>, StorageError> {
    match url.scheme() {
        Scheme::Sqlite => Ok(Arc::new(SqliteStorageBackend::open(url).await?)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every scheme the configuration layer accepts must also be one
    /// `open` can serve. The dispatch arm is compiler-checked, but
    /// whether the backend behind it actually comes up is not.
    #[tokio::test]
    async fn open_serves_every_scheme() {
        for scheme in Scheme::ALL {
            let url = match scheme {
                Scheme::Sqlite => DatabaseUrl::in_memory(),
            };
            open(&url)
                .await
                .unwrap_or_else(|e| panic!("{scheme} is accepted but cannot be opened: {e}"));
        }
    }

    #[tokio::test]
    async fn every_store_is_reachable_through_the_trait() {
        let backend = open(&DatabaseUrl::in_memory()).await.unwrap();
        // Each accessor runs a read against the migrated schema, which
        // proves the store is wired to a table that exists.
        backend.login_sessions().get("absent").await.unwrap();
        backend.pending_auth().consume("absent").await.unwrap();
        backend.bearer_tokens().get_by_hash("absent").await.unwrap();
        backend
            .cli_token_authorizations()
            .get_for_poll("absent", "absent")
            .await
            .unwrap();
        backend.bookmarks().get("absent").await.unwrap();
        backend.workspaces().get_workspace("absent").await.unwrap();
    }
}
