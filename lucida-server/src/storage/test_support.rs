//! Database setup shared by every test that needs a real one.
//!
//! Each store's tests used to open their own in-memory database with the
//! same three lines. They go through here instead, so how a test database
//! comes up is written once and cannot drift from how production opens
//! one: the migrations, the pool shape, and the pinned connection all
//! come from [`SqliteStorageBackend`].

use sqlx::SqlitePool;

use super::SqliteStorageBackend;

/// A migrated in-memory SQLite backend.
pub(crate) async fn sqlite_backend() -> SqliteStorageBackend {
    SqliteStorageBackend::open_in_memory()
        .await
        .expect("in-memory SQLite backend should open")
}

/// The pool behind a fresh [`sqlite_backend`], for tests that build a
/// concrete store by hand or close the pool to provoke a store failure.
pub(crate) async fn sqlite_pool() -> SqlitePool {
    sqlite_backend().await.pool().clone()
}
