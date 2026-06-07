//! In-memory bearer-token store for tests.

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::bearer_token::hash_bearer_token;

    fn sample(id: &str) -> BearerToken {
        let now = Utc::now();
        BearerToken {
            id: id.to_string(),
            token_hash: hash_bearer_token(id),
            name: "test token".to_string(),
            email: "dev@local".to_string(),
            display_name: "Local Dev".to_string(),
            picture_url: None,
            created_at: now,
            last_used_at: None,
            expires_at: now + chrono::Duration::hours(1),
            revoked_at: None,
        }
    }

    #[tokio::test]
    async fn roundtrip_lookup_touch_and_revoke() {
        let store = MemoryBearerTokenStore::new();
        let token = sample("tok-a");
        let hash = token.token_hash.clone();
        store.create(token).await.unwrap();

        let row = store.get_by_hash(&hash).await.unwrap().unwrap();
        assert_eq!(row.email, "dev@local");

        let touched = Utc::now();
        store.touch_last_used(&row.id, touched).await.unwrap();
        let row = store.get_by_hash(&hash).await.unwrap().unwrap();
        assert_eq!(row.last_used_at, Some(touched));

        let revoked = Utc::now();
        let row = store.revoke_by_hash(&hash, revoked).await.unwrap().unwrap();
        assert_eq!(row.revoked_at, Some(revoked));
    }
}
