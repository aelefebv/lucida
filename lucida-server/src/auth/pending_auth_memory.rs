//! In-memory `PendingAuthStore`, used by tests.
//!
//! Mirrors `MemorySessionStore`: lock + HashMap, methods deliberately
//! match the SQLite semantics (single-use consume, idempotent
//! delete_expired, NULL-vs-empty hash treated as `String::default()`).

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

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration as ChronoDuration;

    fn sample(token: &str, path: &str, hash: &str, now: DateTime<Utc>) -> PendingAuth {
        PendingAuth {
            state_token: token.to_string(),
            intended_path: path.to_string(),
            intended_hash: hash.to_string(),
            created_at: now,
        }
    }

    #[tokio::test]
    async fn consume_is_one_shot() {
        let store = MemoryPendingAuthStore::new();
        let now = Utc::now();
        store.insert(sample("t", "/", "", now)).await.unwrap();
        assert!(store.consume("t").await.unwrap().is_some());
        assert!(store.consume("t").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn duplicate_insert_errors() {
        let store = MemoryPendingAuthStore::new();
        let now = Utc::now();
        store.insert(sample("dupe", "/", "", now)).await.unwrap();
        let res = store.insert(sample("dupe", "/x", "", now)).await;
        assert!(res.is_err());
    }

    #[tokio::test]
    async fn delete_expired_strict_less_than_boundary() {
        let store = MemoryPendingAuthStore::new();
        let now = Utc::now();
        // exactly at the boundary: must NOT be removed
        store
            .insert(sample("boundary", "/", "", now))
            .await
            .unwrap();
        // strictly older: removed
        store
            .insert(sample("old", "/", "", now - ChronoDuration::seconds(1)))
            .await
            .unwrap();

        let removed = store.delete_expired(now).await.unwrap();
        assert_eq!(removed, 1);
        assert!(store.consume("boundary").await.unwrap().is_some());
        assert!(store.consume("old").await.unwrap().is_none());
    }
}
