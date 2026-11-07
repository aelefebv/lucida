//! Storage backends: where the server's persistent state lives.
//!
//! A storage backend owns one database connection, runs the migrations,
//! and hands out the seven stores the rest of the server programs against.
//! A store holds one kind of record and knows nothing about the connection.
//! [`open`] picks the backend from `LUCIDA_DB_URL`'s scheme once at
//! startup, so adding a backend touches this module and no call site.

#[cfg(test)]
mod conformance;
#[cfg(test)]
mod end_to_end;
mod postgres;
mod sqlite;
#[cfg(test)]
pub(crate) mod test_support;
mod url;

pub use postgres::PostgresStorageBackend;
pub use sqlite::SqliteStorageBackend;
pub use url::{DatabaseUrl, DatabaseUrlError, Scheme};

use std::sync::Arc;

use async_trait::async_trait;

use crate::auth::{
    BearerTokenStore, CliTokenAuthorizationStore, LoginSessionStore, PendingAuthStore,
};
use crate::bookmarks::BookmarkStore;
use crate::inbox::InboxStore;
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

/// Why a [`StorageBackend::ping`] got no answer. Carries the driver's
/// reason and nothing about the connection string, so it can be logged
/// without redaction.
#[derive(Debug, thiserror::Error)]
#[error("the database did not answer: {reason}")]
pub struct PingError {
    reason: String,
}

impl PingError {
    pub(crate) fn new(reason: impl ToString) -> Self {
        Self {
            reason: reason.to_string(),
        }
    }
}

/// One database, and the seven stores that read and write it.
///
/// Implementations are constructed by [`open`] and shared as
/// `Arc<dyn StorageBackend>`. Every accessor returns a handle over the
/// same connection pool, so the stores share one connection budget and
/// one transaction domain, and calling an accessor twice is cheap.
#[async_trait]
pub trait StorageBackend: Send + Sync + std::fmt::Debug {
    fn login_sessions(&self) -> Arc<dyn LoginSessionStore>;
    fn pending_auth(&self) -> Arc<dyn PendingAuthStore>;
    fn bearer_tokens(&self) -> Arc<dyn BearerTokenStore>;
    fn cli_token_authorizations(&self) -> Arc<dyn CliTokenAuthorizationStore>;
    fn bookmarks(&self) -> Arc<dyn BookmarkStore>;
    fn workspaces(&self) -> Arc<dyn WorkspaceStore>;
    fn inbox(&self) -> Arc<dyn InboxStore>;

    /// Run one trivial query over the pool the stores share and report
    /// whether the database answered. Goes through the same connections
    /// the stores use, so the answer is about the database the server is
    /// actually talking to. The caller decides how long to wait.
    async fn ping(&self) -> Result<(), PingError>;
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
        Scheme::Postgres => Ok(Arc::new(PostgresStorageBackend::open(url).await?)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use test_support::postgres_schema;

    /// An empty database for `scheme`, or `None` where this machine
    /// cannot offer one.
    ///
    /// The match is exhaustive, so a scheme added without a way to open
    /// one in a test stops this compiling rather than quietly going
    /// untested.
    async fn empty_database(scheme: Scheme) -> Option<DatabaseUrl> {
        match scheme {
            Scheme::Sqlite => Some(DatabaseUrl::in_memory()),
            Scheme::Postgres => Some(postgres_schema().await?.url),
        }
    }

    /// Every scheme the configuration layer accepts must also be one
    /// `open` can serve. The dispatch arm is compiler-checked, but
    /// whether the backend behind it actually comes up is not.
    #[tokio::test]
    async fn open_serves_every_scheme() {
        for scheme in Scheme::ALL {
            let Some(url) = empty_database(*scheme).await else {
                continue;
            };
            open(&url)
                .await
                .unwrap_or_else(|e| panic!("{scheme} is accepted but cannot be opened: {e}"));
        }
    }

    /// Each accessor runs a read against the migrated schema, which
    /// proves the store is wired to a table that exists — on every
    /// backend, because a missing table is a per-backend fault.
    #[tokio::test]
    async fn every_store_is_reachable_through_the_trait() {
        for scheme in Scheme::ALL {
            let Some(url) = empty_database(*scheme).await else {
                continue;
            };
            let backend = open(&url).await.unwrap();
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
            backend
                .inbox()
                .list("absent", chrono::Utc::now())
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn every_backend_answers_a_ping() {
        for scheme in Scheme::ALL {
            let Some(url) = empty_database(*scheme).await else {
                continue;
            };
            let backend = open(&url).await.unwrap();
            backend
                .ping()
                .await
                .unwrap_or_else(|e| panic!("{scheme} does not answer a ping: {e}"));
        }
    }

    #[tokio::test]
    async fn a_backend_that_lost_its_database_fails_a_ping() {
        let backend = test_support::sqlite_backend().await;
        backend.pool().close().await;
        let err = backend
            .ping()
            .await
            .expect_err("a closed pool answers nothing");
        assert!(!err.to_string().is_empty(), "the reason is reported");
    }
}
