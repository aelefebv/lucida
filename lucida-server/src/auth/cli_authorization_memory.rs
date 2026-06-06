//! In-memory CLI authorization request store for tests.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use super::cli_authorization::{
    CliTokenAuthorization, CliTokenAuthorizationStore, CliTokenAuthorizationStoreError,
};

#[derive(Debug, Default)]
pub struct MemoryCliTokenAuthorizationStore {
    rows: Mutex<HashMap<String, CliTokenAuthorization>>,
}

impl MemoryCliTokenAuthorizationStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.rows.lock().expect("memory store mutex poisoned").len()
    }
}

#[async_trait]
impl CliTokenAuthorizationStore for MemoryCliTokenAuthorizationStore {
    async fn create(
        &self,
        request: CliTokenAuthorization,
    ) -> Result<(), CliTokenAuthorizationStoreError> {
        let mut rows = self.rows.lock().expect("memory store mutex poisoned");
        if rows.values().any(|row| {
            row.poll_token_hash == request.poll_token_hash
                || row.token_hash == request.token_hash
                || row.user_code == request.user_code
        }) {
            return Err(CliTokenAuthorizationStoreError::Backend(
                "duplicate cli authorization request".to_string(),
            ));
        }
        rows.insert(request.id.clone(), request);
        Ok(())
    }

    async fn get(
        &self,
        id: &str,
    ) -> Result<Option<CliTokenAuthorization>, CliTokenAuthorizationStoreError> {
        let rows = self.rows.lock().expect("memory store mutex poisoned");
        Ok(rows.get(id).cloned())
    }

    async fn get_for_poll(
        &self,
        id: &str,
        poll_token_hash: &str,
    ) -> Result<Option<CliTokenAuthorization>, CliTokenAuthorizationStoreError> {
        let rows = self.rows.lock().expect("memory store mutex poisoned");
        Ok(rows
            .get(id)
            .filter(|row| row.poll_token_hash == poll_token_hash)
            .cloned())
    }

    async fn mark_approved(
        &self,
        id: &str,
        token_id: &str,
        email: &str,
        now: DateTime<Utc>,
    ) -> Result<(), CliTokenAuthorizationStoreError> {
        let mut rows = self.rows.lock().expect("memory store mutex poisoned");
        if let Some(row) = rows.get_mut(id) {
            row.approved_at = Some(now);
            row.approved_token_id = Some(token_id.to_string());
            row.approved_email = Some(email.to_string());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> CliTokenAuthorization {
        let now = Utc::now();
        CliTokenAuthorization {
            id: "req-1".into(),
            poll_token_hash: "poll-hash".into(),
            token_hash: "token-hash".into(),
            user_code: "ABCD-1234".into(),
            name: "laptop".into(),
            created_at: now,
            expires_at: now + chrono::Duration::minutes(10),
            token_expires_at: now + chrono::Duration::days(30),
            approved_at: None,
            approved_token_id: None,
            approved_email: None,
        }
    }

    #[tokio::test]
    async fn poll_requires_poll_hash_and_approval_marks_row() {
        let store = MemoryCliTokenAuthorizationStore::new();
        store.create(sample()).await.unwrap();

        assert!(
            store
                .get_for_poll("req-1", "wrong")
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .get_for_poll("req-1", "poll-hash")
                .await
                .unwrap()
                .is_some()
        );

        let approved_at = Utc::now();
        store
            .mark_approved("req-1", "tok-1", "dev@local", approved_at)
            .await
            .unwrap();
        let row = store.get("req-1").await.unwrap().unwrap();
        assert_eq!(row.approved_at, Some(approved_at));
        assert_eq!(row.approved_token_id.as_deref(), Some("tok-1"));
        assert_eq!(row.approved_email.as_deref(), Some("dev@local"));
    }
}
