//! In-memory `LoginSessionStore` implementation.
//!
//! Used by unit tests and integration tests so they don't need to spin
//! up a SQLite database on disk. It answers exactly as the SQLite store
//! does, and that is checked rather than intended: both run the
//! `LoginSessionStore` conformance suite in [`crate::storage`].
//!
//! Production code never reaches this — `main.rs` always wires the
//! SQLite implementation. Lives behind a regular module rather than
//! `cfg(test)` so integration tests in `tests/` can construct it.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use super::session_store::{LoginSession, LoginSessionStore, SessionStoreError};

/// In-memory implementation. The mutex is uncontended in tests so the
/// extra lock overhead is irrelevant.
#[derive(Debug, Default)]
pub struct MemorySessionStore {
    rows: Mutex<HashMap<String, LoginSession>>,
}

impl MemorySessionStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Total row count, for tests that want to assert sweep behaviour.
    pub fn len(&self) -> usize {
        self.rows.lock().expect("memory store mutex poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[async_trait]
impl LoginSessionStore for MemorySessionStore {
    async fn create(&self, session: LoginSession) -> Result<(), SessionStoreError> {
        let mut rows = self.rows.lock().expect("memory store mutex poisoned");
        // Reject a reused id rather than overwrite it, as the SQL primary
        // key does.
        if rows.contains_key(&session.id) {
            return Err(SessionStoreError::Backend("duplicate session id".into()));
        }
        rows.insert(session.id.clone(), session);
        Ok(())
    }

    async fn get(&self, id: &str) -> Result<Option<LoginSession>, SessionStoreError> {
        let rows = self.rows.lock().expect("memory store mutex poisoned");
        Ok(rows.get(id).cloned())
    }

    async fn touch_last_used(&self, id: &str, now: DateTime<Utc>) -> Result<(), SessionStoreError> {
        let mut rows = self.rows.lock().expect("memory store mutex poisoned");
        if let Some(row) = rows.get_mut(id) {
            row.last_used_at = now;
        }
        // Missing row is not an error: the session may have been
        // deleted between the get() and the bump (tab open during
        // logout). Mirror the SQLite implementation, which uses
        // `UPDATE` and silently affects 0 rows in the same case.
        Ok(())
    }

    async fn delete(&self, id: &str) -> Result<(), SessionStoreError> {
        let mut rows = self.rows.lock().expect("memory store mutex poisoned");
        rows.remove(id);
        Ok(())
    }

    async fn delete_expired(&self, now: DateTime<Utc>) -> Result<u64, SessionStoreError> {
        let mut rows = self.rows.lock().expect("memory store mutex poisoned");
        let before = rows.len();
        rows.retain(|_, row| row.expires_at > now);
        Ok((before - rows.len()) as u64)
    }
}
