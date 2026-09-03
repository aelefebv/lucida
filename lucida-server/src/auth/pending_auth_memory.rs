//! In-memory `PendingAuthStore`, used by tests.
//!
//! Mirrors `MemorySessionStore`: lock + HashMap. The `PendingAuthStore`
//! conformance suite in [`crate::storage`] runs against this store and
//! the SQLite one, so the two answer alike.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use super::pending_auth::{PendingAuth, PendingAuthStore, PendingAuthStoreError};

#[derive(Debug, Default)]
pub struct MemoryPendingAuthStore {
    rows: Mutex<HashMap<String, PendingAuth>>,
}

impl MemoryPendingAuthStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.rows.lock().expect("memory store mutex poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[async_trait]
impl PendingAuthStore for MemoryPendingAuthStore {
    async fn insert(&self, row: PendingAuth) -> Result<(), PendingAuthStoreError> {
        let mut rows = self.rows.lock().expect("memory store mutex poisoned");
        if rows.contains_key(&row.state_token) {
            return Err(PendingAuthStoreError::Backend(
                "duplicate state_token".into(),
            ));
        }
        rows.insert(row.state_token.clone(), row);
        Ok(())
    }

    async fn consume(
        &self,
        state_token: &str,
    ) -> Result<Option<PendingAuth>, PendingAuthStoreError> {
        let mut rows = self.rows.lock().expect("memory store mutex poisoned");
        Ok(rows.remove(state_token))
    }

    async fn delete_expired(
        &self,
        older_than: DateTime<Utc>,
    ) -> Result<u64, PendingAuthStoreError> {
        let mut rows = self.rows.lock().expect("memory store mutex poisoned");
        let before = rows.len();
        rows.retain(|_, row| row.created_at >= older_than);
        Ok((before - rows.len()) as u64)
    }
}
