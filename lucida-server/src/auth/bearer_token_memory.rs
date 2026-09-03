//! In-memory bearer-token store for tests.
//!
//! The `BearerTokenStore` conformance suite in [`crate::storage`] runs
//! against this store and the SQLite one, so the two answer alike.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use super::bearer_token::{BearerToken, BearerTokenStore, BearerTokenStoreError};

#[derive(Debug, Default)]
pub struct MemoryBearerTokenStore {
    rows: Mutex<HashMap<String, BearerToken>>,
}

impl MemoryBearerTokenStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.rows.lock().expect("memory store mutex poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows
            .lock()
            .expect("memory store mutex poisoned")
            .is_empty()
    }
}

#[async_trait]
impl BearerTokenStore for MemoryBearerTokenStore {
    async fn create(&self, token: BearerToken) -> Result<(), BearerTokenStoreError> {
        let mut rows = self.rows.lock().expect("memory store mutex poisoned");
        // Both uniqueness rules the SQL schema carries: one token per id,
        // one identity per hash.
        if rows.contains_key(&token.id) {
            return Err(BearerTokenStoreError::Backend(
                "duplicate bearer token id".to_string(),
            ));
        }
        if rows.values().any(|row| row.token_hash == token.token_hash) {
            return Err(BearerTokenStoreError::Backend(
                "duplicate bearer token hash".to_string(),
            ));
        }
        rows.insert(token.id.clone(), token);
        Ok(())
    }

    async fn get_by_hash(
        &self,
        token_hash: &str,
    ) -> Result<Option<BearerToken>, BearerTokenStoreError> {
        let rows = self.rows.lock().expect("memory store mutex poisoned");
        Ok(rows
            .values()
            .find(|row| row.token_hash == token_hash)
            .cloned())
    }

    async fn touch_last_used(
        &self,
        id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), BearerTokenStoreError> {
        let mut rows = self.rows.lock().expect("memory store mutex poisoned");
        if let Some(row) = rows.get_mut(id) {
            row.last_used_at = Some(now);
        }
        Ok(())
    }

    async fn revoke_by_hash(
        &self,
        token_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<BearerToken>, BearerTokenStoreError> {
        let mut rows = self.rows.lock().expect("memory store mutex poisoned");
        let Some(row) = rows.values_mut().find(|row| row.token_hash == token_hash) else {
            return Ok(None);
        };
        if row.revoked_at.is_none() {
            row.revoked_at = Some(now);
        }
        Ok(Some(row.clone()))
    }
}
