//! In-memory bearer-token store for tests.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use super::bearer_token::{BearerToken, BearerTokenStore, BearerTokenStoreError};
use crate::persistence::{PersistenceOperation, PersistenceWorkerOutcome};

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
    fn begin_revoke_by_hash(
        &self,
        token_hash: &str,
        now: DateTime<Utc>,
    ) -> PersistenceOperation<Option<BearerToken>, BearerTokenStoreError> {
        let mut rows = self.rows.lock().expect("memory store mutex poisoned");
        let row = rows
            .values_mut()
            .find(|row| row.token_hash == token_hash)
            .and_then(|row| {
                if row.revoked_at.is_some() {
                    None
                } else {
                    row.revoked_at = Some(now);
                    Some(row.clone())
                }
            });
        PersistenceOperation::ready(PersistenceWorkerOutcome::Committed(row))
    }

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
        if row.revoked_at.is_some() {
            return Ok(None);
        }
        row.revoked_at = Some(now);
        Ok(Some(row.clone()))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::auth::bearer_token::hash_bearer_token;
    use tokio::sync::Barrier;

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

    #[tokio::test]
    async fn revoke_returns_the_principal_exactly_once() {
        let store = MemoryBearerTokenStore::new();
        let token = sample("tok-once");
        let hash = token.token_hash.clone();
        store.create(token).await.unwrap();

        let first_at = Utc::now();
        let first = store
            .revoke_by_hash(&hash, first_at)
            .await
            .unwrap()
            .unwrap();
        let second_at = first_at + chrono::Duration::seconds(1);
        assert!(
            store
                .revoke_by_hash(&hash, second_at)
                .await
                .unwrap()
                .is_none()
        );

        assert_eq!(first.email, "dev@local");
        assert_eq!(first.revoked_at, Some(first_at));
        assert_eq!(
            store.get_by_hash(&hash).await.unwrap().unwrap().revoked_at,
            Some(first_at)
        );
    }

    #[tokio::test]
    async fn concurrent_revoke_has_one_transition_owner() {
        let store = Arc::new(MemoryBearerTokenStore::new());
        let token = sample("tok-concurrent");
        let hash = token.token_hash.clone();
        store.create(token).await.unwrap();

        const CALLERS: usize = 8;
        let start = Arc::new(Barrier::new(CALLERS + 1));
        let baseline = Utc::now();
        let mut tasks = Vec::with_capacity(CALLERS);
        for offset in 0..CALLERS {
            let store = Arc::clone(&store);
            let hash = hash.clone();
            let start = Arc::clone(&start);
            tasks.push(tokio::spawn(async move {
                start.wait().await;
                store
                    .revoke_by_hash(&hash, baseline + chrono::Duration::seconds(offset as i64))
                    .await
                    .unwrap()
            }));
        }
        start.wait().await;

        let mut owners = Vec::new();
        for task in tasks {
            if let Some(row) = task.await.unwrap() {
                owners.push(row);
            }
        }

        assert_eq!(owners.len(), 1);
        let owner = &owners[0];
        assert_eq!(owner.email, "dev@local");
        let owner_revoked_at = owner.revoked_at.expect("owner must be revoked");
        assert_eq!(
            store.get_by_hash(&hash).await.unwrap().unwrap().revoked_at,
            Some(owner_revoked_at)
        );
    }
}
